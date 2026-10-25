// Dashboard web app. Deployed with access "Only myself" (see appsscript.json), so Google sign-in as the owner
// is required. The page is rebuilt from the sheet on every visit; the bank is only called by the sync.

function doGet() {
  const template = HtmlService.createTemplateFromFile("Dashboard");
  // Escape "<" so data such as a merchant name can never close the <script> tag it's embedded in.
  template.data = JSON.stringify(dashboardData_()).replace(/</g, "\\u003c");
  return template
    .evaluate()
    .setTitle("Finance")
    .addMetaTag("viewport", "width=device-width, initial-scale=1, viewport-fit=cover");
}

// Called from the page (pull to refresh) to get fresh data without reloading it.
function dashboardData() {
  return JSON.stringify(dashboardData_());
}

// Called from the page: recategorizes one transaction (its Override) or, with forMerchant, every transaction
// from its merchant (My category in Merchants). An empty category removes my choice. Recomputes from the
// sheet without calling the bank and returns fresh dashboard data.
function setCategory(key, category, forMerchant) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("A sync is running, try again in a moment.");
  try {
    const categories = new Set(readRows_(SHEETS.categories).map((r) => String(r[0])));
    if (category && !categories.has(category)) throw new Error(`Unknown category: ${category}`);
    const txs = readTransactions_();
    const tx = txs.find((t) => t.key === key);
    if (!tx) throw new Error("Transaction not found.");
    const choices = merchantChoices_();
    if (forMerchant) {
      categorizeAll([tx], new Map(), []); // only to get its merchant key
      if (!tx.merchantKey) throw new Error("This transaction has no merchant.");
      if (category) choices.set(tx.merchantKey, category);
      else choices.delete(tx.merchantKey);
      tx.override = ""; // so the merchant choice shows on this one too
    } else {
      tx.override = category;
    }
    const session = PropertiesService.getScriptProperties().getProperty("SESSION");
    recompute_(txs, readRows_(SHEETS.balances), choices, session ? JSON.parse(session).access.valid_until : "", new Date(), lastSyncInfo_());
  } finally {
    lock.releaseLock();
  }
  return dashboardData();
}

function dashboardData_() {
  applySettings_();
  const now = new Date();
  const today = today_();
  const categories = readRows_(SHEETS.categories).map((r) => ({ name: String(r[0]), group: String(r[1]), icon: String(r[2]) }));
  const groups = new Map(categories.map((c) => [c.name, c.group]));
  const icons = new Map(categories.map((c) => [c.name, c.icon]));
  const txs = readRows_(SHEETS.transactions)
    .filter((r) => r[12])
    .map((r) => ({
      date: isoDate_(r[0]),
      amount: cents_(r[1]),
      merchant: String(r[2]),
      category: String(r[3] || ""),
      transfer: r[7] === "yes",
      source: String(r[10] || ""),
      hasMerchant: Boolean(r[9]),
      key: String(r[12]),
    }));
  const recurring = readRows_(SHEETS.recurring).map((r) => ({
    merchant: String(r[0]),
    kind: String(r[1]),
    amount: cents_(r[2]),
    intervalDays: Number(r[3]),
    nextExpectedDate: isoDate_(r[6]),
  }));
  const balances = latestBalances_(readRows_(SHEETS.balances));
  const session = PropertiesService.getScriptProperties().getProperty("SESSION");
  const consentUntil = session ? JSON.parse(session).access.valid_until : "";
  const log = readRows_(SHEETS.log)[0];
  return buildDashboard(txs, balances, recurring, groups, icons, consentUntil, today, now, savingsGoal_(), {
    lastSync: log ? { time: Utilities.formatDate(new Date(log[0]), "Europe/Helsinki", "d.M. HH:mm"), status: String(log[1]), message: String(log[4] || "") } : null,
  });
}
