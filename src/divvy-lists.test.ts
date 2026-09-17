import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCursorList, slimTransaction } from "./divvy-rows.js";
import { FILTER_SPECS, FilterCheck, billFilterParam } from "./divvy-filters.js";
import type { DivvyClient } from "./divvy-client.js";
import { registerDivvyTools } from "./tools/divvy.js";
import { MAX_RESULT_CHARS, compact, overBudget } from "./result-size.js";
import { runTool, type ToolResult } from "./tool-logging.js";
import {
  CURSOR_PAGING,
  CURSOR_PAGING_NARROWING,
  LIST_PAGING,
  LIST_PAGING_NARROWING,
  cursorNarrowing,
} from "./tools/list-paging.js";

/**
 * A BILL Spend & Expense transaction in the shape the list endpoint returns —
 * a representative fixture, sized to the live one (~1.9KB each, which is how
 * 50 of them made 93,704 characters). Everything past the dozen fields a
 * treasurer reads is scaffolding: the card and merchant descriptors, the
 * review chain, the custom-field *definitions* re-sent on every row, the sync
 * bookkeeping and the currency block that is always USD.
 */
function liveTransaction(i: number) {
  return {
    id: `VHJhbnNhY3Rpb246NWJlNmI3MzIt${String(i).padStart(4, "0")}LTQ1ZjItOGY0ZC0zM2Q5`,
    uuid: `txr_bfjbecj1il3393vgvevotvju${String(i).padStart(2, "0")}`,
    occurredTime: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T14:22:05.000Z`,
    clearedTime: `2026-05-${String((i % 28) + 2).padStart(2, "0")}T03:11:47.000Z`,
    createdTime: `2026-05-${String((i % 28) + 1).padStart(2, "0")}T14:22:09.113Z`,
    updatedTime: `2026-05-${String((i % 28) + 2).padStart(2, "0")}T09:04:52.884Z`,
    status: i % 9 === 0 ? "DECLINED" : "CLEARED",
    amount: 206.37 + i,
    originalAmount: 206.37 + i,
    currency: "USD",
    originalCurrency: "USD",
    exchangeRate: 1,
    fees: 0,
    transactionType: "PURCHASE",
    userName: "Timothy Eller",
    userUuid: "usr_2d9f4c1a8b7e4f6a9c3d5e8f1a2b3c4d",
    userEmail: "tseller@gmail.com",
    merchantName: "Refilled.com",
    merchantDescriptor: "REFILLED.COM *SUBSCRIPTION 888-555-0142 DE",
    merchantCategoryCode: "5968",
    merchantCategoryName: "Direct Marketing — Continuity/Subscription Merchants",
    budgetId: "bdg_7f3a1c9e2d4b6a8c0e2f4a6b8c0d2e4f",
    budgetName: "Operations",
    cardId: "crd_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    cardName: "Ops virtual card",
    cardLastFour: "4417",
    cardType: "VIRTUAL",
    isLocked: i % 5 === 0,
    receiptRequired: true,
    receiptStatus: i % 3 === 0 ? "ATTACHED" : "MISSING",
    receipts: i % 3 === 0 ? [{ id: `rct_${i}`, url: `https://receipts.bill.com/${i}.jpg` }] : [],
    reviewRequired: true,
    reviewers: [
      {
        userUuid: "usr_9c3d5e8f1a2b3c4d2d9f4c1a8b7e4f6a",
        userName: "Timothy Eller",
        status: "WAITING",
        role: "BUDGET_OWNER",
        respondedTime: null,
      },
    ],
    // BILL states the accounting sync on a nested integration record, and
    // omits the record entirely for a transaction that has not synced — there
    // is no top-level `syncStatus`, which is why the row used to carry none.
    accountingIntegrationTransactions:
      i % 4 === 0
        ? [
            {
              id: `QWNjb3VudGluZ0ludGVncmF0aW9uVHJhbnNhY3Rpb246${i}`,
              billable: false,
              integrationTxId: String(1000 + i),
              syncStatus: "synced",
              syncMessage: "Synced to QBO",
              integrationType: "qbo",
              integrationId: "be28f5ec-7839-41ba-b646-5000d62c6c71",
              syncRequestId: `e80eb15d-5287-4052-b05e-e2a0cbf939${String(i).padStart(2, "0")}`,
            },
          ]
        : null,
    glAccountId: null,
    glAccountName: null,
    customFields: [
      {
        uuid: "cf_nap_codes",
        customFieldId: "cf_nap_codes",
        name: "NAP CODES",
        type: "SELECT",
        isRequired: true,
        isActive: true,
        selectedValues: [{ value: `NAP-${100 + (i % 12)}`, label: `NAP-${100 + (i % 12)}` }],
        note: null,
      },
      {
        uuid: "cf_notes",
        customFieldId: "cf_notes",
        name: "Notes",
        type: "NOTE",
        isRequired: false,
        isActive: true,
        selectedValues: [],
        note: i % 2 === 0 ? "Monthly subscription renewal" : "",
      },
    ],
  };
}

