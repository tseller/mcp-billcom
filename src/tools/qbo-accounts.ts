import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QboClient } from "../qbo-client.js";
import { runTool } from "../tool-logging.js";

export function registerQboAccountTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_list_accounts",
    "List all active accounts (chart of accounts) from QuickBooks. Returns account name, type, classification, and current balance.",
    {},
    (args) => runTool("qbo_list_accounts", args, () => client.listAccounts()),
  );

  server.tool(
    "qbo_account_balances",
    "Get current balances for all bank and credit card accounts. Useful for reconciliation.",
    {},
    (args) =>
      runTool("qbo_account_balances", args, () =>
        client.query(
          "SELECT Id, Name, AccountType, CurrentBalance FROM Account WHERE Active = true AND AccountType IN ('Bank', 'Credit Card') MAXRESULTS 100",
        ),
      ),
  );
}
