/**
 * How BILL pages a list — the spelling, the maximum, and the walk — declared
 * once, in one place.
 *
 * Three facts govern every BILL/Divvy listing, and they lived in five places
 * that agreed with each other nowhere: the query parameter carrying the cursor,
 * the one carrying the page size, and the maximum that second one accepts.
 *
 * Two bugs came out of that, and they are the same bug:
 *
 *  - `divvy_list_transactions` advertised `pageSize` as an unbounded string and
 *    handed it straight to BILL, so `pageSize: "100"` came back as BILL's raw
 *    `400 max: must be less than or equal to 50` (issue #24) — while the tool's
 *    own `BILL_MAX_PAGE_SIZE = 50` sat a few lines away, used for something
 *    else entirely. The limit was known to the code and not to the schema.
 *  - `divvy_list_custom_field_values` spelled those same two parameters `page`
 *    and `page_size`. BILL does not read either name, and answers 200 rather
 *    than rejecting them — so that tool could not page at all. Probed on live
 *    books 2026-09-18: `?page_size=5` returns the same 20 rows as no parameter,
 *    and `?page=<cursor>` returns the FIRST page again, forever.
 *
 * The second is issue #29's shape a fourth time — a parameter sent and assumed.
 * So the spelling is written down here once and every list goes through it; a
 * method can no longer invent a third name for BILL's cursor.
 *
 * Each endpoint's maximum is BILL's own answer, probed rather than assumed
 * (live books, 2026-09-18 — it validates `max`, so the 400 is the boundary):
 *
 *   /v3/spend/transactions            max <= 50    (51 is a 400)
 *   /v3/spend/cards                   max <= 100   (101 is a 400)
 *   /v3/spend/budgets                 max <= 100   (101 is a 400)
 *   /v3/spend/custom-fields/…/values  max <= 100   (101 is a 400)
 *   /v3/spend/custom-fields           max <= 100   (101 is a 400)
 *
 * A caller's `pageSize` is deliberately NOT that maximum. BILL's page is a
 * transport detail; `pageSize` is how many rows the caller wants back. An ask
 * larger than one BILL page is therefore served by walking `nextPage` here —
 * bounded by `MAX_BILL_PAGES_PER_CALL` and by the result-size budget — rather
 * than by a backend 400 the caller has to learn to loop around.
 */

/** The query parameter BILL reads as the cursor. Not `page`. */
export const BILL_CURSOR_PARAM = "nextPage";

/** The query parameter BILL reads as the page size. Not `page_size`. */
export const BILL_PAGE_SIZE_PARAM = "max";

/** BILL's own maximum for `max`, per endpoint. Probed; see the file comment. */
export const BILL_MAX_PAGE_SIZE = {
  transactions: 50,
  cards: 100,
  budgets: 100,
  customFields: 100,
  customFieldValues: 100,
} as const;

export type BillListName = keyof typeof BILL_MAX_PAGE_SIZE;

/**
 * Which Divvy tool serves which BILL list.
 *
 * This exists because the same omission happened three times — a listing tool
 * shipped with no way to accept BILL's cursor — and each time it was fixed as
 * an instance:
 *
 *  - `divvy_list_custom_field_values` spelled the parameters `page`/`page_size`
 *    and could not page at all (issue #24);
 *  - `divvy_list_cards` took no arguments, so BILL's default page of 20 was the
 *    whole answer and the 21st card was unreachable (issue #43);
 *  - `divvy_list_custom_fields` took no arguments either — BILL hands it a
 *    cursor at `?max=1` and the tool had nowhere to put one (issue #46).
 *
 * Nothing pinned "a BILL listing declares the shared cursor shape", the way
 * `FILTER_SPECS` is pinned to the transaction tool's schema. This table is that
 * pin: `divvy-lists.test.ts` walks the registered tools and requires every
 * `divvy_list_*` to appear here (and to carry `page`/`pageSize` bounded by this
 * list's own maximum) or in `UNPAGED_DIVVY_LISTS` with a reason. A listing added
 * tomorrow cannot quietly ship without a cursor: the test fails until someone
 * says which of the two it is.
 */
export const DIVVY_LIST_TOOLS = {
  divvy_list_transactions: "transactions",
  divvy_list_cards: "cards",
  divvy_list_custom_fields: "customFields",
  divvy_list_custom_field_values: "customFieldValues",
} as const satisfies Record<string, BillListName>;

/**
 * The Divvy tools that read like a listing and take no cursor — each with the
 * reason it does not, because "this one has nothing to page" is a claim that
 * has now been wrong three times and must be argued rather than assumed.
 */
