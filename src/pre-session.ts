/**
 * What `/mcp` answers a request that reaches its **legacy leg** before a
 * session exists.
 *
 * ## What this module used to be, and why it narrowed
 *
 * Every Claude client generation opens a conversation by POSTing
 * `server/discover` to `/mcp` with no session (#21). Our handler required the
 * first request on a new session to be `initialize`, so it answered:
 *
 *     HTTP 400  {"error": "First request must be an initialize request"}
 *
 * — not a JSON-RPC message at all, so nothing in it a client could act on.
 * This module replaced that with a JSON-RPC `-32601` that named the method,
 * declared the server legacy-era, and pointed at `initialize`. It said so
 * because it was true: `server/discover` is a GA'd method of MCP revision
 * `2026-07-28`, and at the time no released SDK implemented that revision, so
 * answering a `DiscoverResult` would have advertised an era we could not serve
 * a single request of.
 *
 * That is no longer true. The v2 SDK serves `2026-07-28`, `/mcp` now routes
 * modern-enveloped traffic to a real modern handler, and `server/discover`
 * gets a real `DiscoverResult` (#40). So this module keeps only what genuinely
 * remains unanswered, and the sentence it used to speak — "this server is
 * legacy-era, use `initialize`" — would now be false. Two things changed:
 *
 * - The way in is **both** eras, not one. A request landing here has been
 *   classified as legacy-era traffic, which is a statement about the request,
 *   not about the server.
 * - A method this endpoint does implement on its modern leg is no longer
 *   "not implemented by this server". It is not a method of *the legacy era
 *   this request was routed into* — and the answer says which, and why.
 *
 * ## Why the reason is passed in rather than guessed
 *
 * The routing decision and the explanation of it are one fact. `/mcp` routes
 * with the SDK's own classifier, and hands the classifier's `reason` straight
 * to this module, so the sentence a client reads cannot drift from the branch
 * that was actually taken. Deriving a plausible reason here a second time is
 * exactly the two-copies shape #15, #24 and #29 were each an instance of.
 *
 * ## The structure, not the instance
 *
 * As before, this is deliberately not a case for `server/discover`. It is the
 * single answer path for everything `/mcp`'s legacy leg turns away before a
 * session exists — unknown methods, malformed bodies, notifications with
 * nowhere to go, and requests naming a session that is gone — and every one of
 * those answers is a JSON-RPC error that says what to do instead.
 */

import type { LegacyRouteReason } from "./era-routing.js";
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
 * Why this request was routed to the legacy leg, in the SDK classifier's own
 * vocabulary, said in a sentence a client (or a person) can act on.
 *
 * Every arm of `LegacyRouteReason` is named, so a reason added by a later SDK
 * is reported by name rather than silently read as "no claim".
 */
function routedBecause(reason: LegacyRouteReason | undefined): string {
  switch (reason) {
    case "session":
      return "the request names an Mcp-Session-Id, which only the legacy era has";
    case "no-claim":
      return "the request body carried no per-request `_meta` protocol-version claim";
    case "initialize":
      return "the request is an `initialize` handshake, which is legacy-era by definition";
    case "notification":
      return "the request is a notification with no protocol-version claim or header";
    case "http-method":
      return "the HTTP method is a body-less 2025-era session operation";
    case "batch":
      return "the request is an all-legacy JSON-RPC batch";
    case "response":
      return "the request is a JSON-RPC response posted to this endpoint";
    case undefined:
      return "the request was not classified as modern-era traffic";
    default:
      return `the SDK classified it as legacy-era traffic (${reason as string})`;
  }
}

/**
 * How a client gets from here to a working session, on **either** era.
 * Attached to every answer this module produces, so the advice cannot drift
 * from the refusal — the same discipline `src/tools/list-paging.ts` applies to
 * paging advice.
 */
function wayIn(reason?: LegacyRouteReason): Record<string, unknown> {
  return {
    // This endpoint serves both eras of the protocol. `routedTo` is what
    // happened to *this* request, which is the part a client can change.
    era: "dual",
    routedTo: "legacy",
    routedBecause: routedBecause(reason),
    eras: {
      modern: {
        revision: "2026-07-28 and later",
        entry: "server/discover",
        serving: "per request, no session",
        requires:
          "a per-request `_meta` protocol-version envelope " +
          "(`io.modelcontextprotocol/protocolVersion`) in the body, plus the " +
          "`MCP-Protocol-Version` and `Mcp-Method` headers",
      },
      legacy: {
        revisions: SUPPORTED_PROTOCOL_VERSIONS,
        latestRevision: LATEST_PROTOCOL_VERSION,
        entry: "initialize",
        serving: "sessionful, via the returned Mcp-Session-Id header",
      },
    },
    hint:
      "This endpoint serves both MCP eras on the same URL. To open a legacy " +
      `session (protocol ${LATEST_PROTOCOL_VERSION} and earlier), POST an ` +
      "`initialize` request here and send subsequent requests with the " +
      "returned Mcp-Session-Id header. To be served on the modern era " +
      "instead, send the per-request `_meta` protocol-version envelope and " +
      "the SEP-2243 standard headers; `server/discover` is answered there " +
      "with a real DiscoverResult.",
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
 * The answer for a POST to `/mcp` that was routed to the legacy leg, carries
 * no session id, and is not an `initialize` request.
 *
 * Status stays `400` in every case. That is what the spec's backward-
 * compatibility rule expects a legacy-era exchange to answer with, and it is
 * what the clients already recover from; the body is a JSON-RPC error they can
 * read, and now names the modern way in as well.
 */
export function answerPreSession(
  body: unknown,
  reason?: LegacyRouteReason,
): PreSessionAnswer {
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
          data: wayIn(reason),
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
          data: wayIn(reason),
        },
      },
    };
  }

  return {
    status: 400,
    reason: `unimplemented pre-session method ${method} on the legacy leg`,
    body: {
      jsonrpc: "2.0",
      id,
      error: {
        code: JSON_RPC.methodNotFound,
        // Deliberately not "not implemented by this server": a method this
        // endpoint serves on its modern leg is implemented — this request was
        // routed to the leg that does not define it, and `data` says which and
        // how to reach the other one.
        message:
          `Method not found: \`${method}\` is not a pre-session method of the ` +
          "legacy era this request was routed to",
        data: { method, ...wayIn(reason) },
      },
    },
  };
}

/**
 * The answer for a request naming a session this instance does not have —
 * expired, or served by an instance that has since been replaced.
 *
 * Kept here so `/mcp` speaks JSON-RPC on every path it refuses. `404` and
 * `-32001` match what the SDK's own transport answers, so a client that
 * already recognizes the SDK's session-expiry response recognizes ours.
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
            "new one by POSTing an `initialize` request to this endpoint. " +
            "The modern era needs no session at all — see `eras.modern`.",
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
        data: wayIn("http-method"),
      },
    },
  };
}
