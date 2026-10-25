import assert from "node:assert/strict";
import { test } from "node:test";
import { addRule, categorize, categoryIds, normalizeMerchant, setCategory, setMerchantCategory, txType } from "../src/categorize.ts";
import { openDb, type Db } from "../src/db.ts";
import { detectRecurring, findPattern } from "../src/recurring.ts";

function seed(db: Db, rows: [ref: string, date: string, cents: number, counterparty: string | null, code: string, sub: string, description?: string][]) {
  db.prepare("INSERT INTO accounts (uid, iban, currency, type) VALUES ('u1', 'FI01', 'EUR', 'CACC')").run();
  const insert = db.prepare(
    `INSERT INTO transactions (account_id, entry_reference, booking_date, amount, currency, counterparty, description, bank_code, sub_code, raw)
     VALUES (1, ?, ?, ?, 'EUR', ?, ?, ?, ?, '{}')`,
  );
  for (const [ref, date, cents, cp, code, sub, desc] of rows) insert.run(ref, date, cents, cp, desc ?? null, code, sub);
}

type CategoryRow = { category: string | null; source: string | null; type: string; merchant: string | null };

function categoryOf(db: Db, ref: string): CategoryRow {
  const row = db
    .prepare(
      `SELECT c.name AS category, t.category_source AS source, t.type, m.name AS merchant FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN merchants m ON m.id = t.merchant_id
       WHERE entry_reference = ?`,
    )
    .get(ref);
  return { ...row } as CategoryRow;
}

test("txType maps S-Pankki bank codes", () => {
  assert.equal(txType("CCRD", "POSD", -100), "card");
  assert.equal(txType("CCRD", "POSC", 100), "card_refund");
  assert.equal(txType("CCRD", "OTHR", 100), "card_bill");
  assert.equal(txType("RCDT", "ESCT", 100), "transfer_in");
  assert.equal(txType("IRCT", "ESCT", -100), "transfer_out");
  assert.equal(txType("OTHR", "OTHR", 100), "other");
});

test("normalizeMerchant groups chain stores and strips codes", () => {
  assert.deepEqual(normalizeMerchant("K-market Keskusta"), { key: "k-market", name: "K-Market" });
  assert.deepEqual(normalizeMerchant("K-MARKET ASEMA 123"), { key: "k-market", name: "K-Market" });
  assert.deepEqual(normalizeMerchant("WOLT.COM1234567890"), { key: "wolt", name: "Wolt" });
  assert.deepEqual(normalizeMerchant("SUMUP  *KAHVILA ESIMERKKI 4521"), { key: "kahvila esimerkki", name: "Kahvila Esimerkki" });
  assert.deepEqual(normalizeMerchant("ACME OY / 3"), { key: "acme oy", name: "Acme Oy" });
  assert.deepEqual(normalizeMerchant("Testipuoti"), { key: "testipuoti", name: "Testipuoti" });
  // Processor prefixes, glued city names, HTML entities, web shops without punctuation
  assert.deepEqual(normalizeMerchant("VFI*BAARI ESIMERKKI"), { key: "baari esimerkki", name: "Baari Esimerkki" });
  assert.deepEqual(normalizeMerchant("VFI*A-HUOLTO ESIMERKKI OY"), { key: "a huolto esimerkki oy", name: "A-Huolto Esimerkki Oy" });
  assert.deepEqual(normalizeMerchant("ZETTLE_*ESIMERKKI TRANSPORT AB"), { key: "esimerkki transport ab", name: "Esimerkki Transport Ab" });
  assert.deepEqual(normalizeMerchant("LIDLTURKUKESKUSTA"), { key: "lidl", name: "Lidl" });
  assert.deepEqual(normalizeMerchant("MCDTAMPEREASEMA"), { key: "mcdonald's", name: "McDonald's" });
  assert.deepEqual(normalizeMerchant("Esimerkki Bar &amp;"), { key: "esimerkki bar &", name: "Esimerkki Bar &" });
  assert.deepEqual(normalizeMerchant("Paytrail Oyj httpswwwtikettifi"), { key: "tiketti.fi", name: "tiketti.fi" });
  assert.deepEqual(normalizeMerchant("MOB.PAY*HELSINGIN SEUDUN"), { key: "hsl", name: "HSL" });
  assert.deepEqual(normalizeMerchant("MOB.PAY*MATTI ESIMERKKI"), { key: "mobilepay matti esimerkki", name: "MobilePay Matti Esimerkki" });
});

test("built-in rules can be limited to transaction types", () => {
  const db = openDb(":memory:");
  seed(db, [
    ["bonus", "2026-10-01", 1439, "HOK-ELANTO", "OTHR", "OTHR"],
    ["shop", "2026-10-02", -2000, "HOK-ELANTO", "CCRD", "POSD"],
  ]);
  categorize(db);
  assert.equal(categoryOf(db, "bonus").category, "Income");
  assert.equal(categoryOf(db, "shop").category, null);
});

