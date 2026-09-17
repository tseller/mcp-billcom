import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QboClient } from "../qbo-client.js";
import { runTool } from "../tool-logging.js";

export function registerQboVendorTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_list_vendors",
    "List active vendors in QuickBooks with pagination.",
    {
      startPosition: z.number().int().min(1).optional().describe("1-based start position (default 1)"),
      maxResults: z.number().int().min(1).max(1000).optional().describe("Max results (default 100)"),
    },
    (args) =>
      runTool("qbo_list_vendors", args, ({ startPosition, maxResults }) =>
        client.listVendors(startPosition ?? 1, maxResults ?? 100),
      ),
  );

  server.tool(
    "qbo_search_vendors",
    "Search for vendors by name (partial match).",
    {
      name: z.string().describe("Vendor name to search for (supports % wildcards)"),
    },
    (args) =>
      runTool("qbo_search_vendors", args, ({ name }) => {
        const searchName = name.includes("%") ? name : `%${name}%`;
        return client.query(
          `SELECT * FROM Vendor WHERE DisplayName LIKE '${searchName}' MAXRESULTS 50`,
        );
      }),
  );

  server.tool(
    "qbo_create_vendor",
    "Create a new vendor in QuickBooks.",
    {
      displayName: z.string().describe("Vendor display name"),
      companyName: z.string().optional().describe("Company name"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
    },
    (args) =>
      runTool("qbo_create_vendor", args, ({ displayName, companyName, email, phone }) => {
        const extra: Record<string, unknown> = {};
        if (companyName) extra.CompanyName = companyName;
        if (email) extra.PrimaryEmailAddr = { Address: email };
        if (phone) extra.PrimaryPhone = { FreeFormNumber: phone };
        return client.createVendor(displayName, extra);
      }),
  );
}