export const UNPAGED_DIVVY_LISTS: Record<string, string> = {
  divvy_list_budgets:
    "not one BILL list: BILL's budget endpoint is blind to most of these budgets, so the listing is assembled from several sources and read back by id (issue #34). Its own BILL calls page through `budgets`.",
  divvy_list_members:
    "GET /v3/spend/members answers 404 on these books — there is no list to page yet. Issue #38 owns it, and a cursor here would be a knob over a hole.",
  divvy_list_pending_action:
    "a triage view over the transaction list rather than a BILL endpoint: it walks `transactions` itself and buckets what it finds, so the rows it returns are not one BILL page.",
};

/**
 * How many BILL pages one tool call may consume. A bound, not a target: a call
 * stops as soon as it has the rows asked for, so the ordinary ask — one page's
 * worth — is still one BILL call.
 */
export const MAX_BILL_PAGES_PER_CALL = 10;

/**
 * The paging limits a tool schema advertises for one BILL list: BILL's own page
 * size, and the largest row count this tool can honestly attempt in one call.
 * The schema reads them from here so the number in the description and the
 * number enforced are the same number.
 */
export const billPagingLimits = (list: BillListName) => ({
  billPageSize: BILL_MAX_PAGE_SIZE[list],
  maxRows: BILL_MAX_PAGE_SIZE[list] * MAX_BILL_PAGES_PER_CALL,
  maxPages: MAX_BILL_PAGES_PER_CALL,
});

/** One page as BILL returns it: rows, and a cursor when there are more. */
export interface BillPage<T> {
  results?: T[];
  nextPage?: string;
}

export interface WalkInput<T> {
  /** Which list — this is what fixes the page size asked of BILL. */
  list: BillListName;
  /** How many rows the caller wants back. */
  target: number;
  /** The caller's cursor, i.e. where to start. */
  page?: string;
  /** One BILL page. `pageSize` is already bounded to BILL's maximum. */
  fetch(params: { page?: string; pageSize: string }): Promise<BillPage<T>>;
  /**
   * Rows that survive the caller's filters (see `FilterCheck`). Dropping rows
   * is why a walk can be needed even for a single page's worth: a page made
   * mostly of holes is refilled from the next one rather than coming back
   * near-empty.
   */
  keep?(rows: T[]): T[];
  /**
   * Serialized size of one kept row, for stopping the walk once the rows in
   * hand already exceed what a tool result can carry. Optional because it is
   * the row *as the tool will emit it* that matters — a flattened Divvy row is
   * a sixth of the raw object — so only the caller can measure it.
   */
  measure?(row: T): number;
  /** Character budget for the accumulated rows. */
  budgetChars?: number;
}

export interface Walked<T> {
  /** Kept rows, in BILL's order, at most `target` of them. */
  rows: T[];
  /** BILL's cursor after the last page consumed, when it gave one. */
  nextPage?: string;
  /** BILL pages consumed for this one result. */
  billPages: number;
  /** BILL's last page verbatim, for the tools that hand its envelope back. */
  last: BillPage<T>;
}

/**
 * Walk BILL's cursor until there are `target` rows, BILL runs out, or a bound
 * bites.
 *
 * Each call asks BILL for exactly the rows still wanted (never more than its
 * page maximum), so the accumulated rows end on a BILL page boundary and the
 * cursor handed back is exactly right. That is what lets `pageSize` mean rows
 * rather than BILL pages: `returned` can no longer exceed what was asked for,
 * and following `nextPage` cannot skip rows this call already had in hand.
 */
export async function walkBillPages<T>({
  list,
  target,
  page,
  fetch,
  keep,
  measure,
  budgetChars,
}: WalkInput<T>): Promise<Walked<T>> {
  const billPageSize = BILL_MAX_PAGE_SIZE[list];
  const wanted = Math.max(1, Math.floor(target));

  let cursor = page;
  let billPages = 0;
  let rows: T[] = [];
  let chars = 0;
  let last: BillPage<T> = {};

  do {
    const ask = Math.min(wanted - rows.length, billPageSize);
    last = await fetch({ page: cursor, pageSize: String(ask) });
    billPages += 1;
    const got = Array.isArray(last.results) ? last.results : [];
    const kept = keep ? keep(got) : got;
    rows = rows.concat(kept);
    if (measure) for (const row of kept) chars += measure(row) + 1;
    cursor = last.nextPage;
  } while (
    cursor &&
    rows.length < wanted &&
    billPages < MAX_BILL_PAGES_PER_CALL &&
    (budgetChars === undefined || chars < budgetChars)
  );

  return { rows, nextPage: cursor, billPages, last };
}
