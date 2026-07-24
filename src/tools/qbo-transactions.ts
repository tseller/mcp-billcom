import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QboClient, QboError } from "../qbo-client.js";
import { sniffContentType } from "../mime.js";
import { IdempotencyStore, withIdempotency } from "../idempotency.js";
import type { GmailClient } from "../gmail-client.js";

function err(e: unknown) {
  const msg = e instanceof QboError ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

// QBO's documented attachment ceiling is 100MB, but we buffer the whole file in
// memory on Cloud Run, so cap URL fetches well below that.
const MAX_URL_FILE_BYTES = 30 * 1024 * 1024;

async function fetchFileFromUrl(
  fileUrl: string,
): Promise<{ data: Buffer; contentType?: string; fileName?: string }> {
  const parsed = new URL(fileUrl);
  if (parsed.protocol !== "https:") {
    throw new Error(`fileUrl must be https (got ${parsed.protocol}//)`);
  }
  const res = await fetch(fileUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`fetching fileUrl failed: ${res.status} ${res.statusText}`);
  }
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length === 0) throw new Error("fileUrl returned an empty body");
  if (data.length > MAX_URL_FILE_BYTES) {
    throw new Error(
      `fileUrl body is ${data.length} bytes, over the ${MAX_URL_FILE_BYTES}-byte limit`,
    );
  }
  const contentType = res.headers.get("content-type")?.split(";")[0].trim() || undefined;
  const disposition = res.headers.get("content-disposition") ?? "";
  const dispositionName = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const lastSegment = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
  const fileName = dispositionName || (lastSegment.includes(".") ? lastSegment : undefined);
  return { data, contentType, fileName };
}

export interface QboTransactionToolDeps {
  /** Enables optional idempotencyKey on the create tools. */
  idempotency?: IdempotencyStore;
  /** Enables the Gmail source on qbo_attach_file. */
  gmail?: GmailClient;
}

const IDEMPOTENCY_KEY_DESC =
  "Optional idempotency key (any unique string, e.g. a UUID per logical create). If a create with this key already succeeded, the original result is returned instead of creating a duplicate — makes retries after ambiguous 5xx errors safe.";

