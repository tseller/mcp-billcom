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
 *
 * It is also the DEFAULT, not an opt-in: every tool response goes through
 * `runTool` (src/tool-logging.ts), which serializes with `compact()` and
 * refuses anything over `MAX_RESULT_CHARS`. A new tool inherits the budget
 * without knowing this file exists; paging with `packRows` is what turns that
 * refusal into a usable answer.
 */

/**
 * Character budget for a single tool result. ~4 chars/token puts this near
 * 10k tokens — comfortably inside client caps (Claude Code's default
 * MAX_MCP_OUTPUT_TOKENS is 25,000) while still carrying hundreds of rows.
 */
export const MAX_RESULT_CHARS = 40_000;

/** Serialize without pretty-printing. Indentation alone is ~25% of a report payload. */
export const compact = (v: unknown): string => JSON.stringify(v);

/**
 * What to say when a result is over budget and the tool has not named its own
 * paging knobs. Deliberately knob-free: advice that names parameters is only
 * useful if they are *this* tool's parameters, and a wrong name is worse than
 * no name — `divvy_list_transactions` used to be told to pass `maxResults`,
 * `format`, `offset` or `startPosition`, none of which it accepts. A tool with
 * paging arguments passes the sentence that names them (see
 * `src/tools/list-paging.ts`, where each sentence sits beside the schema that
 * declares those knobs, so the two cannot drift).
 */
export const DEFAULT_NARROWING =
  "Narrow the request — a shorter date range, or a smaller page using this tool's own paging arguments.";

/**
 * The message every over-budget result fails with — states the size and the
 * way out. Raised from the single response path (`runTool`), so a tool that
 * never thought about size still fails loudly here instead of handing the
 * client a payload it will reject.
 */
export function overBudget(
  what: string,
  chars: number,
  narrowing: string = DEFAULT_NARROWING,
): string {
  return (
    `${what} produced a ${chars.toLocaleString()}-character result, over the ` +
    `${MAX_RESULT_CHARS.toLocaleString()}-character tool-result budget. ` +
    narrowing
  );
}

/**
 * The share of the budget a page's rows may use, once room is left for the
 * envelope (header fields and the note) around them. Exported because anything
 * that gathers rows *before* packing them — walking a backend's cursor, say —
 * needs the same number to know when gathering more is pointless.
 */
export const rowBudget = (budget: number = MAX_RESULT_CHARS): number =>
  Math.max(1000, budget - 2000);

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
  const forRows = rowBudget(budget);

  const page: T[] = [];
  let used = 0;
  let truncatedBy: "limit" | "size" | undefined;

  for (let i = start; i < rows.length; i++) {
    if (limit !== undefined && page.length >= limit) {
      truncatedBy = "limit";
      break;
    }
    const size = compact(rows[i]).length + 1; // +1 for the separating comma
    if (page.length > 0 && used + size > forRows) {
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
