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
- `src/tools/qbo-reports.ts` — QBO: transaction_report (optional `cleared` reconcile-status filter), profit_loss, balance_sheet. `qbo_transaction_report` returns **flattened, compact rows** (not QBO's nested report JSON) and **pages automatically** — see "Tool result size" below
- `src/result-size.ts` — the shared tool-result size discipline: `MAX_RESULT_CHARS` budget, `compact()` serialization, `packRows()` paging. Enforced for **every** tool by `runTool`, not opted into per tool
- `src/tools/qbo-reconcile.ts` — QBO: reconcile_worksheet (stitches Uncleared/Cleared TransactionList calls into a per-account reconcile worksheet, computes the difference vs the paper statement's beginning/ending balance), cleared_transactions (list by reconcile status). QBO's Accounting API has **no public Reconcile entity** — you cannot mark items cleared or finalize a reconcile via API; that step is manual in the QBO web UI. The API only exposes reconcile status as the TransactionList report's `cleared` filter (`Reconciled`/`Cleared`/`Uncleared`), filter-only (never per-row), so a worksheet must run one call per status and stitch. Report parsing lives in `parseTransactionList` (src/qbo-client.ts)
- `src/tools/divvy.ts` — Divvy/BILL Spend & Expense: list_transactions (flattened rows + cursor paging), get_transaction, upload_receipt, custom fields, cards, members, budgets, list_pending_action
- `src/divvy-rows.ts` — the flattened Divvy row (`slimTransaction`) plus `buildCursorList()`, the cursor-paged twin of `buildEntityList()`: same `returned`/`pageTotal`/`hasMore`/`truncatedBy`/`note` vocabulary, but the position is BILL's opaque `nextPage`. No `rowCount` — BILL's list returns no total, and an omitted count beats an invented one
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
  refused by name.
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
