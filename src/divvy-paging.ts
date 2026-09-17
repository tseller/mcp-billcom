/**
 * Paging for the Divvy (BILL Spend & Expense) cursor lists, declared the same
 * way filters are (src/divvy-filters.ts): as a pair of what is asked of BILL
 * and what is then asked of the answer.
 *
 * The bug this file exists to make impossible (issue #33):
 * `divvy_list_custom_field_values` advertised `page` and `pageSize` and sent
 * them as `page` / `page_size` query parameters. BILL's v3
 * `/spend/custom-fields/{id}/values` reads NEITHER — it wants `max` and
 * `nextPage` — and, as with #29, it answers 200 with page 1 rather than
 * rejecting a parameter it does not know. Probed on live books, 2026-09-17:
 *
 *   ?page_size=3            -> 20 rows   (BILL's default; `max` is the name)
 *   ?max=3                  -> 3 rows
 *   ?max=3&page=<cursor>    -> page 1 again, and `nextPage` comes back equal
 *                              to the cursor that was sent
 *   ?max=3&nextPage=<cursor>-> the next 3 rows
 *   ?bogusParam=7           -> 200, 20 rows: the control. An unknown query
 *                              parameter is ignored, never refused.
 *
 * So a caller walking the NAP-code list got the same first 20 values forever,
 * behind a `nextPage` that never advanced: an infinite loop wearing the shape
 * of a working paged API.
 *
 * Renaming the two parameters would fix that instance and leave the structure
 * intact — the tool would still be *sending a paging parameter and assuming*.
 * So paging is declared here as:
 *
 *  - `param` / `send()` — the query parameter BILL is asked on, and the value;
 *  - `honored()` — the same question asked of the page that came back.
 *
 * The witness for a cursor is the cheap and honest one: a cursor is derived
 * from a page, so a cursor that re-serves the rows it was derived from has not
 * advanced. To have that comparison available on the *next* call, the cursor
 * this tool hands out is BILL's cursor with a fingerprint of that page sealed
 * onto it (`<billCursor>~<fingerprint>`); when it comes back, the rows BILL
 * returns are fingerprinted again and compared. A cursor that did not advance
 * therefore stops the walk and says so, instead of looping. (A bare BILL
 * cursor pasted by hand still works — it simply carries no witness, and the
 * result says that rather than claiming the cursor advanced.)
 */

import { createHash } from "node:crypto";

/** The paging arguments a Divvy cursor list accepts, as the caller spells them. */
export interface CursorPaging {
  page?: string;
  pageSize?: string;
}

/** What one BILL page offers as evidence about the knobs we turned. */
export interface PageWitness {
  /** The raw rows BILL returned for this page. */
  rows: unknown[];
  /** Fingerprint of those rows. */
  fingerprint: string;
  /** Fingerprint of the page this one's cursor came from, when known. */
  from?: string;
}

export interface PagingSpec {
  /** BILL's own name for this knob on the v3 Spend endpoints. */
  readonly param: string;
  /** The value sent under that name. */
  send(value: string): string;
  /**
   * Was the knob read? `true` — the page shows it was, `false` — the page
   * shows it demonstrably was not, `undefined` — this page cannot witness it
   * either way, which is stated rather than rounded up to "honored".
   */
  honored(page: PageWitness, value: string): boolean | undefined;
}

export const PAGING_SPECS: Record<keyof CursorPaging, PagingSpec> = {
  page: {
    param: "nextPage",
    // A sealed cursor travels to BILL as the plain cursor it wraps.
    send: (v) => openCursor(v).cursor,
    honored: ({ fingerprint, from }) => (from === undefined ? undefined : fingerprint !== from),
  },
  pageSize: {
    param: "max",
    send: (v) => v,
    // One-sided on purpose: more rows than were asked for is proof `max` was
    // not read, while fewer is just as likely to be the last page.
    honored: ({ rows }, v) => (Number(v) > 0 ? rows.length <= Number(v) : undefined),
  },
};

/** The query parameters these paging arguments become. */
export function billPagingParams(paging: CursorPaging): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of Object.keys(PAGING_SPECS) as Array<keyof CursorPaging>) {
    const value = paging[name];
    out[PAGING_SPECS[name].param] =
      value === undefined || value === "" ? undefined : PAGING_SPECS[name].send(String(value));
  }
  return out;
}

/**
 * A page's identity, for the "did this cursor advance?" comparison. It is over
 * BILL's own rows rather than our flattened ones, because what is being
 * compared is what BILL serves for a cursor.
 */
export function pageFingerprint(rows: unknown[]): string {
  return createHash("sha1").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
}

/** Separates BILL's cursor from the fingerprint sealed onto it. Not base64. */
const SEAL = "~";

/** BILL's cursor plus the identity of the page it came after. */
export function sealCursor(cursor: string, fingerprint: string): string {
  return `${cursor}${SEAL}${fingerprint}`;
}

/** The inverse. A cursor with no seal is returned as-is, with no witness. */
export function openCursor(value?: string): { cursor: string; fingerprint?: string } {
  if (!value) return { cursor: "" };
  const at = value.lastIndexOf(SEAL);
  if (at < 0) return { cursor: value };
  return { cursor: value.slice(0, at), fingerprint: value.slice(at + SEAL.length) };
}

