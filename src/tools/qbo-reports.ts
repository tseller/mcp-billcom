import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QboClient, parseTransactionList } from "../qbo-client.js";
import { packRows } from "../result-size.js";
import { runTool } from "../tool-logging.js";
import { OFFSET_PAGING_NARROWING } from "./list-paging.js";

/**
 * A TransactionList row, trimmed to what a treasurer actually reads.
 * Empty cells are dropped rather than emitted as `""` — on real books a third
 * of the cells (Num, Memo) are blank, and every dropped key is payload the
 * client has to carry.
 */
function slimRow(t: ReturnType<typeof parseTransactionList>["transactions"][number]) {
  const row: Record<string, string | number> = { date: t.date, type: t.type, amount: t.amount };
  if (t.id) row.id = t.id;
  if (t.docNumber) row.num = t.docNumber;
  if (t.name) row.name = t.name;
  if (t.memo) row.memo = t.memo;
  if (t.account) row.account = t.account;
  if (t.accountId) row.accountId = t.accountId;
  if (t.split) row.split = t.split;
  return row;
}

export interface TransactionReportArgs {
  startDate: string;
  endDate: string;
  cleared?: "Reconciled" | "Cleared" | "Uncleared";
  offset?: number;
  limit?: number;
}

/**
 * Turn a raw TransactionList report into one page of the tool's response.
 * Pure, so the paging/size behaviour is testable against a large report
 * without going near QBO.
 */
export function buildTransactionReport(
  report: unknown,
  { startDate, endDate, cleared, offset, limit }: TransactionReportArgs,
): Record<string, unknown> {
  const { transactions, total } = parseTransactionList(report);
  const rows = transactions.map(slimRow);
  const page = packRows(rows, offset ?? 0, limit);
  const pageTotal =
    Math.round(
      page.rows.reduce((s, r) => s + (typeof r.amount === "number" ? r.amount : 0), 0) * 100,
    ) / 100;

  return {
    report: "TransactionList",
    startDate,
    endDate,
    ...(cleared ? { cleared } : {}),
    rowCount: rows.length,
    total,
    offset: page.offset,
    returned: page.rows.length,
    pageTotal,
    hasMore: page.hasMore,
    ...(page.hasMore
      ? {
          nextOffset: page.nextOffset,
          truncatedBy: page.truncatedBy,
          note: `Showing rows ${page.offset}-${page.offset + page.rows.length - 1} of ${rows.length}. Call again with offset: ${page.nextOffset} for the rest. \`total\` already covers the whole range.`,
        }
      : {}),
    rows: page.rows,
  };
}

export function registerQboReportTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_transaction_report",
    "Get a company-wide TransactionList report for a date range, optionally filtered by reconcile status. " +
      "Returns flattened rows (date, type, name, memo, account, split, amount, QBO ids) plus the signed total for the WHOLE range. " +
      "Long ranges are paged automatically: when `hasMore` is true, call again with `offset: nextOffset` to get the rest — no range is too long. " +
      "NOTE: QBO silently ignores this report's account filter, so this returns ALL accounts — to get transactions for a single account (e.g. for reconciliation) use qbo_reconcile_worksheet or qbo_cleared_transactions, which filter by account client-side.",
    {
      startDate: z.string().describe("Start date YYYY-MM-DD"),
      endDate: z.string().describe("End date YYYY-MM-DD"),
      cleared: z
        .enum(["Reconciled", "Cleared", "Uncleared"])
        .optional()
        .describe("Filter by reconcile status. For a per-account reconcile worksheet use qbo_reconcile_worksheet instead."),
      offset: z.number().int().min(0).optional().describe("Row offset for paging (default 0). Use the `nextOffset` from a previous call."),
      limit: z.number().int().min(1).optional().describe("Max rows to return in this page. The response is also capped by a size budget, whichever is smaller."),
      format: z
        .enum(["rows", "raw"])
        .optional()
        .describe("`rows` (default) returns flattened transaction rows. `raw` returns QBO's nested report JSON — much larger, and rejected outright if it exceeds the size budget."),
    },
    (args) =>
      runTool("qbo_transaction_report", args, async ({ startDate, endDate, cleared, offset, limit, format }) => {
        const report = await client.transactionList({ startDate, endDate, cleared });
        // `raw` is the whole nested report — the size budget in runTool is what
        // keeps it honest, so there is nothing to guard here.
        if (format === "raw") return report;
        return buildTransactionReport(report, { startDate, endDate, cleared, offset, limit });
      },
      { narrowing: OFFSET_PAGING_NARROWING },
      ),
  );

  server.tool(
    "qbo_profit_loss",
    "Get a Profit & Loss report for a date range. Shows income and expenses by category.",
    {
      startDate: z.string().describe("Start date YYYY-MM-DD"),
      endDate: z.string().describe("End date YYYY-MM-DD"),
    },
    (args) =>
      runTool("qbo_profit_loss", args, ({ startDate, endDate }) =>
        client.report("ProfitAndLoss", { start_date: startDate, end_date: endDate }),
      ),
  );

  server.tool(
    "qbo_balance_sheet",
    "Get a Balance Sheet report as of a given date.",
    {
      asOfDate: z.string().describe("As-of date YYYY-MM-DD"),
    },
    (args) =>
      runTool("qbo_balance_sheet", args, ({ asOfDate }) =>
        client.report("BalanceSheet", { start_date: asOfDate, end_date: asOfDate }),
      ),
  );
}
