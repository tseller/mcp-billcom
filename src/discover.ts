/**
 * What this endpoint advertises to a modern client — asked of the thing that
 * answers it, never restated beside it.
 *
 * `server/discover` is the 2026-07-28 revision's entry point: a modern client
 * POSTs it before anything else and reads back a `DiscoverResult` naming the
 * revisions the server speaks, its capabilities and its identity. #21 could
 * only refuse that request, because no released SDK implemented the method
 * (see `src/pre-session.ts` for the refusal and why it was the honest answer
 * at the time). The v2 SDK implements it, so the refusal is gone and the
 * question this module answers is a different one: *what did we just tell that
 * client?*
 *
 * `/health` needs that answer, and the tempting way to produce it is a
 * constant — a `MODERN_PROTOCOL_VERSIONS = ["2026-07-28"]` sitting next to the
 * handler. That is the shape this repo keeps finding bugs in: a fact stated in
 * two places that can drift (#15's protocol version in a header vs. the one
 * negotiated, #24's page maximum in the code vs. the schema, #29's filter sent
 * vs. the rows checked). The SDK does not export its modern-revision list from
 * any package root — `SUPPORTED_PROTOCOL_VERSIONS` is the *legacy* handshake's
 * list and stops at `2025-11-25` — so a constant here would be a hand copy of
 * a number only the handler knows. Drift with extra steps.
 *
 * So this module asks, in two steps, and hard-codes no revision at all:
 *
 * 1. Send a claim-less request. A modern-only handler answers `-32022` and
 *    names its own revisions in `error.data.supported` — the endpoint stating
 *    what it serves.
 * 2. Send the real `server/discover` speaking the newest of those, and report
 *    the `DiscoverResult` that comes back.
 *
 * Step 2 is what a modern client does, so a reading that succeeds is proof the
 * client's path works, not an assertion about it. And next year's revision
 * needs no edit here — the same property that made `src/pre-session.ts` answer
 * a method nobody had written yet.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from "@modelcontextprotocol/server";

/** The `DiscoverResult` fields worth reporting, as they arrive on the wire. */
export interface DiscoverAdvertisement {
  /** The modern revisions this endpoint serves, as it named them. */
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
}

/** What a `server/discover` against our own handler produced. */
export type DiscoverReading =
  | { ok: true; advertisement: DiscoverAdvertisement }
  | { ok: false; error: string };

/** A fetch-shaped handler — `McpHttpHandler["fetch"]`, narrowed to what we use. */
export type FetchHandler = (request: Request) => Promise<Response>;

const PROBE_URL = "http://self-check/mcp";

function jsonRpcPost(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(PROBE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Step 1 — the revisions the modern leg says it serves.
 *
 * A request naming no protocol version is refused by a modern-only handler
 * with `-32022 Unsupported protocol version`, whose `data.supported` is the
 * endpoint's own list. We read it rather than restate it.
 */
export async function readSupportedModernVersions(fetchHandler: FetchHandler): Promise<string[]> {
  const response = await fetchHandler(
    jsonRpcPost({ jsonrpc: "2.0", id: "health-versions", method: "server/discover", params: {} }),
  );
  const body = (await response.json()) as {
    error?: { data?: { supported?: unknown } };
  };
  const supported = body.error?.data?.supported;
  if (!Array.isArray(supported) || supported.length === 0) {
    throw new Error(
      `the modern leg did not name its supported revisions when refused (HTTP ${response.status})`,
    );
  }
  return supported.map(String);
}

/**
 * Build the `server/discover` request a modern client sends.
 *
 * The 2026-07-28 revision requires the SEP-2243 standard headers
 * (`MCP-Protocol-Version`, `Mcp-Method`) on every modern request POST *and*
 * the per-request `_meta` envelope in the body. A request carrying only one of
 * the two is refused (`-32020`, headers and body disagree) rather than served,
 * and one carrying neither is classified as legacy-era traffic — so this probe
 * sends both, and therefore travels the same path a real client's does. Every
 * envelope key comes from the SDK's own exported constant.
 */
export function discoverRequest(version: string): Request {
  return jsonRpcPost(
    {
      jsonrpc: "2.0",
      id: "health-discover",
      method: "server/discover",
      params: {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: version,
          [CLIENT_INFO_META_KEY]: { name: "billcom-mcp-self-check", version: "1.0.0" },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    },
    { "MCP-Protocol-Version": version, "Mcp-Method": "server/discover" },
  );
}

/**
 * Read what the modern leg advertises by asking it.
 *
 * A failure is reported rather than thrown: `/health` answering "the modern
 * leg did not answer its own discover, and here is what it said" is a usable
 * diagnosis, where a 500 on the liveness probe is precisely the failure this
 * endpoint exists to tell apart from a dead container.
 */
export async function readDiscoverResult(fetchHandler: FetchHandler): Promise<DiscoverReading> {
  try {
    const versions = await readSupportedModernVersions(fetchHandler);
    // Newest first: the list is the endpoint's own, and a client speaking the
    // newest revision it offers is the case worth proving.
    const newest = [...versions].sort().reverse()[0];

    const response = await fetchHandler(discoverRequest(newest));
    const text = await response.text();
    if (response.status !== 200) {
      return {
        ok: false,
        error: `server/discover answered ${response.status}: ${text.slice(0, 300)}`,
      };
    }
    const body = JSON.parse(text) as {
      result?: { supportedVersions?: unknown; capabilities?: unknown; _meta?: Record<string, unknown> };
      error?: { message?: string };
    };
    if (!body.result) {
      return { ok: false, error: body.error?.message ?? "server/discover returned no result" };
    }
    const { supportedVersions, capabilities, _meta } = body.result;
    if (!Array.isArray(supportedVersions)) {
      return { ok: false, error: "server/discover returned no supportedVersions" };
    }
    return {
      ok: true,
      advertisement: {
        supportedVersions: supportedVersions.map(String),
        capabilities: (capabilities as Record<string, unknown>) ?? {},
        // The 2026-07-28 revision moved server identity out of the result body
        // into result `_meta`: a modern exchange has no `initialize` response
        // to carry it.
        serverInfo: _meta?.[SERVER_INFO_META_KEY] as { name?: string; version?: string } | undefined,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The same reading, computed once. What the modern leg advertises is a
 * property of the build, not of the request asking for it, and `/health` is
 * polled by the platform.
 *
 * A *failed* reading is deliberately not cached: it may be a transient startup
 * condition, and a `/health` that repeats a stale failure forever is the same
 * "succeeds and says nothing true" shape this repo keeps removing.
 */
export function cachedDiscoverReading(fetchHandler: FetchHandler): () => Promise<DiscoverReading> {
  let cached: DiscoverReading | undefined;
  return async () => {
    if (cached?.ok) return cached;
    cached = await readDiscoverResult(fetchHandler);
    return cached;
  };
}
