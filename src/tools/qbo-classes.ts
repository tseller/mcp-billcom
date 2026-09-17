import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { QboClient, type QboClass } from "../qbo-client.js";
import { IdempotencyStore, withIdempotency } from "../idempotency.js";
import { runTool } from "../tool-logging.js";

const shape = (c: QboClass) => ({
  id: c.Id,
  name: c.Name,
  fullyQualifiedName: c.FullyQualifiedName,
  active: c.Active,
  subClass: c.SubClass ?? false,
  parentClassId: c.ParentRef?.value,
  parentClassName: c.ParentRef?.name,
});

export interface QboClassToolDeps {
  idempotency?: IdempotencyStore;
}

export function registerQboClassTools(
  server: McpServer,
  client: QboClient,
  deps: QboClassToolDeps = {},
) {
  server.tool(
    "qbo_list_classes",
    "List QuickBooks Classes — the season tags (e.g. Fall, Spring, General/Year-round) used to attribute transactions to a season. Returns each class's id, name, fully-qualified name (which includes the parent for sub-classes), active flag and parent. Use this to resolve a season name to the class id that the write tools need.",
    {
      nameContains: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on the name (e.g. 'Fall')"),
      includeInactive: z
        .boolean()
        .optional()
        .describe("Include deactivated classes (default false)"),
    },
    (args) =>
      runTool("qbo_list_classes", args, async ({ nameContains, includeInactive }) => {
        const result = (await client.listClasses(includeInactive ?? false)) as {
          QueryResponse?: { Class?: QboClass[] };
        };
        let classes = (result.QueryResponse?.Class ?? []).map(shape);
        if (nameContains) {
          const needle = nameContains.toLowerCase();
          classes = classes.filter(
            (c) =>
              (c.name ?? "").toLowerCase().includes(needle) ||
              (c.fullyQualifiedName ?? "").toLowerCase().includes(needle),
          );
        }
        return {
          count: classes.length,
          classTrackingNote:
            classes.length === 0
              ? "No classes exist in this company yet — create them with qbo_create_class before tagging anything."
              : undefined,
          classes,
        };
      }),
  );

  server.tool(
    "qbo_create_class",
    "Create a QuickBooks Class (a season tag such as 'Fall 2026'). Safe to re-run: if a class with that name already exists it is returned instead of creating a near-duplicate, because QuickBooks happily accepts two classes with confusingly similar names and merging them afterwards is a manual chore in the web UI. Pass parentClassId to nest it under an existing class (e.g. seasons under a fiscal year).",
    {
      name: z
        .string()
        .min(1)
        .describe("Class name, e.g. 'Fall 2026'. Season names are never assumed — say exactly what you want."),
      parentClassId: z
        .string()
        .optional()
        .describe("Make this a sub-class of an existing class (its id, from qbo_list_classes)"),
      idempotencyKey: z
        .string()
        .optional()
        .describe(
          "Optional idempotency key (any unique string). If a create with this key already succeeded, the original result is returned instead of creating a duplicate.",
        ),
    },
    (args) =>
      runTool("qbo_create_class", args, async ({ name, parentClassId, idempotencyKey }) => {
        const existing = await client.findClassByName(name);
        if (existing) {
          return {
            created: false,
            reason: "a class with this name already exists",
            class: shape(existing),
          };
        }

        const create = () => client.createClass(name, parentClassId);
        const result = (await (deps.idempotency
          ? withIdempotency(deps.idempotency, "qbo_create_class", idempotencyKey, create)
          : create())) as { Class?: QboClass };

        return { created: true, class: result.Class ? shape(result.Class) : result };
      }),
  );
}
