// Onboarding for a new user, run step by step by Claude Code (see ONBOARDING.md). Every step is non-interactive
// and safe to re-run. Personal data stays on this computer in secrets/ and data/onboarding/ (both git-ignored).
//
//   npm run onboard -- register --email you@example.com [--link "<sign-in link from the email>"] [--sandbox]
//   npm run onboard -- banks [--country FI]
//   npm run onboard -- link --bank "Nordea" [--country FI]      then: link --url "<address the bank redirected to>"
//   npm run onboard -- fetch
//   npm run onboard -- review [--all]
//   npm run onboard -- google
//   npm run onboard -- code
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { loadLogic } from "../src/logic.ts";

const CONTROL_PANEL = "https://enablebanking.com";
const KEY_PATH = "secrets/enablebanking.pem";
const SESSION_PATH = "secrets/session.json";
const DIR = "data/onboarding";
const BANK_DATA = `${DIR}/bank.json`;
const CHOICES = `${DIR}/choices.json`;
const LINK_STATE = `${DIR}/link-state.json`;
// Same redirect as the Sheet's reconnect flow: the page doesn't load, the address is copied back.
const REDIRECT_URL = "https://localhost:8443/callback";
const PAGES = "https://fiivari.github.io/finance-tracker-public";
const CLASP = "@google/clasp@3.4.1";
const CALLBACK_PORT = 8888;
const SIGN_IN_TIMEOUT_MIN = 15;
const HISTORY_DAYS = 89;

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: "string" },
    link: { type: "string" },
    sandbox: { type: "boolean" },
    country: { type: "string", default: "FI" },
    bank: { type: "string" },
    url: { type: "string" },
    all: { type: "boolean" },
  },
});

if (existsSync(".env")) process.loadEnvFile(".env");

const commands: Record<string, () => Promise<void>> = { register, banks, link, fetch: fetchData, review, google, code };
const command = commands[positionals[0]];
if (!command) fail(`Unknown step "${positionals[0] ?? ""}". Steps: ${Object.keys(commands).join(", ")}.`);
await command();

// --- 1. Enable Banking app ---

// Creates the app's key pair here, signs in to the Enable Banking control panel with an email link and registers
// the app with the public key (the same API the official enablebanking-cli uses). The private key never leaves
// this computer except inside the setup code pasted into the user's own Sheet.
async function register() {
  const email = args.email || fail("Give --email (the address for the Enable Banking account).");
  if (process.env.EB_APP_ID) fail(`Already registered: EB_APP_ID is in .env. Next: activate the app at ${CONTROL_PANEL}/cp/applications.`);
  mkdirSync("secrets", { recursive: true });
  if (!existsSync(KEY_PATH)) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(KEY_PATH, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const publicKey = createPublicKey(readFileSync(KEY_PATH)).export({ type: "spki", format: "pem" }).toString();

  let oobCode: string;
  if (args.link) {
    oobCode = oobCodeFrom(args.link) || fail("No sign-in code in that link. Copy the whole link from the email.");
  } else {
    await post(`${CONTROL_PANEL}/api/relyingparty/getOobConfirmationCode`, {
      requestType: "EMAIL_SIGNIN",
      email,
      continueUrl: `http://localhost:${CALLBACK_PORT}/`,
      canHandleCodeInApp: true,
    });
    console.log(`Sent a sign-in email from Enable Banking to ${email}. Open the link in it on THIS computer.`);
    console.log(`(Opened it on a phone? Copy the link and run this step again with --link "<link>".)`);
    oobCode = await waitForSignIn();
  }
  const { idToken } = await post(`${CONTROL_PANEL}/api/relyingparty/emailLinkSignin`, { oobCode, email });
  const app = await post(
    `${CONTROL_PANEL}/api/applications`,
    {
      name: "Oma talous",
      certificate: publicKey,
      environment: args.sandbox ? "SANDBOX" : "PRODUCTION",
      redirect_urls: [REDIRECT_URL],
      description: "Personal finance tracker for my own accounts only. Read-only account information.",
      gdpr_email: email,
      privacy_url: `${PAGES}/privacy.html`,
      terms_url: `${PAGES}/terms.html`,
    },
    idToken,
  );
  setEnv({ EB_APP_ID: app.app_id, EB_KEY_PATH: KEY_PATH, EB_REDIRECT_URL: REDIRECT_URL });
  console.log(`Registered the Enable Banking app ${app.app_id} (${args.sandbox ? "sandbox" : "production"}); saved to .env.`);
  if (!args.sandbox) {
    console.log(`Next: open ${CONTROL_PANEL}/cp/applications, click "Activate by linking accounts" on "Oma talous" and approve in the bank.`);
  }
}

// The email link ends up at http://localhost:8888/?...&oobCode=... once the user opens it.
function waitForSignIn(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const code = oobCodeFrom(req.url || "");
      res.writeHead(code ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(code ? "<h1>Kirjautuminen onnistui. Voit sulkea tämän ikkunan.</h1>" : "<h1>Linkistä puuttuu koodi.</h1>");
      if (!code) return;
      clearTimeout(timer);
      server.close();
      resolve(code);
    }).listen(CALLBACK_PORT, "localhost");
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`No sign-in within ${SIGN_IN_TIMEOUT_MIN} minutes. Run the step again.`));
    }, SIGN_IN_TIMEOUT_MIN * 60000);
  });
}

