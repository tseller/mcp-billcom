/**
 * Which leg of `/mcp` serves a request.
 *
 * One URL serves both MCP eras: a sessionful 2025-era Streamable HTTP
 * deployment (the one this server's clients already hold sessions on) and a
 * per-request 2026-07-28 handler. Deciding between them is the SDK's
 * `classifyInboundRequest`, so the branch taken here cannot disagree with how
 * either leg would have handled the request — with **one** rule in front of
 * it, which is the whole reason this module exists rather than a bare call.
 *
 * ## The rule in front: a session id means legacy, always
 *
 * The 2026-07-28 era is per request and defines no `Mcp-Session-Id` at all. So
 * a request naming a session is legacy-era traffic by construction, and asking
 * a body-primary classifier about it invites exactly the failure #15 was:
 *
 *   Tim's Claude connector opens a 2025 session, then — per the Streamable
 *   HTTP spec — echoes `MCP-Protocol-Version` on every subsequent request. It
 *   echoes `2026-07-28`. That header with no per-request envelope in the body
 *   is, to the classifier, a *malformed modern request*, and the modern leg
 *   answers it `-32602`. Every tool call on that live session fails, nothing
 *   about the tool is logged, and the UI shows "the tool errored" — the 16
 *   silent failures in 30 days that `src/protocol-version.ts` exists to
 *   prevent, reintroduced by the era fork rather than by the SDK.
 *
 * The narrow fix would be to except `2026-07-28` from the modern-header check.
 * The structural one is to notice that the question was asked in the wrong
 * order: a request that names a session has already told us which leg owns it,
 * and no amount of header archaeology should be able to overrule that. So the
 * session id is read first, and only requests that name none are classified.
 *
 * `src/protocol-version.ts` then reconciles that session's header — the
 * behavior that was already correct, now reachable again.
 */

import { classifyInboundRequest } from "@modelcontextprotocol/server";
import type { InboundLegacyRouteReason } from "@modelcontextprotocol/server";

/** The facts a routing decision is made from — a Node request, narrowed. */
export interface RoutableRequest {
  httpMethod: string;
  sessionId?: string;
  protocolVersionHeader?: string;
  mcpMethodHeader?: string;
  mcpNameHeader?: string;
  body?: unknown;
}

/**
 * Why a request is served on the legacy leg: the SDK classifier's own reason,
 * or `"session"` for the rule above — the one case the classifier is never
 * asked about.
 */
export type LegacyRouteReason = InboundLegacyRouteReason | "session";

/** Which leg serves this request, and why. */
export type EraRoute =
  | { leg: "legacy"; reason: LegacyRouteReason }
  | { leg: "modern"; reason: "modern-envelope" }
  /**
   * The request claimed the modern mechanism and got it wrong. The SDK's rule
   * is that the modern path owns the error answers for malformed modern
   * requests, so this is routed there too — but it is named separately so the
   * rejection log says which rung refused it.
   */
  | { leg: "modern"; reason: "malformed-modern"; rung: string; cell: string };

export function routeEra(request: RoutableRequest): EraRoute {
  // A session id is a statement about which leg owns this request, and the
  // modern era never sends one. Read it before anything else looks at a header.
  // An *unknown* session takes this branch too: the legacy leg answers it with
  // the 404 that tells the client to re-`initialize`, which is the answer a
  // client whose session expired needs — not a modern parameter error.
  if (request.sessionId) return { leg: "legacy", reason: "session" };

  const outcome = classifyInboundRequest({
    httpMethod: request.httpMethod,
    protocolVersionHeader: request.protocolVersionHeader,
    mcpMethodHeader: request.mcpMethodHeader,
    mcpNameHeader: request.mcpNameHeader,
    body: request.body,
  });

  if (outcome.kind === "legacy") return { leg: "legacy", reason: outcome.reason };
  if (outcome.kind === "modern") return { leg: "modern", reason: "modern-envelope" };
  return { leg: "modern", reason: "malformed-modern", rung: outcome.rung, cell: outcome.cell };
}
