import { test } from "node:test";
import assert from "node:assert/strict";
import { DivvyClient } from "./divvy-client.js";
import { registerDivvyTools } from "./tools/divvy.js";
import { CURSOR_PAGING } from "./tools/list-paging.js";
import { PAGING_SPECS, PagingCheck, billPagingParams, openCursor } from "./divvy-paging.js";
import type { ToolResult } from "./tool-logging.js";

/**
 * Issue #33. `divvy_list_custom_field_values` advertised `page`/`pageSize` and
 * sent them as `page`/`page_size`. BILL's v3 values endpoint reads `nextPage`
 * and `max`, and answers 200 with page 1 for anything else — so walking the
 * NAP-code list re-served the same 20 values behind a cursor that never moved.
 */

/** A BILL custom-field value, in the shape the live endpoint returns. */
const value = (i: number) => ({
  id: `VGFnVmFsdWU6MzAwNTAwO${String(i).padStart(3, "0")}`,
  uuid: `tvl_p5ag95f6p95gv5dhtl8a53ie${String(i).padStart(2, "0")}`,
  value: `NAP value ${i}`,
  deleted: false,
});

/** Registers the Divvy tools against a stub and hands back what was declared. */
function registeredTools(client: unknown) {
  const tools = new Map<
    string,
    {
      schema: Record<string, unknown>;
      handler: (args: Record<string, unknown>) => Promise<ToolResult>;
    }
  >();
  const server = {
    tool: (
      name: string,
      _desc: string,
      schema: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<ToolResult>,
    ) => tools.set(name, { schema, handler }),
  };
  registerDivvyTools(
    server as unknown as Parameters<typeof registerDivvyTools>[0],
    client as DivvyClient,
  );
  return tools;
}

const call = async (
  handler: (a: Record<string, unknown>) => Promise<ToolResult>,
  args: Record<string, unknown>,
) => JSON.parse((await handler(args)).content[0].text) as Record<string, unknown>;

