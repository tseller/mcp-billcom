import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  QboClient,
  QboError,
  parseTransactionList,
  RECONCILE_COLUMNS,
  type ReconcileTxn,
} from "../qbo-client.js";

function err(e: unknown) {
  const msg = e instanceof QboError ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const norm = (s: string) => s.trim().toLowerCase();

/** Fetch company-wide TransactionList for a cleared status, then keep only rows posting to `accountName`. */
async function txnsForAccount(
  client: QboClient,
  accountName: string,
  startDate: string,
  endDate: string,
  cleared: "Reconciled" | "Cleared" | "Uncleared",
): Promise<{ matched: ReconcileTxn[]; total: number; accountsSeen: string[] }> {
  const report = await client.transactionList({
    startDate,
    endDate,
    cleared,
    columns: RECONCILE_COLUMNS,
  });
  const { transactions } = parseTransactionList(report);
  const target = norm(accountName);
  const matched = transactions.filter((t) => norm(t.account) === target);
  const total = round2(matched.reduce((s, t) => s + t.amount, 0));
  const accountsSeen = [...new Set(transactions.map((t) => t.account).filter(Boolean))].sort();
  return { matched, total, accountsSeen };
}

/**
 * QBO reconcile support.
 *
 * The QuickBooks Online Accounting API has NO public Reconcile entity — you
 * cannot create, read, or finalize a reconciliation, nor flip a transaction's
 * cleared flag, over the API. Finalizing (checking items off and saving) is a
 * manual step in the QBO web UI.
 *
 * Worse, the TransactionList report's `account` filter is silently ignored by
 * QBO (verified live), so these tools fetch company-wide with the *working*
 * `cleared` filter, request the `account_name` column, and filter to the target
 * account client-side. Given the paper statement's beginning/ending balance
 * they compute whether the account reconciles to zero and surface the
 * difference to investigate.
 */
export function registerQboReconcileTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_reconcile_worksheet",
    "Build a reconciliation worksheet for one bank/credit-card account against a paper (Chase/Divvy) statement. Pulls the account's Uncleared and Cleared transactions through the statement end date and, given the statement's beginning + ending balance, computes the cleared total and remaining difference — telling you whether the account reconciles to zero and, if not, which transactions to investigate. NOTE: QBO's API cannot check items off or finalize a reconcile — that final step is manual in the QBO web UI. Use this to prep and verify, then finalize in the UI.",
    {
      accountId: z.string().describe("Bank/credit-card Account ID to reconcile (from qbo_account_balances)"),
      statementEndDate: z.string().describe("Statement ending date YYYY-MM-DD (the reconcile 'through' date)"),
      statementBeginningBalance: z
        .number()
        .optional()
        .describe("Beginning balance from the paper statement (QBO's last reconciled balance). Provide to compute the difference."),
      statementEndingBalance: z
        .number()
        .optional()
        .describe("Ending balance from the paper statement. Provide to compute the difference."),
      startDate: z
        .string()
        .optional()
        .describe("Lower bound for the transaction listing YYYY-MM-DD. Defaults to 2000-01-01 so ALL outstanding uncleared items are captured, matching QBO's reconcile view."),
    },
    async ({ accountId, statementEndDate, statementBeginningBalance, statementEndingBalance, startDate }) => {
      try {
        const accountName = await client.getAccountName(accountId);
        if (!accountName) {
          return err(new Error(`No account found with Id ${accountId} (use qbo_account_balances to list accounts).`));
        }
        const start = startDate ?? "2000-01-01";
        const [uncleared, cleared] = await Promise.all([
          txnsForAccount(client, accountName, start, statementEndDate, "Uncleared"),
          txnsForAccount(client, accountName, start, statementEndDate, "Cleared"),
        ]);

        const summary: Record<string, unknown> = {
          accountId,
          accountName,
          statementEndDate,
          startDate: start,
          clearedCount: cleared.matched.length,
          clearedTotal: cleared.total,
          unclearedCount: uncleared.matched.length,
          unclearedTotal: uncleared.total,
          note:
            "QBO's API cannot mark items cleared or finalize the reconcile. Match the uncleared items below against the paper statement, then check them off and Finish in the QBO web UI. Amounts are register-signed (deposits/credits +, payments/charges −).",
        };
        if (uncleared.matched.length === 0 && cleared.matched.length === 0) {
          summary.warning = `No transactions posted to "${accountName}" in this window. Accounts seen in the report: ${uncleared.accountsSeen.join(", ") || "(none)"}. Check the accountId.`;
        }

        if (statementBeginningBalance !== undefined && statementEndingBalance !== undefined) {
          const statementChange = round2(statementEndingBalance - statementBeginningBalance);
          const differenceClearedOnly = round2(
            statementEndingBalance - (statementBeginningBalance + cleared.total),
          );
          const differenceClearAll = round2(
            statementEndingBalance - (statementBeginningBalance + cleared.total + uncleared.total),
          );
          summary.statement = {
            beginningBalance: statementBeginningBalance,
            endingBalance: statementEndingBalance,
            statementChange,
          };
          summary.difference = {
            ifClearingOnlyAlreadyClearedItems: differenceClearedOnly,
            ifClearingAllOutstandingItems: differenceClearAll,
            reconcilesToZero: differenceClearAll === 0,
            interpretation:
              differenceClearAll === 0
                ? "Clearing every outstanding item brings the difference to 0.00 — the account reconciles cleanly. Check all uncleared items off in the QBO UI and Finish."
                : `A ${Math.abs(differenceClearAll).toFixed(2)} difference remains even after clearing every outstanding item — there is a discrepancy (a missing, duplicate, or mismatched-amount transaction, or the statement balances are off). Investigate before finalizing.`,
          };
        }

        const fmt = (t: ReconcileTxn) =>
          `  ${t.date}  ${t.amount.toFixed(2).padStart(12)}  ${t.type}  ${t.docNumber ? `#${t.docNumber} ` : ""}${t.name}${t.memo ? ` — ${t.memo}` : ""}`;
        const lines: string[] = [];
        lines.push(JSON.stringify(summary, null, 2));
        lines.push("");
        lines.push(`Uncleared transactions (${uncleared.matched.length}) — match these against the statement:`);
        lines.push(...uncleared.matched.map(fmt));
        if (cleared.matched.length) {
          lines.push("");
          lines.push(`Already-Cleared (in-progress) transactions (${cleared.matched.length}):`);
          lines.push(...cleared.matched.map(fmt));
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_cleared_transactions",
    "List one account's transactions filtered by QBO reconcile status (Reconciled, Cleared, or Uncleared) for a date range. Useful for hunting reconciliation discrepancies — e.g. list Uncleared items to find what's outstanding. (QBO exposes reconcile status only as a report filter and ignores its account filter, so this fetches company-wide and filters to your account client-side.)",
    {
      accountId: z.string().describe("Account ID"),
      startDate: z.string().describe("Start date YYYY-MM-DD"),
      endDate: z.string().describe("End date YYYY-MM-DD"),
      status: z
        .enum(["Reconciled", "Cleared", "Uncleared"])
        .describe("Reconcile status to filter by"),
    },
    async ({ accountId, startDate, endDate, status }) => {
      try {
        const accountName = await client.getAccountName(accountId);
        if (!accountName) {
          return err(new Error(`No account found with Id ${accountId}.`));
        }
        const { matched, total, accountsSeen } = await txnsForAccount(
          client,
          accountName,
          startDate,
          endDate,
          status,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  accountId,
                  accountName,
                  status,
                  startDate,
                  endDate,
                  count: matched.length,
                  total,
                  ...(matched.length === 0 ? { accountsSeen } : {}),
                  transactions: matched,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );
}
