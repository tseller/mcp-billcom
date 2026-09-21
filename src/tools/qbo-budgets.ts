import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { QboClient, parseProfitAndLossByClass, type AccountingMethod } from "../qbo-client.js";
import { buildBudgetVsActuals, type QboBudget } from "../budget-actuals.js";
import { packRows } from "../result-size.js";
import { runTool } from "../tool-logging.js";
import { OFFSET_PAGING_NARROWING } from "./list-paging.js";

const READ_ONLY_NOTE =
  "Budgets are READ-ONLY in the QuickBooks API — there is no create/update/delete, so a budget has to be built in the QuickBooks web UI first and can only be read back from here.";

const summarize = (b: QboBudget, includeDetail: boolean) => ({
  id: b.Id,
  name: b.Name,
  startDate: b.StartDate,
  endDate: b.EndDate,
  budgetType: b.BudgetType,
  budgetEntryType: b.BudgetEntryType,
  active: b.Active,
  detailRows: (b.BudgetDetail ?? []).length,
  classSubdivided: (b.BudgetDetail ?? []).some((d) => d.ClassRef?.value),
  detail: includeDetail
    ? (b.BudgetDetail ?? []).map((d) => ({
        budgetDate: d.BudgetDate,
        amount: d.Amount,
        accountId: d.AccountRef?.value,
        account: d.AccountRef?.name,
        classId: d.ClassRef?.value ?? null,
        class: d.ClassRef?.name ?? null,
      }))
    : undefined,
});

export function registerQboBudgetTools(server: McpServer, client: QboClient) {
  server.registerTool(
    "qbo_list_budgets",
    {
      description: `List QuickBooks budgets, optionally with their line detail (amount per account, per class, per period). ${READ_ONLY_NOTE}`,
      inputSchema: z.object({
      nameContains: z.string().optional().describe("Case-insensitive substring filter on the budget name"),
      includeInactive: z.boolean().optional().describe("Include inactive budgets (default false)"),
      includeDetail: z
        .boolean()
        .optional()
        .describe("Include every BudgetDetail row — account, class, period, amount (default false; can be long)"),
    }),
    },
    (args) =>
      runTool(
        "qbo_list_budgets",
        args,
        async ({ nameContains, includeInactive, includeDetail }) => {
          const result = (await client.listBudgets(includeInactive ?? false)) as {
          QueryResponse?: { Budget?: QboBudget[] };
        };
        let budgets = result.QueryResponse?.Budget ?? [];
        if (nameContains) {
          const needle = nameContains.toLowerCase();
          budgets = budgets.filter((b) => (b.Name ?? "").toLowerCase().includes(needle));
        }
          return {
            count: budgets.length,
            note:
              budgets.length === 0
                ? `No budgets exist in this company yet. ${READ_ONLY_NOTE}`
                : READ_ONLY_NOTE,
            budgets: budgets.map((b) => summarize(b, includeDetail ?? false)),
          };
        },
        {
          narrowing:
            "Call again without `includeDetail`, or narrow with `nameContains`.",
        },
      ),
  );

  server.registerTool(
    "qbo_budget_vs_actuals",
    {
      description: "Compare a budget to actual income and expenses, broken out by class (season). QuickBooks has no budget-vs-actuals report in its API, so this is computed: the budget's own detail rows (account × class × period) joined against a Profit & Loss summarised by class for the same window. Untagged actuals are reported with a null class so they can't quietly disappear from the comparison.",
      inputSchema: z.object({
      budgetId: z.string().describe("Budget id (from qbo_list_budgets)"),
      startDate: z
        .string()
        .optional()
        .describe("Start date YYYY-MM-DD. Defaults to the budget's own start date."),
      endDate: z
        .string()
        .optional()
        .describe("End date YYYY-MM-DD. Defaults to the budget's own end date."),
      classIds: z.array(z.string()).optional().describe("Restrict the actuals to these class ids"),
      accountingMethod: z
        .enum(["Cash", "Accrual"])
        .optional()
        .describe(
          "Cash or Accrual. Defaults to Accrual so deferred revenue lands in the season it belongs to; this company's QBO web UI default is Cash, so numbers can differ from the UI on purpose.",
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Row offset for paging (default 0). Use the `nextOffset` from a previous call."),
      limit: z.number().int().min(1).optional().describe("Max rows to return in this page"),
    }),
    },
    (args) =>
      runTool(
        "qbo_budget_vs_actuals",
        args,
        async ({ budgetId, startDate, endDate, classIds, accountingMethod, offset, limit }) => {
          const found = (await client.getBudget(budgetId)) as {
          QueryResponse?: { Budget?: QboBudget[] };
        };
          const budget = found.QueryResponse?.Budget?.[0];
          if (!budget) {
            throw new Error(
              `budget ${budgetId} not found. ${READ_ONLY_NOTE} List what exists with qbo_list_budgets.`,
            );
          }

          const from = startDate ?? budget.StartDate;
          const to = endDate ?? budget.EndDate;
          if (!from || !to) {
            throw new Error(
              "this budget carries no start/end date, so pass startDate and endDate explicitly.",
            );
          }

        const basis: AccountingMethod = accountingMethod ?? "Accrual";
        const report = await client.classReport("ProfitAndLoss", {
          startDate: from,
          endDate: to,
          classIds,
          accountingMethod: basis,
          summarizeColumnBy: "Classes",
        });
        const actuals = parseProfitAndLossByClass(report);
        const { rows, totals } = buildBudgetVsActuals(budget, actuals, { startDate: from, endDate: to });
        const page = packRows(rows, offset ?? 0, limit);

          return {
            budget: { id: budget.Id, name: budget.Name, entryType: budget.BudgetEntryType, type: budget.BudgetType },
          startDate: from,
          endDate: to,
          accountingBasis: actuals.basis || basis,
          computed:
            "No budget-vs-actuals report exists in the QuickBooks API — these numbers are budget detail joined to a P&L summarised by class.",
          totals,
          rowCount: rows.length,
          offset: page.offset,
          returned: page.rows.length,
          hasMore: page.hasMore,
          ...(page.hasMore
            ? {
                nextOffset: page.nextOffset,
                truncatedBy: page.truncatedBy,
                note: `Showing rows ${page.offset}-${page.offset + page.rows.length - 1} of ${rows.length}. Call again with offset: ${page.nextOffset} for the rest. \`totals\` already cover the whole budget.`,
              }
            : {}),
            rows: page.rows,
          };
        },
        { narrowing: OFFSET_PAGING_NARROWING },
      ),
  );
}
