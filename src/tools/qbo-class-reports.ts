import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  QboClient,
  QboError,
  CLASS_LEDGER_COLUMNS,
  parseClassLedger,
  parseProfitAndLossByClass,
  type AccountingMethod,
} from "../qbo-client.js";

function err(e: unknown) {
  const msg = e instanceof QboError ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

/**
 * Class-aware reporting.
 *
 * Two hard QBO facts shape every tool in this file, both verified live against
 * the AYSO company:
 *
 *  - **TransactionList cannot show a class.** It silently drops the `klass_name`
 *    column — behaving identically to a deliberately bogus column name used as
 *    a control. The same token *does* render a real `Class` column on
 *    GeneralLedger and ProfitAndLossDetail, so the class-aware transaction
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
 * Accounting basis: this company's own default is **Cash**, which would report
 * May/June registration revenue in the month the cash landed and defeat the
 * deferred-revenue plan. These tools therefore default to **Accrual** and
 * always state the basis QBO actually used in the response.
 */

const ACCOUNTING_METHOD_DESC =
  "Cash or Accrual. Defaults to Accrual so deferred revenue lands in the season it belongs to — note this company's QBO web UI default is Cash, so numbers here can differ from the UI on purpose. The basis actually used is reported back.";

export function registerQboClassReportTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_class_transactions",
    "List transactions with their Class over a date range — the class-aware transaction report. Built on the GeneralLedger report because QuickBooks' TransactionList report cannot return a class column at all. Filter to specific classes, or set untaggedOnly to find every transaction still missing a class (the worklist for bulk re-tagging). Returns date, type, doc number, name, memo, posting account, class and signed amount.",
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
    },
    async ({ startDate, endDate, classIds, untaggedOnly, accountNameContains, accountingMethod }) => {
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

        const basis: AccountingMethod = accountingMethod ?? "Accrual";
        const report = await client.classReport("GeneralLedger", {
          startDate,
          endDate,
          classIds,
          accountingMethod: basis,
          columns: CLASS_LEDGER_COLUMNS,
        });

        const parsed = parseClassLedger(report);
        let rows = parsed.transactions;
        if (untaggedOnly) rows = rows.filter((t) => !t.className.trim());
        if (accountNameContains) {
          const needle = accountNameContains.toLowerCase();
          rows = rows.filter((t) => t.account.toLowerCase().includes(needle));
        }

        const untagged = parsed.transactions.filter((t) => !t.className.trim()).length;
        const body = {
          period: { startDate, endDate },
          accountingBasis: parsed.basis || basis,
          classFilterApplied: parsed.classFilterEcho ?? null,
          totals: {
            rowsReturned: rows.length,
            rowsInPeriod: parsed.transactions.length,
            untaggedInPeriod: untagged,
            amount: Math.round(rows.reduce((s, t) => s + t.amount, 0) * 100) / 100,
          },
          transactions: rows.map((t) => ({
            date: t.date,
            type: t.type,
            docNumber: t.docNumber,
            name: t.name,
            memo: t.memo,
            account: t.account,
            class: t.className || null,
            amount: t.amount,
          })),
        };
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
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
      raw: z
        .boolean()
        .optional()
        .describe("Return QBO's raw report JSON instead of the flattened rows (default false)"),
    },
    async ({ startDate, endDate, classIds, accountingMethod, raw }) => {
      try {
        const basis: AccountingMethod = accountingMethod ?? "Accrual";
        const report = await client.classReport("ProfitAndLoss", {
          startDate,
          endDate,
          classIds,
          accountingMethod: basis,
          summarizeColumnBy: "Classes",
        });
        if (raw) {
          return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
        }

        const parsed = parseProfitAndLossByClass(report);
        const untaggedColumn = parsed.columns.find((c) => c.isUntagged);
        const body = {
          period: { startDate, endDate },
          accountingBasis: parsed.basis || basis,
          summarizedBy: parsed.summarizedBy,
          columns: parsed.columns.map((c) => ({
            title: c.title,
            classId: c.classId ?? null,
            isUntagged: c.isUntagged,
            isTotal: c.isTotal,
          })),
          untaggedColumn: untaggedColumn?.title ?? null,
          rows: parsed.rows,
        };
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );
}