const page = (n: number) => Array.from({ length: n }, (_, i) => liveTransaction(i));

test("the default call at BILL's own maximum page size fits the budget; raw does not", () => {
  const raw = page(50);
  const rawSize = compact({ results: raw, nextPage: "cursor" }).length;
  assert.ok(
    rawSize > MAX_RESULT_CHARS,
    `a 50-row raw page should be over budget, was ${rawSize}`,
  );

  const rows = buildCursorList({
    entity: "Transaction",
    key: "transactions",
    rows: raw.map(slimTransaction),
    nextPage: "cursor",
  });
  const rowSize = compact(rows).length;
  assert.ok(rowSize < MAX_RESULT_CHARS, `a 50-row page should fit, was ${rowSize}`);
  assert.equal(rows.returned, 50);
  assert.equal((rows.transactions as unknown[]).length, 50);
  // The whole point of the flip: this is the default path, and it is small.
  assert.ok(rowSize < rawSize / 4, `rows ${rowSize} vs raw ${rawSize}`);
});

test("a row keeps both ids and the filled custom fields, and drops the empty ones", () => {
  const row = slimTransaction(liveTransaction(1));
  assert.equal(row.id, liveTransaction(1).id);
  assert.equal(row.uuid, liveTransaction(1).uuid);
  assert.equal(row.date, "2026-05-02");
  assert.equal(row.merchant, "Refilled.com");
  assert.equal(row.user, "Timothy Eller");
  assert.equal(row.amount, 207.37);
  // Odd rows have an empty Notes field: a key carrying "" is payload for nothing.
  assert.deepEqual(row.fields, { "NAP CODES": "NAP-101" });
  assert.deepEqual(slimTransaction(liveTransaction(2)).fields, {
    "NAP CODES": "NAP-102",
    Notes: "Monthly subscription renewal",
  });
});

test("more pages at BILL: hasMore carries the cursor to follow", () => {
  const result = buildCursorList({
    entity: "Transaction",
    key: "transactions",
    rows: page(10).map(slimTransaction),
    nextPage: "eyJvZmZzZXQiOjEwfQ==",
  });
  assert.equal(result.hasMore, true);
  assert.equal(result.truncatedBy, "window");
  assert.equal(result.nextPage, "eyJvZmZzZXQiOjEwfQ==");
  assert.match(String(result.note), /page: nextPage/);
});

test("the last page states hasMore false and no cursor", () => {
  const result = buildCursorList({
    entity: "Transaction",
    key: "transactions",
    rows: page(3).map(slimTransaction),
  });
  assert.equal(result.hasMore, false);
  assert.equal(result.nextPage, undefined);
  assert.equal(result.note, undefined);
  assert.equal(result.pageTotal, 206.37 + 207.37 + 208.37);
});

test("when the budget cuts a page short, the cursor is withheld — following it would skip rows", () => {
  // Far more rows than the budget holds, all inside ONE BILL page.
  const result = buildCursorList({
    entity: "Transaction",
    key: "transactions",
    rows: page(400).map(slimTransaction),
    nextPage: "eyJvZmZzZXQiOjQwMH0=",
  });
  assert.ok(compact(result).length <= MAX_RESULT_CHARS);
  assert.equal(result.hasMore, true);
  assert.equal(result.truncatedBy, "size");
  assert.ok((result.returned as number) < 400);
  // BILL's cursor starts after all 400 rows; handing it back here would lose
  // the ones the budget dropped. The way forward is a smaller pageSize.
  assert.equal(result.nextPage, undefined);
  assert.match(String(result.note), /same `page`/i);
  assert.match(String(result.note), /smaller `pageSize`/);
});

