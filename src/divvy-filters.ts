/**
 * Every filter `divvy_list_transactions` advertises, declared once: how it is
 * expressed to BILL, and how a row that comes back is checked against it.
 *
 * The bug this file exists to make impossible (issue #29): the tool sent
 * `start_date` / `end_date` / `budget_id` / `sync_status` as query parameters,
 * BILL's v3 `/spend/transactions` does not read those names, and it answers
 * 200 with an unfiltered page rather than rejecting the unknown parameter. So
 * a treasurer asking for May-June got August-September, the call succeeded,
 * and nothing in the response said the filter had done nothing.
 *
 * The wrong parameter name was the instance. The structure that let it happen
 * is that the tool had no way to tell an applied filter from an ignored one —
 * it sent a filter and assumed. So a filter here is not a query parameter; it
 * is a pair:
 *
 *  - `terms()` — what BILL is asked, in its own `field:operator:value` filter
 *    grammar (comma-joined; repeating the `filters` parameter or joining with
 *    a semicolon is silently ignored, so those spellings are not used);
 *  - `matches()` — the same question asked of a row that came back.
 *
 * `enforceFilters` runs the second against every row BILL returns, drops the
 * rows that fail, and reports per filter how it was actually enforced. A
 * filter BILL ignores therefore cannot silently return the wrong rows: the
 * rows are dropped here and the result says in words that the server-side
 * filter was not honored. A filter BILL has no field for at all (`status`)
 * takes the same path with no terms, and reads as client-side rather than
 * pretending to be a server filter.
 *
 * What BILL actually supports on `/v3/spend/transactions`, probed against live
 * books on 2026-09-17 (it validates both field and operator, so this is BILL's
 * own answer, not a guess):
 *
 *   occurredTime  gte, lte only — eq/gt/lt/ne/in/sw are 400s
 *   budgetId      eq, by either the base64 `budgetId` or the `bgt_…` uuid
 *   syncStatus    eq, values PENDING/SYNCED/ERROR/MANUAL_SYNCED/NOT_SYNCED
 *   status        not a filter field at all (400) — client-side only
 *
 * The value cannot carry a time: `occurredTime:lte:2026-06-26T23:59:59` fails
 * the `field:operator:value` split on its colons. And a date-only `lte` means
 * that day at 00:00, which excludes the day itself — `lte:2026-06-26` returns
 * nothing for a transaction at 2026-06-26T10:50. So `endDate` asks BILL for
 * the day after and trims the overhang here; `sentBound` is what keeps that
 * deliberate widening from being misread as BILL ignoring us.
 */

export type Tx = Record<string, unknown>;

/** The filters the transaction list accepts, as the caller spells them. */
export interface TransactionFilters {
  startDate?: string;
  endDate?: string;
  budgetId?: string;
  syncStatus?: string;
  status?: string;
}

export interface FilterSpec {
  /** BILL `filters` terms for this value. Empty when BILL cannot filter on it. */
  terms(value: string): string[];
  /** The caller's question, asked of a returned row. Rows failing it are dropped. */
  matches(row: Tx, value: string): boolean;
  /**
   * The bound actually sent to BILL, when it is deliberately looser than
   * `matches`. A row inside this but outside `matches` is BILL doing what it
   * was asked, so it is trimmed here without counting against the server.
   */
  sentBound?(row: Tx, value: string): boolean;
}

/** The `YYYY-MM-DD` part of a BILL `occurredTime`. */
const occurredOn = (row: Tx): string => String(row.occurredTime ?? "").slice(0, 10);