// The code may sit inside a redirect or tracking link, URL-encoded once or twice.
function oobCodeFrom(link: string): string | undefined {
  let text = link;
  for (let i = 0; i < 3; i++) {
    const m = /oobCode(?:=|%3D)([\w-]+)/i.exec(text);
    if (m) return m[1];
    text = decodeURIComponent(text);
  }
  return undefined;
}

// --- 2. Bank link ---

async function banks() {
  const { api } = await import("../src/enablebanking.ts");
  const { aspsps } = await api<{ aspsps: { name: string }[] }>("GET", `/aspsps?country=${args.country}&psu_type=personal`);
  console.log(aspsps.map((a) => a.name).join("\n"));
}

// Without --url: starts a consent and prints the bank's login address. With --url: finishes it.
async function link() {
  mkdirSync(DIR, { recursive: true });
  if (!args.url) {
    const bank = args.bank || fail('Give --bank "<name>" as listed by the banks step.');
    setEnv({ EB_BANK_NAME: bank, EB_BANK_COUNTRY: args.country! });
    const { startConsent } = await import("../src/bank.ts");
    const state = randomUUID();
    const url = await startConsent(state);
    writeFileSync(LINK_STATE, JSON.stringify({ state }));
    console.log(`Open this address, log in and approve read-only access (valid up to 180 days):\n\n${url}\n`);
    console.log("The bank then sends you to a page that doesn't load. That's expected: copy that page's full address.");
    return;
  }
  const redirected = new URL(args.url);
  const pending = existsSync(LINK_STATE) ? JSON.parse(readFileSync(LINK_STATE, "utf8")) : {};
  if (redirected.searchParams.get("state") !== pending.state) fail("This address belongs to an older login. Start the link step again.");
  const consentCode = redirected.searchParams.get("code") || fail(`The bank didn't grant access: ${redirected.searchParams.get("error") ?? "no code"}.`);
  const { finishConsent } = await import("../src/bank.ts");
  const session = await finishConsent(consentCode);
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2), { mode: 0o600 });
  console.log(`Linked ${session.accounts.length} account(s), access valid until ${session.access.valid_until.slice(0, 10)}.`);
}

// --- 3. Fetch and review ---

