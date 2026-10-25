// Detects transfers between my own accounts so they don't count as spending or income.
// S-Pankki doesn't return counterparty IBANs, so we pair an outgoing and an incoming
// transaction of the same amount on different own accounts within a few days.
import type { Db } from "./db.ts";
import { transaction } from "./db.ts";

const MAX_DAYS_APART = 3;
// Card purchases, refunds and cash are never transfers. CCRD/OTHR is not listed: it's how
// a credit-card bill payment arrives on the card account.
const NON_TRANSFER_CODES = new Set(["CCRD/POSC", "CCRD/POSD", "CCRD/XBCP", "CCRD/CWDL", "CCRD/CDPT"]);

export interface TransferCandidate {
  id: number;
  accountId: number;
  date: string; // YYYY-MM-DD
  amount: number; // signed cents
  bankCode: string | null;
  subCode: string | null;
}

// Greedy pairing: each debit takes the closest-dated unused credit of the opposite amount.
export function matchTransfers(rows: TransferCandidate[]): [debitId: number, creditId: number][] {
  const eligible = rows.filter((r) => r.amount !== 0 && !NON_TRANSFER_CODES.has(`${r.bankCode}/${r.subCode}`));
  const debits = eligible.filter((r) => r.amount < 0).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const credits = eligible.filter((r) => r.amount > 0);
  const used = new Set<number>();
  const pairs: [number, number][] = [];

  for (const debit of debits) {
    let best: TransferCandidate | undefined;
    let bestGap = Infinity;
    for (const credit of credits) {
      if (used.has(credit.id) || credit.accountId === debit.accountId || credit.amount !== -debit.amount) continue;
      const gap = Math.abs(daysBetween(debit.date, credit.date));
      if (gap <= MAX_DAYS_APART && (gap < bestGap || (gap === bestGap && credit.id < best!.id))) {
        best = credit;
        bestGap = gap;
      }
    }
    if (best) {
      used.add(best.id);
      pairs.push([debit.id, best.id]);
    }
  }
  return pairs;
}

// Matches only transactions not already marked, so earlier pairings stay stable. Returns new pairs found.
export function detectTransfers(db: Db): number {
  const rows = db
    .prepare(
      `SELECT id, account_id AS accountId, booking_date AS date, amount, bank_code AS bankCode, sub_code AS subCode
       FROM transactions WHERE is_transfer = 0`,
    )
    .all() as unknown as TransferCandidate[];
  const pairs = matchTransfers(rows);
  const mark = db.prepare("UPDATE transactions SET is_transfer = 1, transfer_peer_id = ? WHERE id = ?");
  transaction(db, () => {
    for (const [debitId, creditId] of pairs) {
      mark.run(creditId, debitId);
      mark.run(debitId, creditId);
    }
  });
  return pairs.length;
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86_400_000;
}
