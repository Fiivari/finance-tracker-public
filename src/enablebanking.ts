// Minimal Enable Banking API client (read-only account information).
// Docs: https://enablebanking.com/docs/api/reference
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const API_BASE = "https://api.enablebanking.com";

export const config = {
  appId: requireEnv("EB_APP_ID"),
  keyPath: process.env.EB_KEY_PATH ?? "secrets/enablebanking.pem",
  redirectUrl: process.env.EB_REDIRECT_URL ?? "https://localhost:8443/callback",
  bankName: process.env.EB_BANK_NAME ?? "S-Pankki",
  bankCountry: process.env.EB_BANK_COUNTRY ?? "FI",
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function loadPrivateKey(): string {
  try {
    return readFileSync(config.keyPath, "utf8");
  } catch {
    throw new Error(`Private key not found at ${config.keyPath}. Copy the .pem from Enable Banking there.`);
  }
}

// Enable Banking authenticates each request with a short-lived RS256 JWT signed by the app's private key.
function makeJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "RS256", kid: config.appId };
  const payload = { iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 };
  const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${encode(header)}.${encode(payload)}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(loadPrivateKey()).toString("base64url");
  return `${unsigned}.${signature}`;
}

export async function api<T = any>(method: "GET" | "POST" | "DELETE", path: string, body?: object): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${makeJwt()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : (undefined as T);
}

// --- Types for the parts of the API we use ---

export interface Amount {
  amount: string;
  currency: string;
}

export interface Transaction {
  entry_reference?: string;
  transaction_amount: Amount;
  credit_debit_indicator: "CRDT" | "DBIT";
  status: string; // "BOOK" = booked, "PDNG" = pending
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  creditor?: { name?: string };
  debtor?: { name?: string };
  creditor_account?: { iban?: string };
  debtor_account?: { iban?: string };
  bank_transaction_code?: { code?: string; sub_code?: string };
  reference_number?: string;
  remittance_information?: string[];
}

export interface Balance {
  name?: string;
  balance_amount: Amount;
  balance_type: string;
  reference_date?: string;
}

export interface SessionAccount {
  uid: string;
  name?: string;
  product?: string;
  currency: string;
  cash_account_type?: string; // "CACC" = current, "SVGS" = savings
  account_id?: { iban?: string };
}

// Shape of POST /sessions, saved by `npm run link` to secrets/session.json.
export interface Session {
  session_id: string;
  accounts: SessionAccount[];
  access: { valid_until: string };
}

export async function getBalances(accountUid: string): Promise<Balance[]> {
  const { balances } = await api<{ balances: Balance[] }>("GET", `/accounts/${accountUid}/balances`);
  return balances;
}

export async function getTransactions(accountUid: string, dateFrom: string): Promise<Transaction[]> {
  const all: Transaction[] = [];
  let continuationKey: string | undefined;
  do {
    const params = new URLSearchParams({ date_from: dateFrom });
    if (continuationKey) params.set("continuation_key", continuationKey);
    const page = await api<{ transactions: Transaction[]; continuation_key?: string }>(
      "GET",
      `/accounts/${accountUid}/transactions?${params}`,
    );
    all.push(...page.transactions);
    continuationKey = page.continuation_key || undefined;
  } while (continuationKey);
  return all;
}
