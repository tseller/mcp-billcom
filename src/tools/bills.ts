import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BillComClient, BillComError } from "../billcom-client.js";

export function registerBillTools(server: McpServer, client: BillComClient) {
  server.tool(
    "list_bills",
    "List bills with pagination",
    {
      start: z.number().int().min(0).optional().describe("Starting position (default 0)"),
      max: z.number().int().min(1).max(100).optional().describe("Max records per page (default 20, max 100)"),
    },
    async ({ start, max }) => {
      try {
        const result = await client.listBills(start ?? 0, max ?? 20);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const msg = e instanceof BillComError ? e.message : String(e);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_bill",
    "Get a bill by ID",
    {
      id: z.string().describe("The bill ID"),
    },
    async ({ id }) => {
      try {
        const result = await client.getBill(id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const msg = e instanceof BillComError ? e.message : String(e);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "create_bill",
    "Create a new bill. Provide vendor, dates, and line items.",
    {
      vendorId: z.string().describe("The vendor ID for this bill"),
      invoiceNumber: z.string().optional().describe("Vendor's invoice number"),
      invoiceDate: z.string().optional().describe("Invoice date (YYYY-MM-DD)"),
      dueDate: z.string().describe("Payment due date (YYYY-MM-DD)"),
      description: z.string().optional().describe("Bill description/memo"),
      billLineItems: z
        .array(
          z.object({
            amount: z.number().describe("Line item amount"),
            chartOfAccountId: z.string().optional().describe("Chart of account ID"),
            description: z.string().optional().describe("Line item description"),
          })
        )
        .min(1)
        .describe("Bill line items (at least one required)"),
    },
    async (input) => {
      try {
        const data: Record<string, unknown> = {
          vendorId: input.vendorId,
          dueDate: input.dueDate,
          billLineItems: input.billLineItems,
        };
        if (input.invoiceNumber) data.invoiceNumber = input.invoiceNumber;
        if (input.invoiceDate) data.invoiceDate = input.invoiceDate;
        if (input.description) data.description = input.description;

        const result = await client.createBill(data);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const msg = e instanceof BillComError ? e.message : String(e);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
