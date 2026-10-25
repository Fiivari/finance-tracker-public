// Detects recurring payments and income (subscriptions, bills, salary) from regular intervals and similar amounts.
import type { Db } from "./db.ts";
import { transaction } from "./db.ts";
import { addDays } from "./sync.ts";

const PERIODS = [7, 14, 30, 91]; // weekly, biweekly, monthly, quarterly (90 days of history rules out yearly)
const MIN_OCCURRENCES = 3;
const AMOUNT_TOLERANCE = 0.25; // amounts within ±25% of the median

export interface Occurrence {
  date: string;
  amount: number; // signed cents
}

export interface Pattern {
  intervalDays: number;
  amount: number;
  occurrences: number;
  lastDate: string;
  nextExpectedDate: string;
}

// Returns the pattern if the occurrences (one merchant, one direction) repeat regularly and are still active.
export function findPattern(occurrences: Occurrence[], today: string): Pattern | undefined {
  // Several payments on one day count once (summed), e.g. a bill split in two.
  const byDate = new Map<string, number>();
  for (const o of occurrences) byDate.set(o.date, (byDate.get(o.date) ?? 0) + o.amount);
  const dates = [...byDate.keys()].sort();
  if (dates.length < MIN_OCCURRENCES) return undefined;

  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
  const period = PERIODS.find((p) => gaps.every((g) => Math.abs(g - p) <= Math.max(3, p * 0.2)));
  if (!period) return undefined;

  const amounts = [...byDate.values()];
  const typical = median(amounts);
  if (!amounts.every((a) => Math.abs(a - typical) <= Math.abs(typical) * AMOUNT_TOLERANCE)) return undefined;

  const lastDate = dates[dates.length - 1];
  const intervalDays = Math.round(median(gaps));
  // Stopped: more than one and a half intervals without a payment.
  if (daysBetween(lastDate, today) > intervalDays * 1.5 + 3) return undefined;
  return { intervalDays, amount: typical, occurrences: dates.length, lastDate, nextExpectedDate: addDays(lastDate, intervalDays) };
}

// Rebuilds the recurring table from all non-transfer transactions with a merchant. Returns the number found.
export function detectRecurring(db: Db, today: string): number {
  const rows = db
    .prepare(
      `SELECT t.merchant_id AS merchantId, t.booking_date AS date, t.amount, c.name AS category
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.merchant_id IS NOT NULL AND t.is_transfer = 0 AND t.amount <> 0
       ORDER BY t.booking_date`,
    )
    .all() as { merchantId: number; date: string; amount: number; category: string | null }[];

  const groups = new Map<string, { merchantId: number; income: boolean; category: string | null; items: Occurrence[] }>();
  for (const r of rows) {
    const key = `${r.merchantId}:${r.amount > 0}`;
    const group = groups.get(key) ?? { merchantId: r.merchantId, income: r.amount > 0, category: r.category, items: [] };
    group.items.push(r);
    group.category = r.category ?? group.category;
    groups.set(key, group);
  }

  const insert = db.prepare(
    `INSERT INTO recurring (merchant_id, kind, amount, interval_days, occurrences, last_date, next_expected_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let found = 0;
  transaction(db, () => {
    db.exec("DELETE FROM recurring");
    for (const g of groups.values()) {
      const p = findPattern(g.items, today);
      if (!p) continue;
      const kind = g.income ? "income" : g.category === "Subscriptions" ? "subscription" : "bill";
      insert.run(g.merchantId, kind, p.amount, p.intervalDays, p.occurrences, p.lastDate, p.nextExpectedDate);
      found++;
    }
  });
  return found;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
