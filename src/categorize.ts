// Assigns a transaction type, a normalized merchant and a category to every transaction.
// Precedence: manual choice > transfer > merchant set by me > my rules > built-in rules > type fallback.
// No LLM: unknown merchants stay uncategorized until I pick a category for them once.
import type { Db } from "./db.ts";
import { transaction } from "./db.ts";

export type TxType = "card" | "card_refund" | "card_bill" | "cash" | "transfer_in" | "transfer_out" | "other";

// S-Pankki codes seen so far: CCRD/POSD (debit card on S-TILI), CCRD/POSC (credit card), CCRD/XBCP (cross-border
// card), CCRD/OTHR (credit card bill arriving on the card), RCDT (incoming transfer), ICDT/IRCT (outgoing transfer).
export function txType(code: string | null, subCode: string | null, amount: number): TxType {
  if (code === "CCRD") {
    if (subCode === "OTHR") return "card_bill";
    if (subCode === "CWDL" || subCode === "CDPT") return "cash";
    return amount > 0 ? "card_refund" : "card";
  }
  if (code === "RCDT") return "transfer_in";
  if (code === "ICDT" || code === "IRCT") return "transfer_out";
  return "other";
}

interface BuiltInRule {
  match: RegExp;
  category: string;
  name?: string; // canonical merchant name, so "K-market Keskusta" and "K-MARKET ASEMA" group together
  types?: TxType[]; // only for these transaction types
}

