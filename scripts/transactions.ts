// Lists balances and the last 90 days of transactions for every linked account.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { api, getTransactions, type Balance, type Transaction } from "../src/enablebanking.ts";

const DAYS = 90;

let session: { accounts: { uid: string; name?: string; account_id?: { iban?: string } }[] };
try {
  session = JSON.parse(readFileSync("secrets/session.json", "utf8"));
} catch {
  console.error("No session found. Run `npm run link` first.");
  process.exit(1);
}

const dateFrom = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);
mkdirSync("data", { recursive: true });

for (const account of session.accounts) {
  const label = account.name ?? account.account_id?.iban ?? account.uid;
  console.log(`\n=== ${label} ===`);

  const { balances } = await api<{ balances: Balance[] }>("GET", `/accounts/${account.uid}/balances`);
  for (const b of balances) {
    console.log(`Balance (${b.balance_type}): ${b.balance_amount.amount} ${b.balance_amount.currency}`);
  }

  const transactions = await getTransactions(account.uid, dateFrom);
  // Raw dump to inspect which fields S-Pankki actually fills in; data/ is git-ignored.
  writeFileSync(`data/transactions-${account.uid}.json`, JSON.stringify(transactions, null, 2));

  let income = 0;
  let spending = 0;
  console.log(`\n${transactions.length} transactions since ${dateFrom}:\n`);
  for (const t of transactions) {
    const amount = signedAmount(t);
    if (amount > 0) income += amount;
    else spending -= amount;
    const date = t.booking_date ?? t.transaction_date ?? t.value_date ?? "?";
    const pending = t.status === "PDNG" ? " (pending)" : "";
    console.log(`${date}  ${amount.toFixed(2).padStart(10)}  ${counterparty(t)}${pending}`);
  }
  console.log(`\nIn: ${income.toFixed(2)}   Out: ${spending.toFixed(2)}   Net: ${(income - spending).toFixed(2)}`);
}

function signedAmount(t: Transaction): number {
  const value = Number(t.transaction_amount.amount);
  return t.credit_debit_indicator === "DBIT" ? -Math.abs(value) : Math.abs(value);
}

function counterparty(t: Transaction): string {
  const name = t.credit_debit_indicator === "DBIT" ? t.creditor?.name : t.debtor?.name;
  return (name ?? t.remittance_information?.join(" ") ?? "—").slice(0, 60);
}
