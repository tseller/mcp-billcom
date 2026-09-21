import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  McpServer,
  classifyInboundRequest,
  createMcpHandler,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { cachedDiscoverReading, discoverRequest, readDiscoverResult } from "./discover.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "./protocol-version.js";

/**
 * A stand-in for the real factory: one tool, registered once, reachable from
 * whichever era serves the request. The point under test is the era plumbing,
 * not the tools.
 */
function handler(): McpHttpHandler {
  return createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "treasurer-mcp", version: "0.2.0" },
        { capabilities: { tools: {} } },
      );
      server.registerTool(
        "qbo_account_balances",
        { description: "balances", inputSchema: z.object({}) },
        async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
      );
      return server;
    },
    // The same posture http-server.ts uses: the legacy leg there is sessionful
    // and routed in front of this one.
    { legacy: "reject" },
  );
}

test("the modern leg answers server/discover with a real DiscoverResult", async () => {
  const modern = handler();
  const reading = await readDiscoverResult((request) => modern.fetch(request));
  assert.equal(reading.ok, true, reading.ok ? "" : reading.error);
  if (!reading.ok) return;

  // #40's first goal, in one assertion: a modern client asking `server/discover`
  // gets the revisions, the capabilities and the identity — not a signpost
  // pointing at a handshake it does not speak.
  assert.deepEqual(reading.advertisement.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(reading.advertisement.capabilities.tools, { listChanged: true });
  assert.equal(reading.advertisement.serverInfo?.name, "treasurer-mcp");
  assert.equal(reading.advertisement.serverInfo?.version, "0.2.0");
  await modern.close();
});

test("the modern revision is read from the handler, never hand-copied here", async () => {
  // The revision this repo serves appears in no constant of ours: it is asked
  // of the handler (a claim-less request names it in the refusal) and then
  // spoken back. A grep proves the absence — the fact lives in one place, the
  // SDK, which is the whole reason #15/#24/#29's two-copy bugs cannot recur
  // here.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./discover.ts", import.meta.url), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");
  assert.ok(!code.includes("2026-07-28"), "discover.ts must not hard-code a protocol revision");

  const modern = handler();
  const reading = await readDiscoverResult((request) => modern.fetch(request));
  assert.equal(reading.ok && reading.advertisement.supportedVersions[0], "2026-07-28");
  await modern.close();
});

test("a tool registered once is callable on the modern era", async () => {
  const modern = handler();
  const reading = await readDiscoverResult((request) => modern.fetch(request));
  assert.equal(reading.ok, true);
  if (!reading.ok) return;
  const version = reading.advertisement.supportedVersions[0];

  const call = await modern.fetch(
    new Request("http://self-check/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": version,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "qbo_account_balances",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "qbo_account_balances",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  assert.equal(call.status, 200);
  const body = (await call.json()) as { result?: { content?: { text?: string }[] } };
  assert.equal(body.result?.content?.[0]?.text, "ok");
  await modern.close();
});

test("the era fork sends each client to the leg that can serve it", () => {
  // The same classifier `/mcp` routes with. A modern-enveloped request never
  // reaches the session machinery, and a 2025 handshake never reaches the
  // modern handler — which is what makes the sessionful legacy deployment
  // survive the change.
  const envelope = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "c", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  const modern = classifyInboundRequest({
    httpMethod: "POST",
    protocolVersionHeader: "2026-07-28",
    mcpMethodHeader: "server/discover",
    body: { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: envelope } },
  });
  assert.equal(modern.kind, "modern");

  const initialize = classifyInboundRequest({
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
  assert.equal(initialize.kind, "legacy");
  assert.equal(initialize.kind === "legacy" && initialize.reason, "initialize");

  // The residue `src/pre-session.ts` still answers: the modern method asked in
  // a shape that carries no modern claim. It is legacy-routed, so the legacy
  // leg must explain itself rather than refuse anonymously.
  const claimless = classifyInboundRequest({
    httpMethod: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} },
  });
  assert.equal(claimless.kind, "legacy");
  assert.equal(claimless.kind === "legacy" && claimless.reason, "no-claim");
});

test("the discover request carries both halves the modern era requires", () => {
  // Sending the `_meta` envelope without the SEP-2243 headers (or the reverse)
  // is refused `-32020` rather than served, so a probe that omits either would
  // prove nothing about the path a real client takes.
  const request = discoverRequest("2026-07-28");
  assert.equal(request.headers.get("MCP-Protocol-Version"), "2026-07-28");
  assert.equal(request.headers.get("Mcp-Method"), "server/discover");
});

test("a successful reading is computed once, a failed one is retried", async () => {
  let calls = 0;
  const modern = handler();
  const reading = cachedDiscoverReading((request) => {
    calls += 1;
    return modern.fetch(request);
  });

  await reading();
  const afterFirst = calls;
  await reading();
  assert.equal(calls, afterFirst, "a successful reading must not be re-asked");
  await modern.close();

  let failures = 0;
  const failing = cachedDiscoverReading(async () => {
    failures += 1;
    throw new Error("modern leg is still starting");
  });
  assert.equal((await failing()).ok, false);
  await failing();
  assert.equal(failures, 2, "a failed reading must not be cached forever");
});
