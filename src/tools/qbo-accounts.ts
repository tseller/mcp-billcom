import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QboClient, QboError } from "../qbo-client.js";

function err(e: unknown) {
  const msg = e instanceof QboError ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerQboAccountTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_list_accounts",
    "List all active accounts (chart of accounts) from QuickBooks. Returns account name, type, classification, and current balance.",
    {},
    async () => {
      try {
        const result = await client.listAccounts();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_account_balances",
    "Get current balances for all bank and credit card accounts. Useful for reconciliation.",
    {},
    async () => {
      try {
        const result = await client.query(
          "SELECT Id, Name, AccountType, CurrentBalance FROM Account WHERE Active = true AND AccountType IN ('Bank', 'Credit Card') MAXRESULTS 100",
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );
}
