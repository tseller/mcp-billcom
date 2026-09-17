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
- Inspector: `npx @modelcontextprotocol/inspector node --env-file=.env --import=tsx src/index.ts`

## Architecture

- **ESM project** using TypeScript with Node16 module resolution
- `src/index.ts` — entry point: registers QBO and/or Divvy tools based on available env vars
- `src/qbo-client.ts` — QuickBooks Online API client with OAuth2 token refresh (rolling refresh tokens)
- `src/oauth.ts` — OAuth2 server (Google-backed) for MCP HTTP auth
- `src/http-server.ts` — Streamable HTTP transport for Cloud Run deployment
- `src/tools/qbo-accounts.ts` — QBO: list_accounts, account_balances
- `src/tools/qbo-vendors.ts` — QBO: list_vendors, search_vendors, create_vendor
- `src/tools/qbo-transactions.ts` — QBO: list/get/update/create purchases; list/get/create/update deposits (single + batch); list/create transfers; create journal entries; attach/list files. Create tools accept an optional `idempotencyKey`; update tools fetch-then-merge fields QBO requires on full-entity validation (PaymentType/AccountRef on Purchase, DepositToAccountRef on Deposit)
- `src/tools/qbo-reports.ts` — QBO: transaction_report (optional `cleared` reconcile-status filter), profit_loss, balance_sheet
- `src/tools/qbo-classes.ts` — QBO: list_classes, create_class (the season tags). Class names are never hardcoded — seasons become year-specific ("Fall 2026")
- `src/tools/qbo-class-reports.ts` — QBO: class_transactions, profit_loss_by_class. **TransactionList cannot return a class**: it silently drops the `klass_name` column (verified against a bogus-column control), so class-aware listing is built on **GeneralLedger**, the only report returning both the posting Account and the Class. The class filter param is `class` (not `classid`, which is ignored) and QBO echoes an applied filter back as `Header.Class` — `QboClient.classReport` asserts that echo so a silently-dropped filter can't pose as a real answer. These reports default to **Accrual** because the company default is Cash, which would break deferred revenue
- `src/tools/qbo-class-writes.ts` — QBO: set_transaction_class (+ batch) — the only sanctioned way to class an existing transaction
- `src/tools/qbo-budgets.ts` — QBO: list_budgets, budget_vs_actuals. The Budget entity is **read-only** via the API (build budgets in the web UI), and there is **no budget report at all**: `BudgetVsActuals`/`BudgetSummary` return `5020 Permission Denied`, exactly as an invented report name does. So budget-vs-actuals is computed — `src/budget-actuals.ts` joins BudgetDetail (account × class) to a P&L summarised by class
- `src/class-lines.ts` — line-preserving edits. Class writes **never rebuild a line**: they deep-copy QBO's own lines and write only `ClassRef`, then `diffPaths` re-checks that nothing else moved and the write is refused if it did. This exists because the update tools' `lines` array can express 3 fields while a live line carries up to 7 (`Id`, `TaxCodeRef`, `BillableStatus`, `CustomerRef`, `LineNum`), so a rebuild silently dropped the rest — hence `mergeLinePatches` (edit by `lineId`) and the explicit `replaceAllLines` flag on the update tools
- `src/scripts/verify-class-live.ts` — read-only live/sandbox verification of the class tooling (`npx tsx src/scripts/verify-class-live.ts`; set `QBO_BASE_URL` + env credentials for a sandbox company)
- `src/tools/qbo-reconcile.ts` — QBO: reconcile_worksheet (stitches Uncleared/Cleared TransactionList calls into a per-account reconcile worksheet, computes the difference vs the paper statement's beginning/ending balance), cleared_transactions (list by reconcile status). QBO's Accounting API has **no public Reconcile entity** — you cannot mark items cleared or finalize a reconcile via API; that step is manual in the QBO web UI. The API only exposes reconcile status as the TransactionList report's `cleared` filter (`Reconciled`/`Cleared`/`Uncleared`), filter-only (never per-row), so a worksheet must run one call per status and stitch. Report parsing lives in `parseTransactionList` (src/qbo-client.ts)
- `src/idempotency.ts` — idempotency-key store for create tools (Firestore in HTTP mode, in-memory for stdio)
- `src/gmail-client.ts` — Gmail attachment fetch for qbo_attach_file (per-account refresh tokens)
- `src/scripts/gmail-link.ts` — one-time bootstrap to mint a Gmail refresh token (`npm run gmail:link`)
- SDK: `@modelcontextprotocol/sdk` ^1.26.0
- All logging goes to stderr (stdout is MCP protocol)

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
