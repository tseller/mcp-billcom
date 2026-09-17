import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildEntityList,
  queryRows,
  slimDeposit,
  slimPurchase,
  slimTransfer,
} from "./qbo-rows.js";
import { MAX_RESULT_CHARS, compact } from "./result-size.js";
import { runTool, ToolFailure } from "./tool-logging.js";

/**
 * A Purchase exactly as live QBO returns it — the shape that made a fiscal
 * year of purchases 199,955 characters. Every envelope field here (PurchaseEx,
 * domain, sparse, SyncToken, MetaData, PrintStatus, CustomExtensions,
 * per-line TaxCodeRef/BillableStatus, the USD CurrencyRef) is payload a
 * treasurer never reads.
 */
function livePurchase(i: number) {
  return {
    AccountRef: { value: "14", name: "Chase Checking" },
    PaymentType: "Check",
    EntityRef: { value: String(80 + (i % 40)), name: "United States Postal Service", type: "Vendor" },
    TotalAmt: 242 + i,
    PrintStatus: "NotSet",
    PurchaseEx: {
      any: [
        {
          name: "{http://schema.intuit.com/finance/v3}NameValue",
          declaredType: "com.intuit.schema.finance.v3.NameValue",
          scope: "javax.xml.bind.JAXBElement$GlobalScope",
          value: { Name: "TxnType", Value: "3" },
          nil: false,
          globalScope: true,
          typeSubstituted: false,
        },
      ],
    },
    domain: "QBO",
    sparse: false,
    Id: String(900 + i),
    SyncToken: "1",
    MetaData: {
      CreateTime: "2026-06-06T15:42:35-07:00",
      LastUpdatedTime: "2026-08-31T16:35:37-07:00",
    },
    DocNumber: String(1000 + i),
    TxnDate: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    CurrencyRef: { value: "USD", name: "United States Dollar" },
    PrivateNote: `CHECK # ${1000 + i}`,
    Line: [
      {
        Id: "1",
        Description: `CHECK # ${1000 + i}`,
        Amount: 242 + i,
        DetailType: "AccountBasedExpenseLineDetail",
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: "112", name: "Office Supplies" },
          BillableStatus: "NotBillable",
          TaxCodeRef: { value: "NON" },
        },
        CustomExtensions: [],
      },
    ],
  };
}

const livePurchases = (n: number) => Array.from({ length: n }, (_, i) => livePurchase(i));
const purchaseRows = (n: number) => livePurchases(n).map(slimPurchase);

test("a purchase row drops QBO's envelope and keeps what a treasurer reads", () => {
  const row = slimPurchase(livePurchase(0));
  const text = compact(row);

  for (const envelope of [
    "PurchaseEx",
    "declaredType",
    "javax.xml.bind",
    "domain",
    "sparse",
    "SyncToken",
    "MetaData",
    "PrintStatus",
    "CustomExtensions",
    "BillableStatus",
    "TaxCodeRef",
    "United States Dollar",
  ]) {
    assert.ok(!text.includes(envelope), `row still carries QBO envelope: ${envelope}`);
  }

  assert.deepEqual(row, {
    id: "900",
    date: "2026-01-01",
    amount: 242,
    paymentType: "Check",
    num: "1000",
    payee: "United States Postal Service",
    payeeId: "80",
    account: "Chase Checking",
    accountId: "14",
    memo: "CHECK # 1000",
    // The line description repeated the memo verbatim, so it is dropped.
    lines: [{ amount: 242, account: "Office Supplies", accountId: "112" }],
  });

  // The live payload averaged 2,083 characters per purchase.
  assert.ok(text.length < 300, `row is ${text.length} chars`);
});

