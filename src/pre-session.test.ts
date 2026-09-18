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
 * `server/discover` is a GA'd method of MCP revision 2026-07-28; no released
 * SDK implements it (1.30.0 is on 2025-11-25), so it must be *answered*, not
 * special-cased into existence.
 */
const DISCOVER = {
  jsonrpc: "2.0",
  id: "discover-1",
  method: "server/discover",
  params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
};

test("the connector's probe is answered with a JSON-RPC error, not a bare string", () => {
  const answer = answerPreSession(DISCOVER);
  assert.equal(answer.status, 400);
  assert.equal(answer.body.jsonrpc, "2.0");
  assert.equal(answer.body.id, "discover-1");
  assert.equal(answer.body.error.code, JSON_RPC.methodNotFound);
  assert.match(answer.body.error.message, /server\/discover/);
});

test("the answer names the way in: initialize, and the versions we speak", () => {
  const data = answerPreSession(DISCOVER).body.error.data!;
  assert.equal(data.handshake, "initialize");
  assert.equal(data.era, "legacy");
  assert.deepEqual(data.supportedVersions, SUPPORTED_PROTOCOL_VERSIONS);
  assert.equal(data.latestSupportedVersion, LATEST_PROTOCOL_VERSION);
  assert.match(String(data.hint), /initialize/);
});

test("the version the client announced is not in the list we claim to speak", () => {
  // The list has to be the SDK's own, not a hand-kept copy that could claim
  // 2026-07-28 and send the client back down a path we cannot serve.
  const data = answerPreSession(DISCOVER).body.error.data!;
  assert.equal((data.supportedVersions as string[]).includes("2026-07-28"), false);
});

test("it is not a special case for server/discover — any method is answered", () => {
  for (const method of ["tools/list", "server/discover", "some/future-method"]) {
    const answer = answerPreSession({ jsonrpc: "2.0", id: 7, method });
    assert.equal(answer.body.error.code, JSON_RPC.methodNotFound);
    assert.equal(answer.body.error.data!.method, method);
    assert.equal(answer.body.id, 7);
  }
});

test("a pre-session notification is refused with an id-less JSON-RPC error", () => {
  // JSON-RPC forbids a response carrying an id the client never sent; the
  // Streamable HTTP spec allows the error body with no id.
  const answer = answerPreSession({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(answer.status, 400);
  assert.equal(answer.body.id, null);
  assert.equal(answer.body.error.code, JSON_RPC.invalidRequest);
  assert.match(answer.body.error.message, /notifications\/initialized/);
});

test("a body that is not a JSON-RPC message is still answered in JSON-RPC", () => {
  for (const body of [undefined, null, {}, "hello", { id: 1 }, { method: 42 }]) {
    const answer = answerPreSession(body);
    assert.equal(answer.status, 400);
    assert.equal(answer.body.error.code, JSON_RPC.invalidRequest);
    assert.equal(answer.body.error.data!.handshake, "initialize");
  }
});

test("every answer carries a reason for the log line", () => {
  const answers = [
    answerPreSession(DISCOVER),
    answerPreSession({ jsonrpc: "2.0", method: "notifications/initialized" }),
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
  for (const answer of [answerPreSession(DISCOVER), answerUnknownSession("x"), answerMissingSession()]) {
    assert.equal(answer.body.jsonrpc, "2.0");
    assert.equal(typeof answer.body.error.code, "number");
    assert.ok("id" in answer.body);
  }
});
