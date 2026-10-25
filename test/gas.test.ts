// Runs the Apps Script code (gas/) in Node against a fake spreadsheet and a fake Enable Banking API.
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { loadAppsScript } from "./fake-apps-script.ts";

const NOW = new Date("2026-10-24T09:00:00Z");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function tx(ref: string, date: string, amount: string, code: string, sub: string, name: string, extra: object = {}) {
  const debit = amount.startsWith("-");
  return {
    entry_reference: ref,
    booking_date: date,
    status: "BOOK",
    credit_debit_indicator: debit ? "DBIT" : "CRDT",
    transaction_amount: { amount: amount.replace("-", ""), currency: "EUR" },
    bank_transaction_code: { code, sub_code: sub },
    ...(debit ? { creditor: { name } } : { debtor: { name } }),
    ...extra,
  };
}

function setup(bankTxs: Record<string, object[]>) {
  const calls: string[] = [];
  const env = loadAppsScript((method, path) => {
    calls.push(`${method} ${path}`);
    const m = /^\/accounts\/([^/]+)\/(balances|transactions)/.exec(path);
    if (m?.[2] === "balances") {
      return m[1] === "card"
        ? { balances: [{ balance_type: "ITBD", balance_amount: { amount: "-150.00" } }, { balance_type: "ITAV", balance_amount: { amount: "1850.00" } }] }
        : { balances: [{ balance_type: "ITBD", balance_amount: { amount: "1000.00" } }, { balance_type: "ITAV", balance_amount: { amount: "950.00" } }] };
    }
    if (m?.[2] === "transactions") return { transactions: bankTxs[m[1]] ?? [] };
    throw new Error(`unexpected ${method} ${path}`);
  }, () => NOW);
  env.props.set("EB_APP_ID", "app-123");
  // Pasted into the Script Properties field with the line breaks flattened.
  env.props.set("EB_PRIVATE_KEY", PEM.replace(/\n/g, " "));
  env.props.set(
    "SESSION",
    JSON.stringify({
      session_id: "s1",
      access: { valid_until: "2027-04-20T00:00:00Z" },
      accounts: [
        { uid: "current", product: "S-TILI", cash_account_type: "CACC", account_id: { iban: "FI00 1111" }, currency: "EUR" },
        { uid: "card", product: "Visa Credit", cash_account_type: "CARD", account_id: { iban: "FI00 2222" }, currency: "EUR" },
      ],
    }),
  );
  env.run("setupSheets_()");
  return { env, calls, sheet: (name: string) => env.sheets.get(name)!.rows() };
}

const BANK = {
  current: [
    tx("c1", "2026-10-01", "2500.00", "RCDT", "ESCT", "Employer Oy"),
    tx("c2", "2026-10-14", "-300.00", "ICDT", "ESCT", "S-Pankki"), // card bill payment
    tx("c3", "2026-10-02", "-40.00", "CCRD", "POSD", "K-MARKET KESKUSTA 123"),
    tx("c4", "2026-10-05", "-12.00", "CCRD", "POSD", "=HYPERLINK(\"https://evil.example\")"),
    tx("pending", "2026-10-23", "-5.00", "CCRD", "POSD", "Cafe", { status: "PDNG" }),
  ],
  card: [
    tx("k1", "2026-10-14", "300.00", "CCRD", "OTHR", "S-Pankki"),
    tx("k2", "2026-10-20", "-150.00", "CCRD", "POSC", "Bar Mystery"),
  ],
};

