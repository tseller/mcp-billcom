import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  QboClient,
  QboError,
  CLASS_LEDGER_COLUMNS,
  parseClassLedger,
  parseProfitAndLossByClass,
  type AccountingMethod,
  type ClassLedgerTxn,
} from "../qbo-client.js";
import { MAX_RESULT_CHARS, packRows, compact, tooBig } from "../result-size.js";

function err(e: unknown) {
  const msg = e instanceof QboError ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

/**
 * Class-aware reporting.
 *
 * Three hard QBO facts shape every tool in this file, all verified live against
 * the AYSO company:
 *
 *  - **TransactionList cannot show a class.** It silently drops the
 *    `klass_name` column — behaving identically to a deliberately bogus column
 *    name used as a control. The same token *does* render a real `Class` column
 *    on GeneralLedger and ProfitAndLossDetail, so the class-aware transaction
 *    listing is built on **GeneralLedger**: the only report that returns both
 *    the posting Account and the Class. (`qbo_transaction_report` is therefore
 *    untouched by class work.)
 *
 *  - **The class filter param is `class`, not `classid`.** `classid` is
 *    silently ignored. `class` is honoured *and* echoed back as `Header.Class`,
 *    which `QboClient.classReport` asserts — so a dropped filter can never be
 *    mistaken for a real answer (the mistake the ignored `account` param on
 *    TransactionList already taught this codebase once).
 *
 *  - **Accounting basis matters here.** This company's own default is **Cash**,
 *    which would report May/June registration revenue in the month the cash
 *    landed and defeat the deferred-revenue plan. These tools default to
 *    **Accrual** and always state the basis QBO actually used.
 *
 * Result size goes through the shared discipline in `result-size.ts`: a class
 * ledger grows with its date range exactly like a TransactionList does (~56
 * rows for a single live month), so it pages rather than trusting the range to
 * stay short.
 */

const ACCOUNTING_METHOD_DESC =
  "Cash or Accrual. Defaults to Accrual so deferred revenue lands in the season it belongs to — note this company's QBO web UI default is Cash, so numbers here can differ from the UI on purpose. The basis actually used is reported back.";

/** A ledger row trimmed to what a treasurer reads. Blank cells are dropped rather than sent as "". */
function slimRow(t: ClassLedgerTxn) {
  const row: Record<string, string | number | null> = { date: t.date, type: t.type, amount: t.amount };
  if (t.id) row.id = t.id;
  if (t.docNumber) row.num = t.docNumber;
  if (t.name) row.name = t.name;
  if (t.memo) row.memo = t.memo;
  if (t.account) row.account = t.account;
  if (t.accountId) row.accountId = t.accountId;
  row.class = t.className || null;
  return row;
}

export interface ClassTransactionsArgs {
  startDate: string;
  endDate: string;
  untaggedOnly?: boolean;
  accountNameContains?: string;
  offset?: number;
  limit?: number;
  requestedBasis: AccountingMethod;
}

/**
 * Turn a raw GeneralLedger report into one page of the tool's response. Pure,
 * so the filtering, paging and size behaviour is testable without QBO.
 */
export function buildClassTransactions(
  report: unknown,
  args: ClassTransactionsArgs,
): Record<string, unknown> {
  const parsed = parseClassLedger(report);

  let matched = parsed.transactions;
  if (args.untaggedOnly) matched = matched.filter((t) => !t.className.trim());
  if (args.accountNameContains) {
    const needle = args.accountNameContains.toLowerCase();
    matched = matched.filter((t) => t.account.toLowerCase().includes(needle));
  }

  const rows = matched.map(slimRow);
  const page = packRows(rows, args.offset ?? 0, args.limit);
  const untagged = parsed.transactions.filter((t) => !t.className.trim()).length;

  return {
    report: "GeneralLedger (class-aware)",
    startDate: args.startDate,
    endDate: args.endDate,
    accountingBasis: parsed.basis || args.requestedBasis,
    classFilterApplied: parsed.classFilterEcho ?? null,
    rowsInPeriod: parsed.transactions.length,
    untaggedInPeriod: untagged,
    rowCount: rows.length,
    total: Math.round(matched.reduce((s, t) => s + t.amount, 0) * 100) / 100,
    offset: page.offset,
    returned: page.rows.length,
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

export function registerQboClassReportTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_class_transactions",
    "List transactions with their Class over a date range — the class-aware transaction report. " +
      "Built on the GeneralLedger report because QuickBooks' TransactionList report cannot return a class column at all. " +
      "Set untaggedOnly to get every transaction still missing a class: that is the re-tagging worklist, and each row carries the QBO transaction id and type that qbo_set_transaction_class needs. " +
      "Long ranges are paged automatically: when `hasMore` is true, call again with `offset: nextOffset`.",
    {
      startDate: z.string().describe("Start date YYYY-MM-DD"),
      endDate: z.string().describe("End date YYYY-MM-DD"),
      classIds: z
        .array(z.string())
        .optional()
        .describe("Only these class ids (from qbo_list_classes). Verified applied via QBO's own filter echo."),
      untaggedOnly: z
        .boolean()
        .optional()
        .describe("Return only rows with no class — the re-tagging worklist (default false)"),
      accountNameContains: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on the posting account (applied client-side)"),
      accountingMethod: z.enum(["Cash", "Accrual"]).optional().describe(ACCOUNTING_METHOD_DESC),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Row offset for paging (default 0). Use the `nextOffset` from a previous call."),
      limit: z.number().int().min(1).optional().describe("Max rows to return in this page"),
    },
    async ({
      startDate,
      endDate,
      classIds,
      untaggedOnly,
      accountNameContains,
      accountingMethod,
      offset,
      limit,
    }) => {
      try {
        if (untaggedOnly && classIds?.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: untaggedOnly and classIds are contradictory — untagged rows belong to no class. Pass one or the other.",
              },
            ],
            isError: true,
          };
        }

        const requestedBasis: AccountingMethod = accountingMethod ?? "Accrual";
        const report = await client.classReport("GeneralLedger", {
          startDate,
          endDate,
          classIds,
          accountingMethod: requestedBasis,
          columns: CLASS_LEDGER_COLUMNS,
        });

        const body = buildClassTransactions(report, {
          startDate,
          endDate,
          untaggedOnly,
          accountNameContains,
          offset,
          limit,
          requestedBasis,
        });
        return { content: [{ type: "text", text: compact(body) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_profit_loss_by_class",
    "Profit & Loss broken out by Class — one money column per season plus a 'Not Specified' column for everything still untagged. That untagged column doubles as the progress meter for class tagging. Optionally filter to specific classes.",
    {
      startDate: z.string().describe("Start date YYYY-MM-DD"),
      endDate: z.string().describe("End date YYYY-MM-DD"),
      classIds: z.array(z.string()).optional().describe("Only these class ids (from qbo_list_classes)"),
      accountingMethod: z.enum(["Cash", "Accrual"]).optional().describe(ACCOUNTING_METHOD_DESC),
      format: z
        .enum(["rows", "raw"])
        .optional()
        .describe("'rows' (default) returns flattened account rows; 'raw' returns QBO's nested report JSON"),
    },
    async ({ startDate, endDate, classIds, accountingMethod, format }) => {
      try {
        const requestedBasis: AccountingMethod = accountingMethod ?? "Accrual";
        const report = await client.classReport("ProfitAndLoss", {
          startDate,
          endDate,
          classIds,
          accountingMethod: requestedBasis,
          summarizeColumnBy: "Classes",
        });

        if (format === "raw") {
          const text = compact(report);
          if (text.length > MAX_RESULT_CHARS) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: ${tooBig("The raw P&L-by-class report", `${startDate}..${endDate}`, text.length)}`,
                },
              ],
              isError: true,
            };
          }
          return { content: [{ type: "text", text }] };
        }

        const parsed = parseProfitAndLossByClass(report);
        const untaggedColumn = parsed.columns.find((c) => c.isUntagged);
        const body = {
          report: "ProfitAndLoss by class",
          startDate,
          endDate,
          accountingBasis: parsed.basis || requestedBasis,
          summarizedBy: parsed.summarizedBy,
          classFilterApplied: classIds?.length ? classIds.join(",") : null,
          columns: parsed.columns.map((c) => ({
            title: c.title,
            classId: c.classId ?? null,
            isUntagged: c.isUntagged,
            isTotal: c.isTotal,
          })),
          untaggedColumn: untaggedColumn?.title ?? null,
          rows: parsed.rows,
        };
        return { content: [{ type: "text", text: compact(body) }] };
      } catch (e) {
        return err(e);
      }
    },
  );
}
