import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
  reconcileProtocolVersion,
  setRequestHeader,
} from "./protocol-version.js";

/**
 * The version Tim's Claude connector announces. Captured from production on
 * 2026-09-17 (#15):
 *   [http] POST /mcp rejected 400 rpc=server/discover session=-
 *          protocolVersion=2026-07-28 ua=Claude-User
 * No released SDK spoke it at the time — v1.30.0, the last of that line, was
 * still on 2025-11-25 — so it must not be an allow-listed special case.
 *
 * This server serves 2026-07-28 now (#40), on its own leg. It is still not a
 * version the *legacy* handshake can negotiate, which is what these tests are
 * about: `initialize` has no modern revision to settle on, so a session that
 * announces one in a header is still reconciled rather than refused.
 */
const CONNECTOR_VERSION = "2026-07-28";

test("the version the connector announces is one we do not speak", () => {
  assert.equal(isSupportedProtocolVersion(CONNECTOR_VERSION), false);
});

test("negotiation honors a version we speak", () => {
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    assert.equal(negotiateProtocolVersion(v), v);
  }
});

test("negotiation answers a version we do not speak with our latest", () => {
  assert.equal(negotiateProtocolVersion(CONNECTOR_VERSION), LATEST_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion("2019-01-01"), LATEST_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(undefined), LATEST_PROTOCOL_VERSION);
  assert.equal(negotiateProtocolVersion(42), LATEST_PROTOCOL_VERSION);
});

test("the connector's header is reconciled to what its session negotiated", () => {
  // The whole bug: this used to be a 400 before any tool ran.
  assert.deepEqual(reconcileProtocolVersion(CONNECTOR_VERSION, LATEST_PROTOCOL_VERSION), {
    action: "replace",
    value: LATEST_PROTOCOL_VERSION,
  });
});

test("a header we speak is left alone", () => {
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    assert.deepEqual(reconcileProtocolVersion(v, LATEST_PROTOCOL_VERSION), { action: "keep" });
  }
});

test("an absent header is left alone — the transport already defaults it", () => {
  assert.deepEqual(reconcileProtocolVersion(undefined, LATEST_PROTOCOL_VERSION), { action: "keep" });
});

test("a session that negotiated an older version is reconciled to that, not to latest", () => {
  // Substituting LATEST here would silently upgrade a session behind the
  // client's back. The negotiated version is the authority, whatever it is.
  const older = "2025-03-26";
  assert.ok(isSupportedProtocolVersion(older));
  assert.deepEqual(reconcileProtocolVersion(CONNECTOR_VERSION, older), {
    action: "replace",
    value: older,
  });
});

test("older and newer unknown versions are treated identically", () => {
  const ancient = reconcileProtocolVersion("2019-01-01", LATEST_PROTOCOL_VERSION);
  const future = reconcileProtocolVersion("2099-12-31", LATEST_PROTOCOL_VERSION);
  assert.deepEqual(ancient, future);
  assert.deepEqual(future, { action: "replace", value: LATEST_PROTOCOL_VERSION });
});

test("with no negotiated version there is nothing authoritative to substitute", () => {
  assert.deepEqual(reconcileProtocolVersion(CONNECTOR_VERSION, undefined), { action: "keep" });
});

/**
 * The SDK's Node transport rebuilds the request via @hono/node-server, which
 * reads `rawHeaders`. A rewrite that touches only `headers` passes every
 * express-shaped assertion and still gets the request refused — that is the
 * shape of a fix that looks green locally and changes nothing in production.
 */
test("a header rewrite lands in rawHeaders, which is what the transport reads", () => {
  const req = {
    headers: { "mcp-protocol-version": CONNECTOR_VERSION } as Record<string, string | string[] | undefined>,
    rawHeaders: ["Content-Type", "application/json", "MCP-Protocol-Version", CONNECTOR_VERSION],
  };
  setRequestHeader(req, "MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  assert.equal(req.headers["mcp-protocol-version"], LATEST_PROTOCOL_VERSION);
  assert.deepEqual(req.rawHeaders, [
    "Content-Type",
    "application/json",
    "MCP-Protocol-Version",
    LATEST_PROTOCOL_VERSION,
  ]);
});

test("a header rewrite matches the client's casing, whatever it sent", () => {
  const req = {
    headers: {} as Record<string, string | string[] | undefined>,
    rawHeaders: ["mcp-PROTOCOL-version", CONNECTOR_VERSION],
  };
  setRequestHeader(req, "MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  assert.deepEqual(req.rawHeaders, ["mcp-PROTOCOL-version", LATEST_PROTOCOL_VERSION]);
});

test("a duplicated header is rewritten in every copy, not just the first", () => {
  // Node keeps repeated headers as repeated rawHeaders pairs. Leaving a stale
  // copy behind would let the transport read the old value back.
  const req = {
    headers: {} as Record<string, string | string[] | undefined>,
    rawHeaders: ["MCP-Protocol-Version", CONNECTOR_VERSION, "MCP-Protocol-Version", CONNECTOR_VERSION],
  };
  setRequestHeader(req, "MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  assert.deepEqual(req.rawHeaders, [
    "MCP-Protocol-Version",
    LATEST_PROTOCOL_VERSION,
    "MCP-Protocol-Version",
    LATEST_PROTOCOL_VERSION,
  ]);
});

test("a header the client never sent is appended", () => {
  const req = { headers: {} as Record<string, string | string[] | undefined>, rawHeaders: ["Accept", "*/*"] };
  setRequestHeader(req, "MCP-Protocol-Version", LATEST_PROTOCOL_VERSION);
  assert.deepEqual(req.rawHeaders, ["Accept", "*/*", "MCP-Protocol-Version", LATEST_PROTOCOL_VERSION]);
});
