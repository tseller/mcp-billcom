/**
 * Flattened rows for the QBO entity list tools (purchases, deposits, transfers).
 *
 * QBO returns the full entity on a query, and most of it is envelope rather
 * than information: on live books a Purchase is ~2,083 characters, of which
 * `PurchaseEx` (a JAXB NameValue blob), `domain`, `sparse`, `SyncToken`,
 * `MetaData`, `PrintStatus`, `CustomExtensions`, per-line `TaxCodeRef` /
 * `BillableStatus` and the USD `CurrencyRef` are all scaffolding. A fiscal
 * year of purchases was 199,955 characters — 5x the tool-result budget.
 *
 * A list row keeps what a treasurer reads and what a follow-up API call needs:
 * date, amount, payee/account names WITH their QBO ids, doc number, memo, and
 * the categorization lines. Full fidelity is one `qbo_get_purchase` away.
 *
 * These are pure so paging and size behaviour can be tested against a large
 * book without going near QBO.
 */

import { packRows } from "./result-size.js";

type Ref = { value?: string; name?: string; type?: string };
type Entity = Record<string, unknown>;
type QboLine = Record<string, unknown> & {
  Amount?: number;
  Description?: string;
  DetailType?: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Drop empty values — a key carrying `""`, `null` or `[]` is payload for nothing. */
function trim(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

const ref = (v: unknown): Ref => (v ?? {}) as Ref;

/** USD is the overwhelming default here; only a foreign currency is worth a key. */
function currency(e: Entity): string | undefined {
  const code = ref(e.CurrencyRef).value;
  return code && code !== "USD" ? code : undefined;
}

/**
 * One transaction line: the categorization (account/item), any attributed
 * entity, and the description — dropped when it merely repeats the
 * transaction memo, which QBO's bank-feed imports do on every single line.
 */
function slimLine(line: QboLine, memo?: string): Record<string, unknown> {
  const detail = (line.DetailType ? (line[line.DetailType] as Entity | undefined) : undefined) ?? {};
  const account = ref(detail.AccountRef);
  const item = ref(detail.ItemRef);
  const entity = ref(detail.Entity);
  return trim({
    amount: line.Amount,
    account: account.name,
    accountId: account.value,
    item: item.name,
    itemId: item.value,
    entity: entity.name,
    entityId: entity.value,
    description: line.Description === memo ? undefined : line.Description,
  });
}

function slimLines(e: Entity, memo?: string): Record<string, unknown>[] {
  const lines = Array.isArray(e.Line) ? (e.Line as QboLine[]) : [];
  return lines.map((l) => slimLine(l, memo));
}

/** A purchase/expense: check, cash purchase or credit-card charge. */
export function slimPurchase(p: Entity): Record<string, unknown> {
  const memo = p.PrivateNote as string | undefined;
  const payee = ref(p.EntityRef);
  const account = ref(p.AccountRef);
  return trim({
    id: p.Id,
    date: p.TxnDate,
    amount: p.TotalAmt,
    paymentType: p.PaymentType,
    num: p.DocNumber,
    payee: payee.name,
    payeeId: payee.value,
    account: account.name,
    accountId: account.value,
    memo,
    currency: currency(p),
    lines: slimLines(p, memo),
  });
}

/** A deposit: funds landing in a bank account, credited to income accounts. */
export function slimDeposit(d: Entity): Record<string, unknown> {
  const memo = d.PrivateNote as string | undefined;
  const account = ref(d.DepositToAccountRef);
  return trim({
    id: d.Id,
    date: d.TxnDate,
    amount: d.TotalAmt,
    num: d.DocNumber,
    depositTo: account.name,
    depositToId: account.value,
    memo,
    currency: currency(d),
    lines: slimLines(d, memo),
  });
}

/** A transfer between two of our own accounts. */
export function slimTransfer(t: Entity): Record<string, unknown> {
  const from = ref(t.FromAccountRef);
  const to = ref(t.ToAccountRef);
  return trim({
    id: t.Id,
    date: t.TxnDate,
    amount: t.Amount,
    from: from.name,
    fromId: from.value,
    to: to.name,
    toId: to.value,
    memo: t.PrivateNote,
    currency: currency(t),
  });
}

/** Pull the entity array out of a QBO `QueryResponse` (absent when nothing matched). */
export function queryRows(raw: unknown, entity: string): Entity[] {
  const list = (raw as { QueryResponse?: Record<string, unknown> } | undefined)?.QueryResponse?.[
    entity
  ];
  return Array.isArray(list) ? (list as Entity[]) : [];
}

export interface EntityListInput {
  /** QBO entity name, e.g. "Purchase". */
  entity: string;
  /** Response key for the rows, e.g. "purchases". */
  key: string;
  /** This window's rows, already slimmed, in QBO order. */
  rows: Record<string, unknown>[];
  /** 1-based position of `rows[0]` in the whole filtered set. */
  startPosition: number;
  /** What we asked QBO for — a full window means there may be more after it. */
  maxResults: number;
  /** COUNT(*) over the whole filter, when the count query succeeded. */
  rowCount?: number;
  /** Echoed filters (date range, account, vendor) for a self-describing result. */
  filters?: Record<string, unknown>;
}

/**
 * One page of an entity list, bounded by BOTH the caller's `maxResults` and
 * the result-size budget, with a single paging coordinate: `startPosition`.
 *
 * `rowCount` covers the whole filtered range (a separate COUNT(*) query);
 * `pageTotal` covers this page only — QBO's query language has no SUM, so a
 * whole-range amount would mean fetching every page.
 */
export function buildEntityList({
  entity,
  key,
  rows,
  startPosition,
  maxResults,
  rowCount,
  filters = {},
}: EntityListInput): Record<string, unknown> {
  const page = packRows(rows, 0, maxResults);
  const returned = page.rows.length;

  // Two independent reasons there can be more: the size budget cut this
  // window short, or QBO has rows past the window we asked for.
  const sizeTruncated = returned < rows.length;
  const morePastWindow =
    rowCount !== undefined ? startPosition - 1 + rows.length < rowCount : rows.length >= maxResults;
  const hasMore = sizeTruncated || morePastWindow;
  const nextStartPosition = startPosition + returned;

  const pageTotal = round2(
    page.rows.reduce((s, r) => s + (typeof r.amount === "number" ? r.amount : 0), 0),
  );

  const lastShown = startPosition + returned - 1;
  return {
    entity,
    ...trim(filters),
    ...(rowCount !== undefined ? { rowCount } : {}),
    startPosition,
    returned,
    pageTotal,
    hasMore,
    ...(hasMore
      ? {
          nextStartPosition,
          truncatedBy: sizeTruncated ? "size" : "window",
          note:
            `Showing ${returned === 0 ? "no rows" : `${startPosition}-${lastShown}`}` +
            `${rowCount !== undefined ? ` of ${rowCount}` : ""}. ` +
            `Call again with startPosition: ${nextStartPosition} for the rest. ` +
            `\`rowCount\` covers the whole range; \`pageTotal\` is this page only.`,
        }
      : {}),
    [key]: page.rows,
  };
}
