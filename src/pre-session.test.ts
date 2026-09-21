import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JSON_RPC,
  answerMissingSession,
  answerPreSession,
  answerUnknownSession,
} from "./pre-session.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol-version.js";

/**
 * The probe every current Claude client generation opens a conversation with,
 * captured from production on 2026-09-18 (#21):
 *   [http] POST /mcp rejected 400 rpc=server/discover session=-
 *          protocolVersion=2026-07-28 ua=claude-code/2.1.260 (sdk-ts, …)
 *
 * A probe in *this* shape no longer reaches this module at all: it carries the
 * per-request `_meta` protocol-version claim, so `/mcp` classifies it as modern
 * and the modern leg answers it with a real DiscoverResult (#40). What still
 * arrives here is the claim-less variant below — the same method asked in a
 * shape that cannot be served on the era it belongs to.
 */
const CLAIMLESS_DISCOVER = {
  jsonrpc: "2.0",
  id: "discover-1",
  method: "server/discover",
  params: {},
};

test("a claim-less modern method is answered with a JSON-RPC error, not a bare string", () => {
  const answer = answerPreSession(CLAIMLESS_DISCOVER, "no-claim");
  assert.equal(answer.status, 400);
  assert.equal(answer.body.jsonrpc, "2.0");
  assert.equal(answer.body.id, "discover-1");
  assert.equal(answer.body.error.code, JSON_RPC.methodNotFound);
  assert.match(answer.body.error.message, /server\/discover/);
});

test("the answer no longer calls this server legacy-era — it names both ways in", () => {
  const data = answerPreSession(CLAIMLESS_DISCOVER, "no-claim").body.error.data!;
  // The server serves both eras; `routedTo` is what happened to this request,
  // which is the part the client can change.
  assert.equal(data.era, "dual");
  assert.equal(data.routedTo, "legacy");

  const eras = data.eras as Record<string, Record<string, unknown>>;
  assert.equal(eras.legacy.entry, "initialize");
  assert.deepEqual(eras.legacy.revisions, SUPPORTED_PROTOCOL_VERSIONS);
  assert.equal(eras.legacy.latestRevision, LATEST_PROTOCOL_VERSION);
  assert.equal(eras.modern.entry, "server/discover");
  assert.match(String(data.hint), /initialize/);
  assert.match(String(data.hint), /server\/discover/);
});

test("the answer says why this request was routed to the legacy leg", () => {
  // The reason is the SDK classifier's own, handed through by the route that
  // took the branch — so the sentence a client reads cannot drift from the
  // decision that was actually made.
  const claimless = answerPreSession(CLAIMLESS_DISCOVER, "no-claim").body.error.data!;
  assert.match(String(claimless.routedBecause), /protocol-version claim/);

  const batched = answerPreSession(CLAIMLESS_DISCOVER, "batch").body.error.data!;
  assert.match(String(batched.routedBecause), /batch/);

  // Every arm of the SDK's reason union is named rather than collapsing into a
  // default, so a reason added by a later SDK is reported by name.
  for (const reason of ["no-claim", "initialize", "notification", "http-method", "batch", "response"] as const) {
    const data = answerPreSession(CLAIMLESS_DISCOVER, reason).body.error.data!;
    assert.ok(
      !/the SDK classified it as/.test(String(data.routedBecause)),
      `${reason} fell through to the default`,
    );
  }
});

test("the legacy leg's version list still excludes the modern revision", () => {
  // `initialize` cannot negotiate 2026-07-28 — the modern era has no handshake
  // — so claiming it in the legacy list would send a client down a path that
  // leg cannot serve. The modern era is named separately, where it is true.
  const data = answerPreSession(CLAIMLESS_DISCOVER, "no-claim").body.error.data!;
  const eras = data.eras as Record<string, Record<string, unknown>>;
  assert.equal((eras.legacy.revisions as string[]).includes("2026-07-28"), false);
  assert.match(String(eras.modern.revision), /2026-07-28/);
});

test("the message does not claim a method this server implements is unimplemented", () => {
  // `server/discover` *is* implemented here — on the modern leg. Saying it "is
  // not implemented by this server" would be false, and would push a dual-era
  // client away from the path that works.
  const message = answerPreSession(CLAIMLESS_DISCOVER, "no-claim").body.error.message;
  assert.ok(!/not implemented by this server/.test(message), message);
  assert.match(message, /legacy era this request was routed to/);
});

test("it is not a special case for server/discover — any method is answered", () => {
  for (const method of ["tools/list", "server/discover", "some/future-method"]) {
    const answer = answerPreSession({ jsonrpc: "2.0", id: 7, method }, "no-claim");
    assert.equal(answer.body.error.code, JSON_RPC.methodNotFound);
    assert.equal(answer.body.error.data!.method, method);
    assert.equal(answer.body.id, 7);
  }
});

test("a pre-session notification is refused with an id-less JSON-RPC error", () => {
  // JSON-RPC forbids a response carrying an id the client never sent; the
  // Streamable HTTP spec allows the error body with no id.
  const answer = answerPreSession({ jsonrpc: "2.0", method: "notifications/initialized" }, "notification");
  assert.equal(answer.status, 400);
  assert.equal(answer.body.id, null);
  assert.equal(answer.body.error.code, JSON_RPC.invalidRequest);
  assert.match(answer.body.error.message, /notifications\/initialized/);
});

test("a body that is not a JSON-RPC message is still answered in JSON-RPC", () => {
  for (const body of [undefined, null, {}, "hello", { id: 1 }, { method: 42 }]) {
    const answer = answerPreSession(body, "no-claim");
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error.code, JSON_RPC.invalidRequest);
    const eras = answer.body.error.data!.eras as Record<string, Record<string, unknown>>;
    assert.equal(eras.legacy.entry, "initialize");
  }
});

test("every answer carries a reason for the log line", () => {
  const answers = [
    answerPreSession(CLAIMLESS_DISCOVER, "no-claim"),
    answerPreSession({ jsonrpc: "2.0", method: "notifications/initialized" }, "notification"),
    answerPreSession({}),
    answerUnknownSession("52f61bc9"),
    answerMissingSession(),
  ];
  for (const answer of answers) {
    assert.ok(answer.reason.length > 0, "reason must not be empty");
  }
});

test("an unknown session is a 404 matching the SDK's own shape", () => {
  const answer = answerUnknownSession("52f61bc9-af6e-402c-9693-70da4e97d004");
  assert.equal(answer.status, 404);
  assert.equal(answer.body.error.code, JSON_RPC.sessionNotFound);
  assert.equal(answer.body.error.message, "Session not found");
  assert.equal(answer.body.error.data!.sessionId, "52f61bc9-af6e-402c-9693-70da4e97d004");
  assert.match(String(answer.body.error.data!.hint), /initialize/);
});

test("a missing session header is a JSON-RPC error too", () => {
  const answer = answerMissingSession();
  assert.equal(answer.status, 400);
  assert.equal(answer.body.error.code, JSON_RPC.invalidRequest);
  assert.match(answer.body.error.message, /Mcp-Session-Id/);
});

test("no answer is the unparseable shape this replaced", () => {
  // `{"error": "First request must be an initialize request"}` — a body with
  // no `jsonrpc`, no numeric code and no id is what made the refusal anonymous.
  for (const answer of [
    answerPreSession(CLAIMLESS_DISCOVER, "no-claim"),
    answerUnknownSession("x"),
    answerMissingSession(),
  ]) {
    assert.equal(answer.body.jsonrpc, "2.0");
    assert.equal(typeof answer.body.error.code, "number");
    assert.ok("id" in answer.body);
  }
});
