/**
 * What a list result says when it has no rows.
 *
 * `divvy_list_budgets` answered `{"results":[]}` on books where every
 * transaction names a budget (issue #34). The call succeeded, the payload was
 * well-formed, and a caller had no way to tell "this company has no budgets"
 * from "this endpoint cannot see them" — the same shape as #29 (a filter that
 * silently did nothing) and #33 (paging parameters silently ignored): a call
 * that succeeds and says nothing true.
 *
 * The instance was one blind endpoint. The structure that let it pass is that
 * an empty list is indistinguishable from an unanswered one *unless the result
 * says which*. So a list built here never returns a bare `[]`: when it has no
 * rows it carries an `empty` block naming one of three meanings, and the
 * strongest of the three is only claimable with a witness — an independent
 * source that would have named a row of this kind if one existed.
 *
 *  - `none-found`   — a witness was consulted and it names none either.
 *  - `source-blind` — a witness names rows this source did not return, so the
 *                     source could not see them. Not an empty book.
 *  - `unverified`   — no witness was available; this reports what the source
 *                     returned, which is not evidence that none exist.
 *
 * `unverified` is the default precisely because it is the honest thing to say
 * when nothing was checked, and because it costs a tool nothing: every list
 * built through `buildEntityList` / `buildCursorList` inherits the block
 * without opting in, exactly as they inherit the result-size budget.
 */

export interface Witness {
  /** Where the independent evidence came from, e.g. "cards". */
  source: string;
  /** How many records of the listed kind that source names. */
  found: number;
  /** A few of them, so the claim can be checked rather than taken on trust. */
  sample?: string[];
}

export type EmptyMeaning = "none-found" | "source-blind" | "unverified";

export interface EmptyBlock {
  meaning: EmptyMeaning;
  note: string;
  /** What was consulted, when anything was. */
  checked?: Array<{ source: string; found: number; sample?: string[] }>;
}

const SAMPLE_LIMIT = 5;

/**
 * The `empty` block for a listing that returned no rows.
 *
 * `witnesses` are the independent sources that were actually consulted for
 * THIS result — not sources that exist in principle. A tool that consults none
 * says so; that is the point.
 */
export function describeEmpty(witnesses: Witness[] = []): EmptyBlock {
  if (witnesses.length === 0) {
    return {
      meaning: "unverified",
      note:
        "No rows. Nothing independent was checked against this, so it states what the source " +
        "returned — not that none exist.",
    };
  }

  const checked = witnesses.map((w) => ({
    source: w.source,
    found: w.found,
    ...(w.sample && w.sample.length > 0 ? { sample: w.sample.slice(0, SAMPLE_LIMIT) } : {}),
  }));
  const naming = witnesses.filter((w) => w.found > 0);

  if (naming.length > 0) {
    const detail = naming.map((w) => `${w.source} names ${w.found}`).join("; ");
    return {
      meaning: "source-blind",
      note:
        `No rows — but ${detail}. The source this listing queried could not see them, ` +
        "so this is a blind answer, not an empty book.",
      checked,
    };
  }

  return {
    meaning: "none-found",
    note:
      `No rows, and ${witnesses.length === 1 ? "the" : "all"} ${witnesses.length} independent ` +
      `source${witnesses.length === 1 ? "" : "s"} checked (${witnesses
        .map((w) => w.source)
        .join(", ")}) name none either.`,
    checked,
  };
}
