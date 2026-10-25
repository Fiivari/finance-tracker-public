import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import type { Session, Transaction } from "../src/enablebanking.ts";
import { addDays, consentDaysLeft, sync, toCents, type BankClient } from "../src/sync.ts";
import { matchTransfers } from "../src/transfers.ts";

const NOW = new Date("2026-10-24T12:00:00Z");

function session(validUntil = "2027-04-20T00:00:00Z", uidSuffix = "1"): Session {
  return {
    session_id: `s${uidSuffix}`,
    access: { valid_until: validUntil },
    accounts: [
      { uid: `current-${uidSuffix}`, currency: "EUR", cash_account_type: "CACC", account_id: { iban: "FI01" } },
      { uid: `savings-${uidSuffix}`, currency: "EUR", cash_account_type: "SVGS", account_id: { iban: "FI02" } },
    ],
  };
}

function tx(ref: string, date: string, amount: string, code = "ICDT", extra: Partial<Transaction> = {}): Transaction {
  return {
    entry_reference: ref,
    booking_date: date,
    status: "BOOK",
    credit_debit_indicator: amount.startsWith("-") ? "DBIT" : "CRDT",
    transaction_amount: { amount: amount.replace("-", ""), currency: "EUR" },
    bank_transaction_code: { code, sub_code: "ESCT" },
    ...extra,
  };
}

function fakeClient(byAccount: Record<string, Transaction[]>, calls: string[] = []): BankClient {
  return {
    async getBalances() {
      return [
        { balance_type: "ITBD", balance_amount: { amount: "100.50", currency: "EUR" } },
        { balance_type: "ITAV", balance_amount: { amount: "90.00", currency: "EUR" } },
      ];
    },
    async getTransactions(uid, dateFrom) {
      calls.push(`${uid}:${dateFrom}`);
      return byAccount[uid.split("-")[0]] ?? [];
    },
  };
}

test("toCents parses decimal strings exactly", () => {
  assert.equal(toCents("12.34"), 1234);
  assert.equal(toCents("0.1"), 10);
  assert.equal(toCents("-7"), -700);
  assert.equal(toCents("19.99"), 1999);
  assert.throws(() => toCents("1,50"));
});

test("consentDaysLeft and addDays", () => {
  assert.equal(consentDaysLeft("2026-11-07T12:00:00Z", NOW), 14);
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("matchTransfers pairs opposite amounts across accounts, ignoring card purchases", () => {
  const pairs = matchTransfers([
    { id: 1, accountId: 1, date: "2026-10-01", amount: -5000, bankCode: "ICDT", subCode: "ESCT" },
    { id: 2, accountId: 2, date: "2026-10-02", amount: 5000, bankCode: "RCDT", subCode: "ESCT" },
    { id: 3, accountId: 2, date: "2026-10-01", amount: 5000, bankCode: "RCDT", subCode: "ESCT" }, // closer date wins
    // Card purchase coinciding with an incoming payment (a friend paying back): not a transfer
    { id: 4, accountId: 2, date: "2026-10-01", amount: -1200, bankCode: "CCRD", subCode: "POSC" },
    { id: 5, accountId: 1, date: "2026-10-01", amount: 1200, bankCode: "RCDT", subCode: "ESCT" },
    { id: 6, accountId: 1, date: "2026-10-01", amount: -300, bankCode: "ICDT", subCode: "ESCT" },
    { id: 7, accountId: 1, date: "2026-10-01", amount: 300, bankCode: "RCDT", subCode: "ESCT" }, // same account
    { id: 8, accountId: 1, date: "2026-10-01", amount: -900, bankCode: "ICDT", subCode: "ESCT" },
    { id: 9, accountId: 2, date: "2026-10-08", amount: 900, bankCode: "RCDT", subCode: "ESCT" }, // too far apart
    // Credit-card bill payment: arrives on the card account as CCRD/OTHR
    { id: 10, accountId: 1, date: "2026-10-05", amount: -40000, bankCode: "ICDT", subCode: "ESCT" },
    { id: 11, accountId: 2, date: "2026-10-05", amount: 40000, bankCode: "CCRD", subCode: "OTHR" },
  ]);
  assert.deepEqual(pairs, [[1, 3], [10, 11]]);
});

test("sync stores transactions, dedups, snapshots balances and marks transfers", async () => {
  const db = openDb(":memory:");
  const data = {
    current: [
      tx("c1", "2026-10-01", "-50.00"),
      tx("c2", "2026-10-02", "-12.30", "CCRD", { bank_transaction_code: { code: "CCRD", sub_code: "POSD" }, creditor: { name: "K-Market" } }),
    ],
    savings: [tx("s1", "2026-10-01", "50.00")],
  };
  const calls: string[] = [];
  const first = await sync(db, session(), fakeClient(data, calls), NOW);
  assert.equal(first.inserted, 3);
  assert.equal(first.transfers, 1);
  assert.deepEqual(calls, ["current-1:2026-07-27", "savings-1:2026-07-27"]);

  const card = db.prepare("SELECT amount, counterparty, is_transfer FROM transactions WHERE entry_reference = 'c2'").get();
  assert.deepEqual({ ...card }, { amount: -1230, counterparty: "K-Market", is_transfer: 0 });
  const balance = db.prepare("SELECT booked, available FROM balances_daily WHERE date = '2026-10-24' LIMIT 1").get();
  assert.deepEqual({ ...balance }, { booked: 10050, available: 9000 });

  // Renewed consent: new uids, same IBANs. Nothing duplicated; fetch resumes with the overlap window.
  calls.length = 0;
  const second = await sync(db, session(undefined, "2"), fakeClient(data, calls), NOW);
  assert.equal(second.inserted, 0);
  assert.deepEqual(calls, ["current-2:2026-09-22", "savings-2:2026-09-21"]);
  const counts = db.prepare("SELECT (SELECT count(*) FROM accounts) a, (SELECT count(*) FROM transactions) t").get();
  assert.deepEqual({ ...counts }, { a: 2, t: 3 });
  const savings = db.prepare("SELECT is_savings FROM accounts WHERE iban = 'FI02'").get();
  assert.equal(savings?.is_savings, 1);
});

test("sync warns before consent expiry and fails after it", async () => {
  const db = openDb(":memory:");
  const soon = await sync(db, session("2026-11-01T00:00:00Z"), fakeClient({}), NOW);
  assert.match(soon.warnings.join(), /expires in 7 days/);
  await assert.rejects(sync(db, session("2026-10-20T00:00:00Z"), fakeClient({}), NOW), /expired/);
  const run = db.prepare("SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1").get();
  assert.equal(run?.status, "error");
});
