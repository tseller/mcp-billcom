/**
 * Minimal Gmail API client for fetching message attachments server-side,
 * so invoices can flow email → QBO without base64 transiting the chat.
 *
 * Auth: per-account OAuth refresh tokens (scope gmail.readonly), minted once
 * via `npm run gmail:link` and supplied as GMAIL_REFRESH_TOKENS — a JSON
 * object mapping account email → refresh token. Client credentials default
 * to the existing Google OAuth app (GOOGLE_CLIENT_ID/SECRET).
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface MessagePart {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string; size?: number };
  parts?: MessagePart[];
}

export class GmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailError";
  }
}

export class GmailClient {
  private tokens = new Map<string, CachedToken>();

  constructor(
    private clientId: string,
    private clientSecret: string,
    /** account email → OAuth refresh token */
    private refreshTokens: Record<string, string>,
  ) {}

  accountEmails(): string[] {
    return Object.keys(this.refreshTokens);
  }

  /** Resolve which account to use; errors list the configured ones. */
  private resolveAccount(account?: string): string {
    const emails = this.accountEmails();
    if (account) {
      if (!this.refreshTokens[account]) {
        throw new GmailError(
          `Gmail account "${account}" is not configured. Configured accounts: ${emails.join(", ") || "none"}`,
        );
      }
      return account;
    }
    if (emails.length === 1) return emails[0];
    throw new GmailError(
      `gmailAccount is required when multiple accounts are configured: ${emails.join(", ")}`,
    );
  }

  private async accessToken(email: string): Promise<string> {
    const cached = this.tokens.get(email);
    if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshTokens[email],
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) {
      throw new GmailError(
        `Gmail token refresh failed for ${email}: ${res.status} ${await res.text()}`,
      );
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.tokens.set(email, {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000 - 60_000,
    });
    return json.access_token;
  }

  private async api<T>(email: string, path: string): Promise<T> {
    const token = await this.accessToken(email);
    const res = await fetch(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new GmailError(`Gmail API ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Fetch an attachment's bytes. Also fetches the message to recover the
   * attachment's filename (Gmail's attachment endpoint returns bytes only).
   */
  async getAttachment(
    account: string | undefined,
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: Buffer; fileName?: string; mimeType?: string; account: string }> {
    const email = this.resolveAccount(account);

    // Filename lives on the message part, not the attachment resource.
    // Attachment ids are not guaranteed stable across message fetches, so a
    // miss here only costs us the filename — the byte fetch still proceeds.
    let fileName: string | undefined;
    let mimeType: string | undefined;
    try {
      const msg = await this.api<{ payload?: MessagePart }>(email, `/messages/${messageId}`);
      const part = findPart(msg.payload, attachmentId);
      fileName = part?.filename || undefined;
      mimeType = part?.mimeType || undefined;
    } catch (e) {
      console.error(`[gmail] message metadata fetch failed (continuing): ${e}`);
    }

    const att = await this.api<{ data?: string; size?: number }>(
      email,
      `/messages/${messageId}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    if (!att.data) {
      throw new GmailError(`Gmail attachment ${attachmentId} on message ${messageId} has no data`);
    }
    // Gmail returns base64url
    const data = Buffer.from(att.data, "base64url");
    return { data, fileName, mimeType, account: email };
  }
}

function findPart(part: MessagePart | undefined, attachmentId: string): MessagePart | undefined {
  if (!part) return undefined;
  if (part.body?.attachmentId === attachmentId) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, attachmentId);
    if (hit) return hit;
  }
  return undefined;
}

/** Build a GmailClient from env, or undefined if not configured. */
export function gmailClientFromEnv(): GmailClient | undefined {
  const clientId = process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const tokensJson = process.env.GMAIL_REFRESH_TOKENS;
  if (!clientId || !clientSecret || !tokensJson) return undefined;
  let tokens: Record<string, string>;
  try {
    tokens = JSON.parse(tokensJson);
  } catch {
    console.error("[gmail] GMAIL_REFRESH_TOKENS is not valid JSON — Gmail fetch disabled");
    return undefined;
  }
  if (Object.keys(tokens).length === 0) return undefined;
  console.error(`[gmail] Gmail fetch enabled for: ${Object.keys(tokens).join(", ")}`);
  return new GmailClient(clientId, clientSecret, tokens);
}
