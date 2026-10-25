// Finance menu in the spreadsheet (desktop browser; the Sheets phone app doesn't show custom menus).

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Finance")
    .addItem("Sync now", "syncNow")
    .addSeparator()
    .addItem("Reconnect bank…", "startReconnect")
    .addItem("Finish reconnect (paste address)…", "finishReconnect")
    .addSeparator()
    .addItem("Set up from setup code…", "showSetupDialog")
    .addItem("Set up sheets and 4-hour sync", "setup")
    .addToUi();
}

// Creates the sheets and the time trigger. Safe to run again.
function setup() {
  setupSheets_();
  ensureTrigger_();
  notify_("Sheets are ready and the sync runs every 4 hours. Next: Finance → Reconnect bank.");
}

function ensureTrigger_() {
  if (!ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === "syncNow")) {
    ScriptApp.newTrigger("syncNow").timeBased().everyHours(4).create();
  }
}

// Onboarding (ONBOARDING.md): paste the setup code that `npm run onboard:code` copied to the clipboard.
function showSetupDialog() {
  const html = HtmlService.createHtmlOutput(
    `<div style="font:14px/1.5 system-ui,sans-serif">
      <p>Paste the setup code (Ctrl+V / Cmd+V) and press <b>Set up</b>. The first sync takes up to a minute.</p>
      <textarea id="code" style="width:100%;height:110px;font:12px monospace" spellcheck="false"></textarea>
      <p><button id="go" style="font-size:14px;padding:6px 16px">Set up</button> <span id="msg"></span></p>
      <script>
        const msg = document.getElementById("msg");
        document.getElementById("go").onclick = (e) => {
          e.target.disabled = true;
          msg.textContent = "Setting up and syncing…";
          google.script.run
            .withSuccessHandler((text) => { msg.textContent = text; })
            .withFailureHandler((err) => { msg.textContent = err.message; e.target.disabled = false; })
            .importSetupCode(document.getElementById("code").value);
        };
      </script>
    </div>`,
  )
    .setWidth(460)
    .setHeight(280);
  SpreadsheetApp.getUi().showModalDialog(html, "Set up from setup code");
}

// The setup code is base64 JSON made on the user's computer during onboarding: the Enable Banking app id and
// private key, the bank and the bank session linked there, and the choices from the categorization interview.
// Writes the credentials to Script Properties and the choices to the sheets, then creates the trigger and syncs.
function importSetupCode(code) {
  let setup;
  try {
    setup = JSON.parse(Utilities.newBlob(Utilities.base64Decode(String(code).trim())).getDataAsString());
  } catch (err) {
    throw new Error("That isn't a whole setup code. Copy it again (npm run onboard:code) and paste all of it.");
  }
  if (setup.version !== 1 || !setup.appId || !setup.key || !setup.session || !setup.bank) {
    throw new Error("The setup code is missing parts. Make it again with npm run onboard:code.");
  }
  PropertiesService.getScriptProperties().setProperties({
    EB_APP_ID: setup.appId,
    EB_PRIVATE_KEY: setup.key,
    SESSION: JSON.stringify(setup.session),
    BANK: JSON.stringify(setup.bank),
  });
  setupSheets_(setup.categories || []);
  if (setup.settings) {
    if (setup.settings.payday != null) setSetting_(SETTING_PAYDAY, setup.settings.payday);
    if (setup.settings.savingsGoal != null) setSetting_(SETTING_GOAL, setup.settings.savingsGoal);
  }
  // Merchant choices: [key, name, category]; existing choices for other merchants are kept.
  const merchants = new Map(readRows_(SHEETS.merchants).map((r) => [String(r[6]), r]));
  for (const [key, name, category] of setup.merchants || []) merchants.set(key, [name, category, "", 0, 0, "", key]);
  writeRows_(SHEETS.merchants, [...merchants.values()]);
  const rules = readRows_(SHEETS.rules);
  const patterns = new Set(rules.map((r) => String(r[0]).toLowerCase()));
  for (const [pattern, category] of setup.rules || []) if (!patterns.has(pattern.toLowerCase())) rules.push([pattern, category]);
  writeRows_(SHEETS.rules, rules);
  ensureTrigger_();
  syncNow();
  const until = setup.session.access.valid_until.slice(0, 10);
  return `Done: ${readRows_(SHEETS.transactions).length} transactions synced, bank access valid until ${until}. Close this window.`;
}

// A non-blocking toast in the sheet, plus the execution log. (A modal alert would make an editor run
// wait until someone clicks OK in the spreadsheet tab.)
function notify_(message) {
  console.log(message);
  SpreadsheetApp.getActive().toast(message, "Finance", 10);
}

// Step 1: open the bank and approve in its app. The bank then redirects to a page that doesn't load.
function startReconnect() {
  const state = Utilities.getUuid();
  CacheService.getScriptCache().put("consent_state", state, 1800);
  const url = ebStartConsent_(state);
  const html = HtmlService.createHtmlOutput(
    `<div style="font:14px/1.5 system-ui,sans-serif">
      <p><a href="${escapeHtml_(url)}" target="_blank" rel="noopener noreferrer"><b>Open ${escapeHtml_(ebBank_().name)}</b></a> and approve access (usually in your bank's app).</p>
      <p>You'll land on a page that doesn't load (that's expected). Copy the full address from the browser's
      address bar, then use <b>Finance → Finish reconnect</b> and paste it there.</p>
      <p style="color:#666">Read-only access, valid 180 days. The link works for 30 minutes.</p>
    </div>`,
  )
    .setWidth(420)
    .setHeight(220);
  SpreadsheetApp.getUi().showModalDialog(html, "Reconnect bank");
}

// Step 2: paste the address the bank redirected to; exchange its code for a session and sync.
function finishReconnect() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.prompt("Finish reconnect", "Paste the full address the bank redirected to:", ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  const address = answer.getResponseText().trim();
  const param = (name) => {
    const m = new RegExp(`[?&]${name}=([^&#]*)`).exec(address);
    return m ? decodeURIComponent(m[1]) : "";
  };
  const expected = CacheService.getScriptCache().get("consent_state");
  if (!expected || param("state") !== expected) {
    ui.alert("This address doesn't belong to the reconnect just started (or it's older than 30 minutes). Start again.");
    return;
  }
  const code = param("code");
  if (!code) {
    ui.alert(`The bank didn't grant access: ${param("error") || "no code in the address"}.`);
    return;
  }
  const session = ebFinishConsent_(code);
  PropertiesService.getScriptProperties().setProperty("SESSION", JSON.stringify(session));
  CacheService.getScriptCache().remove("consent_state");
  syncNow();
  ui.alert(`Connected ${session.accounts.length} account(s), access valid until ${session.access.valid_until.slice(0, 10)}. Synced.`);
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
