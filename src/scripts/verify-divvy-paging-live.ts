/**
 * Read-only live verification of the Divvy cursor paging (issue #33).
 *
 * Run against real BILL books:
 *   DIVVY_API_TOKEN=... npx tsx src/scripts/verify-divvy-paging-live.ts
 *
 * It answers the two questions the unit tests cannot, because the bug was in
 * what BILL does with a query parameter it does not recognise:
 *
 *  1. does the default call return the WHOLE list of a custom field's values,
 *     ending at `hasMore: false`?
 *  2. does walking that list in small pages terminate, visiting every value
 *     exactly once — where before every page was the same first 20?
 *
 * Nothing here writes. The custom field defaults to NAP CODES, which is the
 * list a treasurer actually walks to resolve a code.
 */

import { DivvyClient } from "../divvy-client.js";
import { registerDivvyTools } from "../tools/divvy.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

function toolset(client: DivvyClient): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) =>
      tools.set(name, handler),
  };
  registerDivvyTools(server as unknown as Parameters<typeof registerDivvyTools>[0], client);
  return tools;
}

async function main(): Promise<void> {
  const token = process.env.DIVVY_API_TOKEN;
  if (!token) throw new Error("DIVVY_API_TOKEN is not set");
  const tools = toolset(new DivvyClient(token));

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await tools.get(name)!(args);
    const body = res.content[0].text;
    if (res.isError) throw new Error(`${name} failed: ${body}`);
    return JSON.parse(body) as Record<string, any>;
  };

  const fields = await call("divvy_list_custom_fields", {});
  const named = (process.argv[2] ?? "NAP CODES").toLowerCase();
  const field = (fields.results as Array<Record<string, string>>).find(
    (f) => f.name.toLowerCase() === named,
  );
  if (!field) throw new Error(`no custom field named ${named}`);
  console.log(`custom field: ${field.name} (${field.uuid})\n`);

  // 1. One call, the whole list.
  const whole = await call("divvy_list_custom_field_values", { customFieldId: field.uuid });
  console.log(`default call: returned=${whole.returned} hasMore=${whole.hasMore}`);
  console.log(`  paging: ${JSON.stringify(whole.paging)}`);
  console.log(`  first: ${JSON.stringify(whole.values[0])}`);
  console.log(`  last:  ${JSON.stringify(whole.values.at(-1))}\n`);

  // 2. The walk that used to loop.
  const seen: string[] = [];
  let cursor: string | undefined;
  let hasMore = true;
  let pages = 0;
  while (hasMore && pages < 50) {
    const page = await call("divvy_list_custom_field_values", {
      customFieldId: field.uuid,
      pageSize: "10",
      page: cursor,
    });
    pages += 1;
    for (const row of page.values as Array<{ value: string }>) seen.push(row.value);
    if (pages <= 2) {
      console.log(
        `  page ${pages}: returned=${page.returned} hasMore=${page.hasMore} first=${JSON.stringify(
          (page.values as Array<{ value: string }>)[0]?.value,
        )}`,
      );
    }
    hasMore = Boolean(page.hasMore);
    cursor = page.nextPage as string | undefined;
  }
  console.log(
    `\nwalk at pageSize=10: pages=${pages} values=${seen.length} unique=${new Set(seen).size} hasMore=${hasMore}`,
  );

  const ok =
    whole.hasMore === false &&
    hasMore === false &&
    seen.length === whole.returned &&
    new Set(seen).size === seen.length;
  console.log(ok ? "\nOK — the walk terminates and visits every value once" : "\nFAILED");
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
