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
- `src/index.ts` — entry point: creates McpServer + StdioServerTransport
- `src/billcom-client.ts` — Bill.com REST API client with auto session management (30 min refresh + 401 retry)
- `src/tools/vendors.ts` — list_vendors, get_vendor, create_vendor tools
- `src/tools/bills.ts` — list_bills, get_bill, create_bill tools
- SDK: `@modelcontextprotocol/sdk` v1.26.0 from local tarball
- All logging goes to stderr (stdout is MCP protocol)
- Env vars: `BILLCOM_API_BASE_URL`, `BILLCOM_USERNAME`, `BILLCOM_PASSWORD`, `BILLCOM_ORGANIZATION_ID`, `BILLCOM_DEV_KEY`
