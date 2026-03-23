import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
import { startHttpServer } from "./http-server.js";
import { DivvyClient } from "./divvy-client.js";
import { registerDivvyTools } from "./tools/divvy.js";

// --- Bill.com config (optional) ---

const billcomEnv = [
  "BILLCOM_API_BASE_URL",
  "BILLCOM_USERNAME",
  "BILLCOM_PASSWORD",
  "BILLCOM_ORGANIZATION_ID",
  "BILLCOM_DEV_KEY",
] as const;

const hasBillcom = billcomEnv.every((k) => process.env[k]);

let billcomConfig: BillComConfig | undefined;
if (hasBillcom) {
  billcomConfig = {
    baseUrl: process.env.BILLCOM_API_BASE_URL!,
    username: process.env.BILLCOM_USERNAME!,
    password: process.env.BILLCOM_PASSWORD!,
    organizationId: process.env.BILLCOM_ORGANIZATION_ID!,
    devKey: process.env.BILLCOM_DEV_KEY!,
  };
  console.error("[mcp] Bill.com tools enabled");
} else {
  console.error("[mcp] Bill.com tools disabled (missing env vars)");
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

if (!hasBillcom && !hasQbo && !divvyApiToken) {
  console.error("ERROR: No integrations configured. Set Bill.com, QuickBooks, and/or Divvy env vars.");
  process.exit(1);
}

// --- Register tools and start ---

function registerAllTools(server: McpServer) {
  if (billcomConfig) {
    const billcomClient = new BillComClient(billcomConfig);
    registerVendorTools(server, billcomClient);
    registerBillTools(server, billcomClient);
  }

  if (qboConfig) {
    const qboClient = new QboClient(qboConfig);
    qboClient.onTokenRefresh = (newToken) => {
      console.error(`[qbo] New refresh token issued — update QBO_REFRESH_TOKEN to persist across restarts`);
      // In production, you'd persist this to Secret Manager here
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
  startHttpServer(billcomConfig, qboConfig);
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
