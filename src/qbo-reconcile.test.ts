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
  assert.equal(transactions[1].amount, -430.75);
  assert.equal(transactions[1].docNumber, "1042");
  assert.equal(transactions[2].type, "Check");
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

test("parseTransactionList tolerates an empty report", () => {
  const { transactions, total } = parseTransactionList({ Rows: {} });
  assert.equal(transactions.length, 0);
  assert.equal(total, 0);
});
