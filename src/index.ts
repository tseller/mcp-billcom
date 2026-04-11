import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { QboConfig } from "./qbo-client.js";
import { QboClient } from "./qbo-client.js";
import { registerQboAccountTools } from "./tools/qbo-accounts.js";
import { registerQboVendorTools } from "./tools/qbo-vendors.js";
import { registerQboTransactionTools } from "./tools/qbo-transactions.js";
import { registerQboReportTools } from "./tools/qbo-reports.js";
import { startHttpServer } from "./http-server.js";
import { DivvyClient } from "./divvy-client.js";
import { registerDivvyTools } from "./tools/divvy.js";

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

// --- QuickBooks config (optional) ---

const qboEnv = ["INTUIT_CLIENT_ID", "INTUIT_CLIENT_SECRET", "QBO_REALM_ID", "QBO_REFRESH_TOKEN"] as const;
const hasQbo = qboEnv.every((k) => process.env[k]);

let qboConfig: QboConfig | undefined;
if (hasQbo) {
  qboConfig = {
    clientId: process.env.INTUIT_CLIENT_ID!,
    clientSecret: process.env.INTUIT_CLIENT_SECRET!,
    realmId: process.env.QBO_REALM_ID!,
    refreshToken: process.env.QBO_REFRESH_TOKEN!,
    baseUrl: process.env.QBO_BASE_URL,
  };
  console.error("[mcp] QuickBooks tools enabled");
} else {
  console.error("[mcp] QuickBooks tools disabled (missing env vars)");
}

// --- Divvy config (optional) ---

const divvyApiToken = process.env.DIVVY_API_TOKEN;
if (divvyApiToken) {
  console.error("[mcp] Divvy tools enabled");
} else {
  console.error("[mcp] Divvy tools disabled (missing DIVVY_API_TOKEN)");
}

if (!hasQbo && !divvyApiToken) {
  console.error("ERROR: No integrations configured. Set QuickBooks and/or Divvy env vars.");
  process.exit(1);
}

// --- Register tools and start ---

function registerAllTools(server: McpServer) {
  if (qboConfig) {
    const qboClient = new QboClient(qboConfig);
    qboClient.onTokenRefresh = async (newToken) => {
      console.error(`[qbo] New refresh token issued — persisting to Secret Manager`);
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
    };
    registerQboAccountTools(server, qboClient);
    registerQboVendorTools(server, qboClient);
    registerQboTransactionTools(server, qboClient);
    registerQboReportTools(server, qboClient);
  }

  if (divvyApiToken) {
    const divvyClient = new DivvyClient(divvyApiToken);
    registerDivvyTools(server, divvyClient);
  }
}

if (process.env.MCP_TRANSPORT === "http") {
  startHttpServer(qboConfig);
} else {
  const server = new McpServer(
    { name: "treasurer-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  registerAllTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] Server started (stdio)");
}
