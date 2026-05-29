const DIVVY_BASE_URL = 'https://gateway.prod.bill.com/connect';

// BILL S&E web UI company segment. Stable per company; encoded base64 of
// "Company:<numeric id>". Used to build deep-link URLs into transactions.
// For multi-tenant deployments this would become per-tenant config.
const DIVVY_WEB_COMPANY = 'Q29tcGFueToxMTE3NA==';
const DIVVY_WEB_BASE = 'https://spend.bill.com/companies';

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
      nextPage: params?.page,
      max: params?.pageSize,
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

  async listCustomFieldValues(
    customFieldId: string,
    params?: { page?: string; pageSize?: string },
  ): Promise<unknown> {
    return this.get(`/v3/spend/custom-fields/${customFieldId}/values`, {
      page: params?.page,
      page_size: params?.pageSize,
    });
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

  /**
   * Walk every page of /v3/spend/transactions and return rows that need
   * action: either fields are missing (PTR_INCOMPLETE / INCOMPLETE) or a
   * specific reviewer is still WAITING. Each row carries a `blockers` list
   * naming exactly what's missing, so the caller can act without re-deriving.
   *
   * `reviewerUuid`: when set, restrict to transactions where that user is
   *   listed in `reviewers[]` with `status === "WAITING"`. Useful for "what
   *   am I supposed to approve" queries.
   * `since`: optional YYYY-MM-DD lower bound on `occurredTime` (passed through
   *   as `start_date`).
   */
  async listPendingAction(params?: {
    reviewerUuid?: string;
    since?: string;
  }): Promise<{
    pendingFields: PendingActionRow[];
    pendingReview: PendingActionRow[];
  }> {
    const pendingFields: PendingActionRow[] = [];
    const pendingReview: PendingActionRow[] = [];
    let cursor: string | undefined;
    let safety = 50;
    do {
      const resp = (await this.get('/v3/spend/transactions', {
        start_date: params?.since,
        nextPage: cursor,
        max: '50',
      })) as { results?: RawTransaction[]; nextPage?: string };
      const results = Array.isArray(resp.results) ? resp.results : [];
      for (const tx of results) {
        if (TERMINAL_STATUSES.has(tx.status ?? '')) continue;
        const row = shapePendingRow(tx);
        if (row.blockers.length > 0) {
          pendingFields.push(row);
        } else if (
          tx.reviewRequired &&
          Array.isArray(tx.reviewers) &&
          tx.reviewers.some(
            (r) =>
              r.status === 'WAITING' &&
              (!params?.reviewerUuid || r.userUuid === params.reviewerUuid),
          )
        ) {
          pendingReview.push(row);
        }
      }
      const next = resp.nextPage;
      if (!next || next === cursor) break;
      cursor = next;
      safety -= 1;
    } while (safety > 0);
    return { pendingFields, pendingReview };
  }
}

const TERMINAL_STATUSES = new Set(['APPROVED', 'COMPLETE', 'DECLINED', 'DENIED', 'REVIEWED']);

interface RawCustomField {
  uuid?: string;
  name?: string;
  isRequired?: boolean;
  selectedValues?: unknown[];
  note?: string;
}

interface RawReviewer {
  status?: string;
  userUuid?: string;
  userName?: string;
}

interface RawTransaction {
  id?: string;
  uuid?: string;
  userName?: string;
  merchantName?: string;
  amount?: number;
  occurredTime?: string;
  budgetName?: string;
  status?: string;
  receiptRequired?: boolean;
  receiptStatus?: string;
  reviewRequired?: boolean;
  customFields?: RawCustomField[];
  reviewers?: RawReviewer[];
}

export interface PendingActionRow {
  uuid: string;
  user: string;
  merchant: string;
  amount: number;
  occurredOn: string;
  budget: string;
  status: string;
  blockers: string[];
  waitingReviewers: string[];
  reviewUrl: string;
}

function shapePendingRow(tx: RawTransaction): PendingActionRow {
  const blockers: string[] = [];
  if (tx.receiptRequired && tx.receiptStatus !== 'ATTACHED') {
    blockers.push('receipt missing');
  }
  for (const f of tx.customFields ?? []) {
    if (!f.isRequired) continue;
    const hasSelected = Array.isArray(f.selectedValues) && f.selectedValues.length > 0;
    const hasNote = typeof f.note === 'string' && f.note.trim().length > 0;
    if (!hasSelected && !hasNote) {
      blockers.push(`${f.name ?? 'custom field'} missing`);
    }
  }
  const waitingReviewers = (tx.reviewers ?? [])
    .filter((r) => r.status === 'WAITING')
    .map((r) => r.userName ?? r.userUuid ?? 'unknown')
    .filter((s): s is string => Boolean(s));
  const reviewUrl = tx.id
    ? `${DIVVY_WEB_BASE}/${DIVVY_WEB_COMPANY}/transactions/pending-and-cleared/${tx.id}`
    : '';
  return {
    uuid: tx.uuid ?? '',
    user: tx.userName ?? '',
    merchant: tx.merchantName ?? '',
    amount: typeof tx.amount === 'number' ? tx.amount : 0,
    occurredOn: (tx.occurredTime ?? '').slice(0, 10),
    budget: tx.budgetName ?? '',
    status: tx.status ?? '',
    blockers,
    waitingReviewers,
    reviewUrl,
  };
}