test("the over-budget error names knobs the tool actually has", async () => {
  const fat = { blob: "x".repeat(MAX_RESULT_CHARS + 10) };
  const res = await runTool("divvy_list_transactions", {}, async () => fat, {
    narrowing: CURSOR_PAGING_NARROWING,
  });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /over the 40,000-character tool-result budget/);
  assert.match(text, /pageSize/);
  assert.match(text, /page: nextPage/);
  // The defect this replaced: advising four parameters this tool does not take.
  for (const absent of ["maxResults", "startPosition", "nextOffset", "offset"]) {
    assert.doesNotMatch(text, new RegExp(absent), `advice names ${absent}, which the tool lacks`);
  }
});

test("a tool with no paging arguments is given no knobs to turn", () => {
  const text = overBudget("divvy_list_cards", 50_000);
  for (const absent of ["maxResults", "startPosition", "offset", "pageSize", "format"]) {
    assert.doesNotMatch(text, new RegExp(absent));
  }
  assert.match(text, /Narrow the request/);
});

/**
 * The advice and the schema are two spellings of the same fact — which knobs
 * this tool has — so they can drift. This is what pins them together: every
 * parameter the advice names must exist in the shape it is paired with.
 */
test("every narrowing sentence names only parameters of its own paging shape", () => {
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    // sentence, schema shape, response fields it may also name
    [LIST_PAGING_NARROWING, LIST_PAGING, ["nextStartPosition"]],
    [CURSOR_PAGING_NARROWING, CURSOR_PAGING, ["nextPage"]],
    [cursorNarrowing({ format: false }), { page: 1, pageSize: 1 }, ["nextPage"]],
  ];
  for (const [sentence, shape, responseFields] of cases) {
    const named = [...sentence.matchAll(/`([A-Za-z]+)(?::[^`]*)?`/g)].map((m) => m[1]);
    assert.ok(named.length > 0, `advice names no parameters: ${sentence}`);
    for (const knob of named) {
      assert.ok(
        knob in shape || responseFields.includes(knob),
        `advice names \`${knob}\`, which is not in its schema: ${sentence}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * Filters (issue #29): what is asked of BILL, and what is checked of
 * the rows that come back.
 * ------------------------------------------------------------------ */

/**
 * The instance of the bug. `start_date` / `end_date` are not parameters BILL
 * reads, and it answers 200 with an unfiltered page rather than rejecting
 * them — so the only way to know they were wrong was to look at the dates.
 * BILL's own grammar is `filters=field:operator:value`, comma-joined, and it
 * rejects an unknown field or operator with a 400.
 */
test("a date range is asked of BILL in the grammar BILL actually reads", () => {
  assert.equal(
    billFilterParam({ startDate: "2026-05-01", endDate: "2026-06-30" }),
    "occurredTime:gte:2026-05-01,occurredTime:lte:2026-07-01",
  );
  assert.equal(
    billFilterParam({ budgetId: "bgt_uv3ogfaead47j90sf9v9k97ab8", syncStatus: "SYNCED" }),
    "budgetId:eq:bgt_uv3ogfaead47j90sf9v9k97ab8,syncStatus:eq:SYNCED",
  );
  // BILL has no `status` filter field (asking for one is a 400), so it
  // contributes no term and is enforced here instead.
  assert.equal(billFilterParam({ status: "DECLINED" }), undefined);
  assert.equal(billFilterParam({}), undefined);
});

/**
 * BILL's `lte` is midnight of the day named, so `lte:2026-06-26` excludes a
 * transaction at 2026-06-26T10:50 — the end of an inclusive range cannot be
 * said to BILL directly (a value with a time fails the `field:operator:value`
 * split on its colons). The tool asks for the day after and trims here.
 */
test("the last day of the range is in the range", () => {
  const onEndDate = { ...liveTransaction(1), occurredTime: "2026-06-26T10:50:44.000+00:00" };
  const dayAfterEnd = { ...liveTransaction(2), occurredTime: "2026-06-27T09:00:00.000+00:00" };
  const check = new FilterCheck({ startDate: "2026-06-01", endDate: "2026-06-26" });
  assert.deepEqual(check.keep([onEndDate, dayAfterEnd]), [onEndDate]);
  // The overhang is ours — we asked BILL for the wider bound — so it does not
  // read as BILL ignoring the filter.
  assert.match(check.report().endDate, /^server \+ client/);
});

/**
 * The check that would have caught #29: ask the rows, not the request. These
 * are the rows production actually returned for a May-June query before the
 * fix — the newest page, every row outside the range.
 */
test("rows outside the range asked for never reach the caller, and the result says so", () => {
  const unfiltered = [
    { ...liveTransaction(1), occurredTime: "2026-09-16T19:50:58.000+00:00" },
    { ...liveTransaction(2), occurredTime: "2026-08-02T13:52:22.000+00:00" },
    { ...liveTransaction(3), occurredTime: "2026-05-19T10:00:03.000+00:00" },
  ];
  const check = new FilterCheck({ startDate: "2026-05-01", endDate: "2026-06-30" });
  const kept = check.keep(unfiltered);

  assert.equal(kept.length, 1);
  assert.equal(String(kept[0].occurredTime).slice(0, 10), "2026-05-19");
  assert.equal(check.dropped, 2);
  // Not "filter: 2026-05-01" — that only echoes what was asked. This states
  // what happened, which is the whole difference.
  assert.match(check.report().endDate, /not being honored/);
  assert.match(check.report().endDate, /2 of 3 row\(s\) outside it/);
});

test("a filter BILL honors reads as server-side, with the rows to show for it", () => {
  const inRange = [1, 2, 3].map((i) => ({
    ...liveTransaction(i),
    occurredTime: `2026-05-0${i}T10:00:00.000+00:00`,
  }));
  const check = new FilterCheck({ startDate: "2026-05-01", endDate: "2026-06-30" });
  assert.equal(check.keep(inRange).length, 3);
  assert.equal(check.dropped, 0);
  assert.match(check.report().startDate, /^server — BILL filtered/);
  assert.match(check.report().endDate, /^server — BILL filtered/);
});

test("a filter BILL has no field for says it is applied here, not pretends to be a server filter", () => {
  const check = new FilterCheck({ status: "DECLINED" });
  const kept = check.keep(page(9));
  assert.equal(kept.length, 1); // liveTransaction(0) is the DECLINED one
  assert.match(check.report().status, /^client — BILL has no `status` filter/);
  assert.match(check.report().status, /8 of 9 row\(s\) dropped/);
});

/**
 * `budgetId` and `syncStatus` travel the same path, and were the same kind of
 * dead parameter (`budget_id`, `sync_status`). BILL takes both as filter
 * terms, and both have a witness on the row — BILL accepts either spelling of
 * a budget id, and states the accounting sync on a nested integration record.
 */
test("budgetId and syncStatus are checked against the row too", () => {
  const byId = new FilterCheck({ budgetId: "bdg_7f3a1c9e2d4b6a8c0e2f4a6b8c0d2e4f" });
  assert.equal(byId.keep(page(3)).length, 3);
  const byUuid = new FilterCheck({ budgetId: "bgt_other" });
  assert.equal(byUuid.keep(page(3)).length, 0);
  assert.match(byUuid.report().budgetId, /not being honored/);

  // Every 4th fixture row carries a nested "synced" record; the rest carry none.
  const synced = new FilterCheck({ syncStatus: "SYNCED" });
  assert.equal(synced.keep(page(8)).length, 2);
  const notSynced = new FilterCheck({ syncStatus: "NOT_SYNCED" });
  assert.equal(notSynced.keep(page(8)).length, 6);
});

test("a row carries the sync status the tool says it carries", () => {
  assert.equal(slimTransaction(liveTransaction(0)).syncStatus, "SYNCED");
  assert.equal(slimTransaction(liveTransaction(1)).syncStatus, undefined);
});

/** Registers the Divvy tools against a stub and hands back what was declared. */
function registeredTools(client: unknown) {
  const tools = new Map<
    string,
    { schema: Record<string, unknown>; handler: (args: Record<string, unknown>) => Promise<ToolResult> }
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

const listResult = async (
  handler: (a: Record<string, unknown>) => Promise<ToolResult>,
  args: Record<string, unknown>,
) => JSON.parse((await handler(args)).content[0].text) as Record<string, unknown>;

/**
 * The structural pin. Every filter this tool advertises must be declared in
 * FILTER_SPECS — that is what makes it impossible to add one that is sent and
 * never checked, which is the shape #29 had.
 */
test("every filter the tool advertises is declared with how it is checked", () => {
  const { schema } = registeredTools({})!.get("divvy_list_transactions")!;
  const paging = new Set(Object.keys(CURSOR_PAGING));
  const advertised = Object.keys(schema).filter((k) => !paging.has(k));
  assert.ok(advertised.length > 0);
  for (const name of advertised) {
    assert.ok(
      name in FILTER_SPECS,
      `\`${name}\` is offered as a filter with no declaration of how a row is checked against it`,
    );
  }
  // And nothing is declared that the tool does not offer.
  for (const name of Object.keys(FILTER_SPECS)) {
    assert.ok(advertised.includes(name), `FILTER_SPECS declares \`${name}\`, which no tool offers`);
  }
});

