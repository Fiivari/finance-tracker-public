// Starts a bank consent session: prints the bank login URL, then exchanges the returned code for a session.
// The app's "Reconnect bank" button does the same without copy-pasting; this is the fallback.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { finishConsent, startConsent } from "../src/bank.ts";
import { openDb } from "../src/db.ts";
import { saveSession } from "../src/sync.ts";

const state = randomUUID();
const url = await startConsent(state);

console.log("\n1. Open this URL and approve access in your bank app:\n");
console.log(`   ${url}\n`);
console.log("2. You'll land on a page that may fail to load (that's expected).");
console.log("   Copy the FULL address from the browser's address bar and paste it below.\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const redirected = new URL((await rl.question("Redirected URL: ")).trim());
rl.close();

if (redirected.searchParams.get("state") !== state) {
  console.error("State mismatch: this URL doesn't belong to the login just started. Run `npm run link` again.");
  process.exit(1);
}
const code = redirected.searchParams.get("code");
if (!code) {
  console.error(`No code in URL. Bank returned: ${redirected.searchParams.get("error") ?? "unknown error"}`);
  process.exit(1);
}

const session = await finishConsent(code);

mkdirSync("secrets", { recursive: true });
writeFileSync("secrets/session.json", JSON.stringify(session, null, 2), { mode: 0o600 });
const db = openDb();
saveSession(db, session);
db.close();

console.log(`\nLinked ${session.accounts.length} account(s). Access valid until ${session.access.valid_until}.`);
console.log("Session saved to the database and secrets/session.json. Next: npm run sync");
