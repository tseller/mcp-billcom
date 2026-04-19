const DIVVY_BASE_URL = 'https://gateway.prod.bill.com/connect';

export class DivvyClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor(apiToken: string) {
    this.baseUrl = DIVVY_BASE_URL;
    this.apiToken = apiToken;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    params?: Record<string, string | undefined>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      apiToken: this.apiToken,
      'Content-Type': 'application/json',
    };

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Divvy API error ${response.status} ${response.statusText}${text ? ': ' + text : ''}`
      );
    }

    return response.json() as Promise<T>;
  }

  private async get<T = unknown>(
    path: string,
    params?: Record<string, string | undefined>,
  ): Promise<T> {
    return this.request('GET', path, params);
  }

  private async post<T = unknown>(
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.request('POST', path, undefined, body);
  }

  async listBudgets(): Promise<unknown> {
    return this.get('/v3/spend/budgets');
  }

  async listTransactions(params?: {
    startDate?: string;
    endDate?: string;
    budgetId?: string;
    syncStatus?: string;
    page?: string;
    pageSize?: string;
  }): Promise<unknown> {
    return this.get('/v3/spend/transactions', {
      start_date: params?.startDate,
      end_date: params?.endDate,
      budget_id: params?.budgetId,
      sync_status: params?.syncStatus,
      page: params?.page,
      page_size: params?.pageSize,
    });
  }

  async getTransaction(transactionId: string): Promise<unknown> {
    return this.get(`/v3/spend/transactions/${transactionId}`);
  }

  async listCards(): Promise<unknown> {
    return this.get('/v3/spend/cards');
  }

  async listMembers(): Promise<unknown> {
    return this.get('/v3/spend/members');
  }

  /**
   * Upload a receipt to a transaction. Three-step flow:
   * 1. Get a pre-signed upload URL from BILL
   * 2. PUT the receipt bytes to that URL
   * 3. POST the URL back to BILL to attach it to the transaction
   */
  async getReceiptUploadUrl(): Promise<{ url: string }> {
    const resp = await this.post<Record<string, unknown>>(
      '/v3/spend/transactions/receipt-upload-url',
    );
    const url = resp && typeof resp === 'object' ? (resp as { url?: unknown }).url : undefined;
    if (typeof url !== 'string') {
      throw new Error(
        `Divvy receipt-upload-url response missing 'url' field. Got: ${JSON.stringify(resp)}`,
      );
    }
    return { url };
  }

  async uploadReceiptFile(uploadUrl: string, imageData: Buffer, contentType: string): Promise<void> {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(imageData.buffer, imageData.byteOffset, imageData.byteLength) as unknown as BodyInit,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Receipt upload failed: ${response.status} ${response.statusText}${text ? ': ' + text : ''}`,
      );
    }
  }

  async attachReceiptToTransaction(transactionUuid: string, uploadUrl: string): Promise<unknown> {
    return this.post(`/v3/spend/transactions/${transactionUuid}/receipts`, { url: uploadUrl });
  }

  async listCustomFields(): Promise<unknown> {
    return this.get('/v3/spend/custom-fields');
  }

  async listCustomFieldValues(customFieldId: string): Promise<unknown> {
    return this.get(`/v3/spend/custom-fields/${customFieldId}/values`);
  }

  /**
   * Assign custom field values to a transaction. Each entry needs
   * `customFieldId` (the field's ID) and either `selectedValues` (value IDs,
   * for SELECT-type fields) or `note` (for NOTE-type fields).
   */
  async updateTransactionCustomFields(
    transactionUuid: string,
    customFields: Array<{ customFieldId: string; selectedValues?: string[]; note?: string }>,
  ): Promise<unknown> {
    return this.request(
      'PUT',
      `/v3/spend/transactions/${transactionUuid}/custom-fields`,
      undefined,
      { customFields },
    );
  }
}
