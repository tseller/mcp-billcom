import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { QboConfig, TokenStore } from "./qbo-client.js";
import { InMemoryTokenStore, QboClient } from "./qbo-client.js";
import { SecretManagerTokenStore } from "./secret-manager-store.js";
import { registerQboAccountTools } from "./tools/qbo-accounts.js";
import { registerQboVendorTools } from "./tools/qbo-vendors.js";
import { registerQboTransactionTools } from "./tools/qbo-transactions.js";
import { registerQboReportTools } from "./tools/qbo-reports.js";
import { startHttpServer } from "./http-server.js";
import { DivvyClient } from "./divvy-client.js";
import { registerDivvyTools } from "./tools/divvy.js";

// --- QuickBooks config (optional) ---

const isHttp = process.env.MCP_TRANSPORT === "http";
const hasQboBase = !!(
  process.env.INTUIT_CLIENT_ID &&
  process.env.INTUIT_CLIENT_SECRET &&
  process.env.QBO_REALM_ID
);
// stdio bootstraps from an env-var refresh token; HTTP reads from Secret Manager.
const hasQbo = hasQboBase && (isHttp || !!process.env.QBO_REFRESH_TOKEN);

let qboConfig: QboConfig | undefined;
if (hasQbo) {
  let tokenStore: TokenStore;
  if (isHttp) {
    const projectId = process.env.GCP_PROJECT_ID || "mcp-servers-487419";
    const secretId = process.env.QBO_REFRESH_TOKEN_SECRET || "QBO_REFRESH_TOKEN";
    tokenStore = new SecretManagerTokenStore(projectId, secretId);
  } else {
    tokenStore = new InMemoryTokenStore(process.env.QBO_REFRESH_TOKEN!);
  }

  qboConfig = {
    clientId: process.env.INTUIT_CLIENT_ID!,
    clientSecret: process.env.INTUIT_CLIENT_SECRET!,
    realmId: process.env.QBO_REALM_ID!,
    tokenStore,
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
