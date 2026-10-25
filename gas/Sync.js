// Bank sync: fetch new transactions and balances, then recompute transfers, categories, recurring payments,
// monthly totals and the summary. Runs every 4 hours (time trigger) and from Finance → Sync now.

// Banks reject date_from older than about 90 days (S-Pankki: 90), so this sheet is the only long-term history.
const HISTORY_DAYS = 89;
// Re-fetch this many days before the newest stored booking, to catch late-booked card purchases.
const OVERLAP_DAYS = 10;
const CONSENT_WARN_DAYS = 14;

function syncNow() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // another sync is running
  try {
    runSync_();
  } catch (err) {
    appendLog_("error", 0, 0, err.message || String(err));
    throw err;
  } finally {
    lock.releaseLock();
  }
}

function loadSession_() {
  const raw = PropertiesService.getScriptProperties().getProperty("SESSION");
  if (!raw) throw new Error("Bank not connected. Use Finance → Reconnect bank.");
  return JSON.parse(raw);
}

function runSync_() {
  const session = loadSession_();
  const now = new Date();
  const today = today_();
  const consentDays = Math.floor((Date.parse(session.access.valid_until) - now.getTime()) / 86400000);
  if (consentDays <= 0) throw new Error("Bank consent has expired. Use Finance → Reconnect bank.");
  const warnings = [];
  if (consentDays <= CONSENT_WARN_DAYS) warnings.push(`Bank access expires in ${consentDays} days: Finance → Reconnect bank.`);

  const txs = readTransactions_();
  const byKey = new Map(txs.map((t) => [t.key, t]));
  const balances = readRows_(SHEETS.balances);
  const earliest = addDays(today, -HISTORY_DAYS);
  let inserted = 0;
  let updated = 0;

  for (const account of session.accounts) {
    const acct = accountKey_((account.account_id && account.account_id.iban) || account.uid);
    const label = account.product || account.name || "Account";
    const latest = txs.filter((t) => t.account === acct).reduce((max, t) => (t.date > max ? t.date : max), "");
    let dateFrom = earliest;
    if (latest && addDays(latest, -OVERLAP_DAYS) >= earliest) dateFrom = addDays(latest, -OVERLAP_DAYS);
    else if (latest && latest < earliest) warnings.push(`${label}: no data between ${latest} and ${earliest} (older than the bank allows).`);

    for (const raw of ebTransactions_(account.uid, dateFrom)) {
      const row = fromBank(acct, label, raw);
      if (!row) continue;
      const existing = byKey.get(row.key);
      if (!existing) {
        txs.push(row);
        byKey.set(row.key, row);
        inserted++;
      } else if (["date", "amount", "counterparty", "description", "code", "subCode"].some((f) => existing[f] !== row[f])) {
        Object.assign(existing, row, { override: existing.override, transfer: existing.transfer });
        updated++;
      }
    }
    upsertBalance_(balances, today, acct, label, account.cash_account_type || "", ebBalances_(account.uid));
  }

  markTransfers(txs);
  recompute_(txs, balances, merchantChoices_(), session.access.valid_until, now, {
    lastSync: Utilities.formatDate(now, "Europe/Helsinki", "yyyy-MM-dd HH:mm"),
    warnings,
  });
  appendLog_("ok", inserted, updated, warnings.join(" "));
}

// Merchant key → the category I picked in the Merchants sheet.
function merchantChoices_() {
  return new Map(
    readRows_(SHEETS.merchants)
      .filter((r) => r[1] && r[6])
      .map((r) => [String(r[6]), String(r[1])]),
  );
}

// Categories, recurring payments, monthly totals and the summary from the transactions alone; no bank calls,
// so recategorizing from the dashboard can run it too. sync: { lastSync, warnings } shown in the summary.
function recompute_(txs, balances, merchantChoices, consentValidUntil, now, sync) {
  applySettings_();
  const today = today_();
  const groups = new Map(readRows_(SHEETS.categories).map((r) => [String(r[0]), String(r[1])]));
  const rules = readRows_(SHEETS.rules).map((r) => ({ pattern: r[0], category: r[1] }));
  categorizeAll(txs, merchantChoices, rules);
  const recurring = detectRecurring(txs, today);

  writeTransactions_(txs);
  writeMerchants_(txs, merchantChoices);
  writeRows_(SHEETS.monthly, monthlyTotals(txs, groups).map((r) => [r[0], r[1], r[2], euros_(r[3]), r[4]]));
  writeRows_(
    SHEETS.recurring,
    recurring.map((r) => [r.merchant, r.kind, euros_(r.amount), r.intervalDays, r.occurrences, r.lastDate, r.nextExpectedDate]),
  );
  writeRows_(SHEETS.balances, balances);

  const summary = summarize(txs, latestBalances_(balances), recurring, groups, consentValidUntil, today, now);
  const firstDate = txs.reduce((min, t) => (t.date < min ? t.date : min), today);
  writeSummary_(summary, savingsPlan(txs, summary, recurring, groups, firstDate, savingsGoal_()), sync);
}

// The summary's sync info as the last sync wrote it, for a recompute that didn't sync.
function lastSyncInfo_() {
  const rows = new Map(readRows_(SHEETS.summary).map((r) => [String(r[0]), r[1]]));
  const last = rows.get("Last sync");
  const warnings = String(rows.get("Warnings") || "");
  return {
    // The sheet may have parsed the text as a date.
    lastSync: last instanceof Date ? Utilities.formatDate(last, "Europe/Helsinki", "yyyy-MM-dd HH:mm") : String(last || ""),
    warnings: warnings && warnings !== "none" ? [warnings] : [],
  };
}

