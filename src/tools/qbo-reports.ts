import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QboClient, QboError, parseTransactionList } from "../qbo-client.js";
import { MAX_RESULT_CHARS, packRows, compact, tooBig } from "../result-size.js";

function err(e: unknown) {
  const msg = e instanceof QboError ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

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
    async ({ startDate, endDate, cleared, offset, limit, format }) => {
      try {
        const report = await client.transactionList({ startDate, endDate, cleared });

        if (format === "raw") {
          const text = compact(report);
          if (text.length > MAX_RESULT_CHARS) {
            throw new QboError(tooBig("raw TransactionList", `${startDate}..${endDate}`, text.length), 200);
          }
          console.error(
            `[tool] qbo_transaction_report start=${startDate} end=${endDate} format=raw chars=${text.length}`,
          );
          return { content: [{ type: "text", text }] };
        }

        const result = buildTransactionReport(report, { startDate, endDate, cleared, offset, limit });
        const text = compact(result);
        console.error(
          `[tool] qbo_transaction_report start=${startDate} end=${endDate}${cleared ? ` cleared=${cleared}` : ""} rows=${result.rowCount} returned=${result.returned} offset=${result.offset} hasMore=${result.hasMore} chars=${text.length}`,
        );
        return { content: [{ type: "text", text }] };
      } catch (e) {
        console.error(`[tool] qbo_transaction_report FAILED start=${startDate} end=${endDate}: ${e instanceof Error ? e.message : String(e)}`);
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
        return { content: [{ type: "text", text: guardedText("ProfitAndLoss", `${startDate}..${endDate}`, result) }] };
      } catch (e) {
        console.error(`[tool] qbo_profit_loss FAILED ${startDate}..${endDate}: ${e instanceof Error ? e.message : String(e)}`);
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
        return { content: [{ type: "text", text: guardedText("BalanceSheet", asOfDate, result) }] };
      } catch (e) {
        console.error(`[tool] qbo_balance_sheet FAILED ${asOfDate}: ${e instanceof Error ? e.message : String(e)}`);
        return err(e);
      }
    },
  );
}

/**
 * Summary reports (P&L, Balance Sheet) are hierarchical, so there is nothing
 * sane to page — but they must still never hand the client a payload it will
 * reject. Over budget is a named error naming the size, not a mystery.
 */
function guardedText(report: string, range: string, result: unknown): string {
  const text = compact(result);
  if (text.length > MAX_RESULT_CHARS) {
    throw new QboError(tooBig(report, range, text.length), 200);
  }
  return text;
}
