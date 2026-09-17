import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTransactionReport } from "./tools/qbo-reports.js";
import { MAX_RESULT_CHARS, compact, packRows } from "./result-size.js";
import { qboFaultMessage } from "./qbo-client.js";

/**
 * Build a TransactionList report of `n` transaction rows shaped like the live
 * one (nested Rows, ids on the type/account cells, comma-formatted amounts,
 * a trailing summary row with no ColData). Memo lengths mirror real books —
 * this is the payload that used to blow past the client's result cap.
 */
function bigReport(n: number) {
  const Row = Array.from({ length: n }, (_, i) => ({
    ColData: [
      { value: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}` },
      { value: i % 3 === 0 ? "Deposit" : "Expenditure", id: String(900 + i) },
      { value: i % 2 ? `FF539FE75266812CCA59C${i}` : "" },
      { value: "Yes" },
      { value: `VENDOR NUMBER ${i}`, id: String(50 + (i % 40)) },
      { value: `Sam Habash | Google Services | AYSO Region 2B145 | Monthly bill line ${i}.` },
      { value: i % 2 ? "2150 Divvy Credit Card Payable" : "1100 Chase Checking", id: i % 2 ? "20" : "14" },
      { value: "7515 Phone/Internet/website", id: "108" },
      { value: `${i % 2 ? "-" : ""}1,2${String(i % 100).padStart(2, "0")}.34` },
    ],
  }));
  return {
    Header: { ReportName: "TransactionList", StartPeriod: "2025-07-01", EndPeriod: "2026-06-30" },
    Columns: {
      Column: [
        { ColTitle: "Date", ColType: "tx_date" },
        { ColTitle: "Transaction Type", ColType: "txn_type" },
        { ColTitle: "Num", ColType: "doc_num" },
        { ColTitle: "Posting", ColType: "is_no_post" },
        { ColTitle: "Name", ColType: "name" },
        { ColTitle: "Memo/Description", ColType: "memo" },
        { ColTitle: "Account", ColType: "account_name" },
        { ColTitle: "Split", ColType: "other_account" },
        { ColTitle: "Amount", ColType: "subt_nat_amount" },
      ],
    },
    Rows: { Row: [...Row, { type: "Section", Rows: { Row: [] } }] },
  };
}

const ARGS = { startDate: "2025-07-01", endDate: "2026-06-30" };

test("a fiscal-year-sized report is paged instead of returned oversized", () => {
  const report = bigReport(1200);
  const first = buildTransactionReport(report, ARGS);

  assert.equal(first.rowCount, 1200, "row count covers the whole range, not the page");
  assert.equal(first.hasMore, true);
  assert.ok((first.returned as number) > 0 && (first.returned as number) < 1200);
  assert.equal(first.truncatedBy, "size");
  assert.ok(
    compact(first).length <= MAX_RESULT_CHARS,
    `page must fit the ${MAX_RESULT_CHARS}-char budget, got ${compact(first).length}`,
  );
});

test("paging through a large range returns every row exactly once", () => {
  const report = bigReport(1200);
  const seen: string[] = [];
  let offset = 0;
  let pages = 0;
  let pageTotalSum = 0;

  for (;;) {
    const page = buildTransactionReport(report, { ...ARGS, offset });
    pages++;
    assert.ok(pages < 100, "paging must terminate");
    assert.ok(
      compact(page).length <= MAX_RESULT_CHARS,
      `page ${pages} exceeded the budget: ${compact(page).length}`,
    );
    assert.ok((page.returned as number) > 0, "a page must always advance");
    for (const r of page.rows as Array<Record<string, unknown>>) seen.push(String(r.id));
    pageTotalSum += page.pageTotal as number;
    if (!page.hasMore) break;
    offset = page.nextOffset as number;
  }

  assert.ok(pages > 1, "a fiscal year should take more than one page");
  assert.equal(seen.length, 1200);
  assert.equal(new Set(seen).size, 1200, "no row repeated or dropped across pages");

  const whole = buildTransactionReport(report, ARGS).total as number;
  assert.equal(Math.round(pageTotalSum * 100) / 100, whole, "page totals sum to the whole-range total");
});

test("a two-month-sized report comes back in one page, far smaller than the raw report", () => {
  const report = bigReport(62); // the live 2026-05-01..2026-06-30 row count
  const page = buildTransactionReport(report, { startDate: "2026-05-01", endDate: "2026-06-30" });

  assert.equal(page.hasMore, false);
  assert.equal(page.returned, 62);
  assert.equal(page.rowCount, 62);
  // Live books, same range: 52,180 chars of pretty raw report -> 19,789 chars
  // of compact rows (2.6x). The fixture's memos are longer than real ones, so
  // hold the bar at 2.5x rather than chasing the exact live ratio.
  const slim = compact(page).length;
  const rawPretty = JSON.stringify(report, null, 2).length;
  assert.ok(slim * 2.5 < rawPretty, `expected a >2.5x shrink, got ${rawPretty} -> ${slim}`);
});

test("explicit limit pages just as reliably as the size budget", () => {
  const report = bigReport(50);
  const page = buildTransactionReport(report, { ...ARGS, limit: 10 });
  assert.equal(page.returned, 10);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 10);
  assert.equal(page.truncatedBy, "limit");
});

test("offset past the end returns an empty final page, not an error", () => {
  const page = buildTransactionReport(bigReport(5), { ...ARGS, offset: 99 });
  assert.equal(page.returned, 0);
  assert.equal(page.hasMore, false);
  assert.equal(page.rowCount, 5);
});

test("packRows always advances, even when one row alone exceeds the budget", () => {
  const fat = [{ memo: "x".repeat(50_000) }, { memo: "second" }];
  const page = packRows(fat, 0);
  assert.equal(page.rows.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 1);
});

test("rows keep the QBO ids a follow-up lookup needs", () => {
  const page = buildTransactionReport(bigReport(1), ARGS);
  const row = (page.rows as Array<Record<string, unknown>>)[0];
  assert.equal(row.id, "900");
  assert.equal(row.accountId, "14");
  assert.equal(row.split, "7515 Phone/Internet/website");
  assert.ok(!("posting" in row), "blank/boilerplate cells are dropped from the payload");
});

test("a QBO Fault returned with HTTP 200 is recognised as an error, not data", () => {
  const fault = {
    Fault: {
      Error: [
        {
          Message: "An application error has occurred while processing your request",
          Detail: 'System Failure Error: java.lang.IllegalArgumentException: Invalid format: "2026-01-01 2026-06-30"',
          code: "10000",
        },
      ],
      type: "SystemFault",
    },
    time: "2026-09-16T22:04:51.650-07:00",
  };
  const msg = qboFaultMessage(fault);
  assert.ok(msg?.includes("SystemFault"));
  assert.ok(msg?.includes("Invalid format"));
  assert.equal(qboFaultMessage(bigReport(1)), undefined, "a real report is not a fault");
});
