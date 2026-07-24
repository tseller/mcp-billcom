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
- `src/tools/qbo-reports.ts` — QBO: transaction_report, profit_loss, balance_sheet
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
