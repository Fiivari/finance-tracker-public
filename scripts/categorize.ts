// Re-applies categorization to the local database and prints a summary.
// --list also prints uncategorized merchants and detected recurring payments (contains merchant names).
import { categorize } from "../src/categorize.ts";
import { openDb } from "../src/db.ts";
import { detectRecurring } from "../src/recurring.ts";
import { localDate } from "../src/sync.ts";

const euros = (cents: number) => (cents / 100).toFixed(2).padStart(10);
const db = openDb();
try {
  const result = categorize(db);
  const recurring = detectRecurring(db, localDate(new Date()));
  console.log(`${result.categorized} categorized, ${result.uncategorized} uncategorized, ${recurring} recurring.\n`);

  const byCategory = db
    .prepare(
      `SELECT coalesce(c.name, '(uncategorized)') AS name, count(*) AS n, sum(t.amount) AS total
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       GROUP BY 1 ORDER BY total`,
    )
    .all() as { name: string; n: number; total: number }[];
  for (const r of byCategory) console.log(`${r.name.padEnd(16)} ${String(r.n).padStart(4)} tx ${euros(r.total)} €`);

  if (process.argv.includes("--list")) {
    console.log("\nUncategorized merchants:");
    const unknown = db
      .prepare(
        `SELECT coalesce(m.name, '(no counterparty)') AS name, t.type, count(*) AS n, sum(t.amount) AS total
         FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id
         WHERE t.category_id IS NULL GROUP BY 1, 2 ORDER BY n DESC`,
      )
      .all() as { name: string; type: string; n: number; total: number }[];
    for (const r of unknown) console.log(`  ${r.name.padEnd(32)} ${r.type.padEnd(12)} ${String(r.n).padStart(3)} ${euros(r.total)} €`);

    console.log("\nRecurring:");
    const rows = db
      .prepare(
        `SELECT m.name, r.kind, r.amount, r.interval_days, r.next_expected_date
         FROM recurring r JOIN merchants m ON m.id = r.merchant_id ORDER BY r.kind, r.amount`,
      )
      .all() as { name: string; kind: string; amount: number; interval_days: number; next_expected_date: string }[];
    for (const r of rows) {
      console.log(`  ${r.kind.padEnd(12)} ${r.name.padEnd(32)} ${euros(r.amount)} € every ${r.interval_days}d, next ${r.next_expected_date}`);
    }
  }
} finally {
  db.close();
}
