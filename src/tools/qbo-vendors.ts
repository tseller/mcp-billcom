import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { ACTIVE_VENDORS, QboClient, vendorNameWhere } from "../qbo-client.js";
import { runTool } from "../tool-logging.js";
import { LIST_PAGING_NARROWING, listPaging } from "./list-paging.js";
import { buildEntityList, queryRows, slimVendor } from "../qbo-rows.js";

const VENDOR_ROWS_DOC =
  "Returns flattened rows: id, display name, company (when it differs from the display name), email, phone, and balance when we owe them anything. " +
  "`active` appears only on an inactive vendor. " +
  "Paged by size as well as row count: when `hasMore` is true, call again with `startPosition: nextStartPosition`.";

export function registerQboVendorTools(server: McpServer, client: QboClient) {
  server.registerTool(
    "qbo_list_vendors",
    {
      description: "List active vendors in QuickBooks. " + VENDOR_ROWS_DOC,
      inputSchema: z.object({ ...listPaging(100) }),
    },
    (args) =>
      runTool("qbo_list_vendors", args, async ({ startPosition, maxResults, format }) => {
        const start = startPosition ?? 1;
        const max = maxResults ?? 100;

        const raw = await client.listVendors(start, max);
        if (format === "raw") return raw;

        const rowCount = await client.countEntities("Vendor", ACTIVE_VENDORS);
        return buildEntityList({
          entity: "Vendor",
          key: "vendors",
          rows: queryRows(raw, "Vendor").map(slimVendor),
          startPosition: start,
          maxResults: max,
          rowCount,
          // A page of vendor balances is a slice of what we owe, not a total.
          sumField: null,
        });
      },
      { narrowing: LIST_PAGING_NARROWING },
      ),
  );

  server.registerTool(
    "qbo_search_vendors",
    {
      description: "Search for vendors by name (partial match). " + VENDOR_ROWS_DOC,
      inputSchema: z.object({
      name: z.string().describe("Vendor name to search for (supports % wildcards)"),
      ...listPaging(100),
    }),
    },
    (args) =>
      runTool("qbo_search_vendors", args, async ({ name, startPosition, maxResults, format }) => {
        const pattern = name.includes("%") ? name : `%${name}%`;
        const start = startPosition ?? 1;
        const max = maxResults ?? 100;

        const raw = await client.searchVendors(pattern, start, max);
        if (format === "raw") return raw;

        const rowCount = await client.countEntities("Vendor", vendorNameWhere(pattern));
        return buildEntityList({
          entity: "Vendor",
          key: "vendors",
          rows: queryRows(raw, "Vendor").map(slimVendor),
          startPosition: start,
          maxResults: max,
          rowCount,
          sumField: null,
          filters: { name },
        });
      },
      { narrowing: LIST_PAGING_NARROWING },
      ),
  );

  server.registerTool(
    "qbo_create_vendor",
    {
      description: "Create a new vendor in QuickBooks.",
      inputSchema: z.object({
      displayName: z.string().describe("Vendor display name"),
      companyName: z.string().optional().describe("Company name"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
    }),
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
