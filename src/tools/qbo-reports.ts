import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QboClient, QboError } from "../qbo-client.js";

function err(e: unknown) {
  const msg = e instanceof QboError ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerQboReportTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_transaction_report",
    "Get a transaction list report for an account and date range. Useful for reconciliation — shows all transactions across types for a given account.",
    {
      startDate: z.string().describe("Start date YYYY-MM-DD"),
      endDate: z.string().describe("End date YYYY-MM-DD"),
      accountId: z.string().optional().describe("Filter by account ID"),
    },
    async ({ startDate, endDate, accountId }) => {
      try {
        const params: Record<string, string> = {
          start_date: startDate,
          end_date: endDate,
        };
        if (accountId) params.account = accountId;
        const result = await client.report("TransactionList", params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_profit_loss",
    "Get a Profit & Loss report for a date range. Shows income and expenses by category.",
    {
      startDate: z.string().describe("Start date YYYY-MM-DD"),
      endDate: z.string().describe("End date YYYY-MM-DD"),
    },
    async ({ startDate, endDate }) => {
      try {
        const result = await client.report("ProfitAndLoss", {
          start_date: startDate,
          end_date: endDate,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_balance_sheet",
    "Get a Balance Sheet report as of a given date.",
    {
      asOfDate: z.string().describe("As-of date YYYY-MM-DD"),
    },
    async ({ asOfDate }) => {
      try {
        const result = await client.report("BalanceSheet", {
          start_date: asOfDate,
          end_date: asOfDate,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );
}