// Order matters: first match wins (e.g. "Uber Eats" before "Uber", "Sokos Hotel" before "Sokos").
const BUILT_IN_RULES: BuiltInRule[] = [
  // Bars & eating out (delivery first: these brands also do rides/groceries)
  { match: /\bwolt\b/, category: "Bars & eating out", name: "Wolt" },
  { match: /\bfoodora\b/, category: "Bars & eating out", name: "Foodora" },
  { match: /\buber\s*\*?\s*eats\b/, category: "Bars & eating out", name: "Uber Eats" },
  { match: /\bbolt\s*\*?\s*food\b/, category: "Bars & eating out", name: "Bolt Food" },
  { match: /\bmcdonald|^mcd(?=[a-z])/, category: "Bars & eating out", name: "McDonald's" }, // "Mcdtampereasema"
  { match: /\bhesburger\b|^hesb\b/, category: "Bars & eating out", name: "Hesburger" },
  { match: /\bkfc\b/, category: "Bars & eating out", name: "KFC" },
  { match: /\bfive guys\b/, category: "Bars & eating out", name: "Five Guys" },
  { match: /\bburger king\b/, category: "Bars & eating out", name: "Burger King" },
  { match: /\bkotipizza\b/, category: "Bars & eating out", name: "Kotipizza" },
  { match: /\bsubway\b/, category: "Bars & eating out", name: "Subway" },
  { match: /\brolls\b/, category: "Bars & eating out", name: "Rolls" },
  { match: /\bstarbucks\b/, category: "Bars & eating out", name: "Starbucks" },
  { match: /\brobert'?s coffee\b/, category: "Bars & eating out", name: "Robert's Coffee" },
  { match: /\bespresso house\b/, category: "Bars & eating out", name: "Espresso House" },
  { match: /\bwayne'?s coffee\b/, category: "Bars & eating out", name: "Wayne's Coffee" },
  { match: /\barnold'?s\b/, category: "Bars & eating out", name: "Arnold's" },
  { match: /\bmax burgers\b/, category: "Bars & eating out", name: "Max Burgers" },
  { match: /\b(unicafe|sodexo|amica|compass group|fazer food|juvenes)\b/, category: "Bars & eating out" },
  { match: /\b(ravintola|restaurant|kahvila|cafe|pizzeria|sushi|kebab|grill|bistro|burger|pub|baari|bar|public house|brewery|panimo|toastery)\b/, category: "Bars & eating out" },
  { match: /restaurants?\b|kippola\b|keller\b|kellari\b|kallare|källare|kammari\b/, category: "Bars & eating out" },

  // Groceries
  { match: /\bk-?citymarket\b/, category: "Groceries", name: "K-Citymarket" },
  { match: /\bk-?supermarket\b/, category: "Groceries", name: "K-Supermarket" },
  { match: /\bk-?market\b/, category: "Groceries", name: "K-Market" },
  { match: /\bs-?market\b/, category: "Groceries", name: "S-Market" },
  { match: /\bprisma\b/, category: "Groceries", name: "Prisma" },
  { match: /\balepa\b/, category: "Groceries", name: "Alepa" },
  { match: /^sale\b/, category: "Groceries", name: "Sale" },
  { match: /\blidl/, category: "Groceries", name: "Lidl" }, // "Lidlturkukeskusta"
  { match: /\b7-eleven\b/, category: "Groceries", name: "7-Eleven" },
  { match: /^r[-_ ]?kioski|^r_[a-z]+_/, category: "Groceries", name: "R-Kioski" }, // "R_TRE_Rautatieasema"
  { match: /\b(siwa|valintatalo|minimani|lähikauppa|m-market|food market herkku|sokos herkku)\b/, category: "Groceries" },

  // Transport
  { match: /\bhsl\b|\bhelsingin seudun\b/, category: "Transport", name: "HSL" }, // via MobilePay: "Helsingin Seudun"
  { match: /^vr\b|\bvr-yhtym|\bvr\.fi\b/, category: "Transport", name: "VR" },
  { match: /\b(matkahuolto|onnibus|nysse|föli|waltti)\b/, category: "Transport" },
  { match: /\buber\b/, category: "Transport", name: "Uber" },
  { match: /\bbolt\b/, category: "Transport", name: "Bolt" },
  { match: /\b(taksi|taxi|valopilkku|menevä)\b/, category: "Transport" },
  { match: /\b(neste|st1|teboil|shell|circle k|easypark|parkman|aimo park|tier|voi|lime)\b/, category: "Transport" },

  // Subscriptions
  { match: /\bnetflix\b/, category: "Subscriptions", name: "Netflix" },
  { match: /\bspotify\b/, category: "Subscriptions", name: "Spotify" },
  { match: /\bdisney\s*(plus|\+)/, category: "Subscriptions", name: "Disney+" },
  { match: /\bhbo\s*max\b|^max\b/, category: "Subscriptions", name: "HBO Max" },
  { match: /\bviaplay\b/, category: "Subscriptions", name: "Viaplay" },
  { match: /\byoutube\b/, category: "Subscriptions", name: "YouTube" },
  { match: /\bapple\.com\/bill|\bitunes\b|\bicloud\b/, category: "Subscriptions", name: "Apple" },
  { match: /\bgoogle\s*\*?\s*(one|storage|play)/, category: "Subscriptions", name: "Google" },
  { match: /\b(openai|chatgpt)\b/, category: "Subscriptions", name: "OpenAI" },
  { match: /\b(anthropic|claude\.ai)\b/, category: "Subscriptions", name: "Anthropic" },
  { match: /\b(storytel|bookbeat|nextory|audible|patreon|duolingo|dropbox|adobe|ruutu|hs\.fi|helsingin sanomat)\b/, category: "Subscriptions" },

  // Bills (telecom, energy, insurance)
  { match: /\b(elisa|dna|telia|moi mobiili)\b/, category: "Bills" },
  { match: /\b(helen|fortum|vattenfall|oomi|caruna|väre|hsy)\b/, category: "Bills" },
  { match: /\b(lähitapiola|pohjola vakuutus|if vakuutus|fennia|turva|vakuutus)\b/, category: "Bills" },

  // Travel
  { match: /\bsokos hotel/, category: "Travel", name: "Sokos Hotels" },
  { match: /\b(finnair|norwegian|ryanair|airbaltic|lufthansa|airbnb|booking\.com|hotels\.com|scandic|cumulus|tallink|silja|viking line|ecker|hostel|hotel|hotelli|sixt|hertz|avis|europcar)\b/, category: "Travel" },

  // Health and fitness
  { match: /\b(apteekki|apotek|terveystalo|mehiläinen|pihlajalinna|aava|hammas|optikko|instru|specsavers|silmäasema)\b/, category: "Health" },
  { match: /\b(sats|elixia|fressi|myfitness|unisport|kuntosali)\b/, category: "Health" },
  // Personal care
  { match: /\b(parturi|kampaamo|barber|barbershop|hair|frisör)\b/, category: "Health" },

  // Entertainment
  { match: /\b(finnkino|bio rex|steam|steampowered|playstation|xbox|nintendo|epic games|liveto|museo)\b/, category: "Entertainment" },
  { match: /tiketti|liputon|lippu\.fi|ticketmaster/, category: "Entertainment" }, // also glued: "httpswwwtikettifi"
  { match: /\b(golf|karaoke|arena|festival|teatteri|theatre|theater|keilailu|bowling)\b/, category: "Entertainment" },

  // Shopping
  { match: /\bamzn\b|\bamazon\b/, category: "Shopping", name: "Amazon" },
  { match: /\bzalando\b/, category: "Shopping", name: "Zalando" },
  { match: /\bikea\b/, category: "Shopping", name: "IKEA" },
  { match: /\btokmanni\b/, category: "Shopping", name: "Tokmanni" },
  { match: /\bverkkokauppa/, category: "Shopping", name: "Verkkokauppa.com" },
  { match: /\bgigantti\b/, category: "Shopping", name: "Gigantti" },
  { match: /\b(h&m|hennes|clas ohlson|power|jimm'?s|motonet|biltema|puuilo|xxl|intersport|stadium|sokos|stockmann|lindex|kappahl|normal|flying tiger|aliexpress|temu|shein|ebay|etsy|halpa-halli|suomalainen kirjakauppa|akateeminen|jysk|rusta|uniqlo|zara|lagerhaus|muji|alko|klarna|dhgate|levi'?s)\b/, category: "Shopping" },

  // Money moved to my own accounts elsewhere, and investing
  { match: /\brevolut\b/, category: "Transfers", name: "Revolut" },
  { match: /\b(nordnet|säästö)\b/, category: "Savings" },

  // Government fees
  { match: /\bpoliisi/, category: "Bills" },

  // Gambling (Trustly is a generic payment rail, so it's a per-merchant choice, not a rule here)
  { match: /\b(veikkaus|unibet|betsson|paf|coolbet|leovegas|kindred|pokerstars|bet365|casumo|mr green)\b/, category: "Gambling" },

  // Loans (usually only visible in the payment message)
  { match: /\b(opintolaina|lainanlyhennys|laina)\b/, category: "Loans" },

  // Income
  { match: /\b(kela|palkka|verohallinto|veronpalautus)\b/, category: "Income" },
  // S-Group bonus payout (an incoming OTHR/OTHR from the cooperative)
  { match: /\b(hok-elanto|osuuskauppa)\b/, category: "Income", types: ["other", "transfer_in"] },
  // Rent (usually only visible in the payment message)
  { match: /\b(vuokra|vastike|hoitovastike)\b/, category: "Housing" },
];

// Card processors that prefix the real merchant name ("SUMUP *Cafe X", "VFI*BAR X", "Paytrail Oyj wwwshopfi").
const PROCESSOR_PREFIX =
  /^(?:paypal|sumup|sq|ztl|zettle_?|iz|sp|tst|vps|vfi|nets|paytrail|mollie|stripe)\s*\*+\s*|^sp\s+(?=\S+\.(?:fi|com)$)|^paytrail oyj\s+/i;
// MobilePay payments look like card purchases. The payee is often a person, so the name keeps a "MobilePay" marker.
const MOBILEPAY_PREFIX = /^mob\.?pay\s*\*+\s*/i;

export function normalizeMerchant(counterparty: string): { key: string; name: string } {
  let name = counterparty
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const mobilePay = MOBILEPAY_PREFIX.test(name);
  const withoutPrefix = name.replace(MOBILEPAY_PREFIX, "").replace(PROCESSOR_PREFIX, "");
  if (withoutPrefix) name = withoutPrefix;
  // Web shops written without punctuation: "httpswwwtikettifi" → "tiketti.fi"
  const web = /^(?:https?:?\/*)?www\.?(.+?)\.?(fi|com|se)$/i.exec(name);
  if (web) name = `${web[1]}.${web[2]}`;

  const lower = name.toLowerCase();
  const canonical = BUILT_IN_RULES.find((r) => r.name && r.match.test(lower))?.name;
  if (canonical) return { key: canonical.toLowerCase(), name: canonical };

  // Drop store numbers and reference codes at the end: "ACME 12345", "ACME.COM1234567890", "ACME / 3".
  const trimmed = name
    .replace(/\d{4,}$/, "")
    .replace(/(\s+[#/]?\s*[A-Z]?\d[\d/-]*)+$/i, "")
    .replace(/[\s/*.#-]+$/, "")
    .trim();
  if (trimmed) name = trimmed;
  if (name === name.toUpperCase() && /[A-ZÅÄÖ]{4}/.test(name)) name = titleCase(name);
  if (mobilePay) name = `MobilePay ${name}`;
  // "A Huolto" and "A-Huolto" are the same merchant.
  return { key: name.toLowerCase().replace(/[\s_-]+/g, " "), name };
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s\-/.&*_])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function builtInCategory(text: string, type?: TxType): string | undefined {
  const lower = text.toLowerCase();
  return BUILT_IN_RULES.find((r) => r.match.test(lower) && (!r.types || (type && r.types.includes(type))))?.category;
}

export function categoryIds(db: Db): Map<string, number> {
  const rows = db.prepare("SELECT id, name FROM categories").all() as { id: number; name: string }[];
  return new Map(rows.map((r) => [r.name, r.id]));
}

interface TxRow {
  id: number;
  amount: number;
  counterparty: string | null;
  description: string | null;
  bank_code: string | null;
  sub_code: string | null;
  is_transfer: number;
  category_source: string | null;
}

interface MerchantRow {
  id: number;
  category_id: number | null;
  category_source: string | null;
}

export interface CategorizeResult {
  categorized: number;
  uncategorized: number;
}

// Recomputes type, merchant and category for every transaction except manually categorized ones.
// Cheap at this scale (a few thousand rows), and keeps results consistent when rules change.
export function categorize(db: Db): CategorizeResult {
  const ids = categoryIds(db);
  const userRules = (db.prepare("SELECT pattern, category_id FROM rules ORDER BY length(pattern) DESC").all() as {
    pattern: string;
    category_id: number;
  }[]).map((r) => ({ pattern: r.pattern.toLowerCase(), categoryId: r.category_id }));

  const rows = db
    .prepare(
      "SELECT id, amount, counterparty, description, bank_code, sub_code, is_transfer, category_source FROM transactions",
    )
    .all() as unknown as TxRow[];
  const findMerchant = db.prepare("SELECT id, category_id, category_source FROM merchants WHERE key = ?");
  const insertMerchant = db.prepare("INSERT INTO merchants (key, name) VALUES (?, ?)");
  const update = db.prepare(
    "UPDATE transactions SET type = ?, merchant_id = ?, category_id = ?, category_source = ? WHERE id = ?",
  );
  const updateTypeAndMerchant = db.prepare("UPDATE transactions SET type = ?, merchant_id = ? WHERE id = ?");

  const result: CategorizeResult = { categorized: 0, uncategorized: 0 };
  transaction(db, () => {
    for (const row of rows) {
      const type = txType(row.bank_code, row.sub_code, row.amount);
      let merchant: MerchantRow | undefined;
      let merchantName = "";
      if (row.counterparty) {
        const { key, name } = normalizeMerchant(row.counterparty);
        merchantName = name;
        merchant = findMerchant.get(key) as MerchantRow | undefined;
        if (!merchant) {
          const id = Number(insertMerchant.run(key, name).lastInsertRowid);
          merchant = { id, category_id: null, category_source: null };
        }
      }
      if (row.category_source === "user") {
        updateTypeAndMerchant.run(type, merchant?.id ?? null, row.id);
        result.categorized++;
        continue;
      }

      // The cleaned name matches where the raw one has glued codes ("SIXT1234567890" → "Sixt").
      const text = `${merchantName} ${row.counterparty ?? ""} ${row.description ?? ""}`.toLowerCase();
      let categoryId: number | undefined;
      let source: string | undefined;
      const pick = (id: number | undefined | null, src: string) => {
        if (categoryId === undefined && id != null) {
          categoryId = id;
          source = src;
        }
      };
      if (row.is_transfer) pick(ids.get("Transfers"), "transfer");
      if (merchant?.category_source === "user") pick(merchant.category_id, "merchant");
      pick(userRules.find((r) => text.includes(r.pattern))?.categoryId, "rule");
      const builtIn = builtInCategory(text, type);
      if (builtIn) pick(ids.get(builtIn), "rule");
      if (type === "transfer_in") pick(ids.get("Income"), "type");
      if (type === "cash") pick(ids.get("Other"), "type");
      // MobilePay to a person (no business rule matched): usually splitting a bill with friends.
      if (merchantName.startsWith("MobilePay ")) pick(ids.get("Other"), "type");

      update.run(type, merchant?.id ?? null, categoryId ?? null, source ?? null, row.id);
      if (categoryId === undefined) result.uncategorized++;
      else result.categorized++;
    }
    // Merchants left over after normalization changes, unless I categorized them.
    db.exec(
      `DELETE FROM merchants WHERE category_source IS NULL
         AND id NOT IN (SELECT merchant_id FROM transactions WHERE merchant_id IS NOT NULL)
         AND id NOT IN (SELECT merchant_id FROM recurring)`,
    );
  });
  return result;
}

// Manual recategorization. With applyToMerchant, the choice becomes the merchant's category
// for all its past and future transactions (that I haven't individually overridden).
export function setCategory(db: Db, transactionId: number, categoryId: number, applyToMerchant = false): void {
  transaction(db, () => {
    db.prepare("UPDATE transactions SET category_id = ?, category_source = 'user' WHERE id = ?").run(
      categoryId,
      transactionId,
    );
    if (!applyToMerchant) return;
    const { merchant_id } = (db.prepare("SELECT merchant_id FROM transactions WHERE id = ?").get(transactionId) ?? {}) as {
      merchant_id?: number | null;
    };
    if (merchant_id == null) return;
    db.prepare("UPDATE merchants SET category_id = ?, category_source = 'user' WHERE id = ?").run(categoryId, merchant_id);
  });
  if (applyToMerchant) categorize(db);
}

// Sets a merchant's category directly (e.g. from a merchant list), then re-applies it to its transactions.
export function setMerchantCategory(db: Db, merchantId: number, categoryId: number): void {
  db.prepare("UPDATE merchants SET category_id = ?, category_source = 'user' WHERE id = ?").run(categoryId, merchantId);
  categorize(db);
}

// A pattern rule I define, e.g. "vuokra" → Housing. Matches counterparty + payment message, case-insensitive.
export function addRule(db: Db, pattern: string, categoryId: number): void {
  db.prepare(
    "INSERT INTO rules (pattern, category_id) VALUES (?, ?) ON CONFLICT (pattern) DO UPDATE SET category_id = excluded.category_id",
  ).run(pattern.trim().toLowerCase(), categoryId);
  categorize(db);
}
