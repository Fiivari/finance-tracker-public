// Syncs all linked accounts into the local database (data/finance.db by default).
import { openDb } from "../src/db.ts";
import { getBalances, getTransactions } from "../src/enablebanking.ts";
import { loadSession, sync } from "../src/sync.ts";

const db = openDb();
try {
  const result = await sync(db, loadSession(db), { getBalances, getTransactions });
  console.log(
    `Synced ${result.accounts} account(s): ${result.inserted} new, ${result.updated} updated, ` +
      `${result.skipped} skipped, ${result.transfers} new transfer pair(s), ` +
      `${result.categorized} categorized, ${result.uncategorized} uncategorized, ` +
      `${result.recurring} recurring. Consent: ${result.consentDaysLeft} days left.`,
  );
  for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);
} catch (err) {
  console.error(`Sync failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  db.close();
}
