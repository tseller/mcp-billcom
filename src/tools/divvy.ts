import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DivvyClient } from '../divvy-client.js';
import { runTool } from '../tool-logging.js';
import { sniffContentType } from '../mime.js';

/** One-line-per-transaction shape for compact listings. */
function compactTransaction(tx: Record<string, unknown>): Record<string, unknown> {
  const customFields = Array.isArray(tx.customFields)
    ? (tx.customFields as Array<{ name?: string; selectedValues?: unknown[]; note?: string }>)
    : [];
  const fields: Record<string, string> = {};
  for (const f of customFields) {
    if (!f.name) continue;
    const selected = (f.selectedValues ?? [])
      .map((v) => {
        if (typeof v === 'string') return v;
        const o = v as { value?: unknown; label?: unknown; name?: unknown };
        return String(o.value ?? o.label ?? o.name ?? '');
      })
      .filter(Boolean);
    const value = selected.length > 0 ? selected.join(', ') : (f.note ?? '').trim();
    if (value) fields[f.name] = value;
  }
  return {
    id: tx.id,
    uuid: tx.uuid,
    date: String(tx.occurredTime ?? '').slice(0, 10),
    status: tx.status,
    user: tx.userName,
    merchant: tx.merchantName,
    amount: tx.amount,
    receiptStatus: tx.receiptStatus,
    syncStatus: tx.syncStatus,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

export function registerDivvyTools(server: McpServer, client: DivvyClient): void {
  server.tool(
    'divvy_list_budgets',
    'List all Divvy (BILL Spend & Expense) budgets',
    {},
    (args) => runTool('divvy_list_budgets', args, () => client.listBudgets()),
  );

  server.tool(
    'divvy_list_transactions',
    'List Divvy (BILL Spend & Expense) transactions. Each transaction includes: userName (cardholder), merchantName, amount, receiptRequired, syncStatus (PENDING/SYNCED/NOT_SYNCED), and custom fields like NAP CODES and Notes. Prefer compact:true unless you need raw fields — it returns one small row per transaction instead of ~2KB of scaffolding each. Use status:"DECLINED" to surface card declines.',
    {
      startDate: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
      endDate: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
      budgetId: z.string().optional().describe('Filter by budget ID'),
      syncStatus: z.string().optional().describe('Filter by sync status: PENDING, SYNCED, ERROR, MANUAL_SYNCED, NOT_SYNCED'),
      status: z
        .string()
        .optional()
        .describe(
          'Filter by transaction status, e.g. CLEARED or DECLINED. Applied per page after fetch, so a page can return fewer rows than pageSize while nextPage is still set.',
        ),
      compact: z
        .boolean()
        .optional()
        .describe(
          'Return one small row per transaction: id, uuid, date, status, cardholder, merchant, amount, receiptStatus, syncStatus, and filled custom-field values (NAP CODES, Notes).',
        ),
      page: z.string().optional().describe('Page cursor for pagination (from nextPage in previous response)'),
      pageSize: z.string().optional().describe('Number of results per page'),
    },
    (args) =>
      runTool('divvy_list_transactions', args, async ({ status, compact, ...query }) => {
        const raw = (await client.listTransactions(query)) as {
          results?: Array<Record<string, unknown>>;
          nextPage?: string;
        };
        let results = Array.isArray(raw.results) ? raw.results : [];
        if (status) {
          results = results.filter(
            (tx) => String(tx.status ?? '').toUpperCase() === status.toUpperCase(),
          );
        }
        if (!compact) {
          return status ? { ...raw, results, statusFilter: status } : raw;
        }
        return {
          count: results.length,
          transactions: results.map(compactTransaction),
          nextPage: raw.nextPage,
          ...(status ? { statusFilter: status } : {}),
        };
      }),
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
    'List the available option values for a Divvy custom field (e.g. the list of NAP codes). Returns each value\'s ID and label. Paginated — use page (from nextPage in the previous response) and pageSize to walk the full list.',
    {
      customFieldId: z.string().describe('Custom field ID from divvy_list_custom_fields'),
      page: z.string().optional().describe('Page cursor from the previous response\'s nextPage'),
      pageSize: z.string().optional().describe('Results per page (default per BILL API)'),
    },
    (args) =>
      runTool('divvy_list_custom_field_values', args, ({ customFieldId, page, pageSize }) =>
        client.listCustomFieldValues(customFieldId, { page, pageSize }),
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
