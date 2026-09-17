import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCursorList, slimTransaction } from "./divvy-rows.js";
import { MAX_RESULT_CHARS, compact, overBudget } from "./result-size.js";
import { runTool } from "./tool-logging.js";
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
    syncStatus: i % 4 === 0 ? "SYNCED" : "PENDING",
    syncTime: null,
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
