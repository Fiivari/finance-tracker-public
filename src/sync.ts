// Pulls balances and transactions for every linked account into the database.
import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { transaction } from "./db.ts";
import type { Balance, Session, SessionAccount, Transaction } from "./enablebanking.ts";
import { categorize } from "./categorize.ts";
import { detectRecurring } from "./recurring.ts";
import { detectTransfers } from "./transfers.ts";

// S-Pankki rejects date_from older than 90 days (422 "Wrong transactions period requested").
export const HISTORY_DAYS = 89;
// Re-fetch this many days before the newest stored booking, to catch late-booked card purchases.
const OVERLAP_DAYS = 10;
export const CONSENT_WARN_DAYS = 14;

export interface BankClient {
  getBalances(accountUid: string): Promise<Balance[]>;
  getTransactions(accountUid: string, dateFrom: string): Promise<Transaction[]>;
}

export interface SyncResult {
  accounts: number;
  inserted: number;
  updated: number;
  skipped: number;
  transfers: number;
  categorized: number;
  uncategorized: number;
  recurring: number;
  consentDaysLeft: number;
  warnings: string[];
}

// The active session lives in the database (written by the in-app reconnect flow or `npm run link`).
// secrets/session.json is the fallback for a database that predates that, and is imported on first use.
export function loadSession(db: Db, path = process.env.SESSION_PATH ?? "secrets/session.json"): Session {
  const row = db
    .prepare("SELECT data FROM bank_sessions WHERE status = 'active' AND data IS NOT NULL ORDER BY created_at DESC LIMIT 1")
    .get() as { data: string } | undefined;
  if (row) return JSON.parse(row.data);
  let session: Session;
  try {
    session = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("No bank session. Reconnect the bank in the app or run `npm run link`.");
  }
  saveSession(db, session);
  return session;
}

// Stores a session as the active one; earlier sessions are marked replaced.
export function saveSession(db: Db, session: Session): void {
  transaction(db, () => {
    db.prepare("UPDATE bank_sessions SET status = 'replaced' WHERE session_id <> ? AND status = 'active'").run(
      session.session_id,
    );
    db.prepare(
      `INSERT INTO bank_sessions (session_id, valid_until, data) VALUES (?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET valid_until = excluded.valid_until, data = excluded.data, status = 'active'`,
    ).run(session.session_id, session.access.valid_until, JSON.stringify(session));
  });
}

export async function sync(db: Db, session: Session, client: BankClient, now = new Date()): Promise<SyncResult> {
  const runId = Number(
    db.prepare("INSERT INTO sync_runs (started_at, status) VALUES (?, 'running')").run(now.toISOString())
      .lastInsertRowid,
  );
  const result: SyncResult = {
    accounts: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    transfers: 0,
    categorized: 0,
    uncategorized: 0,
    recurring: 0,
    consentDaysLeft: 0,
    warnings: [],
  };

  try {
    result.consentDaysLeft = consentDaysLeft(session.access.valid_until, now);
    saveSession(db, session);
    if (result.consentDaysLeft <= 0) throw new Error("Bank consent has expired. Reconnect the bank.");
    if (result.consentDaysLeft <= CONSENT_WARN_DAYS) {
      result.warnings.push(`Bank consent expires in ${result.consentDaysLeft} days. Reconnect the bank.`);
    }

    const today = localDate(now);
    for (const account of session.accounts) {
      const accountId = upsertAccount(db, account);
      const { dateFrom, gap } = fetchStart(db, accountId, today);
      if (gap) result.warnings.push(`${accountLabel(account)}: no data between ${gap} and ${dateFrom} (older than the bank allows).`);

      // Network first, then write everything for the account in one DB transaction.
      const [balances, transactions] = await Promise.all([
        client.getBalances(account.uid),
        client.getTransactions(account.uid, dateFrom),
      ]);
      transaction(db, () => {
        const counts = upsertTransactions(db, accountId, transactions);
        result.inserted += counts.inserted;
        result.updated += counts.updated;
        result.skipped += counts.skipped;
        snapshotBalance(db, accountId, today, balances);
      });
      result.accounts++;
    }

    result.transfers = detectTransfers(db);
    const categories = categorize(db);
    result.categorized = categories.categorized;
    result.uncategorized = categories.uncategorized;
    result.recurring = detectRecurring(db, today);
    db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'ok', inserted = ?, updated = ? WHERE id = ?").run(
      new Date().toISOString(),
      result.inserted,
      result.updated,
      runId,
    );
    return result;
  } catch (err) {
    db.prepare("UPDATE sync_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?").run(
      new Date().toISOString(),
      String(err),
      runId,
    );
    throw err;
  }
}

