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
    "Get a company-wide TransactionList report for a date range, optionally filtered by reconcile status. NOTE: QBO silently ignores this report's account filter, so this returns ALL accounts — to get transactions for a single account (e.g. for reconciliation) use qbo_reconcile_worksheet or qbo_cleared_transactions, which filter by account client-side.",
    {
      startDate: z.string().describe("Start date YYYY-MM-DD"),
      endDate: z.string().describe("End date YYYY-MM-DD"),
      cleared: z
        .enum(["Reconciled", "Cleared", "Uncleared"])
        .optional()
        .describe("Filter by reconcile status. For a per-account reconcile worksheet use qbo_reconcile_worksheet instead."),
    },
    async ({ startDate, endDate, cleared }) => {
      try {
        const params: Record<string, string> = {
          start_date: startDate,
          end_date: endDate,
        };
        if (cleared) params.cleared = cleared;
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