// Last 89 days of booked transactions and today's balances, converted with the Sheet's own code. Also records
// which fields this bank fills in, so the review can point out bank-specific gaps.
async function fetchData() {
  const { getBalances, getTransactions } = await import("../src/enablebanking.ts");
  const logic = loadLogic();
  const session = loadSession();
  const today = new Date().toISOString().slice(0, 10);
  const from = logic.addDays(today, -HISTORY_DAYS);
  const accounts = [];
  const transactions = [];
  for (const a of session.accounts) {
    const key = createHash("sha256").update(a.account_id?.iban || a.uid).digest("hex").slice(0, 12);
    const label = a.product || a.name || "Account";
    const raw = await getTransactions(a.uid, from);
    const balances = await getBalances(a.uid);
    const rows = raw.map((t) => logic.fromBank(key, label, t)).filter(Boolean);
    transactions.push(...rows);
    const share = (f: (t: any) => unknown) => raw.filter(f).length;
    accounts.push({
      key,
      label,
      type: a.cash_account_type || "",
      balances: balances.map((b) => ({ type: b.balance_type, amount: b.balance_amount.amount })),
      coverage: {
        total: raw.length,
        booked: share((t) => t.status === "BOOK"),
        pending: share((t) => t.status === "PDNG"),
        entryReference: share((t) => t.entry_reference),
        counterparty: share((t) => (t.credit_debit_indicator === "DBIT" ? t.creditor?.name : t.debtor?.name)),
        description: share((t) => t.remittance_information?.length),
        bankCode: share((t) => t.bank_transaction_code?.code),
        bookingDate: share((t) => t.booking_date),
      },
    });
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(BANK_DATA, JSON.stringify({ fetchedAt: today, from, accounts, transactions }));
  console.log(`Fetched ${transactions.length} booked transactions from ${accounts.length} account(s) since ${from}. Next: review.`);
}

interface Choices {
  payday: number | null;
  savingsGoal: number | null; // euros per pay period
  categories: [string, string, string][]; // extra categories: [name, group, icon]
  merchants: Record<string, string>; // merchant key → category
  rules: [string, string][]; // [text pattern, category]
}

function loadChoices(): Choices {
  const empty: Choices = { payday: null, savingsGoal: null, categories: [], merchants: {}, rules: [] };
  if (!existsSync(CHOICES)) writeFileSync(CHOICES, JSON.stringify(empty, null, 2) + "\n");
  return { ...empty, ...JSON.parse(readFileSync(CHOICES, "utf8")) };
}

// Runs the Sheet's categorization over the fetched data with the choices so far and prints what Claude needs
// for the interview: data quality for this bank, spending per category, merchants still uncategorized, payday.
async function review() {
  const logic = loadLogic();
  const data = JSON.parse(readFileSync(BANK_DATA, "utf8"));
  const choices = loadChoices();
  const categories: string[][] = [...logic.DEFAULT_CATEGORIES, ...choices.categories];
  const groups = new Map(categories.map((c) => [c[0], c[1]]));
  const unknown = [...Object.values(choices.merchants), ...choices.rules.map((r) => r[1])].filter((c) => !groups.has(c));
  if (unknown.length) console.log(`!! Unknown categories in choices.json: ${[...new Set(unknown)].join(", ")}\n`);

  const txs = data.transactions;
  logic.setPaydayDay(choices.payday ?? 14);
  logic.markTransfers(txs);
  logic.categorizeAll(txs, new Map(Object.entries(choices.merchants)), choices.rules.map(([pattern, category]) => ({ pattern, category })));
  const recurring = logic.detectRecurring(txs, data.fetchedAt);
  const months = Math.max(1, logic.daysBetween(data.from, data.fetchedAt) / 30.4);

  section("Accounts");
  for (const a of data.accounts) {
    const c = a.coverage;
    const pct = (n: number) => `${c.total ? Math.round((n / c.total) * 100) : 0}%`;
    console.log(`${a.label} [${a.type || "no type"}] ${c.total} tx (${c.pending} pending, skipped) · balances: ${a.balances.map((b: any) => `${b.type} ${b.amount}`).join(", ") || "none"}`);
    console.log(`  fields: entry_reference ${pct(c.entryReference)}, counterparty ${pct(c.counterparty)}, message ${pct(c.description)}, bank code ${pct(c.bankCode)}, booking_date ${pct(c.bookingDate)}`);
  }

  section("Bank data check");
  const notes = [];
  for (const a of data.accounts) {
    const c = a.coverage;
    if (c.booked && c.entryReference < c.booked) notes.push(`${a.label}: ${c.booked - c.entryReference} booked transactions have no entry_reference and are dropped (the Sheet deduplicates on it).`);
    if (c.total && c.counterparty / c.total < 0.6) notes.push(`${a.label}: few counterparty names; merchants will often be missing, so rules on the message text matter more.`);
    if (c.total && c.bankCode / c.total < 0.5) notes.push(`${a.label}: few bank transaction codes; card purchases can't be told from transfers (types fall back to "other").`);
    if (!a.balances.some((b: any) => ["ITBD", "CLBD", "XPCD", "OPBD"].includes(b.type))) notes.push(`${a.label}: no booked balance type the Sheet knows (${a.balances.map((b: any) => b.type).join(", ")}); add it to pickBalances() in gas/Logic.js.`);
  }
  if (!data.accounts.some((a: any) => a.type === "CARD")) notes.push("No CARD account. If they have a credit card, check whether it was linked (some banks list cards as a separate bank in Enable Banking). Without it, card debt isn't subtracted from safe-to-spend.");
  const codes = new Map<string, { n: number; type: string }>();
  for (const t of txs) {
    const k = `${t.code || "-"}/${t.subCode || "-"} ${t.amount < 0 ? "out" : "in"}`;
    codes.set(k, { n: (codes.get(k)?.n ?? 0) + 1, type: t.type });
  }
  console.log(notes.length ? notes.map((n) => `- ${n}`).join("\n") : "- No problems found.");
  console.log(`- Paired as own transfers: ${txs.filter((t: any) => t.transfer).length} transactions.`);
  console.log(`- Bank codes → type: ${[...codes].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k} ×${v.n} → ${v.type}`).join("; ")}`);

  section(`Per category (${data.from} – ${data.fetchedAt}, transfers left out)`);
  const byCategory = new Map<string, { total: number; n: number }>();
  for (const t of txs) {
    if (t.transfer) continue;
    const c = byCategory.get(t.category || "(uncategorized)") ?? { total: 0, n: 0 };
    c.total += t.amount;
    c.n++;
    byCategory.set(t.category || "(uncategorized)", c);
  }
  for (const [name, c] of [...byCategory].sort((a, b) => a[1].total - b[1].total)) {
    console.log(`${name.padEnd(20)} ${eur(c.total).padStart(11)}  ${String(c.n).padStart(4)} tx  [${groups.get(name) ?? "-"}]`);
  }

  const merchants = new Map<string, { name: string; total: number; n: number; category: string; source: string; sample: string }>();
  for (const t of txs) {
    if (!t.merchantKey || t.transfer) continue;
    const m = merchants.get(t.merchantKey) ?? { name: t.merchant, total: 0, n: 0, category: t.category, source: t.source, sample: t.description };
    m.total += t.amount;
    m.n++;
    merchants.set(t.merchantKey, m);
  }
  const listed = [...merchants].filter(([, m]) => args.all || !m.category).sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total));
  section(args.all ? "All merchants (key | name | tx | net | category (source) | message)" : "Uncategorized merchants, biggest first (key | name | tx | net | message)");
  for (const [key, m] of listed) {
    const cat = args.all ? ` | ${m.category || "-"} (${m.source || "-"})` : "";
    console.log(`${key} | ${m.name} | ${m.n} | ${eur(m.total)}${cat}${m.sample ? ` | ${m.sample.slice(0, 50)}` : ""}`);
  }
  if (!listed.length) console.log("None.");
  const noName = txs.filter((t: any) => !t.merchantKey && !t.transfer && !t.category);
  if (noName.length) {
    console.log(`\nUncategorized without a counterparty (${noName.length}; use rules on the message text):`);
    for (const t of noName.slice(0, 15)) console.log(`  ${t.date} ${eur(t.amount)} ${t.type} | ${t.description.slice(0, 60) || "(no message)"}`);
  }

  section("Payday and saving");
  const income = txs.filter((t: any) => !t.transfer && t.amount >= 20000 && groups.get(t.category) === "income").sort((a: any, b: any) => b.amount - a.amount);
  for (const t of income.slice(0, 8)) console.log(`income ${t.date} ${eur(t.amount)} ${t.merchant || t.description.slice(0, 40)}`);
  for (const r of recurring.filter((r: any) => r.kind === "income")) console.log(`recurring income: ${r.merchant} ${eur(r.amount)} every ${r.intervalDays} d, last ${r.lastDate}`);
  const spending = -txs.filter((t: any) => !t.transfer && (!t.category || ["needs", "wants"].includes(groups.get(t.category)!))).reduce((s: number, t: any) => s + t.amount, 0);
  const incomeTotal = txs.filter((t: any) => !t.transfer && groups.get(t.category) === "income").reduce((s: number, t: any) => s + t.amount, 0);
  const saved = -txs.filter((t: any) => !t.transfer && groups.get(t.category) === "savings").reduce((s: number, t: any) => s + t.amount, 0);
  console.log(`per month on average: income ${eur(incomeTotal / months)}, spending ${eur(spending / months)}, to savings ${eur(saved / months)}`);
  console.log(`choices so far: payday ${choices.payday ?? "not set (14)"}, savings goal ${choices.savingsGoal ?? "not set"} €, ${Object.keys(choices.merchants).length} merchant choices, ${choices.rules.length} rules, extra categories: ${choices.categories.map((c) => c[0]).join(", ") || "none"}`);
}

// --- 4. Google Sheet ---

// Creates the user's Sheet with this Apps Script project bound to it and uploads the code. `clasp create`
// replaces gas/appsscript.json, so ours (scopes, time zone, URL allow-list, web app) is put back before the push.
async function google() {
  if (existsSync(".clasp.json")) fail("A Sheet already exists for this folder (.clasp.json). To upload code changes: npm run gas:push.");
  const manifest = readFileSync("gas/appsscript.json", "utf8");
  clasp("create-script", "--type", "sheets", "--title", "Finance", "--rootDir", "gas");
  writeFileSync("gas/appsscript.json", manifest);
  clasp("push", "--force");
  const project = JSON.parse(readFileSync(".clasp.json", "utf8"));
  const out = spawnSync("npx", ["-y", CLASP, "list-deployments"], { shell: true, encoding: "utf8" });
  const head = /(AKfy[\w-]+)\s+@HEAD/.exec(out.stdout || "");
  console.log(`\nSheet: https://docs.google.com/spreadsheets/d/${project.parentId}/edit`);
  console.log(head ? `Dashboard: https://script.google.com/macros/s/${head[1]}/dev` : "Dashboard: run `npx -y @google/clasp@3.4.1 list-deployments` and use the @HEAD id.");
}

