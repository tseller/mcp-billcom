const DIVVY_BASE_URL = 'https://gateway.prod.bill.com/connect';

export class DivvyClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor(apiToken: string) {
    this.baseUrl = DIVVY_BASE_URL;
    this.apiToken = apiToken;
  }

  private async request<T = unknown>(
    path: string,
    params?: Record<string, string | undefined>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        apiToken: this.apiToken,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Divvy API error ${response.status} ${response.statusText}${text ? ': ' + text : ''}`
      );
    }

    return response.json() as Promise<T>;
  }

  async listBudgets(): Promise<unknown> {
    return this.request('/v3/spend/budgets');
  }

  async listTransactions(params?: {
    startDate?: string;
    endDate?: string;
    budgetId?: string;
    page?: string;
    pageSize?: string;
  }): Promise<unknown> {
    return this.request('/v3/spend/transactions', {
      start_date: params?.startDate,
      end_date: params?.endDate,
      budget_id: params?.budgetId,
      page: params?.page,
      page_size: params?.pageSize,
    });
  }

  async listCards(): Promise<unknown> {
    return this.request('/v3/spend/cards');
  }

  async listMembers(): Promise<unknown> {
    return this.request('/v3/spend/members');
  }
}