test("sync fills transactions, categories, transfers, balances and the summary", () => {
  const { env, sheet, calls } = setup(BANK);
  env.run("syncNow()");

  const txs = sheet("Transactions");
  assert.equal(txs.length, 6); // pending skipped
  const byMerchant = new Map(txs.map((r) => [r[2], r]));
  assert.equal(byMerchant.get("K-Market")?.[3], "Groceries");
  assert.equal(byMerchant.get("Employer Oy")?.[3], "Income");
  assert.equal(txs.filter((r) => r[7] === "yes").length, 2); // card bill paired as a transfer
  assert.equal(byMerchant.get("Bar Mystery")?.[3], "Bars & eating out");
  assert.deepEqual(txs[0].slice(0, 2), ["2026-10-20", -150]); // newest first, euros
  assert.equal(env.sheets.get("Transactions")!.formulas, 0); // bank text never written as a formula
  assert.ok(txs.some((r) => String(r[9]).startsWith("=HYPERLINK"))); // but kept as text
  assert.ok(txs.every((r) => !String(r[12]).includes("FI00"))); // keys use an IBAN hash, not the IBAN

  const summary = new Map(sheet("Summary").map((r) => [r[0], r[1]]));
  assert.equal(summary.get("Cash available"), 950);
  assert.equal(summary.get("Credit card owed"), 150);
  assert.equal(summary.get("Spent this month"), 40 + 12 + 150);
  assert.equal(summary.get("Bank access days left"), 177);
  for (const row of ["Savings jar level", "Savings jar potential"]) {
    const v = summary.get(row);
    assert.ok(typeof v === "number" && v >= 0 && v <= 1, `${row}: ${v}`); // the widget's only data, a share
  }

  assert.equal(sheet("Balances").length, 2);
  assert.equal(sheet("Sync log")[0][1], "ok");
  assert.ok(calls.includes("get /accounts/current/transactions?date_from=2026-07-27"));
});

test("my merchant category applies on the next sync; a second sync adds nothing", () => {
  const { env, sheet, calls } = setup(BANK);
  env.run("syncNow()");
  const merchants = env.sheets.get("Merchants")!;
  const row = merchants.data.findIndex((r) => r[0] === "Bar Mystery");
  merchants.set(row + 1, 2, "Entertainment");
  env.run("syncNow()");

  const bar = sheet("Transactions").find((r) => r[2] === "Bar Mystery")!;
  assert.deepEqual([bar[3], bar[10]], ["Entertainment", "merchant"]);
  assert.equal(sheet("Merchants").find((r) => r[0] === "Bar Mystery")![2], "Entertainment");
  assert.equal(sheet("Transactions").length, 6);
  assert.deepEqual(sheet("Sync log")[0].slice(1, 4), ["ok", 0, 0]);
  // The second sync only re-fetches from 10 days before the newest booking per account.
  assert.ok(calls.includes("get /accounts/card/transactions?date_from=2026-10-10"));
});

test("a transaction override wins over everything", () => {
  const { env, sheet } = setup(BANK);
  env.run("syncNow()");
  const t = env.sheets.get("Transactions")!;
  const row = t.data.findIndex((r) => r[2] === "K-Market");
  t.set(row + 1, 5, "Shopping");
  env.run("syncNow()");
  const km = sheet("Transactions").find((r) => r[2] === "K-Market")!;
  assert.deepEqual([km[3], km[4], km[10]], ["Shopping", "Shopping", "override"]);
});

test("expired consent is logged as an error and stops the sync", () => {
  const { env, sheet } = setup(BANK);
  env.props.set("SESSION", JSON.stringify({ session_id: "s", access: { valid_until: "2026-10-01T00:00:00Z" }, accounts: [] }));
  assert.throws(() => env.run("syncNow()"), /expired/);
  assert.equal(sheet("Sync log")[0][1], "error");
});

test("requests carry a valid RS256 JWT for the app id", () => {
  const { env } = setup(BANK);
  env.run("syncNow()");
  const jwt = env.requests[0].auth.replace("Bearer ", "");
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { typ: "JWT", alg: "RS256", kid: "app-123" });
  assert.equal(JSON.parse(Buffer.from(p, "base64url").toString()).aud, "api.enablebanking.com");
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), createPublicKey(PEM), Buffer.from(s, "base64url")));
  assert.ok(!jwt.includes("="));
});

test("rent is detected even when the landlord also charges small fees", () => {
  const { env } = setup({});
  const occ = (date: string, amount: number) => ({ date, amount, merchant: "Landlord Oy", merchantKey: "landlord oy", category: "Housing", transfer: false });
  const txs = [occ("2026-07-31", -100000), occ("2026-08-12", -450), occ("2026-09-02", -100000), occ("2026-10-01", -100000)];
  env.context.txs = txs;
  const found = env.run("detectRecurring(txs, '2026-10-24')");
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].kind, found[0].amount, found[0].nextExpectedDate], ["bill", -100000, "2026-11-01"]);
});

test("payday is the 14th, or the last weekday before it on a weekend", () => {
  const { env } = setup({});
  const payday = (today: string) => env.run(`nextPayday("${today}")`);
  assert.equal(payday("2026-10-24"), "2026-11-13"); // 14 Nov 2026 is a Saturday
  assert.equal(payday("2026-11-13"), "2026-11-13"); // payday itself
  assert.equal(payday("2026-11-14"), "2026-12-14"); // Monday
  assert.equal(payday("2027-02-01"), "2027-02-12"); // 14 Feb 2027 is a Sunday
  assert.equal(payday("2026-12-20"), "2027-01-14"); // across the year end
});

