import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTransactionList } from "./qbo-client.js";

// A realistic QBO TransactionList report payload: nested/grouped Rows, a summary
// row with no ColData, and comma-formatted amounts — the shapes parseTransactionList
// must survive.
const sampleReport = {
  Header: { ReportName: "TransactionList" },
  Columns: {
    Column: [
      { ColTitle: "Date", ColType: "Date" },
      { ColTitle: "Transaction Type", ColType: "String" },
      { ColTitle: "Num", ColType: "String" },
      { ColTitle: "Name", ColType: "String" },
      { ColTitle: "Memo/Description", ColType: "String" },
      { ColTitle: "Account", ColType: "String" },
      { ColTitle: "Split", ColType: "String" },
      { ColTitle: "Amount", ColType: "Amount" },
    ],
  },
  Rows: {
    Row: [
      {
        ColData: [
          { value: "2026-07-03" },
          { value: "Deposit" },
          { value: "" },
          { value: "AYSO Region" },
          { value: "Registration batch" },
          { value: "Chase Checking" },
          { value: "Registration Income" },
          { value: "1,250.00" },
        ],
      },
      {
        ColData: [
          { value: "2026-07-10" },
          { value: "Expense" },
          { value: "1042" },
          { value: "Dick's Sporting Goods" },
          { value: "Goals & nets" },
          { value: "Chase Checking" },
          { value: "Field Equipment" },
          { value: "-430.75" },
        ],
      },
      // A grouped subsection with its own nested rows + a summary row (no ColData).
      {
        group: "sub",
        Rows: {
          Row: [
            {
              ColData: [
                { value: "2026-07-18" },
                { value: "Check" },
                { value: "1043" },
                { value: "City Parks Dept" },
                { value: "Field permits" },
                { value: "Chase Checking" },
                { value: "Permits" },
                { value: "-200.00" },
              ],
            },
          ],
        },
      },
      // Summary row: no ColData — must be skipped, not crash.
      { type: "Section" },
    ],
  },
};

test("parseTransactionList flattens nested rows, skips summaries, signs amounts", () => {
  const { transactions, total } = parseTransactionList(sampleReport);
  assert.equal(transactions.length, 3);
  assert.equal(transactions[0].name, "AYSO Region");
  assert.equal(transactions[0].amount, 1250);
  assert.equal(transactions[0].account, "Chase Checking");
  assert.equal(transactions[1].amount, -430.75);
  assert.equal(transactions[1].docNumber, "1042");
  assert.equal(transactions[2].type, "Check");
  assert.equal(transactions[2].account, "Chase Checking");
  // 1250 - 430.75 - 200 = 619.25
  assert.equal(total, 619.25);
});

test("reconcile difference math: clears to zero", () => {
  const { total } = parseTransactionList(sampleReport);
  const beginningBalance = 5000;
  const endingBalance = 5619.25; // beginning + all outstanding activity
  const differenceClearAll = Math.round((endingBalance - (beginningBalance + 0 + total)) * 100) / 100;
  assert.equal(differenceClearAll, 0);
});

test("reconcile difference math: surfaces a discrepancy", () => {
  const { total } = parseTransactionList(sampleReport);
  const beginningBalance = 5000;
  const endingBalance = 5700; // off by 80.75 vs cleared activity
  const differenceClearAll = Math.round((endingBalance - (beginningBalance + 0 + total)) * 100) / 100;
  assert.equal(differenceClearAll, 80.75);
});

test("client-side account filter separates two accounts in one company-wide report", () => {
  // QBO ignores the report's `account` filter, so we fetch company-wide and
  // filter by the Account column client-side. This is that filter.
  const mixed = {
    Columns: {
      Column: [
        { ColTitle: "Date" },
        { ColTitle: "Transaction Type" },
        { ColTitle: "Num" },
        { ColTitle: "Name" },
        { ColTitle: "Memo/Description" },
        { ColTitle: "Account" },
        { ColTitle: "Split" },
        { ColTitle: "Amount" },
      ],
    },
    Rows: {
      Row: [
        { ColData: [{ value: "2026-07-03" }, { value: "Deposit" }, { value: "" }, { value: "A" }, { value: "" }, { value: "1100 Chase Checking" }, { value: "x" }, { value: "1000.00" }] },
        { ColData: [{ value: "2026-07-04" }, { value: "Expense" }, { value: "" }, { value: "B" }, { value: "" }, { value: "2150 Divvy Credit Card Payable" }, { value: "x" }, { value: "40.00" }] },
        { ColData: [{ value: "2026-07-05" }, { value: "Check" }, { value: "" }, { value: "C" }, { value: "" }, { value: "1100 Chase Checking" }, { value: "x" }, { value: "-250.00" }] },
      ],
    },
  };
  const { transactions } = parseTransactionList(mixed);
  // Report Account column is number-prefixed ("1100 Chase Checking") while the
  // Account entity Name is bare ("Chase Checking"); strip the prefix to match.
  const norm = (s: string) => s.trim().toLowerCase();
  const stripAcctNum = (s: string) => s.replace(/^\s*\d[\d.\-]*\s+/, "").trim();
  const chase = transactions.filter((t) => norm(stripAcctNum(t.account)) === norm("chase checking"));
  const chaseTotal = Math.round(chase.reduce((s, t) => s + t.amount, 0) * 100) / 100;
  assert.equal(chase.length, 2);
  assert.equal(chaseTotal, 750); // 1000 - 250; the 40.00 Divvy row is excluded
});

test("parseTransactionList tolerates an empty report", () => {
  const { transactions, total } = parseTransactionList({ Rows: {} });
  assert.equal(transactions.length, 0);
  assert.equal(total, 0);
});
