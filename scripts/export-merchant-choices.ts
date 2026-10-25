// One-off migration: writes my merchant category choices from data/finance.db as a CSV for the Merchants sheet.
// Import it into the Merchants tab (File → Import → Upload → Replace current sheet), then Finance → Sync now.
import { mkdirSync, writeFileSync } from "node:fs";
import { openDb } from "../src/db.ts";

const db = openDb();
const rows = db
  .prepare(
    `SELECT m.name, c.name AS category, m.key FROM merchants m JOIN categories c ON c.id = m.category_id
     WHERE m.category_source = 'user' ORDER BY m.name`,
  )
  .all() as { name: string; category: string; key: string }[];
db.close();

const csv = (value: string) => {
  // A leading = + - @ would make Sheets treat the cell as a formula on import.
  if (/^[=+\-@]/.test(value)) throw new Error("Refusing to export a value that Sheets would treat as a formula.");
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
};
const header = ["Merchant", "My category", "Applied", "Transactions", "Net", "Last seen", "Key"];
const lines = [header.join(","), ...rows.map((r) => [csv(r.name), csv(r.category), "", "", "", "", csv(r.key)].join(","))];

mkdirSync("data/export", { recursive: true });
writeFileSync("data/export/merchant-choices.csv", lines.join("\n") + "\n");
console.log(`Wrote ${rows.length} merchant choices to data/export/merchant-choices.csv`);
