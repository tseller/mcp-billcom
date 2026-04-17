/**
 * Persistence for the MCP OAuth layer.
 *
 * Cloud Run scales instances to zero aggressively, so anything kept in a
 * module-level Map disappears between cold starts. We persist OAuth state to
 * Firestore so refresh tokens / registered clients survive restarts and are
 * visible across concurrent instances.
 *
 * Documents are stored with a single `data: stringValue` field holding the
 * JSON-serialized record. We never query by field, so typed Firestore
 * documents would be pure ceremony.
 */

import { getMetadataAccessToken } from "./gcp-metadata.js";

export interface OAuthStore {
  get<T>(collection: string, key: string): Promise<T | undefined>;
  set<T>(collection: string, key: string, value: T): Promise<void>;
  delete(collection: string, key: string): Promise<void>;
}

export class InMemoryOAuthStore implements OAuthStore {
  private data = new Map<string, Map<string, unknown>>();

  private col(name: string): Map<string, unknown> {
    let m = this.data.get(name);
    if (!m) {
      m = new Map();
      this.data.set(name, m);
    }
    return m;
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.col(collection).get(key) as T | undefined;
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    this.col(collection).set(key, value);
  }

  async delete(collection: string, key: string): Promise<void> {
    this.col(collection).delete(key);
  }
}

export class FirestoreOAuthStore implements OAuthStore {
  constructor(
    private projectId: string,
    private databaseId: string = "(default)",
  ) {}

  private docUrl(collection: string, key: string): string {
    const db = encodeURIComponent(this.databaseId);
    const enc = encodeURIComponent(key);
    return `https://firestore.googleapis.com/v1/projects/${this.projectId}/databases/${db}/documents/${collection}/${enc}`;
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    const token = await getMetadataAccessToken();
    const res = await fetch(this.docUrl(collection, key), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new Error(`Firestore get ${collection}/${key} failed: ${res.status} ${await res.text()}`);
    }
    const doc = (await res.json()) as { fields?: { data?: { stringValue?: string } } };
    const raw = doc.fields?.data?.stringValue;
    if (raw == null) return undefined;
    return JSON.parse(raw) as T;
  }

  async set<T>(collection: string, key: string, value: T): Promise<void> {
    const token = await getMetadataAccessToken();
    const res = await fetch(this.docUrl(collection, key), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        fields: { data: { stringValue: JSON.stringify(value) } },
      }),
    });
    if (!res.ok) {
      throw new Error(`Firestore set ${collection}/${key} failed: ${res.status} ${await res.text()}`);
    }
  }

  async delete(collection: string, key: string): Promise<void> {
    const token = await getMetadataAccessToken();
    const res = await fetch(this.docUrl(collection, key), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return;
    if (!res.ok) {
      throw new Error(`Firestore delete ${collection}/${key} failed: ${res.status} ${await res.text()}`);
    }
  }
}