/** Runs `fn` with `fetch` stubbed, and hands back every URL that was requested. */
async function capturingFetch(
  body: (url: URL) => unknown,
  fn: () => Promise<unknown>,
): Promise<URL[]> {
  const urls: URL[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body(url),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return urls;
}

/* ------------------------------------------------------------------ *
 * The instance: the names BILL actually reads.
 * ------------------------------------------------------------------ */

test("the paging arguments become the query parameters BILL reads", () => {
  assert.deepEqual(billPagingParams({ page: "YXJy", pageSize: "3" }), {
    nextPage: "YXJy",
    max: "3",
  });
  // The dead names, which BILL answers 200 and page 1 for.
  const params = billPagingParams({ page: "YXJy", pageSize: "3" });
  assert.equal("page" in params, false);
  assert.equal("page_size" in params, false);
  assert.deepEqual(billPagingParams({}), { nextPage: undefined, max: undefined });
});

/**
 * The test that would have caught #33: assert the wire, not the wrapper. Both
 * BILL list endpoints are asked on the same two names, from the same
 * declaration.
 */
test("the custom-field values request goes out as max/nextPage, like the transaction list", async () => {
  const client = new DivvyClient("test-token");
  const urls = await capturingFetch(
    () => ({ results: [value(1)], nextPage: null }),
    async () => {
      await client.listCustomFieldValues("tty_nap", { page: "YXJyYXk6Mg==", pageSize: "3" });
      await client.listTransactions({ page: "YXJyYXk6Mg==", pageSize: "3" });
    },
  );

  for (const url of urls) {
    assert.equal(url.searchParams.get("max"), "3", `no max on ${url.pathname}`);
    assert.equal(url.searchParams.get("nextPage"), "YXJyYXk6Mg==", `no nextPage on ${url.pathname}`);
    assert.equal(url.searchParams.get("page"), null);
    assert.equal(url.searchParams.get("page_size"), null);
  }
  assert.ok(urls[0].pathname.endsWith("/custom-fields/tty_nap/values"));
});

/**
 * The structural pin, the twin of the one over FILTER_SPECS: a paging
 * parameter a tool offers must be declared with the BILL parameter it becomes
 * and the question asked of the page that comes back. Adding a third spelling
 * of "next page" that is sent and never checked is what this forbids.
 */
test("every paging parameter the tools advertise is declared with how it is witnessed", () => {
  const tools = registeredTools({});
  for (const name of ["divvy_list_transactions", "divvy_list_custom_field_values"]) {
    const { schema } = tools.get(name)!;
    const advertised = Object.keys(schema).filter((k) => k in CURSOR_PAGING && k !== "format");
    assert.ok(advertised.length > 0, `${name} advertises no paging`);
    for (const knob of advertised) {
      assert.ok(
        knob in PAGING_SPECS,
        `${name} offers \`${knob}\` with no declaration of the parameter it is sent as`,
      );
      assert.ok(PAGING_SPECS[knob as keyof typeof PAGING_SPECS].param.length > 0);
    }
  }
  for (const knob of Object.keys(PAGING_SPECS)) {
    assert.ok(knob in CURSOR_PAGING, `PAGING_SPECS declares \`${knob}\`, which no tool offers`);
  }
});

/* ------------------------------------------------------------------ *
 * The structure: a cursor that does not advance cannot pose as one
 * that does.
 * ------------------------------------------------------------------ */

test("a cursor carries the identity of the page it came from, and survives the round trip", () => {
  const paging = new PagingCheck({});
  paging.observe([value(1), value(2)], "YXJyYXljb25uZWN0aW9uOjE=");
  const handed = paging.nextPage!;
  const opened = openCursor(handed);
  assert.equal(opened.cursor, "YXJyYXljb25uZWN0aW9uOjE=", "BILL's own cursor is what is sent back");
  assert.ok(opened.fingerprint, "the page it came after is sealed onto it");

  // And the seal is invisible to BILL: what goes on the wire is BILL's cursor.
  assert.equal(PAGING_SPECS.page.send(handed), "YXJyYXljb25uZWN0aW9uOjE=");
  // A bare BILL cursor pasted by hand still works; it just carries no witness.
  assert.deepEqual(openCursor("YXJyYXljb25uZWN0aW9uOjE="), {
    cursor: "YXJyYXljb25uZWN0aW9uOjE=",
  });
});

test("the loop, reproduced: a cursor that re-serves its own page stops the walk", async () => {
  // Live BILL before the fix: whatever cursor you send, page 1 comes back, and
  // `nextPage` is the cursor you just sent.
  const firstPage = [1, 2, 3].map(value);
  const client = {
    listCustomFieldValues: async () => ({ results: firstPage, nextPage: "stuck-cursor" }),
  };
  const { handler } = registeredTools(client).get("divvy_list_custom_field_values")!;

  const page1 = await call(handler, { customFieldId: "tty_nap" });
  assert.equal(page1.returned, 3);
  const cursor = page1.nextPage as string;
  assert.ok(cursor, "the first page hands back a cursor");

  const page2 = await call(handler, { customFieldId: "tty_nap", page: cursor });
  // The rows are ones the caller already has. Handing them back as a new page
  // IS the loop, so they are dropped and the reason is stated.
  assert.equal(page2.returned, 0);
  assert.deepEqual(page2.values, []);
  assert.equal(page2.nextPage, undefined, "no cursor to follow forever");
  assert.equal(page2.truncatedBy, "cursor");
  assert.match(String((page2.paging as Record<string, string>).page), /not honored/);
  assert.match(String((page2.paging as Record<string, string>).page), /did not advance/);
});

test("walking to the end visits each value once and says the list ended", async () => {
  const pages = [
    { results: [1, 2, 3].map(value), nextPage: "c2" },
    { results: [4, 5, 6].map(value), nextPage: "c3" },
    { results: [7].map(value), nextPage: null },
  ];
  let served = 0;
  const client = {
    listCustomFieldValues: async (_id: string, p: { page?: string }) => {
      const at = p.page ? pages.findIndex((_, i) => i > 0 && pages[i - 1].nextPage === p.page) : 0;
      served += 1;
      return pages[at];
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_custom_field_values")!;

  const seen: string[] = [];
  let cursor: string | undefined;
  let hasMore = true;
  let calls = 0;
  while (hasMore && calls < 10) {
    const result = await call(handler, { customFieldId: "tty_nap", page: cursor });
    calls += 1;
    for (const row of result.values as Array<{ value: string }>) seen.push(row.value);
    hasMore = result.hasMore as boolean;
    cursor = result.nextPage as string | undefined;
  }

  assert.equal(calls, 3, "the walk terminates");
  assert.equal(served, 3);
  assert.equal(hasMore, false, "hasMore: false is the end of the list");
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7, "every value exactly once");
});

test("a page size BILL ignores is reported, not assumed", () => {
  const ignored = new PagingCheck({ pageSize: "3" });
  // BILL's default page, whatever `max` said.
  ignored.observe(Array.from({ length: 20 }, (_, i) => value(i)), "c2");
  assert.match(String(ignored.report()!.pageSize), /not honored/);
  assert.match(String(ignored.report()!.pageSize), /at most 3 row\(s\) a page as `max` and it returned 20/);

  const honored = new PagingCheck({ pageSize: "3" });
  honored.observe([1, 2, 3].map(value), "c2");
  assert.match(String(honored.report()!.pageSize), /^server — sent as `max`/);
});

test("a cursor this tool did not issue says so rather than claiming it advanced", () => {
  const paging = new PagingCheck({ page: "YXJyYXljb25uZWN0aW9uOjE=" });
  paging.observe([1, 2].map(value), "c2");
  assert.equal(paging.looped, false);
  assert.match(String(paging.report()!.page), /not issued by this tool/);
  assert.match(String(paging.report()!.page), /could not be witnessed/);
});

test("a page repeating one seen earlier in the same walk counts as not advancing", () => {
  const paging = new PagingCheck({});
  const a = [1, 2].map(value);
  const b = [3, 4].map(value);
  assert.equal(paging.observe(a, "cb").length, 2);
  assert.equal(paging.observe(b, "ca").length, 2);
  // BILL cycles back: a new cursor string, the page we already have.
  assert.equal(paging.observe(a, "cb").length, 0);
  assert.equal(paging.looped, true);
  assert.equal(paging.hasMore, false);
  assert.equal(paging.nextPage, undefined);
});

test("with a healthy cursor the walk reports advancing, and hands one back", () => {
  const paging = new PagingCheck({ page: "c1~deadbeefdeadbeef" });
  paging.observe([1, 2].map(value), "c2");
  assert.equal(paging.looped, false);
  assert.match(String(paging.report()!.page), /^server — sent as `nextPage`/);
  assert.ok(String(paging.nextPage).startsWith("c2~"));
});

test("the transaction list witnesses its cursor too, and stops if BILL re-serves a page", async () => {
  const { liveish } = { liveish: (i: number) => ({ id: `t${i}`, occurredTime: "2026-05-02T10:00:00Z" }) };
  const client = {
    listTransactions: async () => ({ results: [1, 2].map(liveish), nextPage: "stuck" }),
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const first = await call(handler, {});
  const again = await call(handler, { page: first.nextPage });
  assert.equal(again.returned, 0);
  assert.equal(again.truncatedBy, "cursor");
  assert.match(String((again.paging as Record<string, string>).page), /did not advance/);
});