test("a fiscal year of purchases fits in one result, where the raw entities did not", () => {
  const raw = compact({ QueryResponse: { Purchase: livePurchases(96) } });
  assert.ok(raw.length > MAX_RESULT_CHARS, `raw payload is only ${raw.length} chars`);

  const result = buildEntityList({
    entity: "Purchase",
    key: "purchases",
    rows: purchaseRows(96),
    startPosition: 1,
    maxResults: 100,
    rowCount: 96,
    filters: { startDate: "2025-07-01", endDate: "2026-06-30" },
  });
  const text = compact(result);

  assert.ok(text.length < MAX_RESULT_CHARS, `paged result is ${text.length} chars`);
  assert.equal(result.returned, 96);
  assert.equal(result.rowCount, 96);
  assert.equal(result.hasMore, false);
  assert.ok(!("nextStartPosition" in result));
  // Counts and totals are stated, not implied.
  assert.equal(result.pageTotal, purchaseRows(96).reduce((s, r) => s + (r.amount as number), 0));
});

test("a page too big for the budget is cut by size and says where to resume", () => {
  const result = buildEntityList({
    entity: "Purchase",
    key: "purchases",
    rows: purchaseRows(1000),
    startPosition: 1,
    maxResults: 1000,
    rowCount: 1000,
  });
  const text = compact(result);
  const returned = result.returned as number;

  assert.ok(text.length <= MAX_RESULT_CHARS, `page is ${text.length} chars`);
  assert.ok(returned > 0 && returned < 1000, `returned ${returned} rows`);
  assert.equal(result.hasMore, true);
  assert.equal(result.truncatedBy, "size");
  assert.equal(result.nextStartPosition, 1 + returned);
  assert.equal(result.rowCount, 1000, "rowCount covers the whole range, not the page");
  assert.match(String(result.note), /startPosition: \d+/);
});

test("paging by startPosition walks a fiscal year exactly once", () => {
  const all = purchaseRows(600);
  const seen: string[] = [];
  let startPosition = 1;

  for (let guard = 0; guard < 50; guard++) {
    // What QBO would return for this window (the tool asks for 100 at a time).
    const window = all.slice(startPosition - 1, startPosition - 1 + 100);
    const result = buildEntityList({
      entity: "Purchase",
      key: "purchases",
      rows: window,
      startPosition,
      maxResults: 100,
      rowCount: all.length,
    });
    assert.ok(compact(result).length <= MAX_RESULT_CHARS);
    seen.push(...(result.purchases as Array<Record<string, unknown>>).map((r) => String(r.id)));
    if (!result.hasMore) break;
    assert.ok((result.nextStartPosition as number) > startPosition, "paging must advance");
    startPosition = result.nextStartPosition as number;
  }

  assert.deepEqual(seen, all.map((r) => String(r.id)));
});

test("a full window with more rows behind it reports hasMore even without a count", () => {
  const result = buildEntityList({
    entity: "Transfer",
    key: "transfers",
    rows: purchaseRows(100),
    startPosition: 101,
    maxResults: 100,
  });
  assert.equal(result.hasMore, true);
  assert.equal(result.truncatedBy, "window");
  assert.equal(result.nextStartPosition, 201);
});

test("the last window of a range ends paging", () => {
  const result = buildEntityList({
    entity: "Deposit",
    key: "deposits",
    rows: purchaseRows(12),
    startPosition: 101,
    maxResults: 100,
    rowCount: 112,
  });
  assert.equal(result.hasMore, false);
  assert.equal(result.returned, 12);
});

