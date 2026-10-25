// Bank consent (PSD2 authorization) flow, shared by `npm run link` and the in-app "Reconnect bank" button.
import { api, config, type Session } from "./enablebanking.ts";

const MAX_CONSENT_DAYS = 180;

interface Aspsp {
  name: string;
  country: string;
  maximum_consent_validity?: number;
}

// Returns the bank login URL. The bank redirects to redirectUrl with ?code=…&state=… once I approve.
export async function startConsent(state: string, redirectUrl = config.redirectUrl): Promise<string> {
  const { aspsps } = await api<{ aspsps: Aspsp[] }>("GET", `/aspsps?country=${config.bankCountry}&psu_type=personal`);
  const bank = aspsps.find((a) => a.name.toLowerCase() === config.bankName.toLowerCase());
  if (!bank) {
    throw new Error(
      `Bank "${config.bankName}" not found in ${config.bankCountry}. Available: ${aspsps.map((a) => a.name).join(", ")}`,
    );
  }
  const maxSeconds = Math.min(bank.maximum_consent_validity ?? Infinity, MAX_CONSENT_DAYS * 86400);
  const auth = await api<{ url: string }>("POST", "/auth", {
    access: { valid_until: new Date(Date.now() + maxSeconds * 1000).toISOString() },
    aspsp: { name: bank.name, country: bank.country },
    state,
    redirect_url: redirectUrl,
    psu_type: "personal",
  });
  return auth.url;
}

// Exchanges the code from the redirect for a session (account list + consent expiry).
export function finishConsent(code: string): Promise<Session> {
  return api<Session>("POST", "/sessions", { code });
}
