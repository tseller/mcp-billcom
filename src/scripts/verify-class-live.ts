/**
 * Read-only verification of the class tooling against a real QBO company.
 *
 * Drives the same client methods and parsers the MCP tools use, so a green run
 * means the tools work against live QuickBooks — not just against fixtures.
 * Every call is a GET; nothing is written to the books.
 *
 * Against the production company (reads credentials from Secret Manager):
 *     npx tsx src/scripts/verify-class-live.ts
 *
 * Against a sandbox company (no Secret Manager, no gcloud):
 *     INTUIT_CLIENT_ID=… INTUIT_CLIENT_SECRET=… QBO_REALM_ID=… QBO_REFRESH_TOKEN=… \
 *     QBO_BASE_URL=https://sandbox-quickbooks.api.intuit.com/v3/company \
 *     npx tsx src/scripts/verify-class-live.ts
 *
 * Note on tokens: Intuit rolls refresh tokens. In Secret Manager mode a rotated
 * token is persisted straight back, exactly as the Cloud Run service does, so
 * this can never leave the deployed server holding a stale token.
 */

import { execFileSync } from "node:child_process";
import {
  QboClient,
  CLASS_LEDGER_COLUMNS,
  parseClassLedger,
  parseProfitAndLossByClass,
  InMemoryTokenStore,
  type TokenStore,
} from "../qbo-client.js";

const PROJECT = process.env.GCP_PROJECT_ID ?? "mcp-servers-487419";
const ACCOUNT = process.env.GCLOUD_ACCOUNT ?? "tseller@gmail.com";

const readSecret = (name: string) =>
  execFileSync(
    "gcloud",
    ["secrets", "versions", "access", "latest", `--secret=${name}`, `--project=${PROJECT}`, `--account=${ACCOUNT}`],
    { encoding: "utf8" },
  ).trim();

/** Secret Manager via the gcloud CLI — the local stand-in for the server's metadata-auth store. */
class SecretCliTokenStore implements TokenStore {
  private current = readSecret("QBO_REFRESH_TOKEN");
  async getRefreshToken() {
    return this.current;
  }
  async saveRefreshToken(token: string) {
    if (token === this.current) return;
    execFileSync(
      "gcloud",
      ["secrets", "versions", "add", "QBO_REFRESH_TOKEN", "--data-file=-", `--project=${PROJECT}`, `--account=${ACCOUNT}`],
      { input: token },
    );
    this.current = token;
    console.error("[verify] rotated refresh token persisted to Secret Manager");
  }
}

const fromEnv = !!process.env.QBO_REFRESH_TOKEN;
const client = new QboClient({
  clientId: fromEnv ? process.env.INTUIT_CLIENT_ID! : readSecret("INTUIT_CLIENT_ID"),
  clientSecret: fromEnv ? process.env.INTUIT_CLIENT_SECRET! : readSecret("INTUIT_CLIENT_SECRET"),
  realmId: fromEnv ? process.env.QBO_REALM_ID! : readSecret("QBO_REALM_ID"),
  tokenStore: fromEnv ? new InMemoryTokenStore(process.env.QBO_REFRESH_TOKEN!) : new SecretCliTokenStore(),
  baseUrl: process.env.QBO_BASE_URL,
});

const START = process.env.VERIFY_START ?? "2026-06-01";
const END = process.env.VERIFY_END ?? "2026-06-30";
const FY_START = process.env.VERIFY_FY_START ?? "2025-07-01";
const FY_END = process.env.VERIFY_FY_END ?? "2026-06-30";

const out: Record<string, unknown> = { company: fromEnv ? "env-configured (sandbox?)" : "Secret Manager (production)" };

out.classTrackingMode = await client.getClassTrackingMode();

const classes = (await client.listClasses()) as { QueryResponse?: { Class?: Array<{ Id?: string; Name?: string }> } };
out.classes = (classes.QueryResponse?.Class ?? []).map((c) => ({ id: c.Id, name: c.Name }));

const budgets = (await client.listBudgets()) as { QueryResponse?: { Budget?: Array<{ Id?: string; Name?: string }> } };
out.budgets = (budgets.QueryResponse?.Budget ?? []).map((b) => ({ id: b.Id, name: b.Name }));

// The class-aware transaction listing, through the tool's exact code path.
const ledger = await client.classReport("GeneralLedger", {
  startDate: START,
  endDate: END,
  accountingMethod: "Accrual",
  columns: CLASS_LEDGER_COLUMNS,
});
const ledgerColumns = ((ledger as { Columns?: { Column?: Array<{ ColTitle?: string }> } }).Columns?.Column ?? []).map(
  (c) => c.ColTitle,
);
const parsed = parseClassLedger(ledger);
out.classLedger = {
  period: `${START} → ${END}`,
  basis: parsed.basis,
  columnsReturned: ledgerColumns,
  classColumnPresent: ledgerColumns.includes("Class"),
  transactions: parsed.transactions.length,
  untagged: parsed.transactions.filter((t) => !t.className.trim()).length,
};

// P&L by class, through the tool's exact code path.
const pl = await client.classReport("ProfitAndLoss", {
  startDate: FY_START,
  endDate: FY_END,
  accountingMethod: "Accrual",
  summarizeColumnBy: "Classes",
});
const plParsed = parseProfitAndLossByClass(pl);
out.profitAndLossByClass = {
  period: `${FY_START} → ${FY_END}`,
  basis: plParsed.basis,
  summarizedBy: plParsed.summarizedBy,
  columns: plParsed.columns.map((c) => ({
    title: c.title,
    classId: c.classId ?? null,
    untagged: c.isUntagged,
    total: c.isTotal,
  })),
  accountRows: plParsed.rows.filter((r) => r.accountId).length,
};

// The filter-echo guard must FIRE on a report that ignores `class` — proving a
// silently-dropped filter can never be served as if it were applied.
try {
  await client.classReport("TransactionList", { startDate: START, endDate: END, classIds: ["1"] });
  out.classFilterEchoGuard = "❌ DID NOT FIRE — the guard is broken";
} catch (e) {
  out.classFilterEchoGuard = `✅ fired: ${(e as Error).message.split("—")[0].trim()}`;
}

console.log(JSON.stringify(out, null, 2));
