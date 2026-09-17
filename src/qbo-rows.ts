/**
 * Flattened rows for the QBO entity list tools (purchases, deposits, transfers,
 * accounts, vendors).
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

import { describeEmpty, type Witness } from "./empty-listing.js";
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

/**
 * A chart-of-accounts row: what you read to pick an account, plus the id every
 * other tool asks for. QBO's `Account` adds `domain`, `sparse`, `SyncToken`,
 * `MetaData`, `FullyQualifiedName` (the parent name re-spelled), `CurrencyRef`,
 * `AccountSubType` and `CurrentBalanceWithSubAccounts` — 53,799 characters for
 * one live chart of accounts, past the tool-result budget with no argument to
 * narrow, since the tool took none.
 *
 * `active` is emitted only when the account is INACTIVE: the listing filters to
 * active accounts by default, so `true` on every row is a repeated constant.
 */
export function slimAccount(a: Entity): Record<string, unknown> {
  const parent = ref(a.ParentRef);
  return trim({
    id: a.Id,
    name: a.Name,
    num: a.AcctNum,
    type: a.AccountType,
    classification: a.Classification,
    balance: a.CurrentBalance,
    parent: a.SubAccount ? parent.name : undefined,
    parentId: a.SubAccount ? parent.value : undefined,
    active: a.Active === false ? false : undefined,
    currency: currency(a),
  });
}

/**
 * A vendor row: who they are, how to reach them, what we owe them, and the id.
 * QBO's `Vendor` adds `BillRate`, `CostRate`, `Vendor1099`, `CurrencyRef`,
 * `domain`, `sparse`, `SyncToken`, `MetaData`, `V4IDPseudonym` and the
 * `GivenName`/`MiddleName`/`FamilyName`/`PrintOnCheckName` re-spellings of the
 * display name — which is why `maxResults: 1000`, the tool's own advertised
 * maximum, came back over budget.
 *
 * `company` is dropped when it merely repeats the display name (the common case
 * on these books), and `active` is emitted only when the vendor is inactive.
 */
export function slimVendor(v: Entity): Record<string, unknown> {
  const company = v.CompanyName as string | undefined;
  return trim({
    id: v.Id,
    name: v.DisplayName,
    company: company === v.DisplayName ? undefined : company,
    email: (v.PrimaryEmailAddr as { Address?: string } | undefined)?.Address,
    phone: (v.PrimaryPhone as { FreeFormNumber?: string } | undefined)?.FreeFormNumber,
    balance: v.Balance ? v.Balance : undefined,
    active: v.Active === false ? false : undefined,
    currency: currency(v),
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
  /**
   * Row field summed into `pageTotal` (default `amount`). Pass `null` for a
   * listing where a per-page sum states nothing true: a chart of accounts adds
   * assets to liabilities to income, and a page of vendor balances is a slice
   * of what we owe, not a total. An omitted `pageTotal` beats a misleading one.
   */
  sumField?: string | null;
  /** Echoed filters (date range, account, vendor) for a self-describing result. */
  filters?: Record<string, unknown>;
  /**
   * Independent sources consulted for this result, for the zero-row case.
   * Omitted means none were, and the `empty` block says so rather than letting
   * a bare `[]` read as "there are none" (see `src/empty-listing.ts`).
   */
  witnesses?: Witness[];
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
  sumField = "amount",
  filters = {},
  witnesses,
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

  const pageTotal =
    sumField === null
      ? undefined
      : round2(
          page.rows.reduce((s, r) => {
            const v = r[sumField];
            return s + (typeof v === "number" ? v : 0);
          }, 0),
        );

  const lastShown = startPosition + returned - 1;
  return {
    entity,
    ...trim(filters),
    ...(rowCount !== undefined ? { rowCount } : {}),
    startPosition,
    returned,
    ...(pageTotal !== undefined ? { pageTotal } : {}),
    hasMore,
    ...(returned === 0 ? { empty: describeEmpty(witnesses) } : {}),
    ...(hasMore
      ? {
          nextStartPosition,
          truncatedBy: sizeTruncated ? "size" : "window",
          note:
            `Showing ${returned === 0 ? "no rows" : `${startPosition}-${lastShown}`}` +
            `${rowCount !== undefined ? ` of ${rowCount}` : ""}. ` +
            `Call again with startPosition: ${nextStartPosition} for the rest. ` +
            `\`rowCount\` covers the whole range` +
            `${pageTotal !== undefined ? "; `pageTotal` is this page only" : ""}.`,
        }
      : {}),
    [key]: page.rows,
  };
}
