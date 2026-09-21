import { test } from "node:test";
import assert from "node:assert/strict";
import { routeEra } from "./era-routing.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "./protocol-version.js";

const MODERN_ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "c", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/**
 * The regression this module exists for, captured from the change that caused
 * it (2026-09-21, driven against a local build of this server):
 *
 *   POST /mcp  Mcp-Session-Id: 8d5380e2-…  MCP-Protocol-Version: 2026-07-28
 *   {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
 *
 *   400 {"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params:
 *        the MCP-Protocol-Version header names protocol revision 2026-07-28,
 *        but the request is missing the required per-request envelope key(s)…
 *   [http] POST /mcp rejected 400 rpc=tools/list session=8d5380e2-…
 *          protocolVersion=2026-07-28 why=modern claim rejected at envelope
 *          (modern-header-without-claim)
 *
 * That is #15 exactly — a live 2025 session whose client echoes `2026-07-28`
 * in the header the Streamable HTTP spec tells it to echo, and every tool call
 * on it failing before any tool runs.
 */
test("a live session whose client announces the modern version is still served (#15)", () => {
  const route = routeEra({
    httpMethod: "POST",
    sessionId: "8d5380e2-dcdc-4750-ae6e-1a2fac3f119a",
    protocolVersionHeader: "2026-07-28",
    body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  assert.equal(route.leg, "legacy");
  assert.equal(route.leg === "legacy" && route.reason, "session");
});

test("a session id routes legacy whatever the headers say", () => {
  // The rule is about the session, not about which header happens to be set —
  // an excepted version string would fail again the next time the spec moves.
  for (const header of [undefined, "2025-06-18", "2026-07-28", "2099-01-01"]) {
    const route = routeEra({
      httpMethod: "POST",
      sessionId: "s-1",
      protocolVersionHeader: header,
      mcpMethodHeader: "tools/list",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: MODERN_ENVELOPE } },
    });
    assert.equal(route.leg, "legacy", `header ${header} left the legacy leg`);
  }
});

test("an expired session is answered by the leg that can tell it to re-initialize", () => {
  // A client whose instance was replaced retries with its old session id. It
  // needs the legacy leg's 404, not a modern parameter error.
  const route = routeEra({
    httpMethod: "POST",
    sessionId: "gone",
    protocolVersionHeader: "2026-07-28",
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} },
  });
  assert.equal(route.leg, "legacy");
});

test("a modern-enveloped request with no session goes to the modern leg", () => {
  const route = routeEra({
    httpMethod: "POST",
    protocolVersionHeader: "2026-07-28",
    mcpMethodHeader: "server/discover",
    body: { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: MODERN_ENVELOPE } },
  });
  assert.equal(route.leg, "modern");
  assert.equal(route.reason, "modern-envelope");
});

test("the 2025 handshake opens a session on the legacy leg", () => {
  const route = routeEra({
    httpMethod: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: {},
        clientInfo: { name: "c", version: "1" },
      },
    },
  });
  assert.equal(route.leg, "legacy");
  assert.equal(route.leg === "legacy" && route.reason, "initialize");
});

test("a malformed modern claim is the modern leg's to answer, and says which rung", () => {
  // A header naming the modern revision with no envelope in the body, on no
  // session: the request is claiming the modern mechanism and getting it
  // wrong, so the modern path owns the error — and the log gets the rung.
  const route = routeEra({
    httpMethod: "POST",
    protocolVersionHeader: "2026-07-28",
    mcpMethodHeader: "tools/list",
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  assert.equal(route.leg, "modern");
  assert.equal(route.reason, "malformed-modern");
  assert.ok(route.reason === "malformed-modern" && route.rung.length > 0);
});

test("a session-less GET or DELETE stays on the legacy leg", () => {
  for (const httpMethod of ["GET", "DELETE"]) {
    const route = routeEra({ httpMethod });
    assert.equal(route.leg, "legacy", `${httpMethod} left the legacy leg`);
    assert.equal(route.leg === "legacy" && route.reason, "http-method");
  }
});