test("a recurring amount follows the latest payment (pay rise)", () => {
  const { env } = setup({});
  env.context.salary = [
    { date: "2026-08-14", amount: 250000 },
    { date: "2026-09-12", amount: 250000 },
    { date: "2026-10-14", amount: 280000 },
  ];
  assert.equal(env.run("findPattern(salary, '2026-10-24')").amount, 280000);
});

test("recategorizing from the dashboard saves my choice and recomputes without calling the bank", () => {
  const { env, sheet, calls } = setup(BANK);
  env.run("syncNow()");
  const requests = calls.length;
  const key = (merchant: string) => sheet("Transactions").find((r) => r[2] === merchant)![12];
  const lastSync = new Map(sheet("Summary").map((r) => [r[0], r[1]])).get("Last sync");

  // One transaction: its Override.
  let d = JSON.parse(env.run(`setCategory(${JSON.stringify(key("K-Market"))}, "Shopping", false)`));
  let km = sheet("Transactions").find((r) => r[2] === "K-Market")!;
  assert.deepEqual([km[3], km[4], km[10]], ["Shopping", "Shopping", "override"]);
  assert.equal(d.transactions.find((t: any) => t.m === "K-Market").s, "override");
  assert.equal(d.months[0].categories.find((c: any) => c.name === "Shopping").total, 4000);

  // The whole merchant: My category in Merchants, and this transaction's own override is cleared.
  d = JSON.parse(env.run(`setCategory(${JSON.stringify(key("K-Market"))}, "Health", true)`));
  km = sheet("Transactions").find((r) => r[2] === "K-Market")!;
  assert.deepEqual([km[3], km[4], km[10]], ["Health", "", "merchant"]);
  assert.equal(sheet("Merchants").find((r) => r[0] === "K-Market")![1], "Health");

  // Removing the merchant choice brings back the automatic category.
  env.run(`setCategory(${JSON.stringify(key("K-Market"))}, "", true)`);
  km = sheet("Transactions").find((r) => r[2] === "K-Market")!;
  assert.deepEqual([km[3], km[10]], ["Groceries", "built-in"]);

  assert.equal(calls.length, requests);
  assert.equal(new Map(sheet("Summary").map((r) => [r[0], r[1]])).get("Last sync"), lastSync);
  assert.throws(() => env.run(`setCategory(${JSON.stringify(key("K-Market"))}, "Nope", false)`), /Unknown category/);
});

test("dashboard data is built from the synced sheet", () => {
  const { env } = setup(BANK);
  env.run("syncNow()");
  const d = env.run("dashboardData_()");
  assert.equal(d.payday, "2026-11-13");
  assert.equal(d.cash, 95000);
  assert.equal(d.cardOwed, 15000);
  assert.equal(d.months[0].month, "2026-10");
  assert.equal(d.months[0].spent, 4000 + 1200 + 15000);
  assert.equal(d.pace.thisMonth.length, 24);
  assert.equal(d.pace.thisMonth.at(-1), d.spentThisMonth);
  assert.equal(d.pace.lastMonth.length, 30);
  assert.equal(d.transactions[0].m, "Bar Mystery");
  assert.equal(d.transactions.length, 6);
  assert.equal(d.periodStart, "2026-10-14");
  assert.equal(d.months[0].needs + d.months[0].wants, d.months[0].spent); // uncategorized counts as wants
  assert.equal(d.lastSync.status, "ok");
  assert.equal(d.consentDaysLeft, 177);
  assert.equal(d.balance.values.at(-1), 100000 - 15000); // booked balances, card debt negative
  assert.equal(d.balance.values.length, 1 + (Date.parse("2026-10-24") - Date.parse(d.balance.start)) / 86400000);
});

test("balance history is rebuilt backwards from today's balance", () => {
  const { env } = setup({});
  env.context.txs = [
    { date: "2026-10-20", amount: -5000 },
    { date: "2026-10-22", amount: 20000 },
    { date: "2026-10-22", amount: -1000 },
    { date: "2026-10-25", amount: -999 }, // after today: ignored
  ];
  env.context.balances = [{ type: "CARD", booked: -3000, available: 97000 }, { type: "", booked: 50000, available: 49000 }];
  const h = env.run("balanceHistory(txs, balances, '2026-10-23', '2026-10-20')");
  assert.deepEqual([h.start, [...h.values]], ["2026-10-20", [28000, 28000, 47000, 47000]]);
});

