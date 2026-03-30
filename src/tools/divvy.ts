import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DivvyClient } from '../divvy-client.js';

export function registerDivvyTools(server: McpServer, client: DivvyClient): void {
  server.tool(
    'divvy_list_budgets',
    'List all Divvy (BILL Spend & Expense) budgets',
    {},
    async () => {
      try {
        const result = await client.listBudgets();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
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
    async ({ startDate, endDate, budgetId, syncStatus, page, pageSize }) => {
      try {
        const result = await client.listTransactions({
          startDate,
          endDate,
          budgetId,
          syncStatus,
          page,
          pageSize,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'divvy_get_transaction',
    'Get a single Divvy transaction by ID. Returns full details including receipt status, custom fields, and sync status.',
    {
      transactionId: z.string().describe('Transaction ID'),
    },
    async ({ transactionId }) => {
      try {
        const result = await client.getTransaction(transactionId);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'divvy_upload_receipt',
    'Upload a receipt image and attach it to a Divvy transaction. Provide the transaction UUID and the receipt image as a base64-encoded string.',
    {
      transactionUuid: z.string().describe('Transaction UUID (the uuid field, not the id field)'),
      imageBase64: z.string().describe('Base64-encoded receipt image (JPEG or PNG)'),
      contentType: z.string().optional().describe('Image MIME type (default: image/jpeg)'),
    },
    async ({ transactionUuid, imageBase64, contentType }) => {
      try {
        const mime = contentType || 'image/jpeg';
        const imageData = Buffer.from(imageBase64, 'base64');

        // Step 1: Get pre-signed upload URL
        const { uploadUrl, fileId } = await client.getReceiptUploadUrl();

        // Step 2: Upload the image
        await client.uploadReceiptFile(uploadUrl, imageData, mime);

        // Step 3: Link to transaction
        const result = await client.attachReceiptToTransaction(transactionUuid, fileId);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, fileId, result }, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'divvy_list_cards',
    'List all Divvy (BILL Spend & Expense) virtual and physical cards',
    {},
    async () => {
      try {
        const result = await client.listCards();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'divvy_list_members',
    'List all Divvy (BILL Spend & Expense) team members',
    {},
    async () => {
      try {
        const result = await client.listMembers();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );
}
