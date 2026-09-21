import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildEntityList,
  queryRows,
  slimAccount,
  slimDeposit,
  slimPurchase,
  slimTransfer,
  slimVendor,
} from "./qbo-rows.js";
import { MAX_RESULT_CHARS, compact } from "./result-size.js";
import { vendorNameWhere } from "./qbo-client.js";
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

// --- the chart of accounts and the vendor list --------------------------------

/**
 * An Account as live QBO returns it. The chart of accounts is the everyday
 * treasurer call (it's how you find the account id every other tool wants) and
 * the tool took NO arguments — so when 53,799 characters of these came back
 * over the 40,000-character budget, the error's advice to "narrow the request"
 * was impossible to follow.
 */
function liveAccount(i: number) {
  return {
    Name: `${4000 + i} Program Expenses ${i}`,
    SubAccount: i % 3 === 0,
    ParentRef: i % 3 === 0 ? { value: "88", name: "Program Expenses" } : undefined,
    FullyQualifiedName: `Program Expenses:${4000 + i} Program Expenses ${i}`,
    Active: true,
    Classification: "Expense",
    AccountType: "Expense",
    AccountSubType: "OtherMiscellaneousServiceCost",
    AcctNum: String(4000 + i),
    CurrentBalance: 0,
    CurrentBalanceWithSubAccounts: 0,
    CurrencyRef: { value: "USD", name: "United States Dollar" },
    domain: "QBO",
    sparse: false,
    Id: String(100 + i),
    SyncToken: "0",
    MetaData: {
      CreateTime: "2026-05-08T15:11:43-07:00",
      LastUpdatedTime: "2026-08-31T16:35:37-07:00",
    },
  };
}

/** A Vendor exactly as live QBO returns it (captured from production). */
function liveVendor(i: number) {
  return {
    Balance: 0,
    BillRate: 0,
    Vendor1099: false,
    CurrencyRef: { value: "USD", name: "United States Dollar" },
    CostRate: 0,
    domain: "QBO",
    sparse: false,
    Id: String(26 + i),
    SyncToken: "0",
    MetaData: {
      CreateTime: "2026-05-08T15:11:43-07:00",
      LastUpdatedTime: "2026-05-08T15:11:43-07:00",
    },
    GivenName: "Anthony",
    MiddleName: "and",
    FamilyName: `Marlene Yee ${i}`,
    CompanyName: `Anthony and Marlene Yee ${i}`,
    DisplayName: `Anthony and Marlene Yee ${i}`,
    PrintOnCheckName: `Anthony and Marlene Yee ${i}`,
    Active: true,
    V4IDPseudonym: "0020663109cece5d124d4aa07e068b7dea1d7e",
    PrimaryEmailAddr: { Address: `marlenegyee${i}@gmail.com` },
  };
}

const accountRows = (n: number) => Array.from({ length: n }, (_, i) => slimAccount(liveAccount(i)));
const vendorRows = (n: number) => Array.from({ length: n }, (_, i) => slimVendor(liveVendor(i)));

test("an account row drops QBO's envelope and keeps what picks an account", () => {
  const row = slimAccount({ ...liveAccount(0), CurrentBalance: 1234.5 });
  const text = compact(row);

  for (const envelope of [
    "domain",
    "sparse",
    "SyncToken",
    "MetaData",
    "FullyQualifiedName",
    "AccountSubType",
    "CurrentBalanceWithSubAccounts",
    "United States Dollar",
  ]) {
    assert.ok(!text.includes(envelope), `row still carries QBO envelope: ${envelope}`);
  }

  assert.deepEqual(row, {
    id: "100",
    name: "4000 Program Expenses 0",
    num: "4000",
    type: "Expense",
    classification: "Expense",
    balance: 1234.5,
    parent: "Program Expenses",
    parentId: "88",
  });

  // A top-level account carries no parent keys at all, and `active` shows up
  // only when it is the interesting answer — the listing is active-only.
  const top = slimAccount({ ...liveAccount(1), Active: false });
  assert.ok(!("parent" in top) && !("parentId" in top));
  assert.equal(top.active, false);
  assert.ok(!("active" in slimAccount(liveAccount(1))));
});