export function registerQboTransactionTools(
  server: McpServer,
  client: QboClient,
  deps: QboTransactionToolDeps = {},
) {
  const { idempotency, gmail } = deps;

  /** Run a create under an optional idempotency key (no-op passthrough when no store is wired). */
  async function idempotentCreate(
    tool: string,
    key: string | undefined,
    create: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!idempotency) return create();
    return withIdempotency(idempotency, tool, key, create);
  }

  server.tool(
    "qbo_list_purchases",
    "List expense/purchase transactions from QuickBooks. These include credit card charges, checks, and cash purchases. Filter by date range, account, or vendor.",
    {
      startDate: z.string().optional().describe("Start date YYYY-MM-DD"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD"),
      accountId: z.string().optional().describe("Filter by bank/CC account ID"),
      vendorId: z.string().optional().describe("Filter by vendor (EntityRef) ID"),
      startPosition: z.number().int().min(1).optional().describe("1-based start position (default 1)"),
      maxResults: z.number().int().min(1).max(1000).optional().describe("Max results (default 100)"),
    },
    async ({ startDate, endDate, accountId, vendorId, startPosition, maxResults }) => {
      try {
        const conditions: string[] = [];
        if (startDate) conditions.push(`TxnDate >= '${startDate}'`);
        if (endDate) conditions.push(`TxnDate <= '${endDate}'`);
        if (accountId) conditions.push(`AccountRef = '${accountId}'`);
        if (vendorId) conditions.push(`EntityRef = '${vendorId}'`);
        const where = conditions.join(" AND ");
        const result = await client.queryPurchases(where, startPosition ?? 1, maxResults ?? 100);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_get_purchase",
    "Get a single purchase/expense transaction by ID. Returns full details including line items.",
    {
      id: z.string().describe("Purchase transaction ID"),
    },
    async ({ id }) => {
      try {
        const result = await client.getPurchase(id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_update_purchase",
    "Update a purchase transaction — categorize it by setting the expense account, vendor, and/or memo. Sparse update: only the fields you pass are changed. The current PaymentType and AccountRef are fetched and carried over automatically (QBO rejects a sparse Purchase update without them), and SyncToken is auto-filled from the current version if omitted.",
    {
      id: z.string().describe("Purchase ID"),
      syncToken: z
        .string()
        .optional()
        .describe("SyncToken for optimistic locking. Omit to use the current version's token automatically."),
      vendorId: z.string().optional().describe("Set/change the vendor (EntityRef value)"),
      memo: z.string().optional().describe("Private memo/note"),
      lines: z
        .array(
          z.object({
            amount: z.number().describe("Line amount"),
            accountId: z.string().describe("Expense account ID (from chart of accounts)"),
            description: z.string().optional().describe("Line description"),
          }),
        )
        .optional()
        .describe("Replace line items with new categorization"),
    },
    async ({ id, syncToken, vendorId, memo, lines }) => {
      try {
        // QBO rejects a sparse Purchase update without PaymentType and AccountRef
        // (ValidationFault), so fetch the current transaction and carry them over.
        const current = (await client.getPurchase(id)) as {
          Purchase?: { PaymentType?: string; AccountRef?: unknown; SyncToken?: string };
        };
        const existing = current.Purchase;
        if (!existing) {
          return {
            content: [{ type: "text" as const, text: `Error: purchase ${id} not found` }],
            isError: true,
          };
        }

        const update: Record<string, unknown> = {
          Id: id,
          SyncToken: syncToken ?? existing.SyncToken,
          sparse: true,
          PaymentType: existing.PaymentType,
          AccountRef: existing.AccountRef,
        };

        if (vendorId) update.EntityRef = { type: "Vendor", value: vendorId };
        if (memo) update.PrivateNote = memo;
        if (lines) {
          update.Line = lines.map((l) => ({
            Amount: l.amount,
            DetailType: "AccountBasedExpenseLineDetail",
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: l.accountId },
            },
            Description: l.description,
          }));
        }

        const result = await client.updatePurchase(update);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_create_purchase",
    "Create an expense/purchase transaction in QuickBooks — the outflow side (bill-pay checks, Divvy eWallet debits, Bill.com payments). Booking it into the register lets QBO's banking page offer the matching bank-feed item as a one-click Match. Provide the bank/CC account the money left, the payment type, one or more expense lines, and (for checks) the check number as docNumber.",
    {
      paymentType: z
        .enum(["Check", "Cash", "CreditCard"])
        .describe("How it was paid: Check, Cash, or CreditCard"),
      accountId: z
        .string()
        .describe("Bank/CC account the money came out of (AccountRef value, e.g. 14 for Chase)"),
      txnDate: z.string().optional().describe("Transaction date YYYY-MM-DD (default: today in QBO)"),
      vendorId: z.string().optional().describe("Payee vendor ID (EntityRef value)"),
      docNumber: z.string().optional().describe("Document/check number"),
      memo: z.string().optional().describe("Private note/memo"),
      lines: z
        .array(
          z.object({
            amount: z.number().describe("Line amount (positive)"),
            accountId: z.string().describe("Expense account ID (from chart of accounts)"),
            description: z.string().optional().describe("Line description"),
          }),
        )
        .min(1)
        .describe("Expense lines — at least one required"),
      idempotencyKey: z.string().optional().describe(IDEMPOTENCY_KEY_DESC),
    },
    async ({ paymentType, accountId, txnDate, vendorId, docNumber, memo, lines, idempotencyKey }) => {
      try {
        const purchase: Record<string, unknown> = {
          PaymentType: paymentType,
          AccountRef: { value: accountId },
          Line: lines.map((l) => ({
            Amount: l.amount,
            DetailType: "AccountBasedExpenseLineDetail",
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: l.accountId },
            },
            Description: l.description,
          })),
        };
        if (txnDate) purchase.TxnDate = txnDate;
        if (vendorId) purchase.EntityRef = { type: "Vendor", value: vendorId };
        if (docNumber) purchase.DocNumber = docNumber;
        if (memo) purchase.PrivateNote = memo;

        const result = await idempotentCreate("qbo_create_purchase", idempotencyKey, () =>
          client.createPurchase(purchase),
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_list_deposits",
    "List deposit transactions. Filter by date range.",
    {
      startDate: z.string().optional().describe("Start date YYYY-MM-DD"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD"),
      startPosition: z.number().int().min(1).optional().describe("1-based start position"),
      maxResults: z.number().int().min(1).max(1000).optional().describe("Max results (default 100)"),
    },
    async ({ startDate, endDate, startPosition, maxResults }) => {
      try {
        const conditions: string[] = [];
        if (startDate) conditions.push(`TxnDate >= '${startDate}'`);
        if (endDate) conditions.push(`TxnDate <= '${endDate}'`);
        const where = conditions.join(" AND ");
        const result = await client.queryDeposits(where, startPosition ?? 1, maxResults ?? 100);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_get_deposit",
    "Get a single deposit transaction by ID. Returns full details including line items and SyncToken (needed for update_deposit).",
    {
      id: z.string().describe("Deposit transaction ID"),
    },
    async ({ id }) => {
      try {
        const result = await client.getDeposit(id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  const depositLineSchema = z.object({
    amount: z.number().describe("Line amount (positive)"),
    accountId: z.string().describe("Income account to credit (e.g. 4005 Registration Fees)"),
    entityId: z.string().optional().describe("Attributed entity ID (customer/vendor/employee)"),
    entityType: z
      .enum(["Vendor", "Customer", "Employee"])
      .optional()
      .describe("Entity type for entityId (default Vendor)"),
    description: z.string().optional().describe("Line description"),
  });
  type DepositLineInput = z.infer<typeof depositLineSchema>;

  function buildDepositLines(lines: DepositLineInput[]) {
    return lines.map((l) => {
      const detail: Record<string, unknown> = {
        AccountRef: { value: l.accountId },
      };
      // Deposit line entity is a plain ReferenceType: lowercase { value, type }.
      if (l.entityId) detail.Entity = { value: l.entityId, type: l.entityType ?? "Vendor" };
      return {
        Amount: l.amount,
        DetailType: "DepositLineDetail",
        DepositLineDetail: detail,
        Description: l.description,
      };
    });
  }

  function buildDeposit(item: {
    depositToAccountId: string;
    txnDate?: string;
    memo?: string;
    lines: DepositLineInput[];
  }): Record<string, unknown> {
    const deposit: Record<string, unknown> = {
      DepositToAccountRef: { value: item.depositToAccountId },
      Line: buildDepositLines(item.lines),
    };
    if (item.txnDate) deposit.TxnDate = item.txnDate;
    if (item.memo) deposit.PrivateNote = item.memo;
    return deposit;
  }

  server.tool(
    "qbo_create_deposit",
    "Create a deposit transaction in QuickBooks — the inflow side (e.g. Sports Connect ACH credits into Chase). Booking it into the register lets QBO's banking page offer the matching bank-feed item as a one-click Match. Provide the deposit-to bank account and one or more lines, each crediting an income account and optionally attributing an entity (customer/vendor). For many similar deposits, prefer qbo_create_deposits_batch.",
    {
      depositToAccountId: z
        .string()
        .describe("Bank account the funds land in (DepositToAccountRef value, e.g. 14 for Chase)"),
      txnDate: z.string().optional().describe("Transaction date YYYY-MM-DD (default: today in QBO)"),
      memo: z.string().optional().describe("Private note/memo"),
      lines: z.array(depositLineSchema).min(1).describe("Deposit lines — at least one required"),
      idempotencyKey: z.string().optional().describe(IDEMPOTENCY_KEY_DESC),
    },
    async ({ depositToAccountId, txnDate, memo, lines, idempotencyKey }) => {
      try {
        const deposit = buildDeposit({ depositToAccountId, txnDate, memo, lines });
        const result = await idempotentCreate("qbo_create_deposit", idempotencyKey, () =>
          client.createDeposit(deposit),
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_create_deposits_batch",
    "Create multiple deposits in one call — each item has the same shape as qbo_create_deposit. Items run sequentially server-side and every item reports its own success/failure, so one bad item doesn't abort the rest. Give each item an idempotencyKey so the whole batch can be safely re-sent after an ambiguous network error: already-created items replay instead of duplicating.",
    {
      deposits: z
        .array(
          z.object({
            depositToAccountId: z
              .string()
              .describe("Bank account the funds land in (DepositToAccountRef value)"),
            txnDate: z.string().optional().describe("Transaction date YYYY-MM-DD"),
            memo: z.string().optional().describe("Private note/memo"),
            lines: z.array(depositLineSchema).min(1).describe("Deposit lines"),
            idempotencyKey: z.string().optional().describe(IDEMPOTENCY_KEY_DESC),
          }),
        )
        .min(1)
        .max(50)
        .describe("Deposits to create, in order (max 50 per call)"),
    },
    async ({ deposits }) => {
      const results: Array<Record<string, unknown>> = [];
      for (const [i, item] of deposits.entries()) {
        try {
          const result = await idempotentCreate("qbo_create_deposit", item.idempotencyKey, () =>
            client.createDeposit(buildDeposit(item)),
          );
          results.push({ index: i, ok: true, result });
        } catch (e) {
          const msg = e instanceof QboError ? e.message : String(e);
          results.push({ index: i, ok: false, error: msg });
        }
      }
      const failed = results.filter((r) => !r.ok).length;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { total: deposits.length, succeeded: deposits.length - failed, failed, results },
              null,
              2,
            ),
          },
        ],
        ...(failed === deposits.length ? { isError: true } : {}),
      };
    },
  );

  server.tool(
    "qbo_update_deposit",
    "Update a deposit transaction — recategorize a line's income account and/or attributed entity, or change the memo. Parity with qbo_update_purchase. Sparse update: only the fields you pass are changed. The current DepositToAccountRef is fetched and carried over automatically (QBO requires it even in sparse updates), and SyncToken is auto-filled from the current version if omitted. Note: passing lines REPLACES all existing lines, so include every line you want to keep.",
    {
      id: z.string().describe("Deposit ID"),
      syncToken: z
        .string()
        .optional()
        .describe("SyncToken for optimistic locking. Omit to use the current version's token automatically."),
      depositToAccountId: z
        .string()
        .optional()
        .describe("Bank account the deposit lands in (DepositToAccountRef value). Omit to keep the current account (fetched automatically)."),
      memo: z.string().optional().describe("Private note/memo"),
      lines: z
        .array(
          z.object({
            amount: z.number().describe("Line amount (positive)"),
            accountId: z.string().describe("Income account to credit"),
            entityId: z.string().optional().describe("Attributed entity ID (customer/vendor/employee)"),
            entityType: z
              .enum(["Vendor", "Customer", "Employee"])
              .optional()
              .describe("Entity type for entityId (default Vendor)"),
            description: z.string().optional().describe("Line description"),
          }),
        )
        .optional()
        .describe("Replace all line items with this new set"),
    },
    async ({ id, syncToken, depositToAccountId, memo, lines }) => {
      try {
        // QBO rejects a sparse Deposit update without DepositToAccountRef
        // (ValidationFault 2020) — fetch the current txn and carry it over.
        const current = (await client.getDeposit(id)) as {
          Deposit?: { DepositToAccountRef?: unknown; SyncToken?: string };
        };
        const existing = current.Deposit;
        if (!existing) {
          return {
            content: [{ type: "text" as const, text: `Error: deposit ${id} not found` }],
            isError: true,
          };
        }

        const update: Record<string, unknown> = {
          Id: id,
          SyncToken: syncToken ?? existing.SyncToken,
          sparse: true,
          DepositToAccountRef: depositToAccountId
            ? { value: depositToAccountId }
            : existing.DepositToAccountRef,
        };
        if (memo) update.PrivateNote = memo;
        if (lines) {
          update.Line = lines.map((l) => {
            const detail: Record<string, unknown> = {
              AccountRef: { value: l.accountId },
            };
            if (l.entityId) detail.Entity = { value: l.entityId, type: l.entityType ?? "Vendor" };
            return {
              Amount: l.amount,
              DetailType: "DepositLineDetail",
              DepositLineDetail: detail,
              Description: l.description,
            };
          });
        }

        const result = await client.updateDeposit(update);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_list_transfers",
    "List bank transfer transactions. Filter by date range.",
    {
      startDate: z.string().optional().describe("Start date YYYY-MM-DD"),
      endDate: z.string().optional().describe("End date YYYY-MM-DD"),
      startPosition: z.number().int().min(1).optional().describe("1-based start position"),
      maxResults: z.number().int().min(1).max(1000).optional().describe("Max results (default 100)"),
    },
    async ({ startDate, endDate, startPosition, maxResults }) => {
      try {
        const conditions: string[] = [];
        if (startDate) conditions.push(`TxnDate >= '${startDate}'`);
        if (endDate) conditions.push(`TxnDate <= '${endDate}'`);
        const where = conditions.join(" AND ");
        const result = await client.queryTransfers(where, startPosition ?? 1, maxResults ?? 100);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_create_transfer",
    "Create a bank transfer between two of your own accounts (e.g. Chase → Divvy payment booked as a transfer rather than a check). Moves the amount out of fromAccount and into toAccount.",
    {
      fromAccountId: z.string().describe("Source account ID (FromAccountRef value)"),
      toAccountId: z.string().describe("Destination account ID (ToAccountRef value)"),
      amount: z.number().describe("Transfer amount (positive)"),
      txnDate: z.string().optional().describe("Transaction date YYYY-MM-DD (default: today in QBO)"),
      memo: z.string().optional().describe("Private note/memo"),
      idempotencyKey: z.string().optional().describe(IDEMPOTENCY_KEY_DESC),
    },
    async ({ fromAccountId, toAccountId, amount, txnDate, memo, idempotencyKey }) => {
      try {
        const transfer: Record<string, unknown> = {
          FromAccountRef: { value: fromAccountId },
          ToAccountRef: { value: toAccountId },
          Amount: amount,
        };
        if (txnDate) transfer.TxnDate = txnDate;
        if (memo) transfer.PrivateNote = memo;

        const result = await idempotentCreate("qbo_create_transfer", idempotencyKey, () =>
          client.createTransfer(transfer),
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_create_journal_entry",
    "Create a journal entry — debit and credit lines that must balance (total debits = total credits). Used for adjustments like moving fall pre-collections into 2510 Deferred Registration Fees and recognizing them when the season starts. Each line specifies a posting type (Debit or Credit), an account, and optionally an attributed entity.",
    {
      txnDate: z.string().optional().describe("Transaction date YYYY-MM-DD (default: today in QBO)"),
      memo: z.string().optional().describe("Private note/memo"),
      lines: z
        .array(
          z.object({
            amount: z.number().describe("Line amount (positive)"),
            postingType: z.enum(["Debit", "Credit"]).describe("Debit or Credit"),
            accountId: z.string().describe("Account ID (from chart of accounts)"),
            entityId: z.string().optional().describe("Attributed entity ID (customer/vendor/employee)"),
            entityType: z
              .enum(["Vendor", "Customer", "Employee"])
              .optional()
              .describe("Entity type for entityId (default Vendor)"),
            description: z.string().optional().describe("Line description"),
          }),
        )
        .min(2)
        .describe("At least two lines; total Debits must equal total Credits"),
      idempotencyKey: z.string().optional().describe(IDEMPOTENCY_KEY_DESC),
    },
    async ({ txnDate, memo, lines, idempotencyKey }) => {
      try {
        const totalDebit = lines
          .filter((l) => l.postingType === "Debit")
          .reduce((s, l) => s + l.amount, 0);
        const totalCredit = lines
          .filter((l) => l.postingType === "Credit")
          .reduce((s, l) => s + l.amount, 0);
        // Guard client-side so we return a clear message instead of QBO's generic fault.
        if (Math.abs(totalDebit - totalCredit) > 0.005) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: journal entry is unbalanced — debits ${totalDebit.toFixed(2)} vs credits ${totalCredit.toFixed(2)}. They must be equal.`,
              },
            ],
            isError: true,
          };
        }

        const journalEntry: Record<string, unknown> = {
          Line: lines.map((l) => {
            const detail: Record<string, unknown> = {
              PostingType: l.postingType,
              AccountRef: { value: l.accountId },
            };
            // JournalEntry line entity nests differently from Deposit: { Type, EntityRef: { value } }.
            if (l.entityId) {
              detail.Entity = { Type: l.entityType ?? "Vendor", EntityRef: { value: l.entityId } };
            }
            return {
              Amount: l.amount,
              DetailType: "JournalEntryLineDetail",
              JournalEntryLineDetail: detail,
              Description: l.description,
            };
          }),
        };
        if (txnDate) journalEntry.TxnDate = txnDate;
        if (memo) journalEntry.PrivateNote = memo;

        const result = await idempotentCreate("qbo_create_journal_entry", idempotencyKey, () =>
          client.createJournalEntry(journalEntry),
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_attach_file",
    "Attach a file (receipt, invoice, supporting doc) to a QuickBooks transaction. Provide the file ONE of three ways: fileUrl (https URL the server fetches directly), gmailMessageId + gmailAttachmentId (server pulls the attachment straight from Gmail — use the Gmail MCP to find the ids), or fileBase64 (raw bytes, fallback). File bytes are validated by magic numbers (PDF, JPEG, PNG, GIF, WebP, HEIC) before upload. Returns the created Attachable id and filename. Provide the transaction's entity type (e.g. Purchase, Deposit, Bill, Transfer) and its Id (from the list/get tools).",
    {
      entityType: z
        .enum(["Purchase", "Deposit", "Bill", "Transfer", "Invoice", "JournalEntry", "VendorCredit"])
        .describe("QBO entity type of the transaction to attach to"),
      entityId: z.string().describe("Transaction Id (the entity's Id, from list/get tools)"),
      fileBase64: z
        .string()
        .optional()
        .describe("Base64-encoded file bytes (image or PDF). Fallback — prefer fileUrl or the Gmail source."),
      fileUrl: z
        .string()
        .url()
        .optional()
        .describe("https URL to fetch the file from server-side (e.g. an invoice download link)."),
      gmailMessageId: z
        .string()
        .optional()
        .describe("Gmail message id containing the attachment (pair with gmailAttachmentId)"),
      gmailAttachmentId: z
        .string()
        .optional()
        .describe("Gmail attachment id within the message (pair with gmailMessageId)"),
      gmailAccount: z
        .string()
        .optional()
        .describe(
          "Gmail account email to fetch from. Optional when only one account is configured on the server.",
        ),
      fileName: z
        .string()
        .optional()
        .describe(
          "File name to store in QBO (default: derived from the Gmail attachment or URL, else 'attachment')",
        ),
      contentType: z
        .string()
        .optional()
        .describe("Optional MIME override. Only set this if the auto-detected type is wrong."),
    },
    async ({
      entityType,
      entityId,
      fileBase64,
      fileUrl,
      gmailMessageId,
      gmailAttachmentId,
      gmailAccount,
      fileName,
      contentType,
    }) => {
      try {
        const wantsGmail = !!(gmailMessageId || gmailAttachmentId || gmailAccount);
        const sources = [!!fileBase64, !!fileUrl, wantsGmail].filter(Boolean).length;
        if (sources !== 1) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: provide exactly one file source — fileBase64, fileUrl, or gmailMessageId + gmailAttachmentId",
              },
            ],
            isError: true,
          };
        }

        let fileData: Buffer;
        let source: string;
        let sourceContentType: string | undefined;
        let sourceFileName: string | undefined;
        if (fileUrl) {
          source = "url";
          ({ data: fileData, contentType: sourceContentType, fileName: sourceFileName } =
            await fetchFileFromUrl(fileUrl));
        } else if (wantsGmail) {
          if (!gmail) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: the Gmail source is not configured on this server. Set GMAIL_REFRESH_TOKENS (mint tokens with `npm run gmail:link`) — or use fileUrl/fileBase64.",
                },
              ],
              isError: true,
            };
          }
          if (!gmailMessageId || !gmailAttachmentId) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: the Gmail source needs both gmailMessageId and gmailAttachmentId",
                },
              ],
              isError: true,
            };
          }
          source = "gmail";
          const fetched = await gmail.getAttachment(gmailAccount, gmailMessageId, gmailAttachmentId);
          fileData = fetched.data;
          sourceContentType = fetched.mimeType;
          sourceFileName = fetched.fileName;
        } else {
          source = "base64";
          fileData = Buffer.from(fileBase64!, "base64");
        }

        // Validate magic bytes before uploading — catches truncated/corrupted
        // transfers and non-document payloads. contentType is an explicit
        // escape hatch for formats the sniffer doesn't know.
        const sniffed = sniffContentType(fileData);
        if (!sniffed && !contentType) {
          const head = fileData.subarray(0, 8).toString("hex");
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: file bytes don't match any supported format (PDF, JPEG, PNG, GIF, WebP, HEIC) — first bytes: ${head || "(empty)"}, size: ${fileData.length}. If the format is genuinely something else, pass contentType explicitly.`,
              },
            ],
            isError: true,
          };
        }
        const mime = contentType || sniffed || sourceContentType || "application/octet-stream";
        if (contentType && sniffed && contentType !== sniffed) {
          console.error(
            `[tool] qbo_attach_file warn=mime_mismatch override=${contentType} sniffed=${sniffed}`,
          );
        }
        const name = fileName || sourceFileName || "attachment";
        console.error(
          `[tool] qbo_attach_file entityType=${entityType} entityId=${entityId} mime=${mime} sniffed=${sniffed ?? "unknown"} override=${contentType ?? "none"} source=${source} bytes=${fileData.length}`,
        );
        const result = await client.uploadAttachment(entityType, entityId, name, mime, fileData);
        const attachable = (
          result as {
            AttachableResponse?: Array<{ Attachable?: { Id?: string; FileName?: string } }>;
          }
        )?.AttachableResponse?.[0]?.Attachable;
        console.error(
          `[tool] qbo_attach_file step=done entityType=${entityType} entityId=${entityId} attachableId=${attachable?.Id ?? "unknown"}`,
        );
        const summary = {
          attachableId: attachable?.Id,
          fileName: attachable?.FileName ?? name,
          contentType: mime,
          bytes: fileData.length,
          source,
          attachedTo: { entityType, entityId },
        };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_list_attachments",
    "List the files already attached to a QuickBooks transaction — use before qbo_attach_file to avoid duplicate uploads. Returns each attachment's Attachable id, filename, size, and content type.",
    {
      entityType: z
        .enum(["Purchase", "Deposit", "Bill", "Transfer", "Invoice", "JournalEntry", "VendorCredit"])
        .describe("QBO entity type of the transaction"),
      entityId: z.string().describe("Transaction Id (the entity's Id, from list/get tools)"),
    },
    async ({ entityType, entityId }) => {
      try {
        const result = (await client.queryAttachables(entityType, entityId)) as {
          QueryResponse?: {
            Attachable?: Array<{
              Id?: string;
              FileName?: string;
              Size?: number;
              ContentType?: string;
              Note?: string;
              MetaData?: { CreateTime?: string };
            }>;
          };
        };
        const attachments = (result.QueryResponse?.Attachable ?? []).map((a) => ({
          attachableId: a.Id,
          fileName: a.FileName,
          size: a.Size,
          contentType: a.ContentType,
          note: a.Note,
          createdAt: a.MetaData?.CreateTime,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: attachments.length, attachments }, null, 2),
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );
}
