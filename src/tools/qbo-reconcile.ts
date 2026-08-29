import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  QboClient,
  QboError,
  parseTransactionList,
  matchesAccount,
  RECONCILE_COLUMNS,
  type ReconcileTxn,
} from "../qbo-client.js";

function err(e: unknown) {
  const msg = e instanceof QboError ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** BalanceSheet reports credit-card/liability balances as positive; the register/reconcile convention is negative-when-owed. */
const isCreditCard = (accountType: string) => /credit\s*card/i.test(accountType);
const dayBefore = (isoDate: string) => {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
};

/** Fetch company-wide TransactionList for a status, then keep rows whose register account matches. */
async function txnsForAccount(
  client: QboClient,
  accountName: string,
  startDate: string,
  endDate: string,
  cleared: "Reconciled" | "Cleared" | "Uncleared",
): Promise<{ matched: ReconcileTxn[]; total: number }> {
  const report = await client.transactionList({ startDate, endDate, cleared, columns: RECONCILE_COLUMNS });
  const { transactions } = parseTransactionList(report);
  const matched = transactions.filter((t) => matchesAccount(t.account, accountName));
  return { matched, total: round2(matched.reduce((s, t) => s + t.amount, 0)) };
}

/**
 * QBO reconcile support.
 *
 * The QuickBooks Online Accounting API has NO public Reconcile entity — you
 * cannot finalize a reconcile via API; that (the check-off + Finish) stays a
 * manual step in the QBO web UI. So the deliverable here is VERIFICATION: is
 * every statement transaction correctly reflected in QBO? That reduces to
 *
 *     difference = statement ending balance − QBO register balance as-of the statement date
 *
 * where the register balance comes from the BalanceSheet report (QBO's own
 * "register balance as of <date>", correct on BOTH posting sides — so it
 * handles credit-card payments that post from the bank account, which a
 * per-account transaction scan misses). $0 difference ⇒ everything matches;
 * otherwise there's a missing/duplicate/mismatched transaction to investigate.
 */
export function registerQboReconcileTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_reconcile_worksheet",
    "Verify one bank/credit-card account against a paper (Chase/Divvy) statement, for the monthly reconcile. Compares the statement's ending balance to QBO's register balance as-of the statement date (from the BalanceSheet — correct on both posting sides, so it handles credit-card payments too) and reports the DIFFERENCE: $0 means every statement transaction is correctly in QBO. Also lists the period's transactions to review if it doesn't balance. NOTE: QBO's API cannot finalize a reconcile — after this shows $0, do the check-off + Finish manually in the QBO web UI. Provide the beginning + ending balance from the paper statement.",
    {
      accountId: z.string().describe("Bank/credit-card Account ID (from qbo_account_balances)"),
      statementEndDate: z.string().describe("Statement ending date YYYY-MM-DD"),
      statementEndingBalance: z.number().describe("Ending balance from the paper statement. For a credit card, enter it the way QBO's reconcile shows it (amount owed as a negative number), OR as a positive amount-owed — the tool detects and flags a sign mismatch either way."),
      statementBeginningBalance: z.number().optional().describe("Beginning balance from the paper statement — cross-checked against QBO's register balance as-of the day before the period starts."),
      statementStartDate: z.string().optional().describe("Statement start date YYYY-MM-DD — enables the beginning-balance cross-check and bounds the review listing."),
    },
    async ({ accountId, statementEndDate, statementEndingBalance, statementBeginningBalance, statementStartDate }) => {
      try {
        const account = await client.getAccount(accountId);
        if (!account) {
          return err(new Error(`No account found with Id ${accountId} (use qbo_account_balances to list accounts).`));
        }
        const cc = isCreditCard(account.accountType);
        // Register convention: banks match BalanceSheet as-is; credit cards are negated
        // so a balance owed reads negative, matching QBO's reconcile/register display.
        const toRegister = (bsValue: number | undefined) =>
          bsValue === undefined ? undefined : round2(cc ? -bsValue : bsValue);

        const registerEnd = toRegister(await client.accountBalanceAsOf(account.name, statementEndDate));
        if (registerEnd === undefined) {
          return err(new Error(`Account "${account.name}" not found on the BalanceSheet as of ${statementEndDate}.`));
        }

        const difference = round2(statementEndingBalance - registerEnd);
        const altDifference = round2(statementEndingBalance + registerEnd);
        const reconcilesToZero = Math.abs(difference) < 0.005;
        const likelySignFlip = !reconcilesToZero && Math.abs(altDifference) < 0.005;

        const summary: Record<string, unknown> = {
          accountId,
          accountName: account.name,
          accountType: account.accountType,
          statementEndDate,
          statementEndingBalance,
          qboRegisterBalanceAsOf: registerEnd,
          difference,
          reconcilesToZero,
          verdict: reconcilesToZero
            ? "$0.00 difference — every statement transaction is correctly reflected in QBO. Do the check-off + Finish in the QBO web UI to finalize."
            : likelySignFlip
              ? `The difference is ${difference.toFixed(2)}, but the statement and QBO register balance are equal in magnitude and opposite in sign. Re-enter statementEndingBalance with the opposite sign (for a credit card, QBO's reconcile shows the balance owed as negative).`
              : `${Math.abs(difference).toFixed(2)} difference — a transaction is missing, duplicated, or has the wrong amount in QBO (or the statement ending balance is off). Review the period's transactions below against the statement.`,
          note: "QBO's API cannot finalize a reconcile — the check-off + Finish is manual in the QBO UI. This tool VERIFIES the books match the statement (difference should be $0).",
        };

        // Beginning-balance cross-check (optional).
        if (statementBeginningBalance !== undefined && statementStartDate) {
          const registerBegin = toRegister(await client.accountBalanceAsOf(account.name, dayBefore(statementStartDate)));
          summary.beginningCheck = {
            statementBeginningBalance,
            qboRegisterBalanceAsOfDayBeforeStart: registerBegin,
            matches: registerBegin !== undefined && Math.abs(round2(statementBeginningBalance - registerBegin)) < 0.005,
            note: "Should match — if not, the PRIOR period wasn't fully reconciled.",
          };
        }

        // Review listing: the period's transactions posting to this account's register.
        // (For a credit card, payments post from the bank account and won't appear here —
        // they surface on the bank account's worksheet; the DIFFERENCE above already accounts
        // for them via the BalanceSheet.)
        const listStart = statementStartDate ?? "2000-01-01";
        const [uncleared, cleared] = await Promise.all([
          txnsForAccount(client, account.name, listStart, statementEndDate, "Uncleared"),
          txnsForAccount(client, account.name, listStart, statementEndDate, "Cleared"),
        ]);

        const fmt = (t: ReconcileTxn) =>
          `  ${t.date}  ${t.amount.toFixed(2).padStart(12)}  ${t.type}  ${t.docNumber ? `#${t.docNumber} ` : ""}${t.name}${t.memo ? ` — ${t.memo}` : ""}`;
        const lines: string[] = [JSON.stringify(summary, null, 2), ""];
        lines.push(`Register transactions posting to "${account.name}" in ${listStart}..${statementEndDate}${cc ? " (charges/credits; card payments post from the bank account)" : ""}:`);
        lines.push(`  Uncleared (${uncleared.matched.length}, total ${uncleared.total.toFixed(2)}):`);
        lines.push(...uncleared.matched.map(fmt));
        lines.push(`  Cleared (${cleared.matched.length}, total ${cleared.total.toFixed(2)}):`);
        lines.push(...cleared.matched.map(fmt));

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_cleared_transactions",
    "List one account's transactions filtered by QBO reconcile status (Reconciled, Cleared, or Uncleared) for a date range. Useful for hunting reconciliation discrepancies. (QBO exposes reconcile status only as a report filter and ignores its account filter, so this fetches company-wide and filters to your account client-side by the register-account column. For credit cards, payments recorded from the bank account post under that bank account, not here.)",
    {
      accountId: z.string().describe("Account ID"),
      startDate: z.string().describe("Start date YYYY-MM-DD"),
      endDate: z.string().describe("End date YYYY-MM-DD"),
      status: z.enum(["Reconciled", "Cleared", "Uncleared"]).describe("Reconcile status to filter by"),
    },
    async ({ accountId, startDate, endDate, status }) => {
      try {
        const accountName = await client.getAccountName(accountId);
        if (!accountName) return err(new Error(`No account found with Id ${accountId}.`));
        const { matched, total } = await txnsForAccount(client, accountName, startDate, endDate, status);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ accountId, accountName, status, startDate, endDate, count: matched.length, total, transactions: matched }, null, 2),
            },
          ],
        };
      } catch (e) {
        return err(e);
      }
    },
  );
}
