// Sheet layout and row I/O. Amounts in sheets are euros (numbers); in code they're integer cents.

const SHEETS = {
  summary: { name: "Summary", headers: ["What", "Value"] },
  transactions: {
    name: "Transactions",
    // Override is mine to edit (one transaction); everything else is rewritten by each sync.
    headers: ["Date", "Amount", "Merchant", "Category", "Override", "Account", "Type", "Transfer", "Description", "Counterparty", "Source", "Code", "Key"],
  },
  // My category applies to every transaction from that merchant. Applied shows the result.
  merchants: { name: "Merchants", headers: ["Merchant", "My category", "Applied", "Transactions", "Net", "Last seen", "Key"] },
  rules: { name: "Rules", headers: ["Pattern", "Category"] },
  monthly: { name: "Monthly", headers: ["Month", "Category", "Group", "Total", "Count"] },
  recurring: { name: "Recurring", headers: ["Merchant", "Kind", "Amount", "Every (days)", "Times seen", "Last", "Next expected"] },
  balances: { name: "Balances", headers: ["Date", "Account", "Type", "Booked", "Available", "Account key"] },
  categories: { name: "Categories", headers: ["Name", "Group", "Icon"] },
  log: { name: "Sync log", headers: ["Time", "Status", "New", "Updated", "Message"] },
  // Mine to edit: Value is read on every dashboard visit and sync.
  settings: { name: "Settings", headers: ["Setting", "Value", "Note"] },
};

const SETTING_GOAL = "Savings goal per pay period";
const SETTING_PAYDAY = "Payday (day of month)";
const DEFAULT_SETTINGS = [
  [SETTING_GOAL, 1000, "Euros to move to savings (Savings category) between paydays. 0 turns the goal off."],
  [SETTING_PAYDAY, DEFAULT_PAYDAY, "Salary day, 1–31 (31 = last day of the month). On a weekend it moves to the Friday before."],
];

const EURO_FORMAT = '#,##0.00 "€";-#,##0.00 "€"';
const LOG_ROWS = 200;

