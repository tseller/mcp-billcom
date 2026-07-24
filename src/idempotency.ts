/**
 * Idempotency-key store for QBO create tools.
 *
 * A 5xx from the edge is ambiguous — the create may or may not have landed.
 * Callers pass an idempotencyKey; if a create with the same key already
 * succeeded, we return the recorded result instead of creating a duplicate.
 *
 * Backed by the same OAuthStore abstraction the OAuth layer uses: Firestore
 * in HTTP/Cloud Run mode (survives restarts and spans concurrent instances),
 * in-memory for stdio. Best-effort by design: the get/set pair is not a
 * transaction, so two *simultaneous* calls with the same key can both create.
 * That's fine for the real failure mode (sequential retry after an ambiguous
 * error), and QBO has no server-side idempotency to do better against.
 */

import type { OAuthStore } from "./oauth-store.js";

const C_IDEMPOTENCY = "idempotency";

interface IdempotencyRecord {
  result: unknown;
  createdAt: string;
}

export class IdempotencyStore {
  constructor(private store: OAuthStore) {}

  /** Returns the recorded result for (tool, key), or undefined if unseen. */
  async lookup(tool: string, key: string): Promise<unknown | undefined> {
    const rec = await this.store.get<IdempotencyRecord>(C_IDEMPOTENCY, `${tool}:${key}`);
    return rec?.result;
  }

  async record(tool: string, key: string, result: unknown): Promise<void> {
    await this.store.set<IdempotencyRecord>(C_IDEMPOTENCY, `${tool}:${key}`, {
      result,
      createdAt: new Date().toISOString(),
    });
  }
}

/**
 * Run `create` under an optional idempotency key. On replay, returns the
 * original result wrapped so the caller can tell nothing new was created.
 * A store write failure after a successful create is logged, not thrown —
 * the create landed, and failing the call would re-introduce the ambiguity
 * this exists to remove.
 */
export async function withIdempotency(
  idem: IdempotencyStore,
  tool: string,
  key: string | undefined,
  create: () => Promise<unknown>,
): Promise<unknown> {
  if (key) {
    const prior = await idem.lookup(tool, key);
    if (prior !== undefined) {
      console.error(`[idempotency] ${tool} key=${key} replayed`);
      return { idempotentReplay: true, result: prior };
    }
  }
  const result = await create();
  if (key) {
    try {
      await idem.record(tool, key, result);
    } catch (e) {
      console.error(`[idempotency] ${tool} key=${key} record failed (create succeeded): ${e}`);
    }
  }
  return result;
}
