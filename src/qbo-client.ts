/**
 * QuickBooks Online (QBO) API client.
 *
 * Handles OAuth2 token refresh and provides typed methods for the
 * accounting entities a nonprofit treasurer needs most.
 */

export class QboError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseBody?: unknown,
  ) {
    super(message);
    this.name = "QboError";
  }
}

export interface TokenStore {
  getRefreshToken(): Promise<string>;
  saveRefreshToken(token: string): Promise<void>;
}

/** In-memory token store — for stdio/local use where persistence across restarts is not required. */
export class InMemoryTokenStore implements TokenStore {
  constructor(private token: string) {}
  async getRefreshToken(): Promise<string> {
    return this.token;
  }
  async saveRefreshToken(token: string): Promise<void> {
    this.token = token;
  }
}

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  realmId: string;
  tokenStore: TokenStore;
  /** Override for sandbox testing */
  baseUrl?: string;
}

interface TokenPair {
  accessToken: string;
  expiresAt: number;
}

interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const PRODUCTION_BASE = "https://quickbooks.api.intuit.com/v3/company";

export class QboClient {
  private config: QboConfig;
  private tokens: TokenPair | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(config: QboConfig) {
    this.config = config;
  }

  private get baseUrl(): string {
    const base = this.config.baseUrl || PRODUCTION_BASE;
    return `${base}/${this.config.realmId}`;
  }

  private get basicAuth(): string {
    return Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString("base64");
  }

