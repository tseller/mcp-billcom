import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { BillComConfig } from "./billcom-client.js";
import { BillComClient } from "./billcom-client.js";
import { registerVendorTools } from "./tools/vendors.js";
import { registerBillTools } from "./tools/bills.js";
import { startHttpServer } from "./http-server.js";

// Validate required env vars
const required = [
  "BILLCOM_API_BASE_URL",
  "BILLCOM_USERNAME",
  "BILLCOM_PASSWORD",
  "BILLCOM_ORGANIZATION_ID",
  "BILLCOM_DEV_KEY",
] as const;

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const config: BillComConfig = {
  baseUrl: process.env.BILLCOM_API_BASE_URL!,
  username: process.env.BILLCOM_USERNAME!,
  password: process.env.BILLCOM_PASSWORD!,
  organizationId: process.env.BILLCOM_ORGANIZATION_ID!,
  devKey: process.env.BILLCOM_DEV_KEY!,
};

if (process.env.MCP_TRANSPORT === "http") {
  startHttpServer(config);
} else {
  const client = new BillComClient(config);
  const server = new McpServer(
    { name: "billcom", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  registerVendorTools(server, client);
  registerBillTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[billcom-mcp] Server started (stdio)");
}
