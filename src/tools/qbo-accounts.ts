import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ACTIVE_ACCOUNTS, QboClient } from "../qbo-client.js";
import { runTool } from "../tool-logging.js";
import { listPaging } from "./list-paging.js";
import { buildEntityList, queryRows, slimAccount } from "../qbo-rows.js";

export function registerQboAccountTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_list_accounts",
    "List active accounts (chart of accounts) from QuickBooks — this is how you find the account id every other QBO tool asks for. " +
      "Returns flattened rows: id, name, account number, type, classification, current balance, and the parent account of a sub-account. " +
      "`active` appears only on an inactive account (the listing is active-only unless you ask otherwise). " +
      "Paged by size as well as row count: when `hasMore` is true, call again with `startPosition: nextStartPosition`.",
    // The whole chart of accounts is the everyday call, so a page asks QBO for
    // all of it and the size budget decides where the page ends.
    { ...listPaging(1000) },
    (args) =>
      runTool("qbo_list_accounts", args, async ({ startPosition, maxResults, format }) => {
        const start = startPosition ?? 1;
        const max = maxResults ?? 1000;

        const raw = await client.listAccounts(start, max);
        if (format === "raw") return raw;

        const rowCount = await client.countEntities("Account", ACTIVE_ACCOUNTS);
        return buildEntityList({
          entity: "Account",
          key: "accounts",
          rows: queryRows(raw, "Account").map(slimAccount),
          startPosition: start,
          maxResults: max,
          rowCount,
          // A chart of accounts sums assets, liabilities and income together —
          // a page total would be a number that means nothing.
          sumField: null,
        });
      }),
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
