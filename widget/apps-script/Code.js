// Home screen widget endpoint: a separate, standalone Apps Script project deployed with access "Anyone", so
// Scriptable can fetch it without a Google sign-in. It runs as me and could read the whole finance sheet, so
// this code is the boundary: it only ever returns the savings jar's fill levels (0–1) from Summary and the last
// 7 days as + (under the usual day-to-day spending) / - (over) / . (no data). Never euro amounts.
// Script properties: SHEET_ID (the finance sheet) and TOKEN (made by createToken).

const ROWS = { level: "Savings jar level", potential: "Savings jar potential", earned: "Savings jar earned", days: "Last 7 settled days vs usual" };

function doGet(e) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("TOKEN");
  if (!token || (e && e.parameter.token) !== token) return json_({ error: "forbidden" });
  // The Sheets API service rather than SpreadsheetApp, which needs read and write access to every spreadsheet.
  const rows = Sheets.Spreadsheets.Values.get(props.getProperty("SHEET_ID"), "Summary!A:B", { valueRenderOption: "UNFORMATTED_VALUE" }).values || [];
  const cell = (label) => (rows.find((r) => r[0] === label) || [])[1];
  const value = (label) => {
    const n = Number(cell(label) ?? NaN);
    return Number.isFinite(n) ? Math.round(Math.min(1, Math.max(0, n)) * 100) / 100 : null;
  };
  const days = String(cell(ROWS.days) ?? "");
  return json_({ level: value(ROWS.level), potential: value(ROWS.potential), earned: value(ROWS.earned), days: /^[+\-.]{7}$/.test(days) ? days : null });
}

// Run once from the editor: stores a random token and logs it for the widget's URL. Running it again replaces
// the token, which locks out the old URL.
function createToken() {
  const token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  PropertiesService.getScriptProperties().setProperty("TOKEN", token);
  Logger.log(token);
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
