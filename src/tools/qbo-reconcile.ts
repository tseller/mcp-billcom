import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QboClient, QboError, parseTransactionList, type ReconcileTxn } from "../qbo-client.js";

function err(e: unknown) {
  const msg = e instanceof QboError ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * QBO reconcile support.
 *
 * The QuickBooks Online Accounting API has NO public Reconcile entity — you
 * cannot create, read, or finalize a reconciliation, nor flip a transaction's
 * cleared flag, over the API. Finalizing a reconcile (checking items off and
 * saving) is a manual step in the QBO web UI.
 *
 * What the API *does* expose: the TransactionList report accepts a `cleared`
 * filter ("Reconciled" | "Cleared" | "Uncleared"), usable only as a filter (not
 * a per-row column). These tools stitch those filtered calls into a reconcile
 * worksheet: they list what's outstanding, total it, and — given the paper
 * statement's beginning/ending balance — compute the difference so the treasurer
 * knows whether the account will reconcile to zero and, if not, exactly which
 * transactions to investigate.
 */
export function registerQboReconcileTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_reconcile_worksheet",
    "Build a reconciliation worksheet for one bank/credit-card account against a paper (Chase/Divvy) statement. Pulls the account's Uncleared and Cleared transactions through the statement end date via the TransactionList report and, given the statement's beginning + ending balance, computes the cleared total and the remaining difference — telling you whether the account reconciles to zero and, if not, which transactions to investigate. NOTE: QBO's API cannot check items off or finalize a reconcile — that final step is manual in the QBO web UI. Use this to prep and verify the reconcile, then finalize in the UI.",
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
        const start = startDate ?? "2000-01-01";
        const [unclearedReport, clearedReport] = await Promise.all([
          client.transactionList({ accountId, startDate: start, endDate: statementEndDate, cleared: "Uncleared" }),
          client.transactionList({ accountId, startDate: start, endDate: statementEndDate, cleared: "Cleared" }),
        ]);

        const uncleared = parseTransactionList(unclearedReport);
        const cleared = parseTransactionList(clearedReport);

        const summary: Record<string, unknown> = {
          accountId,
          statementEndDate,
          startDate: start,
          clearedCount: cleared.transactions.length,
          clearedTotal: cleared.total,
          unclearedCount: uncleared.transactions.length,
          unclearedTotal: uncleared.total,
          note:
            "QBO's API cannot mark items cleared or finalize the reconcile. Match the uncleared items below against the paper statement, then check them off and Finish in the QBO web UI. Amounts are register-signed (deposits/credits +, payments/charges −).",
        };

        if (statementBeginningBalance !== undefined && statementEndingBalance !== undefined) {
          const statementChange = round2(statementEndingBalance - statementBeginningBalance);
          // If you clear ONLY items already flagged Cleared:
          const differenceClearedOnly = round2(
            statementEndingBalance - (statementBeginningBalance + cleared.total),
          );
          // If you clear every outstanding (Uncleared) item too — the common case
          // where the whole statement's activity is sitting uncleared in QBO:
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
        lines.push(`Uncleared transactions (${uncleared.transactions.length}) — match these against the statement:`);
        lines.push(...uncleared.transactions.map(fmt));
        if (cleared.transactions.length) {
          lines.push("");
          lines.push(`Already-Cleared (in-progress) transactions (${cleared.transactions.length}):`);
          lines.push(...cleared.transactions.map(fmt));
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_cleared_transactions",
    "List an account's transactions filtered by QBO reconcile status (Reconciled, Cleared, or Uncleared) for a date range, via the TransactionList report. Useful for hunting reconciliation discrepancies — e.g. list Uncleared items to find what's outstanding, or Reconciled items to audit a prior period. (QBO exposes this status as a filter only, never per-row.)",
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
        const report = await client.transactionList({ accountId, startDate, endDate, cleared: status });
        const { transactions, total } = parseTransactionList(report);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ accountId, status, startDate, endDate, count: transactions.length, total, transactions }, null, 2),
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );
}