  private async refreshTokens(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<void> {
    const initial = await this.config.tokenStore.getRefreshToken();
    let result = await this.tryRefresh(initial);

    if (result === "invalid_grant") {
      // A sibling instance may have rotated the token between our read and our refresh.
      // Re-read the store; if it's the same value, give up (operator must re-auth).
      const fresh = await this.config.tokenStore.getRefreshToken();
      if (fresh === initial) {
        throw new QboError(
          "Token refresh failed: invalid_grant (re-authorize at /qbo/auth)",
          400,
          "invalid_grant",
        );
      }
      console.error("[qbo] invalid_grant with stale token, retrying with fresh store value");
      result = await this.tryRefresh(fresh);
      if (result === "invalid_grant") {
        throw new QboError(
          "Token refresh failed: invalid_grant even after store re-read (re-authorize at /qbo/auth)",
          400,
          "invalid_grant",
        );
      }
    }

    this.tokens = {
      accessToken: result.access_token,
      expiresAt: Date.now() + result.expires_in * 1000 - 60_000, // 1 min buffer
    };

    await this.config.tokenStore.saveRefreshToken(result.refresh_token);
    console.error("[qbo] Tokens refreshed and persisted");
  }

  private async tryRefresh(refreshToken: string): Promise<IntuitTokenResponse | "invalid_grant"> {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${this.basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (res.status === 400) {
      const text = await res.text();
      if (text.includes("invalid_grant")) return "invalid_grant";
      throw new QboError(`Token refresh failed: 400 ${text}`, 400, text);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new QboError(`Token refresh failed: ${res.status} ${text}`, res.status, text);
    }
    return (await res.json()) as IntuitTokenResponse;
  }

  private async ensureTokens(): Promise<void> {
    if (!this.tokens || Date.now() >= this.tokens.expiresAt) {
      await this.refreshTokens();
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    await this.ensureTokens();

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.tokens!.accessToken}`,
    };
    if (body) headers["Content-Type"] = "application/json";

    let res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // Retry once on 401
    if (res.status === 401) {
      console.error("[qbo] 401, refreshing tokens...");
      await this.refreshTokens();
      headers.Authorization = `Bearer ${this.tokens!.accessToken}`;
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new QboError(`QBO API error ${res.status}: ${text}`, res.status, text);
    }

    return (await res.json()) as T;
  }

  /** Run a QBO query (SQL-like syntax). */
  async query<T = unknown>(queryStr: string): Promise<T> {
    await this.ensureTokens();

    const url = `${this.baseUrl}/query?query=${encodeURIComponent(queryStr)}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.tokens!.accessToken}`,
    };

    let res = await fetch(url, { method: "GET", headers });

    if (res.status === 401) {
      await this.refreshTokens();
      headers.Authorization = `Bearer ${this.tokens!.accessToken}`;
      res = await fetch(url, { method: "GET", headers });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new QboError(`QBO query error ${res.status}: ${text}`, res.status, text);
    }

    return (await res.json()) as T;
  }

  /** Fetch a report (ProfitAndLoss, BalanceSheet, TransactionList, etc.) */
  async report(reportName: string, params: Record<string, string> = {}): Promise<unknown> {
    await this.ensureTokens();

    const url = new URL(`${this.baseUrl}/reports/${reportName}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.tokens!.accessToken}`,
    };

    let res = await fetch(url, { method: "GET", headers });

    if (res.status === 401) {
      await this.refreshTokens();
      headers.Authorization = `Bearer ${this.tokens!.accessToken}`;
      res = await fetch(url, { method: "GET", headers });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new QboError(`QBO report error ${res.status}: ${text}`, res.status, text);
    }

    return res.json();
  }

  /**
   * Upload a file and attach it to a transaction.
   * entityType: "Purchase", "Deposit", "Bill", etc.
   */
  async uploadAttachment(
    entityType: string,
    entityId: string,
    fileName: string,
    contentType: string,
    fileData: Buffer,
  ): Promise<unknown> {
    await this.ensureTokens();

    const boundary = `----FormBoundary${Date.now()}`;
    const metadata = JSON.stringify({
      AttachableRef: [{ EntityRef: { type: entityType, value: entityId } }],
      FileName: fileName,
      ContentType: contentType,
    });

    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file_metadata_01"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file_content_01"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ];

    const bodyParts = [
      Buffer.from(parts[0]),
      Buffer.from(parts[1]),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];
    const body = Buffer.concat(bodyParts);

    const url = `${this.baseUrl}/upload`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.tokens!.accessToken}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    let res = await fetch(url, { method: "POST", headers, body });

    if (res.status === 401) {
      await this.refreshTokens();
      headers.Authorization = `Bearer ${this.tokens!.accessToken}`;
      res = await fetch(url, { method: "POST", headers, body });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new QboError(`QBO upload error ${res.status}: ${text}`, res.status, text);
    }

    // QBO's /upload returns HTTP 200 even when an individual file fails: each
    // AttachableResponse entry carries either an Attachable (success) or a Fault.
    // Surface the Fault instead of reporting a fake success.
    const json = (await res.json()) as {
      AttachableResponse?: Array<{
        Attachable?: unknown;
        Fault?: { Error?: Array<{ Message?: string; Detail?: string; code?: string }>; type?: string };
      }>;
    };

    const entries = json.AttachableResponse ?? [];
    const fault = entries.find((e) => e.Fault)?.Fault;
    if (fault) {
      const detail = (fault.Error ?? [])
        .map((e) => [e.Message, e.Detail, e.code && `code=${e.code}`].filter(Boolean).join(" — "))
        .join("; ");
      throw new QboError(
        `QBO upload faulted (${fault.type ?? "unknown"}): ${detail || "no detail"}`,
        200,
        json,
      );
    }
    if (!entries.some((e) => e.Attachable)) {
      throw new QboError(
        "QBO upload returned no Attachable and no Fault — file was not persisted",
        200,
        json,
      );
    }

    return json;
  }

  // --- Convenience methods ---

  async listAccounts() {
    return this.query("SELECT * FROM Account WHERE Active = true MAXRESULTS 1000");
  }

  async listVendors(startPosition = 1, maxResults = 100) {
    return this.query(
      `SELECT * FROM Vendor WHERE Active = true STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  async getVendor(id: string) {
    return this.request("GET", `/vendor/${id}`);
  }

  async createVendor(displayName: string, extra: Record<string, unknown> = {}) {
    return this.request("POST", "/vendor", { DisplayName: displayName, ...extra });
  }

  async listCustomers(startPosition = 1, maxResults = 100) {
    return this.query(
      `SELECT * FROM Customer WHERE Active = true STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  async queryPurchases(where: string, startPosition = 1, maxResults = 100) {
    const clause = where ? `WHERE ${where}` : "";
    return this.query(
      `SELECT * FROM Purchase ${clause} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  async getPurchase(id: string) {
    return this.request("GET", `/purchase/${id}`);
  }

  async updatePurchase(purchase: Record<string, unknown>) {
    return this.request("POST", "/purchase", purchase);
  }

  async createPurchase(purchase: Record<string, unknown>) {
    return this.request("POST", "/purchase", purchase);
  }

  async queryDeposits(where: string, startPosition = 1, maxResults = 100) {
    const clause = where ? `WHERE ${where}` : "";
    return this.query(
      `SELECT * FROM Deposit ${clause} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  async getDeposit(id: string) {
    return this.request("GET", `/deposit/${id}`);
  }

  async createDeposit(deposit: Record<string, unknown>) {
    return this.request("POST", "/deposit", deposit);
  }

  async updateDeposit(deposit: Record<string, unknown>) {
    return this.request("POST", "/deposit", deposit);
  }

  async queryTransfers(where: string, startPosition = 1, maxResults = 100) {
    const clause = where ? `WHERE ${where}` : "";
    return this.query(
      `SELECT * FROM Transfer ${clause} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  async createTransfer(transfer: Record<string, unknown>) {
    return this.request("POST", "/transfer", transfer);
  }

  async createJournalEntry(journalEntry: Record<string, unknown>) {
    return this.request("POST", "/journalentry", journalEntry);
  }

  async queryAttachables(entityType: string, entityId: string) {
    return this.query(
      `SELECT * FROM attachable WHERE AttachableRef.EntityRef.Type = '${entityType}' AND AttachableRef.EntityRef.value = '${entityId}'`,
    );
  }

  /**
   * Fetch the TransactionList report, optionally filtered by reconcile status.
   *
   * Two hard QBO API facts shape this:
   *  - The `cleared` *filter* works (values "Reconciled" | "Cleared" |
   *    "Uncleared") but is filter-only — never returned per row.
   *  - The `account` filter param is SILENTLY IGNORED (verified against live
   *    QBO: passing account=14, account=20, or none returns identical rows).
   *    So we never pass it; instead we request the `account_name` column and
   *    filter client-side by account name.
   *
   * `columns` selects which columns the report returns (and their order). We
   * request account_name + a signed natural-amount column so a reconcile
   * worksheet can attribute each row to its bank/CC account and sum it.
   */
  async transactionList(params: {
    startDate: string;
    endDate: string;
    cleared?: "Reconciled" | "Cleared" | "Uncleared";
    columns?: string[];
  }): Promise<unknown> {
    const q: Record<string, string> = {
      start_date: params.startDate,
      end_date: params.endDate,
    };
    if (params.cleared) q.cleared = params.cleared;
    if (params.columns?.length) q.columns = params.columns.join(",");
    return this.report("TransactionList", q);
  }

  /** Look up an account's display name by Id (used to filter reports client-side). */
  async getAccountName(id: string): Promise<string | undefined> {
    const r = (await this.query(`SELECT Id, Name FROM Account WHERE Id = '${id}'`)) as {
      QueryResponse?: { Account?: Array<{ Name?: string }> };
    };
    return r.QueryResponse?.Account?.[0]?.Name;
  }
}

/** Columns we request from the TransactionList report for reconcile worksheets. */
export const RECONCILE_COLUMNS = [
  "tx_date",
  "txn_type",
  "doc_num",
  "name",
  "memo",
  "account_name",
  "split_acc",
  "subt_nat_amount",
];

// --- TransactionList report parsing ---

export interface ReconcileTxn {
  date: string;
  type: string;
  docNumber: string;
  name: string;
  memo: string;
  /** The bank/CC (register) account this row posts to, from the report's Account column. */
  account: string;
  /** Signed amount as reported in the account register (deposits +, payments −). */
  amount: number;
  raw: Record<string, string>;
}

interface QboReportColData {
  value?: string;
  id?: string;
}
interface QboReportRow {
  ColData?: QboReportColData[];
  Rows?: { Row?: QboReportRow[] };
  type?: string;
  group?: string;
}
interface QboReport {
  Columns?: { Column?: Array<{ ColTitle?: string; ColType?: string }> };
  Rows?: { Row?: QboReportRow[] };
}

/**
 * Flatten a TransactionList report into typed rows plus a signed total.
 * Handles the report's nested/grouped `Rows` and skips summary rows (which have
 * no `ColData`). Amounts are parsed from the "Amount" column.
 */
export function parseTransactionList(report: unknown): {
  transactions: ReconcileTxn[];
  total: number;
} {
  const r = report as QboReport;
  const columnDefs = r.Columns?.Column ?? [];
  const cols = columnDefs.map((c) => c.ColTitle ?? "");
  const idx = (title: string) =>
    cols.findIndex((c) => c.toLowerCase() === title.toLowerCase());
  // Amount column: match by title, else by the report's ColType metadata
  // (custom `columns` requests can retitle it, but ColType stays "Amount"/"Money").
  let amountIdx = idx("Amount");
  if (amountIdx < 0)
    amountIdx = columnDefs.findIndex((c) => /amount|money/i.test(c.ColType ?? ""));
  if (amountIdx < 0)
    amountIdx = cols.findIndex((c) => /amount/i.test(c));
  const dateIdx = idx("Date");
  const typeIdx = idx("Transaction Type");
  const numIdx = idx("Num");
  const nameIdx = idx("Name");
  const memoIdx = idx("Memo/Description");
  // account_name column comes back titled "Account" (fall back to any title
  // containing "account" that isn't the split column).
  let accountIdx = idx("Account");
  if (accountIdx < 0)
    accountIdx = cols.findIndex(
      (c) => /account/i.test(c) && !/split/i.test(c),
    );

  const txns: ReconcileTxn[] = [];

  const walk = (rows: QboReportRow[] | undefined) => {
    for (const row of rows ?? []) {
      if (row.Rows?.Row) walk(row.Rows.Row);
      const cd = row.ColData;
      // Skip section/summary rows: real transaction rows carry a full ColData
      // set with an Amount cell.
      if (!cd || amountIdx < 0 || !cd[amountIdx]?.value) continue;
      const raw: Record<string, string> = {};
      cols.forEach((c, i) => {
        if (c) raw[c] = cd[i]?.value ?? "";
      });
      const amount = Number((cd[amountIdx].value ?? "0").replace(/,/g, ""));
      if (Number.isNaN(amount)) continue;
      txns.push({
        date: dateIdx >= 0 ? cd[dateIdx]?.value ?? "" : "",
        type: typeIdx >= 0 ? cd[typeIdx]?.value ?? "" : "",
        docNumber: numIdx >= 0 ? cd[numIdx]?.value ?? "" : "",
        name: nameIdx >= 0 ? cd[nameIdx]?.value ?? "" : "",
        memo: memoIdx >= 0 ? cd[memoIdx]?.value ?? "" : "",
        account: accountIdx >= 0 ? cd[accountIdx]?.value ?? "" : "",
        amount,
        raw,
      });
    }
  };
  walk(r.Rows?.Row);

  const total = txns.reduce((s, t) => s + t.amount, 0);
  return { transactions: txns, total: Math.round(total * 100) / 100 };
}