test("deposit and transfer rows keep the ids a follow-up call needs", () => {
  const deposit = slimDeposit({
    DepositToAccountRef: { value: "14", name: "Chase Checking" },
    TotalAmt: 500,
    domain: "QBO",
    sparse: false,
    Id: "1097",
    SyncToken: "0",
    MetaData: { CreateTime: "2026-08-29T17:49:40-07:00" },
    DocNumber: "1",
    TxnDate: "2026-05-20",
    CurrencyRef: { value: "USD", name: "United States Dollar" },
    PrivateNote: "REMOTE ONLINE DEPOSIT # 1",
    Line: [
      {
        Id: "1",
        LineNum: 1,
        Description: "Spring registration",
        Amount: 500,
        DetailType: "DepositLineDetail",
        DepositLineDetail: {
          Entity: { value: "9", name: "Ken Tam", type: "CUSTOMER" },
          AccountRef: { value: "42", name: "4310 Sponsors/Contributions/Donations" },
        },
        CustomExtensions: [],
      },
    ],
  });
  assert.deepEqual(deposit, {
    id: "1097",
    date: "2026-05-20",
    amount: 500,
    num: "1",
    depositTo: "Chase Checking",
    depositToId: "14",
    memo: "REMOTE ONLINE DEPOSIT # 1",
    lines: [
      {
        amount: 500,
        account: "4310 Sponsors/Contributions/Donations",
        accountId: "42",
        entity: "Ken Tam",
        entityId: "9",
        description: "Spring registration",
      },
    ],
  });

  const transfer = slimTransfer({
    FromAccountRef: { value: "14", name: "Chase Checking" },
    ToAccountRef: { value: "20", name: "Divvy Credit Card Payable" },
    Amount: 175,
    domain: "QBO",
    sparse: false,
    Id: "999",
    SyncToken: "0",
    MetaData: { CreateTime: "2026-07-23T04:05:55-07:00" },
    TxnDate: "2026-06-29",
    CurrencyRef: { value: "USD", name: "United States Dollar" },
    PrivateNote: "Divvy eWallet autopay",
  });
  assert.deepEqual(transfer, {
    id: "999",
    date: "2026-06-29",
    amount: 175,
    from: "Chase Checking",
    fromId: "14",
    to: "Divvy Credit Card Payable",
    toId: "20",
    memo: "Divvy eWallet autopay",
  });
});

test("an empty QueryResponse lists nothing instead of throwing", () => {
  assert.deepEqual(queryRows({ QueryResponse: {} }, "Purchase"), []);
  assert.deepEqual(queryRows(undefined, "Purchase"), []);
  const result = buildEntityList({
    entity: "Purchase",
    key: "purchases",
    rows: [],
    startPosition: 1,
    maxResults: 100,
    rowCount: 0,
  });
  assert.equal(result.returned, 0);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.purchases, []);
});

// --- the shared response path -------------------------------------------------

test("a tool that forgets to page fails with a named error, not an oversized payload", async () => {
  const res = await runTool("fat_tool", {}, async () => ({ rows: livePurchases(300) }));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /over the 40,000-character tool-result budget/);
  assert.match(res.content[0].text, /fat_tool produced a [\d,]+-character result/);
  assert.ok(res.content[0].text.length < 1000, "the error is a message, not the payload");
});

test("results are serialized compactly by default", async () => {
  const res = await runTool("small_tool", {}, async () => ({ a: 1, b: [2, 3] }));
  assert.equal(res.content[0].text, '{"a":1,"b":[2,3]}');
  assert.equal(res.isError, undefined);
});

test("a handler may return ready-made text, and a data-carrying failure", async () => {
  const text = await runTool("text_tool", {}, async () => "line 1\nline 2");
  assert.equal(text.content[0].text, "line 1\nline 2");

  const failure = await runTool("batch_tool", {}, async () => new ToolFailure({ failed: 2 }));
  assert.equal(failure.isError, true);
  assert.equal(failure.content[0].text, '{"failed":2}');
});

test("every tool goes through the shared response path", () => {
  const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "tools");
  for (const file of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(toolsDir, file), "utf8");
    // A handler that builds its own `content: [{ type: "text" ... }]` response
    // has opted out of compaction and the size budget — the exact way the
    // unbounded results got in. There is one response path: runTool.
    assert.ok(
      !/content:\s*\[/.test(src),
      `${file} builds an MCP response directly instead of returning data from runTool`,
    );
    if (src.includes("server.tool(")) {
      assert.match(src, /runTool/, `${file} registers tools without using runTool`);
    }
  }
});