test("the saving suggestion leaves the usual day-to-day spending until payday", () => {
  const { env } = setup({});
  env.context.groups = new Map([["Groceries", "needs"], ["Housing", "needs"], ["Savings", "savings"]]);
  env.context.txs = [
    { date: "2026-09-27", amount: -2800, merchant: "K-Market", category: "Groceries" }, // 28 days back: counts
    { date: "2026-10-10", amount: -2800, merchant: "K-Market", category: "Groceries" },
    { date: "2026-09-26", amount: -9999, merchant: "K-Market", category: "Groceries" }, // too old
    { date: "2026-10-01", amount: -60000, merchant: "Landlord", category: "Housing" }, // a bill, not day-to-day
    { date: "2026-10-05", amount: -5000, merchant: "Gym", category: "Groceries" }, // recurring
    { date: "2026-10-15", amount: -10000, merchant: "Nordnet", category: "Savings" }, // this pay period
    { date: "2026-10-20", amount: 3000, merchant: "Nordnet", category: "Savings" }, // a withdrawal
    { date: "2026-10-10", amount: -7000, merchant: "Nordnet", category: "Savings" }, // previous period
  ];
  env.context.recurring = [{ merchant: "Gym" }];
  // 200 €/28 days ≈ 2 €/day; 20 days left × 1.2 = 48 € kept back.
  env.context.s = { today: "2026-10-24", safeToSpend: 50000, daysLeft: 20 };
  const plan = env.run("savingsPlan(txs, s, recurring, groups, '2026-07-27')");
  assert.equal(plan.typicalDaily, 200);
  assert.equal(plan.suggested, 45000); // 500 − 48 = 452 → 450 €
  assert.equal(plan.saved, 7000);
  assert.equal(plan.perDayAfter, 250); // (500 − 450) / 20
  env.context.s = { today: "2026-10-24", safeToSpend: 3000, daysLeft: 20 };
  assert.equal(env.run("savingsPlan(txs, s, recurring, groups, '2026-07-27')").suggested, 0);
});

test("the savings goal says whether the rest still fits before payday", () => {
  const { env } = setup({});
  env.context.groups = new Map([["Groceries", "needs"], ["Savings", "savings"]]);
  env.context.txs = [
    { date: "2026-10-10", amount: -56000, merchant: "K-Market", category: "Groceries" }, // 20 €/day over 28 days
    { date: "2026-10-15", amount: -20000, merchant: "Nordnet", category: "Savings" }, // 200 € this period
  ];
  env.context.recurring = [];
  const plan = (safeToSpend: number, goal = 100000) => {
    env.context.s = { today: "2026-10-24", safeToSpend, daysLeft: 20 };
    env.context.goal = goal;
    return env.run("savingsPlan(txs, s, recurring, groups, '2026-07-27', goal)");
  };
  // 800 € to go; the usual 20 €/day × 20 days is 400 €, +20 % = 480 €.
  assert.equal(plan(130000).goalStatus, "ok"); // 500 € left after the goal: 25 €/day
  assert.equal(plan(114000).goalStatus, "tight"); // 340 € left: 17 €/day ≥ 80 % of 20
  const out = plan(100000); // 200 € left: 10 €/day
  assert.equal(out.goalStatus, "out");
  assert.equal(out.remaining, 80000);
  assert.equal(out.perDayIfGoal, 1000);
  assert.equal(out.reachable, 80000); // 200 € saved + (1000 − 400) €
  assert.equal(out.periodEnd, "2026-11-12"); // the 14th is a Saturday, so payday is Friday the 13th
  assert.equal(plan(0, 20000).goalStatus, "done");
  assert.equal(plan(130000, 0).goalStatus, null);
});

test("the Settings sheet starts with a 1000 € savings goal and can be changed", () => {
  const { env, sheet } = setup({});
  assert.equal(env.run("savingsGoal_()"), 100000);
  env.run("sheet_(SHEETS.settings).getRange(2, 2, 1, 1).setValues([[750]])");
  assert.equal(env.run("savingsGoal_()"), 75000);
  env.run("sheet_(SHEETS.settings).getRange(2, 2, 1, 1).setValues([['']])");
  assert.equal(env.run("savingsGoal_()"), 0);
  assert.ok(sheet("Settings").length >= 1);
});

