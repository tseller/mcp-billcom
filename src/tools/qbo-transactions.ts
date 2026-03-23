import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QboClient, QboError } from "../qbo-client.js";

function err(e: unknown) {
  const msg = e instanceof QboError ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerQboTransactionTools(server: McpServer, client: QboClient) {
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
    "Update a purchase transaction — categorize it by setting the expense account, vendor, and/or memo. You must include Id and SyncToken (from get_purchase). Use sparse update: only include fields you want to change plus Id, SyncToken, and sparse=true.",
    {
      id: z.string().describe("Purchase ID"),
      syncToken: z.string().describe("SyncToken from the current version (required for optimistic locking)"),
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
        const update: Record<string, unknown> = {
          Id: id,
          SyncToken: syncToken,
          sparse: true,
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
}