// Creates missing sheets with headers, seeds categories (plus extraCategories: [[name, group, icon]] from the
// setup code) and adds the category dropdowns. Safe to re-run.
function setupSheets_(extraCategories) {
  const ss = SpreadsheetApp.getActive();
  for (const def of Object.values(SHEETS)) {
    let sheet = ss.getSheetByName(def.name);
    if (!sheet) sheet = ss.insertSheet(def.name);
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  const categories = sheet_(SHEETS.categories);
  if (categories.getLastRow() < 2) {
    categories.getRange(2, 1, DEFAULT_CATEGORIES.length, 3).setValues(DEFAULT_CATEGORIES);
  }
  const existing = new Set(readRows_(SHEETS.categories).map((r) => String(r[0])));
  const extra = (extraCategories || []).filter((c) => !existing.has(c[0]));
  if (extra.length) categories.getRange(categories.getLastRow() + 1, 1, extra.length, 3).setValues(extra.map((c) => c.map(cell_)));
  settingsSheet_();
  const list = SpreadsheetApp.newDataValidation()
    .requireValueInRange(categories.getRange("A2:A"), true)
    .setAllowInvalid(false)
    .build();
  sheet_(SHEETS.transactions).getRange("E2:E").setDataValidation(list);
  sheet_(SHEETS.merchants).getRange("B2:B").setDataValidation(list);
  sheet_(SHEETS.rules).getRange("B2:B").setDataValidation(list);
  sheet_(SHEETS.transactions).getRange("A2:A").setNumberFormat("yyyy-mm-dd");
  sheet_(SHEETS.transactions).getRange("B2:B").setNumberFormat(EURO_FORMAT);
  sheet_(SHEETS.merchants).getRange("E2:E").setNumberFormat(EURO_FORMAT);
  sheet_(SHEETS.monthly).getRange("D2:D").setNumberFormat(EURO_FORMAT);
  sheet_(SHEETS.recurring).getRange("C2:C").setNumberFormat(EURO_FORMAT);
  sheet_(SHEETS.balances).getRange("D2:E").setNumberFormat(EURO_FORMAT);
  const order = ["summary", "transactions", "merchants", "monthly", "recurring", "rules", "settings", "balances", "categories", "log"];
  order.forEach((k, i) => {
    ss.setActiveSheet(sheet_(SHEETS[k]));
    ss.moveActiveSheet(i + 1);
  });
  const blank = ss.getSheetByName("Sheet1") || ss.getSheetByName("Taulukko1");
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
}

// The Settings sheet, created if it's missing and topped up with any default rows it lacks (so new settings
// appear without re-running setup).
function settingsSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(SHEETS.settings.name);
  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.settings.name);
    sheet.getRange(1, 1, 1, SHEETS.settings.headers.length).setValues([SHEETS.settings.headers]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  const names = new Set(readRows_(SHEETS.settings).map((r) => String(r[0])));
  const missing = DEFAULT_SETTINGS.filter((d) => !names.has(d[0]));
  if (missing.length) sheet.getRange(sheet.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
  return sheet;
}

function setting_(name) {
  settingsSheet_();
  const row = readRows_(SHEETS.settings).find((r) => String(r[0]) === name);
  return row ? row[1] : "";
}

function setSetting_(name, value) {
  const sheet = settingsSheet_();
  const i = readRows_(SHEETS.settings).findIndex((r) => String(r[0]) === name);
  sheet.getRange(i + 2, 2, 1, 1).setValues([[value]]);
}

// Settings the pure logic needs before computing.
function applySettings_() {
  setPaydayDay(setting_(SETTING_PAYDAY));
}

// The savings goal in cents per pay period; 0 when it's blank or off.
function savingsGoal_() {
  return Math.max(0, cents_(setting_(SETTING_GOAL)) || 0);
}

function sheet_(def) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(def.name);
  if (!sheet) throw new Error(`Sheet "${def.name}" is missing. Run Finance → Set up sheets.`);
  return sheet;
}

// Data rows (without the header) as arrays.
function readRows_(def) {
  const sheet = sheet_(def);
  const rows = sheet.getLastRow() - 1;
  if (rows < 1) return [];
  return sheet.getRange(2, 1, rows, def.headers.length).getValues();
}

// Replaces all data rows. Text from the bank is escaped so it can never become a formula.
function writeRows_(def, rows) {
  const sheet = sheet_(def);
  const width = def.headers.length;
  const old = sheet.getLastRow() - 1;
  if (old > 0) sheet.getRange(2, 1, old, width).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, width).setValues(rows.map((r) => r.map(cell_)));
}

function cell_(value) {
  if (value == null) return "";
  if (typeof value === "string" && /^[=+\-@]/.test(value)) return `'${value}`;
  return value;
}

// Dates come back from the sheet as Date objects (or strings if typed by hand).
function isoDate_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  return String(value).slice(0, 10);
}

function euros_(cents) {
  return Math.round(cents) / 100;
}

function cents_(euros) {
  return Math.round(Number(euros || 0) * 100);
}

function today_() {
  return Utilities.formatDate(new Date(), "Europe/Helsinki", "yyyy-MM-dd");
}

// Accounts are identified by a hash of the IBAN: stable across consents, without storing the IBAN.
function accountKey_(iban) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, iban, Utilities.Charset.UTF_8);
  return bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, "0")).join("").slice(0, 12);
}

function appendLog_(status, inserted, updated, message) {
  const sheet = sheet_(SHEETS.log);
  sheet.insertRowAfter(1);
  sheet.getRange(2, 1, 1, 5).setValues([[new Date(), status, inserted, updated, cell_(message)]]);
  if (sheet.getLastRow() > LOG_ROWS + 1) sheet.deleteRows(LOG_ROWS + 2, sheet.getLastRow() - LOG_ROWS - 1);
}
