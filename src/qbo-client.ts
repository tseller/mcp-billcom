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

  /** Eagerly refresh tokens on startup so cold starts get a fresh token. */
  async warmup(): Promise<void> {
    try {
      await this.refreshTokens();
      console.error("[qbo] Warmup: token refreshed successfully");
    } catch (err) {
      console.error("[qbo] Warmup: token refresh failed:", (err as Error).message);
    }
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

    return res.json();
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

  async queryDeposits(where: string, startPosition = 1, maxResults = 100) {
    const clause = where ? `WHERE ${where}` : "";
    return this.query(
      `SELECT * FROM Deposit ${clause} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }

  async getDeposit(id: string) {
    return this.request("GET", `/deposit/${id}`);
  }

  async queryTransfers(where: string, startPosition = 1, maxResults = 100) {
    const clause = where ? `WHERE ${where}` : "";
    return this.query(
      `SELECT * FROM Transfer ${clause} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`,
    );
  }
}
