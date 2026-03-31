import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";

/** Get an access token from Cloud Run's metadata server for Secret Manager API calls. */
async function getAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`Metadata token fetch failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function persistRefreshToken(newToken: string): Promise<void> {
  try {
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/mcp-servers-487419/secrets/QBO_REFRESH_TOKEN:addVersion`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await getAccessToken()}`,
        },
        body: JSON.stringify({
          payload: { data: Buffer.from(newToken).toString("base64") },
        }),
      },
    );
    if (res.ok) {
      console.error("[qbo] Refresh token persisted to Secret Manager");
    } else {
      console.error(`[qbo] Failed to persist refresh token: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error("[qbo] Failed to persist refresh token:", err);
  }
}
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { BillComConfig } from "./billcom-client.js";
import { BillComClient } from "./billcom-client.js";
import type { QboConfig } from "./qbo-client.js";
import { QboClient } from "./qbo-client.js";
import { registerVendorTools } from "./tools/vendors.js";
import { registerBillTools } from "./tools/bills.js";
import { registerQboAccountTools } from "./tools/qbo-accounts.js";
import { registerQboVendorTools } from "./tools/qbo-vendors.js";
import { registerQboTransactionTools } from "./tools/qbo-transactions.js";
import { registerQboReportTools } from "./tools/qbo-reports.js";
import { createOAuthRouter, requireAuth } from "./oauth.js";
import { createQboAuthRouter } from "./qbo-auth-callback.js";
import { DivvyClient } from "./divvy-client.js";
import { registerDivvyTools } from "./tools/divvy.js";

export function startHttpServer(billcomConfig?: BillComConfig, qboConfig?: QboConfig): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || "8080"}`;
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  const app = createMcpExpressApp({ host: "0.0.0.0" });

  // Mount OAuth routes if Google credentials are configured
  if (googleClientId && googleClientSecret) {
    const oauthRouter = createOAuthRouter({
      serverUrl,
      googleClientId,
      googleClientSecret,
    });
    app.use(oauthRouter);

    // Protect MCP endpoints with OAuth
    app.use("/mcp", requireAuth);
    console.error("[http] OAuth enabled");
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

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session — route to its transport
    if (sessionId) {
      const transport = transports.get(sessionId);
      if (!transport) {
        res.status(400).json({ error: "Invalid session ID" });
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

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
        console.error(`[http] New session: ${sessionId}`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
      console.error(`[http] Session closed: ${sid}`);
    };

    // Create a fresh McpServer + clients for this session
    const server = new McpServer(
      { name: "treasurer-mcp", version: "0.2.0" },
      { capabilities: { tools: {} } },
    );

    if (billcomConfig) {
      const billcomClient = new BillComClient(billcomConfig);
      registerVendorTools(server, billcomClient);
      registerBillTools(server, billcomClient);
    }

    if (qboConfig) {
      const qboClient = new QboClient(qboConfig);
      qboClient.onTokenRefresh = (newToken) => {
        console.error("[qbo] New refresh token issued — persisting to Secret Manager");
        persistRefreshToken(newToken);
      };
      registerQboAccountTools(server, qboClient);
      registerQboVendorTools(server, qboClient);
      registerQboTransactionTools(server, qboClient);
      registerQboReportTools(server, qboClient);
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
      res.status(400).json({ error: "Invalid session ID" });
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
      res.status(400).json({ error: "Invalid session ID" });
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
