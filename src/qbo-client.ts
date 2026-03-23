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

export interface QboConfig {
  clientId: string;
  clientSecret: string;
  realmId: string;
  refreshToken: string;
  /** Override for sandbox testing */
  baseUrl?: string;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const PRODUCTION_BASE = "https://quickbooks.api.intuit.com/v3/company";

export class QboClient {
  private config: QboConfig;
  private tokens: TokenPair | null = null;
  /** Called whenever tokens are refreshed so the caller can persist them */
  public onTokenRefresh?: (refreshToken: string) => void;

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
    const refreshToken = this.tokens?.refreshToken ?? this.config.refreshToken;

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

    if (!res.ok) {
      const text = await res.text();
      throw new QboError(`Token refresh failed: ${res.status} ${text}`, res.status, text);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000 - 60_000, // 1 min buffer
    };

    // Persist the new refresh token (rolling expiration)
    this.config.refreshToken = data.refresh_token;
    this.onTokenRefresh?.(data.refresh_token);

    console.error("[qbo] Tokens refreshed");
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