test("the whole chart of accounts fits one result, where the raw entities did not", () => {
  const raw = compact({ QueryResponse: { Account: Array.from({ length: 120 }, (_, i) => liveAccount(i)) } });
  assert.ok(raw.length > MAX_RESULT_CHARS, `raw chart of accounts is only ${raw.length} chars`);

  const result = buildEntityList({
    entity: "Account",
    key: "accounts",
    rows: accountRows(120),
    startPosition: 1,
    maxResults: 1000,
    rowCount: 120,
    sumField: null,
  });

  assert.ok(compact(result).length < MAX_RESULT_CHARS, `paged result is ${compact(result).length} chars`);
  assert.equal(result.returned, 120);
  assert.equal(result.hasMore, false, "the whole chart comes back in one call");
  // Assets + liabilities + income added together would be a number that means
  // nothing, so a chart of accounts states no page total at all.
  assert.ok(!("pageTotal" in result), "a chart of accounts must not claim a page total");
});

test("a vendor row keeps who they are, not how QBO spells their name four times", () => {
  const row = slimVendor({
    ...liveVendor(0),
    Balance: 250,
    PrimaryPhone: { FreeFormNumber: "(555) 123-4567" },
  });
  const text = compact(row);

  for (const envelope of [
    "BillRate",
    "CostRate",
    "Vendor1099",
    "V4IDPseudonym",
    "PrintOnCheckName",
    "GivenName",
    "FamilyName",
    "SyncToken",
    "MetaData",
    "United States Dollar",
  ]) {
    assert.ok(!text.includes(envelope), `row still carries QBO envelope: ${envelope}`);
  }

  assert.deepEqual(row, {
    id: "26",
    name: "Anthony and Marlene Yee 0",
    // CompanyName repeated the display name verbatim, so it is dropped.
    email: "marlenegyee0@gmail.com",
    phone: "(555) 123-4567",
    balance: 250,
  });

  const withCompany = slimVendor({ ...liveVendor(0), CompanyName: "Yee Family Trust" });
  assert.equal(withCompany.company, "Yee Family Trust");
});

test("maxResults: 1000 — the schema's own maximum — returns vendors instead of an error", () => {
  const raw = compact({ QueryResponse: { Vendor: Array.from({ length: 1000 }, (_, i) => liveVendor(i)) } });
  assert.ok(raw.length > MAX_RESULT_CHARS, `raw vendor page is only ${raw.length} chars`);

  const all = vendorRows(1000);
  const seen: string[] = [];
  let startPosition = 1;

  for (let guard = 0; guard < 50; guard++) {
    const result = buildEntityList({
      entity: "Vendor",
      key: "vendors",
      rows: all.slice(startPosition - 1),
      startPosition,
      maxResults: 1000,
      rowCount: all.length,
      sumField: null,
    });
    assert.ok(compact(result).length <= MAX_RESULT_CHARS, "every page fits the budget");
    assert.ok((result.returned as number) > 0, "a page that fits must carry rows");
    assert.ok(!("pageTotal" in result), "a slice of what we owe is not a total");
    seen.push(...(result.vendors as Array<Record<string, unknown>>).map((r) => String(r.id)));
    if (!result.hasMore) break;
    assert.equal(result.truncatedBy, "size");
    startPosition = result.nextStartPosition as number;
  }

  assert.deepEqual(seen, all.map((r) => String(r.id)), "paging walks all 1000 vendors exactly once");
});

test("a vendor whose name has an apostrophe is a search, not a query syntax error", () => {
  assert.equal(vendorNameWhere("%Bob's Signs%"), "DisplayName LIKE '%Bob''s Signs%'");
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
    if (src.includes("server.registerTool(")) {
      assert.match(src, /runTool/, `${file} registers tools without using runTool`);
    }
  }
});
