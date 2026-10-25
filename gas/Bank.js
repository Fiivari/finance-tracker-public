// Enable Banking client (read-only account information). Docs: https://enablebanking.com/docs/api/reference
// Credentials live in Script Properties: EB_APP_ID and EB_PRIVATE_KEY (the PKCS#8 PEM), and BANK ({ name, country }
// as Enable Banking names the bank; the setup code writes it). SESSION is written by the reconnect flow.

const EB_API = "https://api.enablebanking.com";
// For sheets set up before BANK existed.
const DEFAULT_BANK = { name: "S-Pankki", country: "FI" };
// Registered in the Enable Banking app. The page doesn't load; the address is copied back into the sheet.
const EB_REDIRECT_URL = "https://localhost:8443/callback";
const MAX_CONSENT_DAYS = 180;

function ebConfig_() {
  const props = PropertiesService.getScriptProperties();
  const appId = props.getProperty("EB_APP_ID");
  const key = props.getProperty("EB_PRIVATE_KEY");
  if (!appId || !key) throw new Error("Set EB_APP_ID and EB_PRIVATE_KEY in Project Settings → Script Properties.");
  return { appId, key: normalizePem_(key) };
}

// Pasting into the Script Properties field can turn line breaks into spaces; rebuild the PEM layout.
function normalizePem_(pem) {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
}

// Each request is authenticated with a short-lived RS256 JWT signed by the app's private key.
function ebJwt_() {
  const { appId, key } = ebConfig_();
  const now = Math.floor(Date.now() / 1000);
  const encode = (obj) => b64url_(Utilities.base64EncodeWebSafe(JSON.stringify(obj), Utilities.Charset.UTF_8));
  const unsigned = `${encode({ typ: "JWT", alg: "RS256", kid: appId })}.${encode({
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: now,
    exp: now + 3600,
  })}`;
  return `${unsigned}.${b64url_(Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(unsigned, key)))}`;
}

function b64url_(s) {
  return s.replace(/=+$/, "");
}

function ebApi_(method, path, body) {
  const res = UrlFetchApp.fetch(EB_API + path, {
    method,
    headers: { Authorization: `Bearer ${ebJwt_()}` },
    contentType: "application/json",
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true,
  });
  const text = res.getContentText();
  if (res.getResponseCode() >= 300) throw new Error(`${method} ${path.split("?")[0]} failed (${res.getResponseCode()}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

function ebBalances_(accountUid) {
  return ebApi_("get", `/accounts/${accountUid}/balances`).balances;
}

function ebTransactions_(accountUid, dateFrom) {
  const all = [];
  let continuationKey = "";
  do {
    let query = `date_from=${dateFrom}`;
    if (continuationKey) query += `&continuation_key=${encodeURIComponent(continuationKey)}`;
    const page = ebApi_("get", `/accounts/${accountUid}/transactions?${query}`);
    all.push(...page.transactions);
    continuationKey = page.continuation_key || "";
  } while (continuationKey);
  return all;
}

function ebBank_() {
  const raw = PropertiesService.getScriptProperties().getProperty("BANK");
  return raw ? JSON.parse(raw) : DEFAULT_BANK;
}

// Returns the bank's login URL for a new consent.
function ebStartConsent_(state) {
  const wanted = ebBank_();
  const { aspsps } = ebApi_("get", `/aspsps?country=${wanted.country}&psu_type=personal`);
  const bank = aspsps.find((a) => a.name.toLowerCase() === wanted.name.toLowerCase());
  if (!bank) throw new Error(`${wanted.name} not found in Enable Banking.`);
  const maxSeconds = Math.min(bank.maximum_consent_validity || Infinity, MAX_CONSENT_DAYS * 86400);
  return ebApi_("post", "/auth", {
    access: { valid_until: new Date(Date.now() + maxSeconds * 1000).toISOString() },
    aspsp: { name: bank.name, country: bank.country },
    state,
    redirect_url: EB_REDIRECT_URL,
    psu_type: "personal",
  }).url;
}

// Exchanges the code from the redirect for a session (account list + consent expiry).
function ebFinishConsent_(code) {
  return ebApi_("post", "/sessions", { code });
}
