/**
 * What `/mcp` answers a request that arrives before a session exists.
 *
 * Every Claude client generation opens a conversation by POSTing
 * `server/discover` to `/mcp` with no session (#21). Our handler required the
 * first request on a new session to be `initialize`, so it answered:
 *
 *     HTTP 400  {"error": "First request must be an initialize request"}
 *
 * That is not a JSON-RPC message at all — no `jsonrpc`, no `id`, no numeric
 * error code — so there is nothing in it a client can act on. It has never
 * been user-visible only because the clients fall back to `initialize` on
 * their own; the whole mitigation is the client happening to retry. Measured
 * on production over 24h (2026-09-17T08:11Z..2026-09-18T08:11Z): 31 of these,
 * across three client families.
 *
 * `server/discover` is not an oddity of Tim's connector. It is a GA'd method
 * of MCP revision `2026-07-28` — the revision those clients announce — where
 * "Servers **MUST** implement it". No released `@modelcontextprotocol/sdk`
 * does: 1.30.0 (latest as of 2026-09-18) speaks `2025-11-25` at the newest and
 * the string `server/discover` appears nowhere in it. So this cannot be fixed
 * by upgrading the SDK, and it is not a bug in the client.
 *
 * ## Why we answer it rather than implement it
 *
 * `server/discover` returns a `DiscoverResult`, and in the spec's own era
 * model that result is the signal "this is a modern server" — one that serves
 * requests statelessly with per-request `_meta` and no handshake. We cannot
 * serve a single modern request: the SDK compiled into this build implements
 * the `initialize` handshake and nothing else. Answering a `DiscoverResult`
 * would advertise an era we cannot honor and would push a dual-era client
 * *away* from the handshake that currently works — trading a refusal the
 * client recovers from for a claim it would believe.
 *
 * So the honest answer is the one the spec's own HTTP backward-compatibility
 * rule tells a client to read:
 *
 *   "On `400 Bad Request`, the client SHOULD inspect the response body before
 *    falling back. […] If the body is empty or is not a recognized modern
 *    JSON-RPC error, fall back to `initialize` and continue with the legacy
 *    version for subsequent requests."
 *    — Streamable HTTP, Backward Compatibility (2026-07-28)
 *
 * A JSON-RPC `-32601 Method not found` is exactly that: a well-formed body
 * that identifies us as a legacy-era server, names the versions we do speak,
 * and names `initialize` as the way in. The client's recovery becomes
 * something we told it rather than something it guessed, and a human reading
 * the response sees a sentence instead of a byte count.
 *
 * ## The structure, not the instance
 *
 * The fix is deliberately not a case for `server/discover`. The refusal was
 * anonymous for *any* pre-session method, and next year's spec will add
 * another one. So this module is the single answer path for everything
 * `/mcp` turns away before a session exists — unknown methods, malformed
 * bodies, notifications with nowhere to go, and requests naming a session
 * that is gone — and every one of those answers is a JSON-RPC error that says
 * what to do instead.
 */

import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol-version.js";

/** JSON-RPC error codes we answer with. Matches the SDK's own numbering. */
export const JSON_RPC = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  /** The SDK's transport answers an unknown session with this same code. */
  sessionNotFound: -32001,
} as const;

/** A JSON-RPC error response, as sent on the wire. */
export interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  /** Echoed from the request; `null` when there was no usable id. */
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

/** What the route should send, and the one-line reason for the log. */
export interface PreSessionAnswer {
  status: number;
  body: JsonRpcErrorBody;
  reason: string;
}

/**
 * How a client gets from here to a working session. Attached to every answer
 * this module produces, so the advice cannot drift from the refusal — the same
 * discipline `src/tools/list-paging.ts` applies to paging advice.
 */
function wayIn(): Record<string, unknown> {
  return {
    // Named so a reader (or a client) learns which era this server is without
    // having to infer it from a version string.
    era: "legacy",
    handshake: "initialize",
    supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
    latestSupportedVersion: LATEST_PROTOCOL_VERSION,
    hint:
      "This server implements the MCP initialize handshake (protocol " +
      `${LATEST_PROTOCOL_VERSION} and earlier). Open a session by POSTing an ` +
      "`initialize` request to this endpoint, then send subsequent requests " +
      "with the returned Mcp-Session-Id header.",
  };
}

/** Is this body a JSON-RPC request (has an id) rather than a notification? */
function requestId(body: unknown): string | number | null {
  const id = (body as { id?: unknown })?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function methodName(body: unknown): string | undefined {
  const method = (body as { method?: unknown })?.method;
  return typeof method === "string" ? method : undefined;
}

/**
 * The answer for a POST to `/mcp` that carries no session id and is not an
 * `initialize` request.
 *
 * Status stays `400` in every case. That is what the spec's backward-
 * compatibility rule expects a legacy-era server to answer a modern request
 * with, and it is what the clients already recover from; what changes is that
 * the body is now a JSON-RPC error they can read.
 */
export function answerPreSession(body: unknown): PreSessionAnswer {
  const method = methodName(body);
  const id = requestId(body);

  if (method === undefined) {
    return {
      status: 400,
      reason: "body is not a JSON-RPC request",
      body: {
        jsonrpc: "2.0",
        id,
        error: {
          code: JSON_RPC.invalidRequest,
          message: "Invalid Request: expected a JSON-RPC message naming a method",
          data: wayIn(),
        },
      },
    };
  }

  if (id === null) {
    // A notification with no session has nowhere to be delivered. The spec
    // allows exactly this: "If the server cannot accept it, it MUST return an
    // HTTP error status code […] The HTTP response body MAY comprise a
    // JSON-RPC error response that has no id."
    return {
      status: 400,
      reason: `notification ${method} before a session exists`,
      body: {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSON_RPC.invalidRequest,
          message: `Cannot accept notification \`${method}\`: no session has been established`,
          data: wayIn(),
        },
      },
    };
  }

  return {
    status: 400,
    reason: `unimplemented pre-session method ${method}`,
    body: {
      jsonrpc: "2.0",
      id,
      error: {
        code: JSON_RPC.methodNotFound,
        message: `Method not found: \`${method}\` is not implemented by this server`,
        data: { method, ...wayIn() },
      },
    },
  };
}

/**
 * The answer for a request naming a session this instance does not have —
 * expired, or served by an instance that has since been replaced.
 *
 * Kept here so `/mcp` speaks JSON-RPC on every path it refuses: this used to
 * be `{"error": "Session not found"}`, the same unreadable shape for the same
 * reason. `404` and `-32001` match what the SDK's own transport answers, so a
 * client that already recognizes the SDK's session-expiry response recognizes
 * ours.
 */
export function answerUnknownSession(sessionId: string | undefined): PreSessionAnswer {
  return {
    status: 404,
    reason: `unknown session ${sessionId ?? "-"}`,
    body: {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JSON_RPC.sessionNotFound,
        message: "Session not found",
        data: {
          sessionId: sessionId ?? null,
          ...wayIn(),
          hint:
            "The session named by Mcp-Session-Id is not known to this server " +
            "(it expired, or the instance holding it was replaced). Start a " +
            "new one by POSTing an `initialize` request to this endpoint.",
        },
      },
    },
  };
}

/** The answer for a GET/DELETE that names no session at all. */
export function answerMissingSession(): PreSessionAnswer {
  return {
    status: 400,
    reason: "missing mcp-session-id header",
    body: {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JSON_RPC.invalidRequest,
        message: "Invalid Request: missing Mcp-Session-Id header",
        data: wayIn(),
      },
    },
  };
}
