/**
 * Who decides which MCP protocol version a live session speaks.
 *
 * The Streamable HTTP spec has a client echo its protocol version in an
 * `MCP-Protocol-Version` header on every request after `initialize`. The SDK's
 * transport validates that header against its own compiled-in list and answers
 * a version it doesn't know with `400 Bad Request: Unsupported protocol
 * version` — before the request reaches any tool.
 *
 * That turned into 16 silent tool failures in 30 days for Tim's Claude
 * connector (#15): the connector announces `2026-07-28`, a version no released
 * SDK spoke at the time (v1.30.0, the last of that line, was still on
 * `2025-11-25`), so nothing ran, nothing was logged about the tool, and the
 * Claude UI showed a bare "the tool errored".
 *
 * This server now *does* serve `2026-07-28`, on its own leg (#40) — but that
 * does not retire any of what follows. The legacy `initialize` handshake
 * cannot negotiate the modern revision, so the list below deliberately stops
 * where it did, and a 2025 session whose client echoes a modern version string
 * in its header is still exactly this problem. `src/era-routing.ts` is what
 * keeps such a request on this leg rather than re-reading it as a malformed
 * modern one.
 *
 * The structural problem is that the same fact — what version this session
 * speaks — is stated in two places that can disagree: the version the server
 * *negotiated* at `initialize`, and whatever the client repeats in a header
 * afterwards. The server already knows the authoritative answer; it was
 * instead trusting the client's copy and refusing the request when the two
 * drifted apart. So the fix isn't a conditional that lets `2026-07-28` through
 * (next quarter's version would fail exactly the same way) — it is to
 * reconcile the header against the session's negotiated version, which is what
 * the transport already does when the header is *absent*:
 *
 *   "For HTTP requests without the MCP-Protocol-Version header: accept and
 *    default to the version negotiated at initialization."
 *    — SDK, webStandardStreamableHttp.ts
 *
 * Nothing is loosened by this: the server only ever speaks the version it
 * negotiated and advertised in its own `initialize` response. A client naming
 * some other version in a header does not make the server behave differently —
 * it only used to make the server hang up.
 */
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";

export { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS };

/** Does the SDK compiled into this build speak `version`? */
export function isSupportedProtocolVersion(version: string): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}

/**
 * The version a session ends up speaking, given what the client asked for in
 * its `initialize` body. This mirrors the SDK's own negotiation rule (honor
 * the ask if we speak it, otherwise answer with our latest) so we can record
 * the negotiated version without the SDK exposing it.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && isSupportedProtocolVersion(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

/** What the transport should see for `MCP-Protocol-Version` on this request. */
export type ProtocolVersionDecision =
  | { action: "keep" }
  | { action: "replace"; value: string };

/**
 * Reconcile a request's `MCP-Protocol-Version` header against the version this
 * session negotiated.
 *
 * - No header, or a header we speak: leave it alone.
 * - A header we don't speak, on a session whose negotiated version we know:
 *   substitute the negotiated version. The session agreed on it at
 *   `initialize`, so it — not the client's repetition — is the authority.
 * - A header we don't speak on a session we don't know: leave it alone and let
 *   the request be refused. With no negotiated version there is nothing
 *   authoritative to substitute, and an unknown session is turned away as a
 *   404 by the route handlers first anyway.
 *
 * Deliberately symmetric in time: a header *newer* than anything we speak and
 * one *older* than anything we speak are the same situation — the client is
 * naming a version this session did not agree on — and get the same answer.
 */
export function reconcileProtocolVersion(
  header: string | undefined,
  negotiated: string | undefined,
): ProtocolVersionDecision {
  if (header === undefined || isSupportedProtocolVersion(header)) return { action: "keep" };
  if (negotiated === undefined) return { action: "keep" };
  return { action: "replace", value: negotiated };
}

/** The bits of a Node request a header rewrite has to touch. */
export interface HeaderBearingRequest {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
}

/**
 * Rewrite a request header so the SDK's transport actually sees the new value.
 *
 * `StreamableHTTPServerTransport` is a wrapper that rebuilds the request as a
 * web-standard `Request` via `@hono/node-server`, and hono reads
 * `IncomingMessage.rawHeaders` — not the `headers` object every Express
 * middleware mutates. Setting only `req.headers` changes what our own code
 * sees and nothing the transport validates against, which looks exactly like a
 * working fix right up until the transport refuses the request anyway.
 *
 * `rawHeaders` is a flat [name, value, name, value, …] list with the names in
 * whatever case the client sent, so every matching pair is replaced.
 */
export function setRequestHeader(req: HeaderBearingRequest, name: string, value: string): void {
  const lower = name.toLowerCase();
  req.headers[lower] = value;

  let found = false;
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === lower) {
      req.rawHeaders[i + 1] = value;
      found = true;
    }
  }
  if (!found) req.rawHeaders.push(name, value);
}
