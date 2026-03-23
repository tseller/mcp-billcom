import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QboClient, QboError } from "../qbo-client.js";

function err(e: unknown) {
  const msg = e instanceof QboError ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}

export function registerQboVendorTools(server: McpServer, client: QboClient) {
  server.tool(
    "qbo_list_vendors",
    "List active vendors in QuickBooks with pagination.",
    {
      startPosition: z.number().int().min(1).optional().describe("1-based start position (default 1)"),
      maxResults: z.number().int().min(1).max(1000).optional().describe("Max results (default 100)"),
    },
    async ({ startPosition, maxResults }) => {
      try {
        const result = await client.listVendors(startPosition ?? 1, maxResults ?? 100);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "qbo_search_vendors",
    "Search for vendors by name (partial match).",
    {
      name: z.string().describe("Vendor name to search for (supports % wildcards)"),
    },
    async ({ name }) => {
      try {
        const searchName = name.includes("%") ? name : `%${name}%`;
        const result = await client.query(
          `SELECT * FROM Vendor WHERE DisplayName LIKE '${searchName}' MAXRESULTS 50`,
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
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
    async ({ displayName, companyName, email, phone }) => {
      try {
        const extra: Record<string, unknown> = {};
        if (companyName) extra.CompanyName = companyName;
        if (email) extra.PrimaryEmailAddr = { Address: email };
        if (phone) extra.PrimaryPhone = { FreeFormNumber: phone };
        const result = await client.createVendor(displayName, extra);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return err(e);
      }
    },
  );
}