/**
 * The cursor state machine for one tool call, and the witness that the paging
 * parameters were read.
 *
 * It is an accumulator rather than a function because one tool call can walk
 * several BILL pages (`divvy_list_transactions` refills a page that client-side
 * filtering emptied, `listPendingAction` walks to the end): every page is
 * fingerprinted, so a cursor that loops back onto a page already seen is caught
 * wherever in the walk it happens.
 */
export class PagingCheck {
  /** Fingerprints of every page seen in this call, plus the caller's cursor's. */
  private readonly seen = new Set<string>();
  /** The page the cursor about to be sent was derived from, when known. */
  private from?: string;
  /** BILL's cursor for the next request. */
  private cursor?: string;
  /** Whether the caller's own cursor carried a witness. */
  private readonly callerSealed: boolean;
  /** Pages BILL returned in this call. */
  pages = 0;
  /** The most rows BILL put on one page here — what the `max` verdict counted. */
  private widestPage = 0;
  /** Rows on the page that repeated, when one did. */
  private loopedRows = 0;
  /** Cursor pages whose rows differed from the page they were derived from. */
  private advanced = 0;
  /** A cursor re-served a page already seen: the walk cannot go further. */
  looped = false;
  /** Per knob, whether BILL was shown to read it. `undefined` = unwitnessable. */
  private readonly verdicts = new Map<keyof CursorPaging, boolean | undefined>();

  constructor(private readonly asked: CursorPaging) {
    const opened = openCursor(asked.page);
    if (opened.cursor) this.cursor = opened.cursor;
    this.callerSealed = Boolean(opened.fingerprint);
    if (opened.fingerprint) {
      this.from = opened.fingerprint;
      this.seen.add(opened.fingerprint);
    }
  }

  /**
   * The paging arguments for the next request, in the caller's vocabulary —
   * `billPagingParams` in the client is the one place they become BILL's.
   */
  get args(): CursorPaging {
    return { page: this.cursor, pageSize: this.asked.pageSize };
  }

  /** Worst verdict wins: one page that proves a knob unread settles it. */
  private record(knob: keyof CursorPaging, verdict: boolean | undefined): void {
    if (this.verdicts.get(knob) === false) return;
    this.verdicts.set(knob, verdict);
  }

  /**
   * One BILL page in; the rows to use out. A page whose cursor did not advance
   * is dropped — those rows are ones the caller already has, and handing them
   * back as a new page is the loop itself.
   */
  observe<T>(rows: T[] | undefined, nextPage?: string): T[] {
    const page = Array.isArray(rows) ? rows : [];
    const fingerprint = pageFingerprint(page);
    // `this.cursor` is still the cursor that produced this page — `params` is
    // derived from it and nothing has advanced it yet.
    const witness: PageWitness = { rows: page, fingerprint, from: this.from };
    this.pages += 1;
    this.widestPage = Math.max(this.widestPage, page.length);

    const size = this.asked.pageSize;
    if (size !== undefined && size !== "") {
      this.record("pageSize", PAGING_SPECS.pageSize.honored(witness, String(size)));
    }

    if (this.cursor !== undefined) {
      // A page repeating one seen earlier in this same walk is the same defect
      // one step further out (A -> B -> A), so it counts as not advancing.
      const repeat = page.length > 0 && this.seen.has(fingerprint);
      const verdict = repeat ? false : PAGING_SPECS.page.honored(witness, this.cursor);
      this.record("page", verdict);
      if (verdict === false) {
        this.looped = true;
        this.loopedRows = page.length;
        this.cursor = undefined;
        return [];
      }
      if (verdict === true) this.advanced += 1;
    }

    this.seen.add(fingerprint);
    this.from = fingerprint;
    this.cursor = nextPage || undefined;
    return page;
  }

  /** True while BILL has offered a cursor that has not been shown to loop. */
  get hasMore(): boolean {
    return Boolean(this.cursor);
  }

  /** The cursor to hand the caller: BILL's, sealed with this page's identity. */
  get nextPage(): string | undefined {
    if (!this.cursor || !this.from) return this.cursor;
    return sealCursor(this.cursor, this.from);
  }

  /**
   * Per knob, one sentence on whether BILL read it — or `undefined` when the
   * caller turned no knob and the walk stayed on one page, so there is nothing
   * to report.
   */
  report(): Record<string, string> | undefined {
    const out: Record<string, string> = {};

    if (this.verdicts.has("pageSize")) {
      const size = this.asked.pageSize;
      out.pageSize =
        this.verdicts.get("pageSize") === false
          ? `not honored — asked BILL for at most ${size} row(s) a page as \`max\` and it returned ${this.widestPage}; ` +
            "the page-size parameter is being ignored"
          : `server — sent as \`max\`; BILL returned at most ${this.widestPage} row(s) a page`;
    }

    if (this.looped) {
      out.page =
        `not honored — BILL re-served the same ${this.loopedRows} row(s) as a page already returned, so the cursor ` +
        "did not advance. Those rows were dropped rather than handed back as new ones, and the walk stops here " +
        "rather than looping; the list cannot be read past this point";
    } else if (this.asked.page && !this.callerSealed) {
      out.page =
        "server — sent as `nextPage`; this cursor was not issued by this tool, so whether it advanced could not be witnessed";
    } else if (this.advanced > 0) {
      out.page =
        `server — sent as \`nextPage\`; ${this.advanced} cursor page(s) fetched here, each carrying rows other than ` +
        "the page the cursor came from";
    }

    return Object.keys(out).length > 0 ? out : undefined;
  }
}