function clasp(...cmd: string[]) {
  const result = spawnSync("npx", ["-y", CLASP, ...cmd], { shell: true, stdio: "inherit" });
  if (result.status !== 0) fail(`clasp ${cmd[0]} failed (see above).`);
}

// --- 5. Setup code ---

// Everything the Sheet needs, as one base64 text on the clipboard: Finance → Set up from setup code → paste.
// Holds the private key, so it's never printed; the clipboard is the only copy.
async function code() {
  const appId = process.env.EB_APP_ID || fail("No EB_APP_ID in .env: run the register step first.");
  const session = loadSession();
  const choices = loadChoices();
  const data = existsSync(BANK_DATA) ? JSON.parse(readFileSync(BANK_DATA, "utf8")) : { transactions: [] };
  const logic = loadLogic();
  logic.categorizeAll(data.transactions, new Map(), []);
  const names = new Map(data.transactions.map((t: any) => [t.merchantKey, t.merchant]));
  const setup = {
    version: 1,
    appId,
    key: readFileSync(process.env.EB_KEY_PATH || KEY_PATH, "utf8"),
    bank: { name: process.env.EB_BANK_NAME, country: process.env.EB_BANK_COUNTRY || "FI" },
    session,
    settings: { payday: choices.payday, savingsGoal: choices.savingsGoal },
    categories: choices.categories,
    merchants: Object.entries(choices.merchants).map(([key, category]) => [key, names.get(key) || key, category]),
    rules: choices.rules,
  };
  if (!setup.bank.name) fail("No EB_BANK_NAME in .env: run the link step first.");
  const text = Buffer.from(JSON.stringify(setup)).toString("base64");
  const [cmd, ...cmdArgs] = process.platform === "win32" ? ["clip"] : process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"];
  const copied = spawnSync(cmd, cmdArgs, { input: text });
  if (copied.status !== 0) fail(`Couldn't copy to the clipboard (${cmd}). Install xclip, or ask Claude for another way.`);
  console.log(`Setup code copied to the clipboard (${text.length} characters). In the Sheet: Finance → Set up from setup code → paste.`);
}

// --- Helpers ---

function loadSession() {
  if (!existsSync(SESSION_PATH)) fail("No bank session: run the link step first.");
  const session = JSON.parse(readFileSync(SESSION_PATH, "utf8"));
  if (Date.parse(session.access.valid_until) < Date.now()) fail("The bank session has expired: run the link step again.");
  return session;
}

async function post(url: string, body: object, token?: string): Promise<any> {
  const res = await globalThis.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`${new URL(url).pathname} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// Sets keys in .env, keeping the other lines.
function setEnv(values: Record<string, string>) {
  const lines = existsSync(".env") ? readFileSync(".env", "utf8").split(/\r?\n/).filter(Boolean) : [];
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
    process.env[k] = v;
  }
  writeFileSync(".env", lines.join("\n") + "\n");
}

function section(title: string) {
  console.log(`\n== ${title} ==`);
}

function eur(cents: number) {
  return `${(cents / 100).toFixed(2)} €`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