test("the tool sends BILL one filter parameter and reports how each filter landed", async () => {
  const calls: Array<Record<string, string | undefined>> = [];
  const client = {
    listTransactions: async (p: Record<string, string | undefined>) => {
      calls.push(p);
      return {
        results: [1, 2, 3].map((i) => ({
          ...liveTransaction(i),
          occurredTime: `2026-05-0${i}T10:00:00.000+00:00`,
        })),
        nextPage: "cursor-2",
      };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, { startDate: "2026-05-01", endDate: "2026-06-30" });

  assert.equal(calls.length, 1, "the healthy path is one BILL call");
  assert.equal(calls[0].filters, "occurredTime:gte:2026-05-01,occurredTime:lte:2026-07-01");
  assert.equal(calls[0].start_date, undefined);
  assert.equal(result.returned, 3);
  assert.match(String((result.filtering as Record<string, string>).startDate), /^server/);
});

/**
 * If BILL stops honoring a filter, the rows are dropped here — and a page made
 * mostly of holes is refilled from the next BILL page rather than coming back
 * near-empty. Bounded: the walk only happens because rows were dropped.
 */
test("when BILL ignores a filter the page is refilled from the cursor, and says it was", async () => {
  let call = 0;
  const client = {
    listTransactions: async () => {
      call += 1;
      // BILL ignoring the range: page 1 is all outside it, page 2 all inside.
      const day = call === 1 ? "2026-09" : "2026-05";
      return {
        results: [1, 2, 3].map((i) => ({
          ...liveTransaction(i),
          occurredTime: `${day}-0${i}T10:00:00.000+00:00`,
        })),
        nextPage: `cursor-${call + 1}`,
      };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, {
    startDate: "2026-05-01",
    endDate: "2026-06-30",
    pageSize: "3",
  });

  assert.equal(call, 2);
  assert.equal(result.billPages, 2);
  assert.equal(result.returned, 3);
  for (const row of result.transactions as Array<{ date: string }>) {
    assert.ok(row.date >= "2026-05-01" && row.date <= "2026-06-30", `row outside range: ${row.date}`);
  }
  assert.match(String((result.filtering as Record<string, string>).endDate), /not being honored/);
  assert.equal(result.nextPage, "cursor-3");
});

test("the walk is bounded — an always-ignored filter stops rather than paging forever", async () => {
  let call = 0;
  const client = {
    listTransactions: async () => {
      call += 1;
      return {
        results: [{ ...liveTransaction(1), occurredTime: "2026-09-01T10:00:00.000+00:00" }],
        nextPage: `cursor-${call + 1}`,
      };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, { startDate: "2026-05-01", endDate: "2026-06-30" });
  assert.ok(call <= 10, `walked ${call} BILL pages`);
  assert.equal(result.returned, 0);
  // Zero rows, and the reason stated — not an empty answer with no explanation.
  assert.match(String((result.filtering as Record<string, string>).endDate), /not being honored/);
});

test("with no filters set, nothing is sent to BILL and nothing is claimed", async () => {
  const calls: Array<Record<string, string | undefined>> = [];
  const client = {
    listTransactions: async (p: Record<string, string | undefined>) => {
      calls.push(p);
      return { results: page(3), nextPage: undefined };
    },
  };
  const { handler } = registeredTools(client).get("divvy_list_transactions")!;
  const result = await listResult(handler, {});
  assert.equal(calls[0].filters, undefined);
  assert.equal(result.filtering, undefined);
  assert.equal(result.returned, 3);
});
