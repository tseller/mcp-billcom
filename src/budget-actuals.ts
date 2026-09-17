/**
 * Budget vs actuals, computed.
 *
 * QuickBooks Online's Accounting API has **no budget report**. Verified live:
 * `/reports/BudgetVsActuals` and `/reports/BudgetSummary` both return
 * `5020 Permission Denied` — and so does a deliberately made-up report name
 * used as a control, which is how we know 5020 here means "no such report"
 * rather than a permissions problem to chase. (Intuit's own idea board still
 * carries an open request for a budget-vs-actuals API report.)
 *
 * The Budget *entity* is readable (and read-only — no create/update/delete via
 * the API, so budgets are built in the QBO web UI). Its `BudgetDetail` rows
 * carry `AccountRef` and `ClassRef`, which is exactly the grain a P&L
 * summarised by class reports actuals at. So this module joins the two:
 *
 *     budget detail (account × class × period)  ⋈  P&L by class (account × class)
 *
 * Both sides are keyed on ids, never on names — class names are year-specific
 * ("Fall 2026") and account names carry a chart-of-accounts number prefix.
 */

import type { ClassColumn, ClassPlRow } from "./qbo-client.js";

export interface BudgetDetailRow {
  BudgetDate?: string;
  Amount?: number;
  AccountRef?: { value?: string; name?: string };
  ClassRef?: { value?: string; name?: string };
  CustomerRef?: { value?: string; name?: string };
  DepartmentRef?: { value?: string; name?: string };
}

export interface QboBudget {
  Id?: string;
  Name?: string;
  StartDate?: string;
  EndDate?: string;
  BudgetType?: string;
  BudgetEntryType?: string;
  Active?: boolean;
  BudgetDetail?: BudgetDetailRow[];
}

export interface BudgetVsActualRow {
  accountId: string;
  account: string;
  classId: string | null;
  class: string | null;
  budget: number;
  actual: number;
  /** budget − actual. Positive = under budget for an expense, short for income. */
  variance: number;
  /** actual / budget, or null when there is nothing budgeted to compare against. */
  pctUsed: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const key = (accountId: string, classId: string | null) => `${accountId}|${classId ?? ""}`;

/** Sum a budget's detail rows into account × class buckets, within a date window. */
export function aggregateBudgetDetail(
  budget: QboBudget,
  startDate?: string,
  endDate?: string,
): Map<string, { accountId: string; account: string; classId: string | null; class: string | null; amount: number }> {
  const out = new Map<
    string,
    { accountId: string; account: string; classId: string | null; class: string | null; amount: number }
  >();

  for (const d of budget.BudgetDetail ?? []) {
    const date = d.BudgetDate ?? "";
    // BudgetDate is a plain YYYY-MM-DD, so lexical comparison is date comparison.
    if (startDate && date && date < startDate) continue;
    if (endDate && date && date > endDate) continue;

    const accountId = d.AccountRef?.value ?? "";
    if (!accountId) continue;
    const classId = d.ClassRef?.value ?? null;
    const k = key(accountId, classId);
    const existing = out.get(k);
    const amount = Number(d.Amount ?? 0);
    if (existing) {
      existing.amount = round2(existing.amount + amount);
    } else {
      out.set(k, {
        accountId,
        account: d.AccountRef?.name ?? "",
        classId,
        class: d.ClassRef?.name ?? null,
        amount: round2(amount),
      });
    }
  }
  return out;
}

/**
 * Join aggregated budget buckets against a parsed P&L-by-class report.
 *
 * Only P&L rows that carry an account id are joined — section subtotals
 * ("Total Income") have none and would double-count. Class columns are
 * identified by QBO's own `ColKey` (the class id), with the untagged
 * "Not Specified" column reported as `classId: null` so untagged actuals stay
 * visible instead of vanishing from the comparison.
 */
export function buildBudgetVsActuals(
  budget: QboBudget,
  actuals: { columns: ClassColumn[]; rows: ClassPlRow[] },
  window?: { startDate?: string; endDate?: string },
): { rows: BudgetVsActualRow[]; totals: { budget: number; actual: number; variance: number } } {
  const budgeted = aggregateBudgetDetail(budget, window?.startDate, window?.endDate);
  const classColumns = actuals.columns.filter((c) => !c.isTotal);

  const merged = new Map<string, BudgetVsActualRow>();
  const put = (row: BudgetVsActualRow) => {
    const k = key(row.accountId, row.classId);
    const existing = merged.get(k);
    if (!existing) {
      merged.set(k, row);
      return;
    }
    existing.budget = round2(existing.budget + row.budget);
    existing.actual = round2(existing.actual + row.actual);
    existing.account ||= row.account;
    existing.class ??= row.class;
  };

  for (const b of budgeted.values()) {
    put({
      accountId: b.accountId,
      account: b.account,
      classId: b.classId,
      class: b.class,
      budget: b.amount,
      actual: 0,
      variance: 0,
      pctUsed: null,
    });
  }

  for (const row of actuals.rows) {
    if (!row.accountId) continue;
    for (const col of classColumns) {
      const amount = row.byClass[col.title] ?? 0;
      if (!amount) continue;
      put({
        accountId: row.accountId,
        account: row.account,
        classId: col.classId ?? null,
        class: col.isUntagged ? null : col.title,
        budget: 0,
        actual: round2(amount),
        variance: 0,
        pctUsed: null,
      });
    }
  }

  const rows = [...merged.values()].map((r) => ({
    ...r,
    variance: round2(r.budget - r.actual),
    pctUsed: r.budget === 0 ? null : Math.round((r.actual / r.budget) * 1000) / 10,
  }));
  rows.sort((a, b) => a.account.localeCompare(b.account) || (a.class ?? "").localeCompare(b.class ?? ""));

  const totals = rows.reduce(
    (t, r) => ({
      budget: round2(t.budget + r.budget),
      actual: round2(t.actual + r.actual),
      variance: 0,
    }),
    { budget: 0, actual: 0, variance: 0 },
  );
  totals.variance = round2(totals.budget - totals.actual);

  return { rows, totals };
}
