/**
 * The paging vocabularies a list tool can take, and — beside each one — the
 * sentence that names its knobs when a result comes back over budget.
 *
 * There is one shape for "give me the next page" per paging coordinate, so a
 * caller (or a model) that learns it once knows it everywhere, and a list tool
 * written later inherits it rather than inventing a third spelling of
 * `startPosition`.
 *
 * The narrowing sentences live here rather than in `result-size.ts` because
 * advice is only useful if it names *this* tool's parameters: a single shared
 * sentence naming QBO's knobs told a Divvy caller to pass `maxResults`,
 * `format`, `offset` or `startPosition`, none of which that tool accepts.
 * Keeping the sentence next to the schema that declares the knobs is what
 * stops the two drifting apart.
 *
 * Three coordinates are in use:
 *  - `startPosition` — QBO entity queries, which take a 1-based offset;
 *  - `offset` — the report tools, which page a report we already hold;
 *  - `page` — BILL/Divvy, whose cursor is an opaque string from the previous
 *    response. It cannot be expressed as a position, so it keeps its own
 *    spelling and states so, rather than pretending to be `startPosition`.
 */

import { z } from "zod";

export const listPaging = (defaultMaxResults: number) =>
  ({
    startPosition: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "1-based start position (default 1). Use `nextStartPosition` from the previous call.",
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        `Max rows to fetch for this page (default ${defaultMaxResults}). The response is also capped by a size budget, whichever is smaller — so a page can return fewer rows than this.`,
      ),
    format: z
      .enum(["rows", "raw"])
      .optional()
      .describe(
        "`rows` (default) returns flattened rows. `raw` returns QBO's full entity JSON — several times larger, and rejected outright if it exceeds the size budget.",
      ),
  }) as const;

/** The default paging arguments (100 rows a page), for the transaction lists. */
export const LIST_PAGING = listPaging(100);

export const LIST_PAGING_DOC =
  "Returns flattened rows (date, amount, payee/account names with their QBO ids, doc number, memo, categorization lines) plus `rowCount` for the WHOLE range. " +
  "Paged by size as well as row count: when `hasMore` is true, call again with `startPosition: nextStartPosition` — no date range is too long.";

/** Over-budget advice for the `startPosition` tools. */
export const LIST_PAGING_NARROWING =
  "Narrow the request — a shorter date range, a smaller `maxResults`, " +
  'the paged row format (omit `format: "raw"`), or the next page ' +
  "(`startPosition: nextStartPosition`).";

/** Over-budget advice for the report tools, which page on `offset`/`limit`. */
export const OFFSET_PAGING_NARROWING =
  "Narrow the request — a shorter date range, a smaller `limit`, " +
  'the paged row format (omit `format: "raw"`), or the next page ' +
  "(`offset: nextOffset`).";

/**
 * The paging arguments for a BILL/Divvy list. Same `format` spelling as the
 * QBO lists — `rows` is the default there and here — but the position is
 * BILL's opaque `nextPage` cursor rather than a row offset, so `page` keeps
 * its own name instead of masquerading as `startPosition`.
 *
 * `pageSize` is **bounded**, and the bound comes from the caller rather than
 * being written here, because it is a fact about one BILL endpoint: its own
 * page maximum differs per list (50 on transactions, 100 on cards, budgets and
 * custom-field values) and is declared once in `src/divvy-paging.ts`. It was
 * an unbounded string, passed straight through, so `pageSize: "100"` on the
 * transaction list surfaced as BILL's raw `400 max: must be less than or equal
 * to 50` — a knob the tool advertised and the backend refused (issue #24).
 *
 * The bound is not BILL's page size, though: `pageSize` is how many ROWS the
 * caller wants back, and an ask spanning several BILL pages is served by
 * walking its cursor (`walkBillPages`). So the number here is the largest ask
 * this tool can actually attempt, and the sentence says where it comes from —
 * the limit is visible before the call rather than after a 400.
 *
 * It stays permissive about type: BILL's `max` is a string and callers have
 * been passing `"50"`, so the schema coerces rather than rejecting it.
 */
export interface CursorPagingLimits {
  /** BILL's own maximum for one page of this list. */
  billPageSize: number;
  /** The largest row count one call can attempt. */
  maxRows: number;
  /** BILL pages one call may walk. */
  maxPages: number;
}

export const cursorPaging = (
  { billPageSize, maxRows, maxPages }: CursorPagingLimits,
  { format = true }: { format?: boolean } = {},
) =>
  ({
    page: z
      .string()
      .optional()
      .describe("Page cursor for the next page — the `nextPage` value from the previous response."),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(
        maxRows,
        `pageSize must be ${maxRows} or fewer rows: BILL's own page holds ${billPageSize}, and one call walks at most ${maxPages} of them.`,
      )
      .optional()
      .describe(
        `Rows to return (default ${billPageSize}, max ${maxRows}). BILL's own page holds ${billPageSize}; a larger ask is served by walking its cursor here, not refused. The response is also capped by a size budget, whichever is smaller — so a page can return fewer rows than this.`,
      ),
    ...(format
      ? {
          format: z
            .enum(["rows", "raw"])
            .optional()
            .describe(
              "`rows` (default) returns one flattened row per record. `raw` returns BILL's full objects — several times larger, and rejected outright if it exceeds the size budget.",
            ),
        }
      : {}),
  }) as const;

/**
 * Over-budget advice for the cursor tools — the knobs BILL actually has.
 * `format` is a parameter of the transaction list and not of every cursor
 * tool, so it is named only where it exists.
 */
export const cursorNarrowing = ({ format = true }: { format?: boolean } = {}) =>
  "Narrow the request — a shorter date range, a smaller `pageSize`, " +
  (format ? 'the paged row format (omit `format: "raw"`), ' : "") +
  "or the next page (`page: nextPage`).";

export const CURSOR_PAGING_NARROWING = cursorNarrowing();
