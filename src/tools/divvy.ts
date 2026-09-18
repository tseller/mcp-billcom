import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DivvyClient } from '../divvy-client.js';
import { runTool } from '../tool-logging.js';
import { sniffContentType } from '../mime.js';
import { buildCursorList, slimTransaction } from '../divvy-rows.js';
import { FilterCheck } from '../divvy-filters.js';
import { assembleBudgets } from '../divvy-budgets.js';
import {
  BILL_MAX_PAGE_SIZE,
  billPagingLimits,
  walkBillPages,
  type BillListName,
} from '../divvy-paging.js';
import { compact, rowBudget } from '../result-size.js';
import { CURSOR_PAGING_NARROWING, cursorNarrowing, cursorPaging } from './list-paging.js';

/**
 * How many rows the caller wants back, when they did not say. One BILL page's
 * worth — so the ordinary call is still exactly one call to BILL.
 */
const defaultPageSize = (list: BillListName, asked: unknown): number =>
  Number(asked) > 0 ? Number(asked) : BILL_MAX_PAGE_SIZE[list];

export function registerDivvyTools(server: McpServer, client: DivvyClient): void {
  server.tool(
    'divvy_list_budgets',
    'List Divvy (BILL Spend & Expense) budgets — one row each with the name, both spellings of the id that `divvy_list_transactions {"budgetId": …}` accepts, whether it is retired, and the current period\'s limit and spend. ' +
      "Use this to resolve a budget name to an id. " +
      "BILL's own budget-list endpoint does not return every budget on these books (issue #34), so the listing is assembled: budgets it does return, plus every budget named by a card or a recent transaction, each read back by id to confirm it exists. " +
      '`sources` states what each one contributed, and `seenOn` on a row says where that budget was named — so a short answer reads as short rather than as "there are none".',
    {},
    (args) => runTool('divvy_list_budgets', args, () => assembleBudgets(client)),
  );

  server.tool(
    'divvy_list_transactions',
    'List Divvy (BILL Spend & Expense) transactions. ' +
      'Returns one flattened row per transaction — date, cardholder, merchant, amount, status, receipt and accounting-sync status, both ids, and the filled custom-field values (NAP CODES, Notes) — plus `pageTotal` for the page. ' +
      `Paged: when \`hasMore\` is true, call again with \`page: nextPage\`. \`pageSize\` is rows, not BILL pages — BILL's own page holds ${BILL_MAX_PAGE_SIZE.transactions}, and a bigger ask is served by walking its cursor here rather than failing. ` +
      'Every filter is checked against the rows that come back, and `filtering` states per filter how it was enforced — so a filter the backend does not honor drops the rows here and says so, rather than quietly returning the wrong ones. ' +
      '`billPages` says how many BILL pages one result consumed — more than one when the ask was bigger than a BILL page, or when a filter applied here dropped rows and the page was refilled. ' +
      'Use status:"DECLINED" to surface card declines. ' +
      '`format: "raw"` returns BILL\'s full objects (~2KB of scaffolding each, and rejected outright if the page exceeds the size budget); for one transaction in full, use divvy_get_transaction.',
    {
      startDate: z
        .string()
        .optional()
        .describe('Only transactions occurring on or after this date (YYYY-MM-DD).'),
      endDate: z
        .string()
        .optional()
        .describe('Only transactions occurring on or before this date (YYYY-MM-DD), inclusive.'),
      budgetId: z
        .string()
        .optional()
        .describe('Filter by budget — either the `budgetId` or the `bgt_…` uuid from a row.'),
      syncStatus: z
        .string()
        .optional()
        .describe('Filter by accounting sync status: PENDING, SYNCED, ERROR, MANUAL_SYNCED, NOT_SYNCED'),
      status: z
        .string()
        .optional()
        .describe(
          'Filter by transaction status, e.g. CLEARED or DECLINED. BILL has no server-side filter for this one, so it is applied here after fetch.',
        ),
      ...cursorPaging(billPagingLimits('transactions')),
    },
    (args) =>
      runTool(
        'divvy_list_transactions',
        args,
        async ({ format, page, pageSize, ...filters }) => {
          const check = new FilterCheck(filters);

          // One BILL call in the ordinary case — the walk stops as soon as it
          // has the rows asked for. It runs longer for two reasons, and they
          // are now the same loop: the caller asked for more rows than one
          // BILL page holds (BILL caps `max` at 50, issue #24), or a filter
          // BILL did not honor emptied a page and it is refilled from the next
          // one rather than coming back full of holes.
          const walked = await walkBillPages<Record<string, unknown>>({
            list: 'transactions',
            target: defaultPageSize('transactions', pageSize),
            page,
            fetch: (p) => client.listTransactions({ filters: check.billParam, ...p }),
            keep: (rows) => check.keep(rows),
            // Measured as the tool will emit it: a flattened row is a sixth of
            // the raw object, so measuring the wrong one would stop the walk
            // five pages early.
            measure: (tx) => compact(format === 'raw' ? tx : slimTransaction(tx)).length,
            budgetChars: rowBudget(),
          });

          // BILL's full objects — the size budget in runTool is what keeps
          // this honest, so there is nothing to guard here.
          if (format === 'raw') {
            return {
              ...walked.last,
              results: walked.rows,
              nextPage: walked.nextPage,
              ...(check.any ? { filtering: check.report() } : {}),
            };
          }
          return buildCursorList({
            entity: 'Transaction',
            key: 'transactions',
            rows: walked.rows.map(slimTransaction),
            nextPage: walked.nextPage,
            filters,
            filtering: check.any ? check.report() : undefined,
            billPages: walked.billPages,
          });
        },
        { narrowing: CURSOR_PAGING_NARROWING },
      ),
  );

  server.tool(
    'divvy_get_transaction',
    'Get a single Divvy transaction by ID. Returns full details including receipt status, custom fields, and sync status.',
    {
      transactionId: z.string().describe('Transaction ID'),
    },
    (args) =>
      runTool('divvy_get_transaction', args, ({ transactionId }) =>
        client.getTransaction(transactionId),
      ),
  );

  server.tool(
    'divvy_upload_receipt',
    'Upload a receipt and attach it to a Divvy transaction. Accepts JPEG, PNG, GIF, WebP, HEIC, and PDF — the MIME type is auto-detected from the file bytes, so you generally do not need to specify contentType.',
    {
      transactionUuid: z.string().describe('Transaction UUID (the uuid field, not the id field)'),
      imageBase64: z.string().describe('Base64-encoded receipt bytes (image or PDF)'),
      contentType: z.string().optional().describe('Optional MIME override. Only set this if the auto-detected type is wrong.'),
    },
    (args) =>
      runTool('divvy_upload_receipt', args, async ({ transactionUuid, imageBase64, contentType }) => {
        const imageData = Buffer.from(imageBase64, 'base64');
        const sniffed = sniffContentType(imageData);
        const mime = contentType || sniffed || 'application/octet-stream';
        if (contentType && sniffed && contentType !== sniffed) {
          console.error(
            `[tool] divvy_upload_receipt warn=mime_mismatch override=${contentType} sniffed=${sniffed}`,
          );
        }
        // Cheap pre-check: BILL refuses receipt-attach on locked (settled/
        // reconciled) transactions and returns an opaque 500 "Please retry".
        // Detect it *before* uploading bytes to S3, so we neither orphan an
        // S3 object nor surface BILL's misleading error. (issue #2)
        console.error(
          `[tool] divvy_upload_receipt step=lockCheck transactionUuid=${transactionUuid}`,
        );
        const tx = (await client.getTransaction(transactionUuid)) as { isLocked?: unknown };
        if (tx && tx.isLocked === true) {
          console.error(
            `[tool] divvy_upload_receipt blocked=locked transactionUuid=${transactionUuid}`,
          );
          throw new Error(
            `Transaction ${transactionUuid} is locked/reconciled in BILL; receipts can't be attached via the API ` +
              `(BILL returns an opaque 500 "Please retry"). Attach the receipt in the BILL Spend & Expense app/UI, ` +
              `or unlock the transaction first. Tip: attach receipts while a transaction is still fresh/unlocked — ` +
              `once settled and locked, attach must happen in the BILL UI.`,
          );
        }
        console.error(
          `[tool] divvy_upload_receipt step=getUrl transactionUuid=${transactionUuid} mime=${mime} sniffed=${sniffed ?? 'unknown'} override=${contentType ?? 'none'} bytes=${imageData.length}`,
        );
        const { url } = await client.getReceiptUploadUrl();
        console.error(`[tool] divvy_upload_receipt step=put urlHost=${new URL(url).host}`);
        await client.uploadReceiptFile(url, imageData, mime);
        console.error(`[tool] divvy_upload_receipt step=attach`);
        const result = await client.attachReceiptToTransaction(transactionUuid, url);
        return { success: true, result, detectedMime: sniffed };
      }),
  );

  server.tool(
    'divvy_list_custom_fields',
    'List all Divvy custom field definitions (e.g. NAP CODES, Notes). Returns each field\'s customFieldId, name, and type.',
    {},
    (args) => runTool('divvy_list_custom_fields', args, () => client.listCustomFields()),
  );

  server.tool(
    'divvy_list_custom_field_values',
    'List the available option values for a Divvy custom field (e.g. the list of NAP codes). Returns each value\'s ID and label. ' +
      `Paged: \`pageSize\` is rows (default ${BILL_MAX_PAGE_SIZE.customFieldValues}, BILL's own page maximum), and when \`nextPage\` comes back, call again with \`page: nextPage\`.`,
    {
      customFieldId: z.string().describe('Custom field ID from divvy_list_custom_fields'),
      ...cursorPaging(billPagingLimits('customFieldValues'), { format: false }),
    },
    (args) =>
      runTool(
        'divvy_list_custom_field_values',
        args,
        // This list could not page before: it spelled BILL's parameters `page`
        // and `page_size`, which BILL answers 200 to and ignores, so it
        // returned its first 20 values whatever was asked (see
        // src/divvy-paging.ts). The walk is the same one the transaction list
        // uses, so `pageSize` means rows here too.
        async ({ customFieldId, page, pageSize }) => {
          const walked = await walkBillPages<Record<string, unknown>>({
            list: 'customFieldValues',
            target: defaultPageSize('customFieldValues', pageSize),
            page,
            fetch: (p) => client.listCustomFieldValues(customFieldId, p),
            measure: (v) => compact(v).length,
            budgetChars: rowBudget(),
          });
          return { ...walked.last, results: walked.rows, nextPage: walked.nextPage };
        },
        { narrowing: cursorNarrowing({ format: false }) },
      ),
  );

  server.tool(
    'divvy_update_transaction_custom_fields',
    'Assign custom field values to a Divvy transaction (e.g. set the NAP CODE). Use divvy_list_custom_fields + divvy_list_custom_field_values first to resolve IDs. For SELECT-type fields pass selectedValues (value IDs); for NOTE-type fields pass note. Clearing selectedValues to [] clears the field.',
    {
      transactionUuid: z.string().describe('Transaction UUID (the uuid field, not the id field)'),
      customFields: z
        .array(
          z.object({
            customFieldId: z.string(),
            selectedValues: z.array(z.string()).optional(),
            note: z.string().optional(),
          }),
        )
        .min(1)
        .describe('One entry per custom field to set'),
    },
    (args) =>
      runTool('divvy_update_transaction_custom_fields', args, ({ transactionUuid, customFields }) =>
        client.updateTransactionCustomFields(transactionUuid, customFields),
      ),
  );

  server.tool(
    'divvy_list_cards',
    'List all Divvy (BILL Spend & Expense) virtual and physical cards',
    {},
    (args) => runTool('divvy_list_cards', args, () => client.listCards()),
  );

  server.tool(
    'divvy_list_members',
    'List all Divvy (BILL Spend & Expense) team members',
    {},
    (args) => runTool('divvy_list_members', args, () => client.listMembers()),
  );

  server.tool(
    'divvy_list_pending_action',
    'List Divvy transactions that need action, in two buckets: (1) pendingFields — required NAP CODES / Notes / receipt are missing, the cardholder or the treasurer can fill them; (2) pendingReview — every required field is filled but a reviewer is still WAITING to approve. Each row carries a `blockers` array naming exactly what is missing, a `waitingReviewers` list for items in the second bucket, and a `reviewUrl` pointing to the transaction in BILL S&E (Tim can tap to open it directly — render this as a Markdown link in any summary you send him). Use this instead of divvy_list_transactions when triaging open work.',
    {
      reviewerUuid: z
        .string()
        .optional()
        .describe(
          'If set, only return pendingReview rows where this userUuid is the WAITING reviewer. Look it up via divvy_list_members.',
        ),
      since: z
        .string()
        .optional()
        .describe('Optional lower bound on transaction date (YYYY-MM-DD). Defaults to all history.'),
    },
    (args) =>
      runTool('divvy_list_pending_action', args, ({ reviewerUuid, since }) =>
        client.listPendingAction({ reviewerUuid, since }),
      ),
  );
}
