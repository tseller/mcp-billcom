export class BillComError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseBody?: unknown
  ) {
    super(message);
    this.name = "BillComError";
  }
}

export interface BillComConfig {
  baseUrl: string;
  username: string;
  password: string;
  organizationId: string;
  devKey: string;
}

interface Session {
  sessionId: string;
  loginTime: number;
}

const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

export class BillComClient {
  private config: BillComConfig;
  private session: Session | null = null;

  constructor(config: BillComConfig) {
    this.config = config;
  }

  private async login(): Promise<void> {
    const res = await fetch(`${this.config.baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: this.config.username,
        password: this.config.password,
        organizationId: this.config.organizationId,
        devKey: this.config.devKey,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new BillComError(`Login failed: ${res.status}`, res.status, body);
    }

    const data = (await res.json()) as { sessionId: string };
    this.session = {
      sessionId: data.sessionId,
      loginTime: Date.now(),
    };
    console.error(`[billcom] Logged in, session obtained`);
  }

  private async ensureSession(): Promise<void> {
    if (
      !this.session ||
      Date.now() - this.session.loginTime > SESSION_MAX_AGE_MS
    ) {
      await this.login();
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      devKey: this.config.devKey,
      sessionId: this.session!.sessionId,
    };
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>
  ): Promise<T> {
    await this.ensureSession();

    const url = new URL(`${this.config.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }

    let res = await fetch(url, {
      method,
      headers: this.authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });

    // Auto-retry on 401 (expired session)
    if (res.status === 401) {
      console.error("[billcom] Session expired, re-authenticating...");
      await this.login();
      res = await fetch(url, {
        method,
        headers: this.authHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new BillComError(
        `API error ${res.status}: ${text}`,
        res.status,
        text
      );
    }

    return (await res.json()) as T;
  }

  // --- Vendors ---

  async listVendors(start = 0, max = 20) {
    return this.request("GET", "/vendors", undefined, {
      start: String(start),
      max: String(max),
    });
  }

  async getVendor(id: string) {
    return this.request("GET", `/vendors/${id}`);
  }

  async createVendor(data: Record<string, unknown>) {
    return this.request("POST", "/vendors", data);
  }

  // --- Bills ---

  async listBills(start = 0, max = 20) {
    return this.request("GET", "/bills", undefined, {
      start: String(start),
      max: String(max),
    });
  }

  async getBill(id: string) {
    return this.request("GET", `/bills/${id}`);
  }

  async createBill(data: Record<string, unknown>) {
    return this.request("POST", "/bills", data);
  }
}
