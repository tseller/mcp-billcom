import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { BillComConfig } from "./billcom-client.js";
import { BillComClient } from "./billcom-client.js";
import { registerVendorTools } from "./tools/vendors.js";
import { registerBillTools } from "./tools/bills.js";
import { createOAuthRouter, requireAuth } from "./oauth.js";

export function startHttpServer(config: BillComConfig): void {
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

    // Create a fresh McpServer + BillComClient for this session
    const client = new BillComClient(config);
    const server = new McpServer(
      { name: "billcom", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerVendorTools(server, client);
    registerBillTools(server, client);

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