test("payday follows the Settings sheet; 31 means the last weekday of the month", () => {
  const { env } = setup({});
  const payday = (today: string) => env.run(`applySettings_(); nextPayday("${today}")`);
  env.run("setSetting_(SETTING_PAYDAY, 31)");
  assert.equal(payday("2026-10-24"), "2026-10-30"); // 31 Oct 2026 is a Saturday
  assert.equal(payday("2026-11-02"), "2026-11-30"); // November has 30 days
  assert.equal(payday("2027-02-10"), "2027-02-26"); // 28 Feb 2027 is a Sunday
  env.run("setSetting_(SETTING_PAYDAY, 25)");
  assert.equal(payday("2026-10-20"), "2026-10-23"); // 25 Oct 2026 is a Sunday
  env.run("setSetting_(SETTING_PAYDAY, '')");
  assert.equal(payday("2026-10-24"), "2026-11-13"); // blank falls back to the 14th
});

test("a setup code stores the credentials and the onboarding choices, then syncs", () => {
  const { env, sheet, calls } = setup(BANK);
  for (const k of ["EB_APP_ID", "EB_PRIVATE_KEY", "SESSION"]) env.props.delete(k);
  const session = JSON.parse(JSON.stringify({ session_id: "s2", access: { valid_until: "2027-04-20T00:00:00Z" }, accounts: [{ uid: "current", product: "Käyttötili", cash_account_type: "CACC", account_id: { iban: "FI00 3333" }, currency: "EUR" }] }));
  const code = Buffer.from(
    JSON.stringify({
      version: 1,
      appId: "app-456",
      key: PEM,
      bank: { name: "Nordea", country: "FI" },
      session,
      settings: { payday: 31, savingsGoal: 300 },
      categories: [["Pets", "needs", "🐾"]],
      merchants: [["bar mystery", "Bar Mystery", "Pets"]],
      rules: [["kissanruoka", "Pets"]],
    }),
  ).toString("base64");
  const result = env.run(`importSetupCode(${JSON.stringify(code)})`);

  assert.match(result, /^Done: 4 transactions synced, bank access valid until 2027-04-20/);
  assert.equal(env.props.get("EB_APP_ID"), "app-456");
  assert.deepEqual(JSON.parse(env.props.get("BANK")!), { name: "Nordea", country: "FI" });
  assert.equal(JSON.parse(env.props.get("SESSION")!).session_id, "s2");
  assert.ok(sheet("Categories").some((r) => r[0] === "Pets" && r[1] === "needs"));
  assert.equal(env.run("setting_(SETTING_PAYDAY)"), 31);
  assert.equal(env.run("savingsGoal_()"), 30000);
  assert.deepEqual(sheet("Rules"), [["kissanruoka", "Pets"]]);
  assert.ok(calls.some((c) => c.includes("/accounts/current/transactions")));
  assert.equal(new Map(sheet("Transactions").map((r) => [r[2], r[3]])).get("Bar Mystery"), undefined); // not on this account
  assert.equal(sheet("Merchants").find((r) => r[6] === "bar mystery")?.[1], "Pets"); // choice kept for later
  assert.throws(() => env.run(`importSetupCode("bm90IGpzb24=")`), /isn't a whole setup code/);
});

test("reconnecting uses the bank from the BANK property", () => {
  const { env } = setup({});
  const seen: string[] = [];
  env.context.UrlFetchApp.fetch = (url: string, opts: { method: string; payload?: string }) => {
    seen.push(url);
    const body = url.includes("/aspsps")
      ? { aspsps: [{ name: "S-Pankki", country: "FI" }, { name: "Nordea", country: "FI", maximum_consent_validity: 7776000 }] }
      : { url: "https://bank.example/login" };
    if (opts.payload) seen.push(opts.payload);
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
  };
  env.props.set("BANK", JSON.stringify({ name: "Nordea", country: "FI" }));
  assert.equal(env.run("ebStartConsent_('st')"), "https://bank.example/login");
  assert.equal(JSON.parse(seen[2]).aspsp.name, "Nordea");
  // 90-day maximum from the bank wins over 180 days.
  assert.ok(Date.parse(JSON.parse(seen[2]).access.valid_until) - Date.parse("2026-10-24T09:00:00Z") <= 90 * 86400000 + 1000);
});