test("MobilePay to a person defaults to Other, to a business follows the rules", () => {
  const db = openDb(":memory:");
  seed(db, [
    ["p", "2026-10-01", -2500, "MOB.PAY*MATTI ESIMERKKI", "CCRD", "POSD"],
    ["b", "2026-10-02", -320, "MOB.PAY*HELSINGIN SEUDUN", "CCRD", "POSD"],
  ]);
  categorize(db);
  assert.deepEqual([categoryOf(db, "p").category, categoryOf(db, "p").source], ["Other", "type"]);
  assert.equal(categoryOf(db, "b").category, "Transport");
});

test("categorize applies built-in rules, type fallbacks and user overrides", () => {
  const db = openDb(":memory:");
  seed(db, [
    ["a", "2026-10-01", -1234, "K-market Keskusta", "CCRD", "POSD"],
    ["b", "2026-10-02", -900, "Unknown Shop 55", "CCRD", "POSD"],
    ["c", "2026-10-03", 250000, "Employer Oy", "RCDT", "ESCT"],
    ["d", "2026-10-04", -80000, "Landlord Oy", "ICDT", "ESCT", "Vuokra lokakuu"],
    ["e", "2026-10-05", -1500, "Unknown Shop 77", "CCRD", "POSD"],
  ]);
  assert.deepEqual(categorize(db), { categorized: 3, uncategorized: 2 });
  assert.deepEqual(categoryOf(db, "a"), { category: "Groceries", source: "rule", type: "card", merchant: "K-Market" });
  assert.equal(categoryOf(db, "c").category, "Income");
  assert.equal(categoryOf(db, "d").category, "Housing");
  assert.equal(categoryOf(db, "b").merchant, "Unknown Shop");
  assert.equal(categoryOf(db, "e").merchant, "Unknown Shop");

  // One transaction recategorized, then "apply to all from this merchant".
  const ids = categoryIds(db);
  const idOf = (ref: string) => (db.prepare("SELECT id FROM transactions WHERE entry_reference = ?").get(ref) as { id: number }).id;
  setCategory(db, idOf("a"), ids.get("Bars & eating out")!);
  setCategory(db, idOf("b"), ids.get("Shopping")!, true);
  categorize(db);
  assert.deepEqual([categoryOf(db, "a").category, categoryOf(db, "a").source], ["Bars & eating out", "user"]);
  assert.deepEqual([categoryOf(db, "e").category, categoryOf(db, "e").source], ["Shopping", "merchant"]);

  // A merchant category never overrides a transaction I categorized by hand.
  const kMarket = (db.prepare("SELECT id FROM merchants WHERE key = 'k-market'").get() as { id: number }).id;
  setMerchantCategory(db, kMarket, ids.get("Shopping")!);
  assert.deepEqual([categoryOf(db, "a").category, categoryOf(db, "a").source], ["Bars & eating out", "user"]);

  addRule(db, "Employer", ids.get("Savings")!);
  assert.equal(categoryOf(db, "c").category, "Savings");
});

test("findPattern detects monthly bills and rejects irregular spending", () => {
  const monthly = [
    { date: "2026-07-15", amount: -1299 },
    { date: "2026-08-15", amount: -1299 },
    { date: "2026-09-14", amount: -1299 },
    { date: "2026-10-15", amount: -1299 },
  ];
  assert.deepEqual(findPattern(monthly, "2026-10-24"), {
    intervalDays: 31,
    amount: -1299,
    occurrences: 4,
    lastDate: "2026-10-15",
    nextExpectedDate: "2026-11-15",
  });
  assert.equal(findPattern(monthly, "2027-01-10"), undefined, "stopped subscriptions are dropped");
  const varying = monthly.map((o, i) => ({ ...o, amount: [-1000, -4000, -1200, -2500][i] }));
  assert.equal(findPattern(varying, "2026-10-24"), undefined);
  const irregular = [
    { date: "2026-09-01", amount: -500 },
    { date: "2026-09-04", amount: -500 },
    { date: "2026-09-20", amount: -500 },
  ];
  assert.equal(findPattern(irregular, "2026-10-24"), undefined);
});

test("detectRecurring stores salary and subscriptions", () => {
  const db = openDb(":memory:");
  seed(db, [
    ["s1", "2026-08-15", 250000, "Employer Oy", "RCDT", "ESCT"],
    ["s2", "2026-09-15", 251000, "Employer Oy", "RCDT", "ESCT"],
    ["s3", "2026-10-15", 250000, "Employer Oy", "RCDT", "ESCT"],
    ["n1", "2026-08-03", -1299, "NETFLIX.COM", "CCRD", "XBCP"],
    ["n2", "2026-09-03", -1299, "NETFLIX.COM", "CCRD", "XBCP"],
    ["n3", "2026-10-03", -1299, "NETFLIX.COM", "CCRD", "XBCP"],
  ]);
  categorize(db);
  assert.equal(detectRecurring(db, "2026-10-24"), 2);
  const rows = db.prepare("SELECT kind, amount, next_expected_date AS next FROM recurring ORDER BY kind").all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { kind: "income", amount: 250000, next: "2026-11-15" },
      { kind: "subscription", amount: -1299, next: "2026-11-03" },
    ],
  );
});
