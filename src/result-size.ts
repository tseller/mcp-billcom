/**
 * A tool result is only useful if the MCP client will accept it.
 *
 * Tools here used to serialize whole QBO reports with `JSON.stringify(x, null, 2)`,
 * which grows without bound with the date range (~840 chars per transaction row
 * on real books: a two-month TransactionList is ~52,000 chars / ~13,000 tokens,
 * a fiscal year is ~470,000). Nothing in the server stops that, so the failure
 * lands past our edge — at whatever per-result cap the client enforces — and
 * shows up as a bare "the tool errored" with nothing in the server logs.
 *
 * The cause is the missing size discipline, not the length of any one range,
 * so the fix lives here and is shared: every result is compact, every list
 * result is paged against a byte budget, and anything that still can't fit is
 * a named error rather than an oversized payload.
 */

/**
 * Character budget for a single tool result. ~4 chars/token puts this near
 * 10k tokens — comfortably inside client caps (Claude Code's default
 * MAX_MCP_OUTPUT_TOKENS is 25,000) while still carrying hundreds of rows.
 */
export const MAX_RESULT_CHARS = 40_000;

/** Serialize without pretty-printing. Indentation alone is ~25% of a report payload. */
export const compact = (v: unknown): string => JSON.stringify(v);

/** The message every over-budget result fails with — states the size and the way out. */
export function tooBig(what: string, range: string, chars: number): string {
  return (
    `${what} for ${range} is ${chars.toLocaleString()} characters, over the ` +
    `${MAX_RESULT_CHARS.toLocaleString()}-character tool-result budget. ` +
    `Narrow the date range, or use the paged row format (omit \`format: "raw"\`).`
  );
}

export interface PagedRows<T> {
  rows: T[];
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  /** Why the page stopped where it did — the caller's `limit`, or the size budget. */
  truncatedBy?: "limit" | "size";
}

/**
 * Take the largest slice of `rows` starting at `offset` that fits both the
 * caller's `limit` and the character budget. Measures each row once rather
 * than re-serializing the growing page.
 *
 * Always returns at least one row (a single row over budget is still better
 * than an empty page that can never advance).
 */
export function packRows<T>(
  rows: T[],
  offset = 0,
  limit?: number,
  budget: number = MAX_RESULT_CHARS,
): PagedRows<T> {
  const start = Math.max(0, Math.min(offset, rows.length));
  // Leave room for the envelope (header fields + note) around the rows.
  const rowBudget = Math.max(1000, budget - 2000);

  const page: T[] = [];
  let used = 0;
  let truncatedBy: "limit" | "size" | undefined;

  for (let i = start; i < rows.length; i++) {
    if (limit !== undefined && page.length >= limit) {
      truncatedBy = "limit";
      break;
    }
    const size = compact(rows[i]).length + 1; // +1 for the separating comma
    if (page.length > 0 && used + size > rowBudget) {
      truncatedBy = "size";
      break;
    }
    page.push(rows[i]);
    used += size;
  }

  const next = start + page.length;
  const hasMore = next < rows.length;
  return {
    rows: page,
    offset: start,
    hasMore,
    ...(hasMore ? { nextOffset: next, truncatedBy: truncatedBy ?? "size" } : {}),
  };
}
