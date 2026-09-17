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
 * `pageSize` stays a string because BILL's `max` query parameter is one.
 */
export const CURSOR_PAGING = {
  page: z
    .string()
    .optional()
    .describe("Page cursor for the next page — the `nextPage` value from the previous response."),
  pageSize: z.string().optional().describe("Number of results per page."),
  format: z
    .enum(["rows", "raw"])
    .optional()
    .describe(
      "`rows` (default) returns one flattened row per record. `raw` returns BILL's full objects — several times larger, and rejected outright if it exceeds the size budget.",
    ),
} as const;

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
