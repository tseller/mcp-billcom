import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BillComClient, BillComError } from "../billcom-client.js";

export function registerVendorTools(server: McpServer, client: BillComClient) {
  server.tool(
    "list_vendors",
    "List vendors with pagination",
    {
      start: z.number().int().min(0).optional().describe("Starting position (default 0)"),
      max: z.number().int().min(1).max(100).optional().describe("Max records per page (default 20, max 100)"),
    },
    async ({ start, max }) => {
      try {
        const result = await client.listVendors(start ?? 0, max ?? 20);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const msg = e instanceof BillComError ? e.message : String(e);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_vendor",
    "Get a vendor by ID",
    {
      id: z.string().describe("The vendor ID"),
    },
    async ({ id }) => {
      try {
        const result = await client.getVendor(id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const msg = e instanceof BillComError ? e.message : String(e);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "create_vendor",
    "Create a new vendor. Does not expose bank account fields for security.",
    {
      name: z.string().describe("Vendor name"),
      accountType: z.enum(["Company", "Individual"]).optional().describe("Account type"),
      email: z.string().email().optional().describe("Vendor email"),
      phone: z.string().optional().describe("Vendor phone number"),
      address1: z.string().optional().describe("Street address line 1"),
      address2: z.string().optional().describe("Street address line 2"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State/province"),
      zip: z.string().optional().describe("ZIP/postal code"),
      country: z.string().optional().describe("Country code"),
    },
    async (input) => {
      try {
        const data: Record<string, unknown> = { name: input.name };
        if (input.accountType) data.accountType = input.accountType;
        if (input.email) data.email = input.email;
        if (input.phone) data.phone = input.phone;

        // Build address if any address field is provided
        if (input.address1 || input.city || input.state || input.zip || input.country) {
          data.address = {
            address1: input.address1,
            address2: input.address2,
            city: input.city,
            state: input.state,
            zip: input.zip,
            country: input.country,
          };
        }

        const result = await client.createVendor(data);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const msg = e instanceof BillComError ? e.message : String(e);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