// Account uids change with every new consent, so the IBAN is the stable identity.
function upsertAccount(db: Db, account: SessionAccount): number {
  const iban = account.account_id?.iban ?? null;
  const existing = (
    iban
      ? db.prepare("SELECT id FROM accounts WHERE iban = ?").get(iban)
      : db.prepare("SELECT id FROM accounts WHERE uid = ?").get(account.uid)
  ) as { id: number } | undefined;

  if (existing) {
    db.prepare("UPDATE accounts SET uid = ?, name = ?, product = ?, currency = ?, type = ? WHERE id = ?").run(
      account.uid,
      account.name ?? null,
      account.product ?? null,
      account.currency,
      account.cash_account_type ?? null,
      existing.id,
    );
    return existing.id;
  }
  return Number(
    db
      .prepare("INSERT INTO accounts (uid, iban, name, product, currency, type, is_savings) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        account.uid,
        iban,
        account.name ?? null,
        account.product ?? null,
        account.currency,
        account.cash_account_type ?? null,
        account.cash_account_type === "SVGS" ? 1 : 0,
      ).lastInsertRowid,
  );
}

function fetchStart(db: Db, accountId: number, today: string): { dateFrom: string; gap?: string } {
  const earliestAllowed = addDays(today, -HISTORY_DAYS);
  const { latest } = db
    .prepare("SELECT max(booking_date) AS latest FROM transactions WHERE account_id = ?")
    .get(accountId) as { latest: string | null };
  if (!latest) return { dateFrom: earliestAllowed };
  const wanted = addDays(latest, -OVERLAP_DAYS);
  if (wanted >= earliestAllowed) return { dateFrom: wanted };
  return { dateFrom: earliestAllowed, gap: latest < earliestAllowed ? latest : undefined };
}

function upsertTransactions(db: Db, accountId: number, transactions: Transaction[]) {
  const counts = { inserted: 0, updated: 0, skipped: 0 };
  const find = db.prepare("SELECT raw FROM transactions WHERE account_id = ? AND entry_reference = ?");
  const insert = db.prepare(
    `INSERT INTO transactions (account_id, entry_reference, booking_date, amount, currency, counterparty,
       description, bank_code, sub_code, raw)
     VALUES ($account_id, $entry_reference, $booking_date, $amount, $currency, $counterparty,
       $description, $bank_code, $sub_code, $raw)`,
  );
  const update = db.prepare(
    `UPDATE transactions SET booking_date = $booking_date, amount = $amount, currency = $currency,
       counterparty = $counterparty, description = $description, bank_code = $bank_code, sub_code = $sub_code,
       raw = $raw, updated_at = datetime('now')
     WHERE account_id = $account_id AND entry_reference = $entry_reference`,
  );

  for (const t of transactions) {
    const row = toRow(accountId, t);
    if (!row) {
      counts.skipped++;
      continue;
    }
    const existing = find.get(accountId, row.entry_reference) as { raw: string } | undefined;
    if (!existing) {
      insert.run(row);
      counts.inserted++;
    } else if (existing.raw !== row.raw) {
      update.run(row);
      counts.updated++;
    }
  }
  return counts;
}

function toRow(accountId: number, t: Transaction) {
  const bookingDate = t.booking_date ?? t.value_date ?? t.transaction_date;
  // Only booked transactions with a stable reference can be deduplicated safely.
  if (!t.entry_reference || !bookingDate || t.status !== "BOOK") return undefined;
  const isDebit = t.credit_debit_indicator === "DBIT";
  const cents = Math.abs(toCents(t.transaction_amount.amount));
  return {
    account_id: accountId,
    entry_reference: t.entry_reference,
    booking_date: bookingDate,
    amount: isDebit ? -cents : cents,
    currency: t.transaction_amount.currency,
    counterparty: (isDebit ? t.creditor?.name : t.debtor?.name) ?? null,
    description: t.remittance_information?.join(" ") || null,
    bank_code: t.bank_transaction_code?.code ?? null,
    sub_code: t.bank_transaction_code?.sub_code ?? null,
    raw: JSON.stringify(t),
  };
}

function snapshotBalance(db: Db, accountId: number, date: string, balances: Balance[]): void {
  const pick = (type: string) => {
    const b = balances.find((x) => x.balance_type === type);
    return b ? toCents(b.balance_amount.amount) : null;
  };
  db.prepare(
    `INSERT INTO balances_daily (account_id, date, booked, available) VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id, date) DO UPDATE SET booked = excluded.booked, available = excluded.available`,
  ).run(accountId, date, pick("ITBD") ?? pick("CLBD"), pick("ITAV") ?? pick("CLAV"));
}

// Parses a decimal string ("-12.3") to integer cents without going through floats.
export function toCents(amount: string): number {
  const match = /^([+-])?(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) throw new Error(`Unexpected amount format: ${amount}`);
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -cents : cents;
}

export function consentDaysLeft(validUntil: string, now = new Date()): number {
  return Math.floor((Date.parse(validUntil) - now.getTime()) / 86_400_000);
}

// Calendar date in Finland, where the bank books transactions.
export function localDate(d: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Helsinki" }).format(d);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function accountLabel(account: SessionAccount): string {
  return account.product ?? account.name ?? account.uid.slice(0, 8);
}
