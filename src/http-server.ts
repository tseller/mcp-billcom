import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { QboConfig } from "./qbo-client.js";
import { QboClient } from "./qbo-client.js";
import { registerQboAccountTools } from "./tools/qbo-accounts.js";
import { registerQboVendorTools } from "./tools/qbo-vendors.js";
import { registerQboTransactionTools } from "./tools/qbo-transactions.js";
import { registerQboReportTools } from "./tools/qbo-reports.js";
import { registerQboReconcileTools } from "./tools/qbo-reconcile.js";
import { createOAuthRouter, createRequireAuth } from "./oauth.js";
import { FirestoreOAuthStore } from "./oauth-store.js";
import { createQboAuthRouter } from "./qbo-auth-callback.js";
import { DivvyClient } from "./divvy-client.js";
import { registerDivvyTools } from "./tools/divvy.js";
import { IdempotencyStore } from "./idempotency.js";
import { gmailClientFromEnv } from "./gmail-client.js";
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
  reconcileProtocolVersion,
  setRequestHeader,
} from "./protocol-version.js";

export function startHttpServer(qboConfig?: QboConfig): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // The protocol version each live session negotiated at `initialize`. This is
  // the authoritative answer to "what does this session speak" — see
  // protocol-version.ts for why the client's per-request header isn't.
  const negotiatedVersions = new Map<string, string>();

  const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || "8080"}`;
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  // One QboClient per process — shared across sessions so single-flight refresh
  // applies across concurrent tool calls. Refresh happens lazily on the first
  // real request rather than on cold start, so two near-simultaneous cold
  // starts don't both race the same refresh token to Intuit (which would trip
  // refresh-token-reuse detection and revoke the whole token family).
  const qboClient = qboConfig ? new QboClient(qboConfig) : undefined;

  // Firestore-backed stores shared across sessions/instances. The Firestore
  // store works off the metadata-server token, independent of the OAuth layer.
  const gcpProjectId = process.env.GCP_PROJECT_ID || "mcp-servers-487419";
  const firestore = new FirestoreOAuthStore(gcpProjectId);
  const idempotency = new IdempotencyStore(firestore);
  const gmail = gmailClientFromEnv();

  // Build the Express app ourselves so we control the JSON body limit.
  // The SDK's createMcpExpressApp hard-codes express.json() at express's
  // default 100kb, which rejects receipt-photo attachments — a 2-3MB JPEG is
  // ~3-4MB as base64 inside the JSON-RPC body. 25mb leaves ample headroom and
  // stays under Cloud Run's 32MB request cap. For our 0.0.0.0 bind the SDK
  // helper adds no DNS-rebinding middleware anyway, so this is otherwise
  // equivalent (and /mcp is still bearer-protected below).
  const app = express();

  // Name every rejected /mcp request in the logs. Cloud Run's access log shows
  // only "400" with a byte count, so a request the transport turns away (wrong
  // protocol version, dead session, bad handshake) is invisible server-side and
  // surfaces to the user as an unexplained tool failure. Log the method,
  // session and protocol version so the next one is readable, not guessed at.
  //
  // Mounted first, ahead of body parsing and auth, so it covers *every* way a
  // /mcp request can be refused — a 401 from the bearer check and a 400 from a
  // body that failed to parse are rejections too, and were previously as
  // anonymous as the ones this line was added for. It logs from `res.finish`,
  // so `req.body` is read after the parser has run (or stays `-` if it never
  // did).
  app.use("/mcp", (req: Request, res: Response, next) => {
    res.on("finish", () => {
      if (res.statusCode < 400) return;
      const body = req.body as { method?: string; id?: unknown } | undefined;
      console.error(
        `[http] ${req.method} /mcp rejected ${res.statusCode}` +
          ` rpc=${body?.method ?? "-"}` +
          ` session=${(req.headers["mcp-session-id"] as string) ?? "-"}` +
          ` protocolVersion=${(req.headers["mcp-protocol-version"] as string) ?? "-"}` +
          ` ua=${req.headers["user-agent"] ?? "-"}`,
      );
    });
    next();
  });

  // Reconcile the client's MCP-Protocol-Version header against the version
  // this session actually negotiated, so a client that announces a version we
  // don't speak is answered rather than refused. See protocol-version.ts.
  app.use("/mcp", (req: Request, _res: Response, next) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const header = req.headers["mcp-protocol-version"] as string | undefined;
    const decision = reconcileProtocolVersion(
      header,
      sessionId ? negotiatedVersions.get(sessionId) : undefined,
    );
    if (decision.action === "replace") {
      setRequestHeader(req, "MCP-Protocol-Version", decision.value);
      console.error(
        `[http] protocol-version reconciled session=${sessionId}` +
          ` client=${header} negotiated=${decision.value}` +
          ` ua=${req.headers["user-agent"] ?? "-"}`,
      );
    }
    next();
  });

  app.use(express.json({ limit: "25mb" }));

  // Mount OAuth routes if Google credentials are configured
  if (googleClientId && googleClientSecret) {
    const oauthStore = firestore;
    const oauthRouter = createOAuthRouter(
      { serverUrl, googleClientId, googleClientSecret },
      oauthStore,
    );
    app.use(oauthRouter);

    // Protect MCP endpoints with OAuth
    app.use("/mcp", createRequireAuth(oauthStore));
    console.error("[http] OAuth enabled (Firestore-backed)");
  } else {
    console.error("[http] OAuth disabled (no GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)");
  }

  // QBO auth routes — for re-auth when refresh token expires
  const intuitClientId = process.env.INTUIT_CLIENT_ID;
  const intuitClientSecret = process.env.INTUIT_CLIENT_SECRET;
  if (intuitClientId && intuitClientSecret) {
    app.use(createQboAuthRouter({ clientId: intuitClientId, clientSecret: intuitClientSecret, serverUrl }));
    console.error("[http] QBO auth routes enabled at /qbo/auth");
  }

  // Unauthenticated liveness probe — lets "container up" be distinguished
  // from "instance failed to start" when diagnosing edge 5xx responses.
  //
  // It also answers "which MCP protocol versions does the deployed server
  // speak?" without a deploy or a log dig. That list is compiled into the SDK,
  // so before this it could only be learned from the 400 the server emitted
  // when it refused a client — the exact failure #15 is about.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      revision: process.env.K_REVISION ?? null,
      protocol: {
        latest: LATEST_PROTOCOL_VERSION,
        supported: SUPPORTED_PROTOCOL_VERSIONS,
        // A version outside `supported` is no longer refused on an established
        // session: it is reconciled to the version that session negotiated.
        unsupportedHeaderPolicy: "reconcile-to-negotiated",
      },
    });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session — route to its transport
    if (sessionId) {
      const transport = transports.get(sessionId);
      if (!transport) {
        // 404 per MCP Streamable HTTP spec — signals the client to
      // start a new session via an initialize request.
      res.status(404).json({ error: "Session not found" });
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — must be an initialize request
    const body = req.body;
    if (!isInitializeRequest(body)) {
      res.status(400).json({ error: "First request must be an initialize request" });
      return;
    }

    // Record what this session settles on, applying the same rule the SDK's
    // initialize handler does. The SDK keeps the negotiated version to itself,
    // and it is the only authority on what the session speaks afterwards.
    const negotiated = negotiateProtocolVersion(
      (body as { params?: { protocolVersion?: unknown } }).params?.protocolVersion,
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
        negotiatedVersions.set(sessionId, negotiated);
        console.error(`[http] New session: ${sessionId} protocolVersion=${negotiated}`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        transports.delete(sid);
        negotiatedVersions.delete(sid);
      }
      console.error(`[http] Session closed: ${sid}`);
    };

    // Create a fresh McpServer + clients for this session
    const server = new McpServer(
      { name: "treasurer-mcp", version: "0.2.0" },
      { capabilities: { tools: {} } },
    );

    if (qboClient) {
      registerQboAccountTools(server, qboClient);
      registerQboVendorTools(server, qboClient);
      registerQboTransactionTools(server, qboClient, { idempotency, gmail });
      registerQboReportTools(server, qboClient);
      registerQboReconcileTools(server, qboClient);
    }

    const divvyToken = process.env.DIVVY_API_TOKEN;
    if (divvyToken) {
      const divvyClient = new DivvyClient(divvyToken);
      registerDivvyTools(server, divvyClient);
    }

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing mcp-session-id header" });
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      // 404 per MCP Streamable HTTP spec — signals the client to
      // start a new session via an initialize request.
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing mcp-session-id header" });
      return;
    }
    const transport = transports.get(sessionId);
    if (!transport) {
      // 404 per MCP Streamable HTTP spec — signals the client to
      // start a new session via an initialize request.
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handleRequest(req, res);
  });

  const port = parseInt(process.env.PORT || "8080", 10);

  const httpServer = app.listen(port, "0.0.0.0", () => {
    console.error(`[http] Listening on 0.0.0.0:${port}`);
  });

  // Graceful shutdown for Cloud Run SIGTERM
  process.on("SIGTERM", async () => {
    console.error("[http] SIGTERM received, shutting down...");
    for (const transport of transports.values()) {
      await transport.close();
    }
    httpServer.close();
  });
}
