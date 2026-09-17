/**
 * Flattened rows for the Divvy (BILL Spend & Expense) list tools, and the
 * cursor-paged envelope they come back in.
 *
 * BILL returns the full transaction object on a list, and most of it is
 * envelope rather than information: on live books the default call at BILL's
 * own maximum page size (50) is 93,704 characters — over twice the
 * tool-result budget, so the everyday call simply failed. The flattened row
 * existed, behind `compact: true`; the same 50 transactions are 14,973
 * characters that way. Nothing was missing but the default.
 *
 * A row keeps what a treasurer reads and what a follow-up call needs: the
 * date, who spent it, where, how much, whether the receipt and the sync are
 * done, and both ids (`id` for a deep link or `divvy_get_transaction`, `uuid`
 * for the receipt/custom-field writes). Full fidelity is one
 * `divvy_get_transaction` away, or `format: "raw"` for a whole page of it.
 *
 * Pure, so the row shape and the paging/size behaviour can be tested against a
 * large page without going near BILL.
 */

import { rowSyncStatus } from "./divvy-filters.js";
import { packRows } from "./result-size.js";

type Tx = Record<string, unknown>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One transaction as a row. The filled custom fields (NAP CODES, Notes)
 * collapse from BILL's array of field objects to a `name: value` map — the
 * definitions are `divvy_list_custom_fields`, not something to repeat on every
 * row — and an empty field is dropped rather than carried as `""`.
 */
export function slimTransaction(tx: Tx): Record<string, unknown> {
  const customFields = Array.isArray(tx.customFields)
    ? (tx.customFields as Array<{ name?: string; selectedValues?: unknown[]; note?: string }>)
    : [];
  const fields: Record<string, string> = {};
  for (const f of customFields) {
    if (!f.name) continue;
    const selected = (f.selectedValues ?? [])
      .map((v) => {
        if (typeof v === "string") return v;
        const o = v as { value?: unknown; label?: unknown; name?: unknown };
        return String(o.value ?? o.label ?? o.name ?? "");
      })
      .filter(Boolean);
    const value = selected.length > 0 ? selected.join(", ") : (f.note ?? "").trim();
    if (value) fields[f.name] = value;
  }
  return {
    id: tx.id,
    uuid: tx.uuid,
    date: String(tx.occurredTime ?? "").slice(0, 10),
    status: tx.status,
    user: tx.userName,
    merchant: tx.merchantName,
    amount: tx.amount,
    receiptStatus: tx.receiptStatus,
    // BILL states the accounting sync on a nested integration record, not a
    // top-level `syncStatus` — reading the top-level name meant the row this
    // tool advertises as carrying a sync status never carried one.
    syncStatus: rowSyncStatus(tx),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

/**
 * One option value of a custom field (a NAP code). BILL sends `deleted` on
 * every row and it is `false` on every live one, so it is carried only when it
 * is true — a repeated constant is payload for nothing (the same reason
 * `slimAccount` emits `active` only when a row is inactive).
 */
export function slimCustomFieldValue(v: Tx): Record<string, unknown> {
  return {
    id: v.id,
    uuid: v.uuid,
    value: v.value,
    ...(v.deleted === true ? { deleted: true } : {}),
  };
}

export interface CursorListInput {
  /** Record type, e.g. "Transaction". */
  entity: string;
  /** Response key for the rows, e.g. "transactions". */
  key: string;
  /** This BILL page's rows, already slimmed, in BILL order. */
  rows: Record<string, unknown>[];
  /** BILL's cursor for the page after this one, when it gave one. */
  nextPage?: string;
  /** Row field summed into `pageTotal` (default `amount`); `null` to omit. */
  sumField?: string | null;
  /** Echoed filters (date range, budget, status) for a self-describing result. */
  filters?: Record<string, unknown>;
  /**
   * Per filter, how it was actually enforced — server-side, dropped here, or
   * sent and not honored (see `FilterCheck`, src/divvy-filters.ts). Echoing a
   * filter says only what was asked; this says what happened, which is the
   * difference between #29 being invisible and being stated in the result.
   */
  filtering?: Record<string, string>;
  /**
   * Per paging knob, whether BILL was shown to read it (see `PagingCheck`,
   * src/divvy-paging.ts). Same idea as `filtering`, for the parameters that
   * decide which rows come back rather than which ones stay.
   */
  paging?: Record<string, string>;
  /**
   * BILL's cursor did not advance — it re-served a page already returned, so
   * the walk stopped here rather than looping (issue #33). There is no cursor
   * to hand back, and `hasMore` says so rather than claiming the list ended.
   */
  cursorStalled?: boolean;
  /** BILL pages consumed for this one result, when more than one. */
  billPages?: number;
}

/**
 * One page of a BILL list, bounded by the result-size budget, stated in the
 * same vocabulary as the QBO lists — `returned`, `hasMore`, `truncatedBy`,
 * `pageTotal`, `note` — with the one difference BILL forces: the position is
 * its opaque `nextPage` cursor, not a row offset.
 *
 * That difference is why the `hasMore` reasons need different advice.
 * `window` — BILL has more pages — resumes with `page: nextPage`. `size` — the
 * budget cut this page short — cannot: the cursor points past the whole BILL
 * page, so following it would silently skip the rows we dropped. The way
 * forward there is the SAME `page` again with a smaller `pageSize`, and the
 * note says so. `cursor` — BILL re-served a page already returned — has no way
 * forward at all, and says that rather than handing back a cursor that loops.
 *
 * There is no `rowCount`: BILL's list returns neither a total nor a page
 * count, and an omitted count beats an invented one.
 */
export function buildCursorList({
  entity,
  key,
  rows,
  nextPage,
  sumField = "amount",
  filters = {},
  filtering,
  paging,
  cursorStalled = false,
  billPages,
}: CursorListInput): Record<string, unknown> {
  const page = packRows(rows, 0, undefined);
  const returned = page.rows.length;
  const sizeTruncated = returned < rows.length;
  const hasMore = sizeTruncated || cursorStalled || Boolean(nextPage);

  const pageTotal =
    sumField === null
      ? undefined
      : round2(
          page.rows.reduce((s, r) => {
            const v = r[sumField];
            return s + (typeof v === "number" ? v : 0);
          }, 0),
        );

  const note = sizeTruncated
    ? `Showing ${returned} of the ${rows.length} rows on this page — the size budget cut it short. ` +
      "Call again with the SAME `page` and a smaller `pageSize`; `nextPage` starts after all " +
      `${rows.length} rows, so following it here would skip the rest of this page.`
    : cursorStalled
      ? "BILL's cursor did not advance — it re-served a page already returned, so the rest of this list " +
        "cannot be reached by paging. `paging.page` says so; there is no cursor to follow."
      : `Showing ${returned} row${returned === 1 ? "" : "s"}. Call again with \`page: nextPage\` for the next page` +
        `${pageTotal !== undefined ? "; `pageTotal` is this page only" : ""}.`;

  return {
    entity,
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== "")),
    ...(filtering && Object.keys(filtering).length > 0 ? { filtering } : {}),
    ...(paging && Object.keys(paging).length > 0 ? { paging } : {}),
    ...(billPages !== undefined && billPages > 1 ? { billPages } : {}),
    returned,
    ...(pageTotal !== undefined ? { pageTotal } : {}),
    hasMore,
    ...(hasMore
      ? {
          ...(sizeTruncated || cursorStalled ? {} : { nextPage }),
          truncatedBy: sizeTruncated ? "size" : cursorStalled ? "cursor" : "window",
          note,
        }
      : {}),
    [key]: page.rows,
  };
}