/** The day after `date` (YYYY-MM-DD), for BILL's midnight-exclusive `lte`. */
export function dayAfter(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * BILL reports a transaction's accounting sync as a nested integration record
 * rather than a top-level field — `accountingIntegrationTransactions[].syncStatus`,
 * lower-case (`"synced"`). On live books the filter and this witness line up
 * exactly: `syncStatus:eq:SYNCED` returns only rows carrying a `"synced"`
 * record, and `NOT_SYNCED` only rows carrying none.
 *
 * PENDING / ERROR / MANUAL_SYNCED return nothing on these books, so their
 * witness spelling is unobserved; the comparison is case-insensitive on the
 * assumption they follow `SYNCED`. If one of them is spelled differently, the
 * rows are dropped and the result says the server filter was not honored —
 * visible and wrong-in-the-safe-direction, rather than silently wrong rows.
 */
export function rowSyncStatus(row: Tx): string | undefined {
  const records = row.accountingIntegrationTransactions;
  if (!Array.isArray(records) || records.length === 0) return undefined;
  for (const r of records) {
    const s = (r as { syncStatus?: unknown })?.syncStatus;
    if (typeof s === "string" && s) return s.toUpperCase();
  }
  return undefined;
}

export const FILTER_SPECS: Record<keyof TransactionFilters, FilterSpec> = {
  startDate: {
    terms: (v) => [`occurredTime:gte:${v}`],
    matches: (row, v) => occurredOn(row) >= v,
  },
  endDate: {
    // BILL's `lte` is midnight of the named day, so ask for the day after and
    // trim; `sentBound` tells the enforcement check that overhang was ours.
    terms: (v) => [`occurredTime:lte:${dayAfter(v)}`],
    matches: (row, v) => occurredOn(row) <= v,
    sentBound: (row, v) => occurredOn(row) <= dayAfter(v),
  },
  budgetId: {
    terms: (v) => [`budgetId:eq:${v}`],
    // BILL accepts either spelling of the id, so a row matches on either.
    matches: (row, v) => row.budgetId === v || row.budgetUuid === v,
  },
  syncStatus: {
    terms: (v) => [`syncStatus:eq:${v}`],
    matches: (row, v) =>
      v.toUpperCase() === "NOT_SYNCED"
        ? rowSyncStatus(row) === undefined
        : rowSyncStatus(row) === v.toUpperCase(),
  },
  status: {
    // Not a filter field on BILL's endpoint — asking for one is a 400.
    terms: () => [],
    matches: (row, v) => String(row.status ?? "").toUpperCase() === v.toUpperCase(),
  },
};

const FILTER_NAMES = Object.keys(FILTER_SPECS) as Array<keyof TransactionFilters>;

/** The filters actually set, in declaration order. */
function active(filters: TransactionFilters): Array<[keyof TransactionFilters, string]> {
  return FILTER_NAMES.filter((n) => filters[n] !== undefined && filters[n] !== "").map(
    (n) => [n, String(filters[n])] as [keyof TransactionFilters, string],
  );
}

/**
 * The `filters` query-parameter value for BILL, or undefined when nothing set
 * has a server-side term. BILL reads comma-joined terms only.
 */
export function billFilterParam(filters: TransactionFilters): string | undefined {
  const terms = active(filters).flatMap(([name, value]) => FILTER_SPECS[name].terms(value));
  return terms.length > 0 ? terms.join(",") : undefined;
}

/** Running tally for one filter across however many BILL pages were walked. */
interface Tally {
  /** Terms were sent to BILL for this filter. */
  server: boolean;
  /** Rows dropped here because they failed the caller's filter. */
  dropped: number;
  /** Of those, rows BILL should not have returned at all — the honor check. */
  unhonored: number;
}

function sentence(name: string, t: Tally, seen: number): string {
  if (!t.server) {
    return `client — BILL has no \`${name}\` filter; applied here, ${t.dropped} of ${seen} row(s) dropped`;
  }
  if (t.unhonored > 0) {
    return (
      `client — BILL was sent this filter and returned ${t.unhonored} of ${seen} row(s) outside it; ` +
      "they were dropped here. Its server-side filter is not being honored"
    );
  }
  if (t.dropped > 0) {
    // Only reachable via `sentBound`: we asked BILL for a wider bound on
    // purpose (endDate) and trimmed the overhang.
    return `server + client — BILL filtered; ${t.dropped} of ${seen} row(s) trimmed to the exact bound`;
  }
  return `server — BILL filtered; every one of the ${seen} row(s) it returned is inside it`;
}

/**
 * Checks every row BILL returns against every filter the caller asked for.
 *
 * It is an accumulator rather than a function because one tool call can walk
 * several BILL pages: the report has to cover all of them, or a filter BILL
 * ignored on page 1 would read as honored because page 2 happened to be clean.
 */
export class FilterCheck {
  private readonly active: Array<[keyof TransactionFilters, string]>;
  private readonly tallies = new Map<string, Tally>();
  /** Rows BILL returned, across every page walked. */
  seen = 0;
  /** Of those, rows dropped here for failing at least one filter. */
  dropped = 0;

  constructor(private readonly filters: TransactionFilters) {
    this.active = active(filters);
    for (const [name, value] of this.active) {
      this.tallies.set(name, {
        server: FILTER_SPECS[name].terms(value).length > 0,
        dropped: 0,
        unhonored: 0,
      });
    }
  }

  /** True when any filter is set — i.e. when there is anything to check. */
  get any(): boolean {
    return this.active.length > 0;
  }

  /** One BILL page in; the rows that satisfy every filter out, in BILL's order. */
  keep(rows: Tx[]): Tx[] {
    this.seen += rows.length;
    const kept: Tx[] = [];
    for (const row of rows) {
      let ok = true;
      for (const [name, value] of this.active) {
        const spec = FILTER_SPECS[name];
        if (spec.matches(row, value)) continue;
        ok = false;
        const t = this.tallies.get(name)!;
        t.dropped += 1;
        if (t.server && !(spec.sentBound ?? spec.matches)(row, value)) t.unhonored += 1;
      }
      if (ok) kept.push(row);
      else this.dropped += 1;
    }
    return kept;
  }

  /** Per filter, one sentence on how it was really enforced on this result. */
  report(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name] of this.active) {
      out[name] = sentence(name, this.tallies.get(name)!, this.seen);
    }
    return out;
  }

  /** The `filters` query-parameter value to send BILL for these filters. */
  get billParam(): string | undefined {
    return billFilterParam(this.filters);
  }
}
