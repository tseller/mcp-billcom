# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server for Bill.com API integration. The project is in early development.

## GCP

- **Project**: `mcp-servers-487419`
- **Account**: `tseller@gmail.com`
- **gcloud configuration**: `mcp-billcom`

Always activate the correct configuration before running gcloud commands:
```
gcloud config configurations activate mcp-billcom
```

## Development

- `npm run build` — compile TypeScript to `dist/`
- `npm run dev` — run with tsx (loads `.env` automatically)
- `npm start` — run compiled output (loads `.env` automatically)
- `npm test` — node:test unit tests (`src/**/*.test.ts`)
- Inspector: `npx @modelcontextprotocol/inspector node --env-file=.env --import=tsx src/index.ts`
- Drive the **deployed** service end-to-end (handshake + one tool call, against live QBO):
  ```
  export MCP_TOKEN=$(gcloud secrets versions access latest --secret=MCP_API_TOKEN \
    --project=mcp-servers-487419 --account=tseller@gmail.com)
  scripts/mcp-call.sh --list
  scripts/mcp-call.sh qbo_transaction_report '{"startDate":"2026-05-01","endDate":"2026-06-30"}'
  ```

## Architecture

- **ESM project** using TypeScript with Node16 module resolution
- `src/index.ts` — entry point: registers QBO and/or Divvy tools based on available env vars
- `src/qbo-client.ts` — QuickBooks Online API client with OAuth2 token refresh (rolling refresh tokens)
- `src/oauth.ts` — OAuth2 server (Google-backed) for MCP HTTP auth
- `src/http-server.ts` — Streamable HTTP transport for Cloud Run deployment
- `src/tools/qbo-accounts.ts` — QBO: list_accounts (flattened rows + paging), account_balances
- `src/tools/qbo-vendors.ts` — QBO: list_vendors, search_vendors (both flattened rows + paging), create_vendor
- `src/tools/list-paging.ts` — the paging vocabularies, each paired with the sentence that names its knobs when a result is over budget (so advice and schema can't drift): `listPaging(defaultMaxResults)` (`startPosition`/`maxResults`/`format`, the QBO entity queries), `OFFSET_PAGING_NARROWING` (the `offset`/`limit` report tools) and `CURSOR_PAGING` (`page`/`pageSize`/`format`, BILL's opaque cursor)
- `src/tools/qbo-transactions.ts` — QBO: list/get/update/create purchases; list/get/create/update deposits (single + batch); list/create transfers; create journal entries; attach/list files. Create tools accept an optional `idempotencyKey`; update tools fetch-then-merge fields QBO requires on full-entity validation (PaymentType/AccountRef on Purchase, DepositToAccountRef on Deposit). The three list tools return **flattened rows** and **page by size as well as row count** — see "Tool result size" below
- `src/qbo-rows.ts` — the flattened row shapes for every list tool (`slimPurchase`/`slimDeposit`/`slimTransfer`/`slimAccount`/`slimVendor`) plus `buildEntityList()`, which packs one page and states `rowCount` / `hasMore` / `nextStartPosition`. `sumField: null` omits `pageTotal` for a listing where a per-page sum states nothing true (a chart of accounts adds assets to liabilities)
- `src/tool-logging.ts` — `runTool()`, the single response path every tool goes through: start/finish logging, `compact()` serialization, and the result-size budget. A handler returns plain data (or a string) and never builds an MCP response itself
- `src/tools/qbo-classes.ts` — QBO: list_classes, create_class (the season tags). Class names are never hardcoded — seasons become year-specific ("Fall 2026")
- `src/tools/qbo-class-reports.ts` — QBO: class_transactions, profit_loss_by_class. **TransactionList cannot return a class**: it silently drops the `klass_name` column (verified against a bogus-column control), so class-aware listing is built on **GeneralLedger**, the only report returning both the posting Account and the Class. The class filter param is `class` (not `classid`, which is ignored) and QBO echoes an applied filter back as `Header.Class` — `QboClient.classReport` asserts that echo so a silently-dropped filter can't pose as a real answer. These reports default to **Accrual** because the company default is Cash, which would break deferred revenue
- `src/tools/qbo-class-writes.ts` — QBO: set_transaction_class (+ batch) — the only sanctioned way to class an existing transaction
- `src/tools/qbo-budgets.ts` — QBO: list_budgets, budget_vs_actuals. The Budget entity is **read-only** via the API (build budgets in the web UI), and there is **no budget report at all**: `BudgetVsActuals`/`BudgetSummary` return `5020 Permission Denied`, exactly as an invented report name does. So budget-vs-actuals is computed — `src/budget-actuals.ts` joins BudgetDetail (account × class) to a P&L summarised by class
- `src/class-lines.ts` — line-preserving edits. Class writes **never rebuild a line**: they deep-copy QBO's own lines and write only `ClassRef`, then `diffPaths` re-checks that nothing else moved and the write is refused if it did. This exists because the update tools' `lines` array can express 3 fields while a live line carries up to 7 (`Id`, `TaxCodeRef`, `BillableStatus`, `CustomerRef`, `LineNum`), so a rebuild silently dropped the rest — hence `mergeLinePatches` (edit by `lineId`) and the explicit `replaceAllLines` flag on the update tools
- `src/scripts/verify-class-live.ts` — read-only live/sandbox verification of the class tooling (`npx tsx src/scripts/verify-class-live.ts`; set `QBO_BASE_URL` + env credentials for a sandbox company)
- `src/tools/qbo-reports.ts` — QBO: transaction_report (optional `cleared` reconcile-status filter), profit_loss, balance_sheet. `qbo_transaction_report` returns **flattened, compact rows** (not QBO's nested report JSON) and **pages automatically** — see "Tool result size" below
- `src/result-size.ts` — the shared tool-result size discipline: `MAX_RESULT_CHARS` budget, `compact()` serialization, `packRows()` paging. Enforced for **every** tool by `runTool`, not opted into per tool
- `src/tools/qbo-reconcile.ts` — QBO: reconcile_worksheet (stitches Uncleared/Cleared TransactionList calls into a per-account reconcile worksheet, computes the difference vs the paper statement's beginning/ending balance), cleared_transactions (list by reconcile status). QBO's Accounting API has **no public Reconcile entity** — you cannot mark items cleared or finalize a reconcile via API; that step is manual in the QBO web UI. The API only exposes reconcile status as the TransactionList report's `cleared` filter (`Reconciled`/`Cleared`/`Uncleared`), filter-only (never per-row), so a worksheet must run one call per status and stitch. Report parsing lives in `parseTransactionList` (src/qbo-client.ts)
- `src/tools/divvy.ts` — Divvy/BILL Spend & Expense: list_transactions (flattened rows + cursor paging), get_transaction, upload_receipt, custom fields, cards, members, budgets, list_pending_action
- `src/divvy-filters.ts` — every filter `divvy_list_transactions` advertises, declared once as a pair: the term BILL is sent (`FILTER_SPECS[name].terms`) and the same question asked of a row that comes back (`.matches`). `FilterCheck` runs the second against every row of every BILL page walked, drops the rows that fail, and reports per filter how it was actually enforced — see "Filters" below
- `src/divvy-paging.ts` — the same treatment for the paging parameters: each knob declared once as the BILL query parameter it becomes (`pageSize`→`max`, `page`→`nextPage`) and the question asked of the page that comes back. `PagingCheck` is the cursor state machine for a call; the cursor it hands out carries a fingerprint of the page it came after, so a cursor that re-serves its own page is caught on the next call — see "Paging" below
- `src/divvy-rows.ts` — the flattened Divvy rows (`slimTransaction`, `slimCustomFieldValue`) plus `buildCursorList()`, the cursor-paged twin of `buildEntityList()`: same `returned`/`pageTotal`/`hasMore`/`truncatedBy`/`note` vocabulary, but the position is BILL's opaque `nextPage`. No `rowCount` — BILL's list returns no total, and an omitted count beats an invented one
- `src/protocol-version.ts` — MCP protocol-version negotiation + header reconciliation (see "Protocol version" below)
- `src/idempotency.ts` — idempotency-key store for create tools (Firestore in HTTP mode, in-memory for stdio)
- `src/gmail-client.ts` — Gmail attachment fetch for qbo_attach_file (per-account refresh tokens)
- `src/scripts/gmail-link.ts` — one-time bootstrap to mint a Gmail refresh token (`npm run gmail:link`)
- SDK: `@modelcontextprotocol/sdk` ^1.26.0
- All logging goes to stderr (stdout is MCP protocol)

## Tool result size

A tool result is only useful if the MCP client accepts it. Report tools used to
emit `JSON.stringify(report, null, 2)` of QBO's nested report JSON — ~840 chars
per transaction row, so a two-month TransactionList is ~52,000 chars (~13,000
tokens) and a fiscal year ~470,000. The server never complained; the failure
landed past our edge at the client's per-result cap and looked like a bare
"the tool errored", with nothing in the Cloud Run logs.

The discipline lives in `src/result-size.ts`, and it is the **default** rather
than something each tool opts into: every tool response goes through `runTool`
(`src/tool-logging.ts`), which serializes with `compact()` and refuses anything
over budget. A tool written tomorrow inherits it without knowing this exists;
paging is what turns that refusal into a usable answer.

- `MAX_RESULT_CHARS` (40,000 ≈ 10k tokens) is the budget for one tool result.
- `compact()` — no pretty-printing (indentation alone was ~25% of a payload).
- `packRows()` — takes the largest slice that fits both the caller's `limit`
  and the budget; the result carries `rowCount` (whole range), `offset`,
  `returned`, `hasMore`, `nextOffset` and a `note` saying how to get the rest.
- Over budget is a named error stating the size and how to narrow the request —
  never a silent oversized payload. The advice names **this** tool's paging
  knobs: each vocabulary in `src/tools/list-paging.ts` carries its own sentence
  (`startPosition`/`maxResults`, `offset`/`limit`, `page`/`pageSize`) and the
  tool passes it to `runTool`. One shared sentence naming QBO's knobs was how
  `divvy_list_transactions` came to tell callers to pass four parameters it does
  not accept; a tool with no paging arguments now names none rather than
  borrowing another tool's.

What this means in practice:

- `qbo_transaction_report` and `qbo_cleared_transactions` accept `offset`/`limit`
  and page. **No date range is too long** — a long one just takes more calls.
  Aggregates (`total`) always cover the whole range, not the page.
- `qbo_list_accounts` / `qbo_list_vendors` / `qbo_search_vendors` page the same
  way. An `Account` row keeps id, name, account number, type, classification,
  balance and a sub-account's parent (dropping `FullyQualifiedName`,
  `AccountSubType`, `CurrentBalanceWithSubAccounts`, `CurrencyRef` and the
  usual envelope); a `Vendor` row keeps id, display name, company (only when it
  differs from the display name), email, phone and a non-zero balance (dropping
  `BillRate`, `CostRate`, `Vendor1099`, `V4IDPseudonym`, `PrintOnCheckName` and
  the `GivenName`/`MiddleName`/`FamilyName` re-spellings). `active` is emitted
  only when a row is INACTIVE — these listings are active-only, so `true` on
  every row is a repeated constant. Neither states a `pageTotal`.
  Live books, measured on revision `billcom-mcp-00062-k55`: the whole chart of
  accounts (`qbo_list_accounts {}`, 108 rows) is 12,720 chars, down from a
  53,799-char refusal on a tool that took no arguments to narrow; every vendor
  at the schema's own maximum (`{"maxResults":1000}`, 76 rows) is 4,042 chars,
  down from a 40,590-char refusal.
- `qbo_list_purchases` / `qbo_list_deposits` / `qbo_list_transfers` return
  flattened rows (`src/qbo-rows.ts`) and page on ONE coordinate: when `hasMore`
  is true, call again with `startPosition: nextStartPosition`. `rowCount` is a
  separate `SELECT COUNT(*)` covering the whole filter (QBO's own `totalCount`
  on a query is only the page it just returned); `pageTotal` is this page only,
  because QBO's query language has no SUM. Both `hasMore` reasons are reported
  via `truncatedBy`: `size` (the budget cut the window short) or `window`
  (QBO has rows past what we asked for). `format: "raw"` still returns the full
  entities, and is refused if it exceeds the budget.
- Live books, a fiscal year of purchases (2025-07-01..2026-06-30, 96 rows,
  measured on revision `billcom-mcp-00061-qnj`): 199,955 chars before →
  38,189 for 92 rows, then a 4-row second page at `startPosition: 93`
  (2,083 → 415 chars per row, 5x). The QBO entity's `PurchaseEx` (a JAXB blob),
  `domain`, `sparse`, `SyncToken`, `MetaData`, `PrintStatus`,
  `CustomExtensions` and the USD `CurrencyRef` are envelope; a row keeps date,
  amount, payee/account names WITH their ids, doc number, memo and the
  categorization lines. Full fidelity is one `qbo_get_purchase` away.
  The same range with `format: "raw"` is 123,152 chars and is refused by name.
- Live books, 2026-05-01..2026-06-30: 62 rows, 52,180 chars before → 19,789
  after (2.6x), one page. Roughly 120-180 rows per page at those memo lengths.
- `divvy_list_transactions` returns flattened rows (`src/divvy-rows.ts`) **by
  default**. The row shape existed from the start but behind `compact: true`,
  so the everyday call — the default, at BILL's own maximum page size of 50 —
  was 93,704 chars and failed. A default nobody has to know about is the fix,
  so `format: "raw"` is now the opt-in (for one transaction in full,
  `divvy_get_transaction`). Live books, one 50-row page
  (`{"startDate":"2026-05-01","endDate":"2026-06-30","pageSize":"50"}`,
  measured on revision `billcom-mcp-00063-2qh`): 93,704 chars before →
  **15,216** (6x), and `format: "raw"` on the same page is still 93,704 and
  refused by name. (That date range narrowed nothing when this was measured —
  BILL ignored the parameter names the tool was sending and returned the newest
  page whatever you asked for, issue #29, found while verifying this. It does
  narrow now; see "Filters" below.)
  BILL's cursor is an opaque `nextPage` string, not a row offset, so this list
  keeps `page`/`pageSize` rather than pretending to be `startPosition`; every
  other field means what it does on the QBO lists. When `truncatedBy` is
  `size` the cursor is **withheld**: it points past the whole BILL page, so
  following it would skip the rows the budget dropped — the note says to
  re-request the same `page` with a smaller `pageSize`.
- `qbo_reconcile_worksheet` truncates the *listing* (never the balances or the
  verdict) with an explicit note pointing at the paged tool.
- `qbo_profit_loss` / `qbo_balance_sheet` are hierarchical with nothing sane to
  page, so over budget is a named error stating the size — not a silent failure.
- QBO answers some failures with **HTTP 200 and a `Fault` body** (a malformed
  date, for one). `qboFaultMessage` is checked in `report()`, `query()` and
  `request()` so a Fault raises a tool error instead of flowing on as data.
- Rejected `/mcp` requests are logged with the rpc method, session and
  `MCP-Protocol-Version`, so a request the transport turns away is readable in
  Cloud Run logs rather than an anonymous 400.

## Filters

A filter is only a filter if the rows that come back obey it.

`divvy_list_transactions` sent `start_date` / `end_date` / `budget_id` /
`sync_status` as query parameters. BILL's v3 `/spend/transactions` does not
read those names, and answers **HTTP 200 with an unfiltered page** rather than
rejecting the unknown parameter — so a treasurer reconciling May-June got
August-September, the call succeeded, and nothing in the response said the
filter had done nothing. `budgetId` and `syncStatus` were dead the same way,
as was `since` on `divvy_list_pending_action`.

The wrong parameter name was the instance. The structure that allowed it is
that the tool had no way to tell an applied filter from an ignored one: it sent
a filter and assumed. So a filter is now declared as a **pair**, in
`src/divvy-filters.ts`:

- `terms(value)` — what BILL is asked, in its own `field:operator:value`
  grammar, comma-joined into the `filters` query parameter;
- `matches(row, value)` — the same question asked of a row that came back.

`FilterCheck` runs `matches` over every row of every BILL page, drops the rows
that fail, and returns a `filtering` block in the result saying per filter how
it was really enforced — `server`, `client`, or *sent and not honored*. A
filter BILL ignores therefore cannot silently return the wrong rows; it drops
them and says so. A filter BILL has no field for (`status`) takes the same path
with no terms and reads as client-side rather than posing as a server filter.
The tool's schema and `FILTER_SPECS` are pinned to each other by a test, so a
filter added later cannot be sent without declaring how a row is checked
against it.

What BILL actually supports on `/v3/spend/transactions`, probed against live
books on 2026-09-17 (it validates both field and operator, so this is BILL's
own answer):

| field | operators | notes |
| --- | --- | --- |
| `occurredTime` | `gte`, `lte` only | `eq`/`gt`/`lt`/`ne`/`in`/`sw` are 400s |
| `budgetId` | `eq` | either the base64 `budgetId` or the `bgt_…` uuid |
| `syncStatus` | `eq` | `PENDING`/`SYNCED`/`ERROR`/`MANUAL_SYNCED`/`NOT_SYNCED` |
| `status` | — | not a filter field at all (400) — client-side only |

Traps worth knowing:

- Terms must be **comma-joined** in one `filters` parameter. Repeating the
  parameter, or joining with a semicolon, is accepted and silently ignored —
  the same failure mode as the original bug.
- The value cannot carry a time: `occurredTime:lte:2026-06-26T23:59:59` fails
  the `field:operator:value` split on its colons. A date-only `lte` means that
  day at 00:00, which **excludes the day itself** — `lte:2026-06-26` returns
  nothing for a transaction at `2026-06-26T10:50`. `endDate` therefore asks
  BILL for the day after and trims the overhang client-side; `sentBound` on the
  spec is what keeps that deliberate widening from reading as BILL ignoring us.
- BILL states a transaction's accounting sync on a nested
  `accountingIntegrationTransactions[].syncStatus` (lower-case `"synced"`), and
  omits the record entirely when nothing synced. There is no top-level
  `syncStatus`, so the row this tool advertises as carrying a sync status
  carried none until `slimTransaction` was pointed at the nested record.
- When client-side filtering empties a page, the tool walks BILL's cursor to
  refill it, bounded at 10 BILL pages per call and entered **only** when rows
  were actually dropped — so the healthy path is still one BILL call. The
  result states `billPages` when more than one was consumed. One consequence:
  `returned` can **exceed** `pageSize`, because a result may span more than one
  BILL page and a partial BILL page has no cursor to hand back.

Live books, measured on revision `billcom-mcp-00064-rnq`. Asking for
2026-05-01..2026-06-30 returned 50 rows dated 2026-08-02..2026-09-16 (all 50
outside the range); it now returns the 6 rows that are in it, `hasMore: false`,
and none outside. Walked to the last page, the row count grows with the range —
6 / 53 / 105 / 185 for two months, three, four and a half, and fourteen —
where before every one of those asks returned the same newest 50 rows. A
single-day ask (`2026-06-26`..`2026-06-26`) returns the one transaction that
day, which is the midnight-`lte` trap above.

## Paging

A cursor is only a cursor if the page it returns is a different page.

`divvy_list_custom_field_values` advertised `page` and `pageSize` and sent them
as `page` / `page_size`. BILL's v3 `/spend/custom-fields/{id}/values` reads
**neither** — it wants `max` and `nextPage`, the same two names the transactions
endpoint uses — and, exactly as with the filters above, it answers **HTTP 200
with page 1** rather than rejecting a parameter it doesn't know. So the tool's
own instruction ("use page … and pageSize to walk the full list") could not be
followed: a caller walking the NAP-code list got the same first 20 values back
forever, behind a `nextPage` that never advanced. An infinite loop wearing the
shape of a working paged API (issue #33).

Probed against live books on 2026-09-17, on that endpoint:

| request | rows | note |
| --- | --- | --- |
| *(no parameters)* | 20 | BILL's default page |
| `?page_size=3` | 20 | what the tool sent — ignored |
| `?pageSize=3` | 20 | ignored |
| `?bogusParam=7` | 20 | the control: an unknown parameter is never refused |
| `?max=3` | 3 | honored |
| `?max=3&page=<cursor>` | 3 | **page 1 again**, and `nextPage` = the cursor sent |
| `?max=3&nextPage=<cursor>` | 3 | advanced |
| `?max=101` | — | `400 max: must be less than or equal to 100` |

Renaming two parameters would have fixed that instance and left the structure
untouched. So paging is declared the way filters are, in `src/divvy-paging.ts`:

- `PAGING_SPECS[knob].param` / `.send()` — the query parameter BILL is asked on
  (`pageSize`→`max`, `page`→`nextPage`) and the value sent;
- `.honored(page, value)` — the same question asked of the page that came back:
  `true` shown to be read, `false` shown not to be, `undefined` unwitnessable —
  which is *stated*, never rounded up to "honored".

The witness for a cursor is the cheap honest one: a cursor is derived from a
page, so a cursor that re-serves the rows it was derived from has not advanced.
To have that comparison on hand, the cursor handed to a caller is BILL's cursor
with a fingerprint of that page sealed onto it (`<billCursor>~<fingerprint>`);
the seal is stripped before the request, so BILL only ever sees its own cursor.
A bare BILL cursor pasted by hand still works — it carries no witness, and the
result says so rather than claiming the cursor advanced.

What this means in practice:

- `divvy_list_custom_field_values` and `divvy_list_transactions` both return a
  `paging` block saying per knob how it was really enforced — the twin of
  `filtering`. A `pageSize` BILL ignores reads as *not honored*, naming the
  rows asked for and the rows returned.
- A cursor that does not advance **stops the walk**: the repeated rows are
  dropped rather than handed back as new ones (they are rows the caller already
  has — returning them *is* the loop), no cursor is handed back, and
  `truncatedBy` is `cursor` alongside the `paging.page` sentence. The three
  `truncatedBy` reasons are now `window` (follow `page: nextPage`), `size`
  (re-request the SAME `page` with a smaller `pageSize`) and `cursor` (there is
  no way forward; the list cannot be read past here).
- The check is an accumulator, so it also covers the walks *inside* one call —
  `divvy_list_transactions` refilling a filtered page, and
  `listPendingAction` walking to the end. It replaced that walk's
  `next === cursor` string comparison, which a backend re-serving a page under
  a *new* cursor string walks straight past.
- `divvy_list_custom_field_values` asks for `max=100` (BILL's maximum on that
  endpoint) by default, so the whole NAP-code list is one call, and returns
  flattened rows: `id`, `uuid`, `value`, and `deleted` only when true.
- A test pins the tools' schemas to `PAGING_SPECS`, and another asserts the
  **wire** — that both BILL list requests go out carrying `max` and `nextPage`
  and neither `page` nor `page_size`. Asserting the wrapper is what let #33
  live; the query string is where the bug was.

Live books, measured on revision `billcom-mcp-00065-xxx` (see "Proof" in issue
#33): the NAP CODES field has **72** values. Before, every call returned the
same first 20 with a `nextPage` that never moved; now one call returns all 72
with `hasMore: false`.

## Protocol version

A Streamable HTTP client echoes an `MCP-Protocol-Version` header on every
request after `initialize`, and the SDK transport refuses a version it doesn't
know with `400 Bad Request: Unsupported protocol version` **before any tool
runs**. Tim's Claude connector announces `2026-07-28`, which no released SDK
speaks (1.30.0, latest as of 2026-09-17, is still on `2025-11-25`) — so
upgrading the SDK does not fix it. That produced 16 silent tool failures in 30
days: nothing ran, nothing was logged about the tool, and the Claude UI showed
a bare "the tool errored".

The cause was that the same fact — what version this session speaks — lived in
two places that could drift: the version negotiated at `initialize` and the
client's per-request header. `src/protocol-version.ts` makes the negotiated
version authoritative: on an established session, a header naming a version we
don't speak is **reconciled to the negotiated version** rather than refused —
the same thing the transport already does when the header is absent. Nothing is
loosened; the server only ever speaks what it advertised in its own
`initialize` response. Newer and older unknown versions are treated alike, so
next year's version needs no code change.

Two traps worth knowing:

- `StreamableHTTPServerTransport` rebuilds the request via `@hono/node-server`,
  which reads `IncomingMessage.rawHeaders` — **not** the `req.headers` object
  Express middleware mutates. `setRequestHeader()` writes both; changing only
  `req.headers` looks like a working fix and changes nothing.
- The `[http] … rejected …` logger is mounted **before** body parsing and auth,
  so it names every refusal — including 401s and unparseable bodies, which
  skipped it when it sat after `express.json()`.

`GET /health` reports the deployed `latest`/`supported` version list, the Cloud
Run revision and the policy — so "which versions does prod speak?" is a curl,
not a deploy or a log dig.

## Environment Variables

### QuickBooks Online (optional — tools enabled if all are set)
- `INTUIT_CLIENT_ID`, `INTUIT_CLIENT_SECRET` — OAuth2 app credentials
- `QBO_REALM_ID` — QuickBooks company ID (obtained during OAuth authorization)
- `QBO_REFRESH_TOKEN` — OAuth2 refresh token (rolling: update after each refresh)
- `QBO_BASE_URL` — optional override (default: production)

### Gmail source for qbo_attach_file (optional)
- `GMAIL_REFRESH_TOKENS` — JSON object mapping account email → OAuth refresh token (scope gmail.readonly). Mint with `npm run gmail:link` (requires the redirect URI, default `http://localhost:8766/callback`, to be allow-listed on the Google OAuth client). For Cloud Run, store as a Secret Manager secret and wire it in deploy.sh.
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` — optional; default to `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`

### Secret rotation (Cloud Run)
Secrets are mounted as `:latest`, resolved at instance start. Never disable a secret version until a newer enabled version exists — a disabled `latest` aborts all new instance startups (the 2026-07-23 burst-502 outage).