function readTransactions_() {
  return readRows_(SHEETS.transactions)
    .filter((r) => r[12])
    .map((r) => {
      const [code, subCode] = String(r[11]).split("/");
      return {
        date: isoDate_(r[0]),
        amount: cents_(r[1]),
        override: String(r[4] || ""),
        accountLabel: String(r[5]),
        transfer: r[7] === "yes",
        description: String(r[8] || ""),
        counterparty: String(r[9] || ""),
        code: code || "",
        subCode: subCode || "",
        key: String(r[12]),
        account: String(r[12]).split("|")[0],
      };
    });
}

function writeTransactions_(txs) {
  const sorted = [...txs].sort((a, b) => b.date.localeCompare(a.date) || b.key.localeCompare(a.key));
  writeRows_(
    SHEETS.transactions,
    sorted.map((t) => [
      t.date,
      euros_(t.amount),
      t.merchant || t.counterparty || t.description,
      t.category,
      t.override,
      t.accountLabel,
      t.type,
      t.transfer ? "yes" : "",
      t.description,
      t.counterparty,
      t.source,
      `${t.code}/${t.subCode}`,
      t.key,
    ]),
  );
}

// One row per merchant, keeping my category choices (also for merchants with no recent transactions).
function writeMerchants_(txs, choices) {
  const merchants = new Map();
  for (const t of txs) {
    if (!t.merchantKey) continue;
    const m = merchants.get(t.merchantKey) || { name: t.merchant, applied: t.category, count: 0, net: 0, last: "" };
    m.count++;
    m.net += t.amount;
    if (t.date >= m.last) {
      m.last = t.date;
      m.applied = t.category;
    }
    merchants.set(t.merchantKey, m);
  }
  const existingNames = new Map(readRows_(SHEETS.merchants).map((r) => [String(r[6]), String(r[0])]));
  for (const key of choices.keys()) {
    if (!merchants.has(key)) merchants.set(key, { name: existingNames.get(key) || key, applied: "", count: 0, net: 0, last: "" });
  }
  const rows = [...merchants.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name))
    .map(([key, m]) => [m.name, choices.get(key) || "", m.applied, m.count, euros_(m.net), m.last, key]);
  writeRows_(SHEETS.merchants, rows);
}

// Today's balance per account (the latest sync of the day wins).
function upsertBalance_(rows, today, acct, label, type, balances) {
  const { booked, available } = pickBalances(balances);
  const row = [today, label, type, booked == null ? "" : euros_(booked), available == null ? "" : euros_(available), acct];
  const i = rows.findIndex((r) => isoDate_(r[0]) === today && r[5] === acct);
  if (i >= 0) rows[i] = row;
  else rows.unshift(row);
}

function latestBalances_(rows) {
  const latest = new Map();
  for (const r of rows) {
    const date = isoDate_(r[0]);
    const prev = latest.get(r[5]);
    if (!prev || date > prev.date) {
      latest.set(r[5], {
        date,
        label: r[1],
        type: r[2],
        booked: r[3] === "" ? null : cents_(r[3]),
        available: r[4] === "" ? null : cents_(r[4]),
      });
    }
  }
  return [...latest.values()];
}

const GOAL_STATUS_TEXT = { done: "reached", ok: "in reach", tight: "tight", out: "out of reach" };

function writeSummary_(s, plan, sync) {
  const eur = (cents) => euros_(cents);
  const p = plan.progress;
  const rows = [
    ["Safe to spend per day", eur(s.safeToSpendPerDay)],
    ["Safe to spend until payday", eur(s.safeToSpend)],
    ["Payday", s.payday],
    ["Days to payday", s.daysLeft],
    ["Cash available", eur(s.cash)],
    ["Credit card owed", eur(s.cardOwed)],
    ["Spent this month", eur(s.spentThisMonth)],
    ["Spent by this day last month", eur(s.spentLastMonthToDate)],
    ["Spent last month", eur(s.spentLastMonth)],
    ["Income this month", eur(s.incomeThisMonth)],
    ["Uncategorized transactions", s.uncategorized],
    ["Bank access days left", s.consentDaysLeft],
    ["Last sync", sync.lastSync],
    ["Warnings", sync.warnings.join(" ") || "none"],
    ["Savings goal per pay period", eur(plan.goal)],
    ["Saved this pay period", eur(plan.saved)],
    ["Savings goal status", GOAL_STATUS_TEXT[plan.goalStatus] || "no goal"],
    // Read by the home screen widget (widget/): the only values it shows.
    ["Savings jar level", plan.jarLevel],
    ["Savings jar potential", plan.jarPotential],
    ["Savings jar earned", plan.jarEarned],
    // + under the usual day-to-day spending, - over it, oldest first; read by the widget too.
    ["Last 7 settled days vs usual", p ? p.days.map((v) => (v == null ? "." : v >= 0 ? "+" : "-")).join("") : ""],
    ["Usual day-to-day spending per day", p ? eur(p.baseline) : ""],
    ["Under usual spending this pay period", p ? eur(p.earned) : ""],
    ["", ""],
    ["Bills before payday", ""],
    ...s.upcoming.map((u) => [`${u.merchant} (${u.date})`, eur(u.amount)]),
  ];
  writeRows_(SHEETS.summary, rows);
  const money = new Set([0, 1, 4, 5, 6, 7, 8, 9, 14, 15, 21, 22]);
  const billsFrom = rows.length - s.upcoming.length;
  const formats = rows.map((r, i) => ["@", money.has(i) || (i >= billsFrom && r[1] !== "") ? EURO_FORMAT : "0"]);
  for (const i of [2, 12, 13, 16, 20]) formats[i][1] = "@";
  for (const i of [17, 18, 19]) formats[i][1] = "0%";
  sheet_(SHEETS.summary).getRange(2, 1, rows.length, 2).setNumberFormats(formats);
}
