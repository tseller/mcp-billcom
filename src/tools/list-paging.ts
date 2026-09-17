/**
 * The paging arguments every QBO list tool takes.
 *
 * There is one shape for "give me the next page" across purchases, deposits,
 * transfers, accounts and vendors — a caller (or a model) that learns it once
 * knows it everywhere, and a list tool written later inherits it rather than
 * inventing a third spelling of `startPosition`.
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
