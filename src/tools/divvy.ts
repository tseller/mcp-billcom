import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DivvyClient } from '../divvy-client.js';
import { runTool } from '../tool-logging.js';

/** Sniff common receipt formats from the first bytes of a decoded buffer. */
function sniffContentType(buf: Buffer): string | undefined {
  if (buf.length < 4) return undefined;
  // PDF: "%PDF"
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // GIF: "GIF8"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  // WebP: "RIFF"...."WEBP"
  if (buf.length >= 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') {
    return 'image/webp';
  }
  // HEIC/HEIF: "ftyp" at offset 4, brand at 8
  if (buf.length >= 12 && buf.subarray(4, 8).toString() === 'ftyp') {
    const brand = buf.subarray(8, 12).toString();
    if (['heic', 'heix', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return undefined;
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
    'List Divvy (BILL Spend & Expense) transactions. Each transaction includes: userName (cardholder), merchantName, amount, receiptRequired, syncStatus (PENDING/SYNCED/NOT_SYNCED), and custom fields like NAP CODES and Notes.',
    {
      startDate: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
      endDate: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
      budgetId: z.string().optional().describe('Filter by budget ID'),
      syncStatus: z.string().optional().describe('Filter by sync status: PENDING, SYNCED, ERROR, MANUAL_SYNCED, NOT_SYNCED'),
      page: z.string().optional().describe('Page cursor for pagination (from nextPage in previous response)'),
      pageSize: z.string().optional().describe('Number of results per page'),
    },
    (args) => runTool('divvy_list_transactions', args, (a) => client.listTransactions(a)),
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
}
