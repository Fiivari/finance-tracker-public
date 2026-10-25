// Pure logic: categorization, transfers, recurring payments and the summary. No Apps Script APIs here,
// so test/gas.test.ts can run this file in Node. Money is integer cents; dates are "YYYY-MM-DD" strings.
// Apps Script loads every .js file into one global scope, so these names are visible to the other files.

// Name, group (needs / wants / savings / income / transfer), icon. Seeds the Categories sheet.
const DEFAULT_CATEGORIES = [
  ["Groceries", "needs", "🛒"],
  ["Bars & eating out", "wants", "🍽️"],
  ["Transport", "needs", "🚌"],
  ["Housing", "needs", "🏠"],
  ["Bills", "needs", "🧾"],
  ["Loans", "needs", "🏦"],
  ["Subscriptions", "wants", "🔁"],
  ["Shopping", "wants", "🛍️"],
  ["Health", "needs", "💊"],
  ["Entertainment", "wants", "🎬"],
  ["Gambling", "wants", "🎰"],
  ["Travel", "wants", "✈️"],
  ["Income", "income", "💶"],
  ["Savings", "savings", "💰"],
  ["Transfers", "transfer", "🔄"],
  ["Other", "wants", "📦"],
];

// S-Pankki codes seen so far: CCRD/POSD (debit card on S-TILI), CCRD/POSC (credit card), CCRD/XBCP (cross-border
// card), CCRD/OTHR (credit card bill arriving on the card), RCDT (incoming transfer), ICDT/IRCT (outgoing transfer).
function txType(code, subCode, amount) {
  if (code === "CCRD") {
    if (subCode === "OTHR") return "card_bill";
    if (subCode === "CWDL" || subCode === "CDPT") return "cash";
    return amount > 0 ? "card_refund" : "card";
  }
  if (code === "RCDT") return "transfer_in";
  if (code === "ICDT" || code === "IRCT") return "transfer_out";
  return "other";
}

// { match, category, name?: canonical merchant name, types?: only for these transaction types }
// Order matters: first match wins (e.g. "Uber Eats" before "Uber", "Sokos Hotel" before "Sokos").
const BUILT_IN_RULES = [
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

// "K-MARKET ASEMA 123" → { key: "k-market", name: "K-Market" }
function normalizeMerchant(counterparty) {
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

function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s\-/.&*_])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

function builtInCategory(text, type) {
  const lower = text.toLowerCase();
  return BUILT_IN_RULES.find((r) => r.match.test(lower) && (!r.types || (type && r.types.includes(type))))?.category;
}

// Sets type, merchant, merchantKey, category and source on every transaction.
// Precedence: my override > transfer > my merchant category > my rules > built-in rules > type fallback.
// merchantCategories: Map(merchant key → category I picked). rules: [{ pattern, category }] substring matches.
function categorizeAll(txs, merchantCategories, rules) {
  const userRules = rules
    .map((r) => ({ pattern: String(r.pattern).trim().toLowerCase(), category: r.category }))
    .filter((r) => r.pattern && r.category)
    .sort((a, b) => b.pattern.length - a.pattern.length);
  for (const tx of txs) {
    tx.type = txType(tx.code, tx.subCode, tx.amount);
    tx.merchant = "";
    tx.merchantKey = "";
    if (tx.counterparty) {
      const m = normalizeMerchant(tx.counterparty);
      tx.merchant = m.name;
      tx.merchantKey = m.key;
    }
    // The cleaned name matches where the raw one has glued codes ("SIXT1234567890" → "Sixt").
    const text = `${tx.merchant} ${tx.counterparty || ""} ${tx.description || ""}`.toLowerCase();
    const candidates = [
      [tx.override, "override"],
      [tx.transfer ? "Transfers" : "", "transfer"],
      [merchantCategories.get(tx.merchantKey), "merchant"],
      [userRules.find((r) => text.includes(r.pattern))?.category, "rule"],
      [builtInCategory(text, tx.type), "built-in"],
      [tx.type === "transfer_in" ? "Income" : tx.type === "cash" ? "Other" : "", "type"],
      // MobilePay to a person (no business rule matched): usually splitting a bill with friends.
      [tx.merchant.startsWith("MobilePay ") ? "Other" : "", "type"],
    ];
    const hit = candidates.find(([category]) => category);
    tx.category = hit ? hit[0] : "";
    tx.source = hit ? hit[1] : "";
  }
}

// --- Transfers between my own accounts ---
// S-Pankki doesn't return counterparty IBANs, so an outgoing and an incoming transaction of the same amount
// on different own accounts within a few days are paired. Card purchases are never transfers; CCRD/OTHR is
// how a credit-card bill payment arrives on the card account.
const NON_TRANSFER_CODES = new Set(["CCRD/POSC", "CCRD/POSD", "CCRD/XBCP", "CCRD/CWDL", "CCRD/CDPT"]);
const TRANSFER_MAX_DAYS_APART = 3;

// Greedy pairing among transactions not yet marked: each debit takes the closest-dated unused credit of the
// opposite amount. Marks both with transfer = true. Returns the number of new pairs.
function markTransfers(txs) {
  const eligible = txs.filter((t) => !t.transfer && t.amount !== 0 && !NON_TRANSFER_CODES.has(`${t.code}/${t.subCode}`));
  const debits = eligible.filter((t) => t.amount < 0).sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
  const credits = eligible.filter((t) => t.amount > 0).sort((a, b) => a.key.localeCompare(b.key));
  let pairs = 0;
  for (const debit of debits) {
    let best;
    let bestGap = Infinity;
    for (const credit of credits) {
      if (credit.transfer || credit.account === debit.account || credit.amount !== -debit.amount) continue;
      const gap = Math.abs(daysBetween(debit.date, credit.date));
      if (gap <= TRANSFER_MAX_DAYS_APART && gap < bestGap) {
        best = credit;
        bestGap = gap;
      }
    }
    if (best) {
      debit.transfer = true;
      best.transfer = true;
      pairs++;
    }
  }
  return pairs;
}

// --- Recurring payments (subscriptions, bills, salary) ---
const RECURRING_PERIODS = [7, 14, 30, 91]; // weekly, biweekly, monthly, quarterly
const RECURRING_MIN_OCCURRENCES = 3;
const RECURRING_AMOUNT_TOLERANCE = 0.25; // amounts within ±25% of the median

// occurrences: [{ date, amount }] for one merchant and direction. Returns the pattern if regular and still active.
function findPattern(occurrences, today) {
  // Several payments on one day count once (summed), e.g. a bill split in two.
  const byDate = new Map();
  for (const o of occurrences) byDate.set(o.date, (byDate.get(o.date) || 0) + o.amount);
  const dates = [...byDate.keys()].sort();
  if (dates.length < RECURRING_MIN_OCCURRENCES) return undefined;

  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
  const period = RECURRING_PERIODS.find((p) => gaps.every((g) => Math.abs(g - p) <= Math.max(3, p * 0.2)));
  if (!period) return undefined;

  const amounts = [...byDate.values()];
  const typical = median(amounts);
  if (!amounts.every((a) => Math.abs(a - typical) <= Math.abs(typical) * RECURRING_AMOUNT_TOLERANCE)) return undefined;

  const lastDate = dates[dates.length - 1];
  const intervalDays = Math.round(median(gaps));
  // Stopped: more than one and a half intervals without a payment.
  if (daysBetween(lastDate, today) > intervalDays * 1.5 + 3) return undefined;
  // The latest amount predicts the next one best (pay rises, price changes); the median only decides similarity.
  const amount = byDate.get(lastDate);
  return { intervalDays, amount, occurrences: dates.length, lastDate, nextExpectedDate: addDays(lastDate, intervalDays) };
}

// All recurring patterns among categorized, non-transfer transactions with a merchant.
function detectRecurring(txs, today) {
  const groups = new Map();
  for (const t of [...txs].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!t.merchantKey || t.transfer || t.amount === 0) continue;
    const key = `${t.merchantKey}:${t.amount > 0}`;
    const group = groups.get(key) || { merchant: t.merchant, income: t.amount > 0, category: t.category, items: [] };
    group.items.push(t);
    group.category = t.category || group.category;
    groups.set(key, group);
  }
  const result = [];
  for (const g of groups.values()) {
    for (const cluster of amountClusters(g.items)) {
      const p = findPattern(cluster, today);
      if (!p) continue;
      const kind = g.income ? "income" : g.category === "Subscriptions" ? "subscription" : "bill";
      result.push({ merchant: g.merchant, kind, ...p });
    }
  }
  return result.sort((a, b) => a.nextExpectedDate.localeCompare(b.nextExpectedDate));
}

// One merchant can have several regular payments (e.g. rent plus a small extra fee to the same payee), so its
// payments are split into groups of similar size and each group is checked for a pattern on its own.
function amountClusters(items) {
  const sorted = [...items].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount));
  const clusters = [];
  for (const item of sorted) {
    const current = clusters[clusters.length - 1];
    if (current && Math.abs(item.amount) <= Math.abs(current[0].amount) * (1 + RECURRING_AMOUNT_TOLERANCE)) current.push(item);
    else clusters.push([item]);
  }
  return clusters;
}

// --- Summary: safe to spend, this month vs last ---
// "Spending" = non-transfer transactions in needs/wants categories (or uncategorized), net of refunds.

// accounts: [{ label, type, booked, available }] latest balance per account (cents).
// groups: Map(category → group). recurring: from detectRecurring. consentValidUntil: ISO string or "".
function summarize(txs, accounts, recurring, groups, consentValidUntil, today, now) {
  const isSpending = (t) => !t.transfer && (!t.category || ["needs", "wants"].includes(groups.get(t.category)));
  const spentBetween = (from, to) =>
    -sum(txs.filter((t) => isSpending(t) && t.date >= from && t.date <= to).map((t) => t.amount));

  // Card account: booked is the balance (negative = owed); available is unused credit, so it's not cash.
  const cash = sum(accounts.filter((a) => a.type !== "CARD").map((a) => (a.available != null ? a.available : a.booked || 0)));
  const cardOwed = sum(accounts.filter((a) => a.type === "CARD").map((a) => Math.max(0, -(a.booked || 0))));

  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthStart = shiftMonth(monthStart, -1);
  const payday = nextPayday(today);
  const daysLeft = Math.max(1, daysBetween(today, payday));
  const upcoming = upcomingBills(recurring, today, payday);
  const total = cash - cardOwed + sum(upcoming.map((u) => u.amount));

  return {
    today,
    cash,
    cardOwed,
    payday,
    daysLeft,
    upcoming,
    safeToSpend: total,
    safeToSpendPerDay: Math.floor(Math.max(0, total) / daysLeft),
    spentThisMonth: spentBetween(monthStart, today),
    spentLastMonthToDate: spentBetween(lastMonthStart, shiftMonth(today, -1)),
    spentLastMonth: spentBetween(lastMonthStart, addDays(monthStart, -1)),
    incomeThisMonth: sum(txs.filter((t) => !t.transfer && groups.get(t.category) === "income" && t.date >= monthStart).map((t) => t.amount)),
    uncategorized: txs.filter((t) => !t.category).length,
    consentDaysLeft: consentValidUntil ? Math.floor((Date.parse(consentValidUntil) - now.getTime()) / 86400000) : null,
  };
}

// Salary day of the month from the Settings sheet (31 = the last day of every month), moved to the last weekday
// before it when it falls on a Saturday or Sunday. Set before computing anything that depends on payday.
const DEFAULT_PAYDAY = 14;
let paydayDayOfMonth = DEFAULT_PAYDAY;

function setPaydayDay(day) {
  const d = Math.round(Number(day));
  paydayDayOfMonth = d >= 1 && d <= 31 ? d : DEFAULT_PAYDAY;
}

// The next payday on or after today.
function nextPayday(today) {
  const thisMonth = paydayIn(today.slice(0, 7));
  return thisMonth >= today ? thisMonth : paydayIn(shiftMonth(`${today.slice(0, 7)}-01`, 1).slice(0, 7));
}

// The payday that started the current pay period (today, if today is payday).
function previousPayday(today) {
  const thisMonth = paydayIn(today.slice(0, 7));
  return thisMonth <= today ? thisMonth : paydayIn(shiftMonth(`${today.slice(0, 7)}-01`, -1).slice(0, 7));
}

function paydayIn(month) {
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  let date = `${month}-${String(Math.min(paydayDayOfMonth, lastDay)).padStart(2, "0")}`;
  while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = addDays(date, -1);
  return date;
}

// Every occurrence of a recurring bill/subscription before payday, including ones due but not yet arrived.
function upcomingBills(recurring, today, payday) {
  const result = [];
  for (const r of recurring) {
    if (r.kind === "income") continue;
    for (let date = r.nextExpectedDate; date < payday; date = addDays(date, r.intervalDays)) {
      result.push({ merchant: r.merchant, kind: r.kind, amount: r.amount, date: date < today ? today : date });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

// Rows of [month, category, group, total cents, count] for non-transfer transactions, newest month first.
function monthlyTotals(txs, groups) {
  const totals = new Map();
  for (const t of txs) {
    if (t.transfer) continue;
    const category = t.category || "Uncategorized";
    const key = `${t.date.slice(0, 7)}|${category}`;
    const row = totals.get(key) || [t.date.slice(0, 7), category, groups.get(category) || "wants", 0, 0];
    row[3] += t.amount;
    row[4]++;
    totals.set(key, row);
  }
  return [...totals.values()].sort((a, b) => b[0].localeCompare(a[0]) || a[3] - b[3]);
}

// --- Dashboard data (the web app embeds this object in the page) ---
const DASHBOARD_MONTHS = 6;

// savingsGoal: cents per pay period (0 = none).
function buildDashboard(txs, balances, recurring, groups, icons, consentValidUntil, today, now, savingsGoal, extra) {
  const s = summarize(txs, balances, recurring, groups, consentValidUntil, today, now);
  const isSpending = (t) => !t.transfer && (!t.category || ["needs", "wants"].includes(groups.get(t.category)));
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthStart = shiftMonth(monthStart, -1);

  // Cumulative spending per day of the month: this month up to today, last month in full.
  const pace = (start, end) => {
    const daily = new Array(daysBetween(start, end) + 1).fill(0);
    for (const t of txs) if (isSpending(t) && t.date >= start && t.date <= end) daily[daysBetween(start, t.date)] -= t.amount;
    let running = 0;
    return daily.map((v) => (running += v));
  };

  const firstDate = txs.reduce((min, t) => (t.date < min ? t.date : min), today);
  const months = [];
  for (let i = 0; i < DASHBOARD_MONTHS; i++) {
    const month = shiftMonth(monthStart, -i).slice(0, 7);
    if (`${month}-31` < firstDate) break;
    const inMonth = txs.filter((t) => !t.transfer && t.date.startsWith(month));
    const byCategory = new Map();
    for (const t of inMonth.filter(isSpending)) {
      const name = t.category || "Uncategorized";
      const c = byCategory.get(name) || { name, icon: icons.get(name) || "•", group: groups.get(name) || "wants", total: 0, count: 0 };
      c.total -= t.amount;
      c.count++;
      byCategory.set(name, c);
    }
    const spentIn = (group) => -sum(inMonth.filter((t) => isSpending(t) && (groups.get(t.category) || "wants") === group).map((t) => t.amount));
    months.push({
      month,
      spent: -sum(inMonth.filter(isSpending).map((t) => t.amount)),
      needs: spentIn("needs"),
      wants: spentIn("wants"),
      income: sum(inMonth.filter((t) => groups.get(t.category) === "income").map((t) => t.amount)),
      saved: -sum(inMonth.filter((t) => groups.get(t.category) === "savings").map((t) => t.amount)),
      categories: [...byCategory.values()].filter((c) => c.total > 0).sort((a, b) => b.total - a.total),
    });
  }

  const historyStart = shiftMonth(monthStart, -(DASHBOARD_MONTHS - 1));

  // Every transaction, newest first, with short keys to keep the page small: d date, m merchant, c category,
  // a amount (cents), x transfer between my own accounts, k sheet key, s category source (override, merchant…),
  // b has a merchant (so "all from this merchant" can apply).
  const transactions = [...txs]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((t) => ({ d: t.date, m: t.merchant, c: t.category, a: t.amount, x: t.transfer ? 1 : 0, k: t.key, s: t.source || "", b: t.hasMerchant ? 1 : 0 }));

  return Object.assign(s, {
    savings: savingsPlan(txs, s, recurring, groups, firstDate, savingsGoal),
    challenges: monthlyChallenges(months, firstDate),
    balance: balanceHistory(txs, balances, today, historyStart > firstDate ? historyStart : firstDate),
    pace: { thisMonth: pace(monthStart, today), lastMonth: pace(lastMonthStart, addDays(monthStart, -1)) },
    months,
    transactions,
    categories: [...groups.keys()].map((name) => ({ name, group: groups.get(name), icon: icons.get(name) || "•" })),
    periodStart: previousPayday(today),
    recurring: recurring.map((r) => ({ merchant: r.merchant, kind: r.kind, amount: r.amount, every: r.intervalDays, next: r.nextExpectedDate })),
    balances,
  }, extra || {});
}

// --- Saving: pay yourself first ---
const TYPICAL_SPENDING_DAYS = 28;
const SAVING_BUFFER = 1.2; // keep 20% more than the usual day-to-day spending until payday

const GOAL_TIGHT = 0.8; // a goal is still in reach if it needs at most 20% less day-to-day spending than usual

// How much can go to savings now without running short before payday: safe-to-spend minus the usual day-to-day
// spending (as in the week card: no transfers, housing, loans, bills or recurring payments) of the last 4 weeks
// for the days left, in whole tens of euros. `saved` is what went to savings-group categories this pay period
// (withdrawals subtract), so the page can reward a transfer once it shows up.
// goal (cents per pay period, 0 = none): goalStatus is "done", "ok" (the rest fits with the usual spending + 20%),
// "tight" (fits if spending stays under the usual + 20% but not more than 20% under it) or "out"; perDayIfGoal is
// what's left per day once the rest of the goal is moved, and reachable what the period can realistically end at.
function savingsPlan(txs, s, recurring, groups, firstDate, goal) {
  const recurringMerchants = new Set(recurring.map((r) => r.merchant));
  const from = addDays(s.today, -(TYPICAL_SPENDING_DAYS - 1));
  const days = daysBetween(from > firstDate ? from : firstDate, s.today) + 1;
  const dayToDay = -sum(
    txs
      .filter((t) => !t.transfer && t.date >= from && t.date <= s.today)
      .filter((t) => (!t.category || ["needs", "wants"].includes(groups.get(t.category))) && !["Housing", "Loans", "Bills"].includes(t.category))
      .filter((t) => !recurringMerchants.has(t.merchant))
      .map((t) => t.amount),
  );
  const typicalDaily = Math.max(0, Math.round(dayToDay / days));
  const spare = s.safeToSpend - Math.round(typicalDaily * s.daysLeft * SAVING_BUFFER);
  const suggested = Math.max(0, Math.floor(spare / 1000) * 1000);
  const periodStart = previousPayday(s.today);
  const saved = -sum(txs.filter((t) => !t.transfer && groups.get(t.category) === "savings" && t.date >= periodStart && t.date <= s.today).map((t) => t.amount));
  goal = Math.max(0, goal || 0);
  const remaining = Math.max(0, goal - saved);
  const perDayIfGoal = Math.floor((s.safeToSpend - remaining) / s.daysLeft);
  let goalStatus = null;
  if (goal) {
    if (!remaining) goalStatus = "done";
    else if (perDayIfGoal >= typicalDaily * SAVING_BUFFER) goalStatus = "ok";
    else if (perDayIfGoal >= 0 && perDayIfGoal >= typicalDaily * GOAL_TIGHT) goalStatus = "tight";
    else goalStatus = "out";
  }
  return {
    suggested,
    saved,
    typicalDaily,
    perDayAfter: Math.floor(Math.max(0, s.safeToSpend - suggested) / s.daysLeft),
    goal,
    remaining,
    goalStatus,
    perDayIfGoal,
    reachable: Math.max(saved, saved + Math.floor(Math.max(0, s.safeToSpend - typicalDaily * s.daysLeft) / 1000) * 1000),
    periodEnd: addDays(nextPayday(s.today), -1),
  };
}

// --- Monthly challenge ---
// Each month the "wants" category with the highest average over up to 3 earlier complete months becomes a
// challenge: spend 15% less than usual. Months that started before the first transaction don't count.
const CHALLENGE_SHARE = 0.85;
const CHALLENGE_MIN_USUAL = 3000; // below 30 €/month there's nothing worth cutting
const CHALLENGE_SKIP = ["Subscriptions", "Uncategorized"]; // fixed prices, or not a real category

// months: newest first, as in buildDashboard. Returns [{ month, category, usual, target, spent }], newest first.
function monthlyChallenges(months, firstDate) {
  const result = [];
  months.forEach((m, i) => {
    const before = months.slice(i + 1, i + 4).filter((p) => `${p.month}-01` >= firstDate);
    if (!before.length) return;
    const totals = new Map();
    for (const p of before) {
      for (const c of p.categories) if (c.group === "wants" && !CHALLENGE_SKIP.includes(c.name)) totals.set(c.name, (totals.get(c.name) || 0) + c.total);
    }
    const top = [...totals].sort((a, b) => b[1] - a[1])[0];
    const usual = top ? Math.round(top[1] / before.length) : 0;
    if (usual < CHALLENGE_MIN_USUAL) return;
    const spent = (m.categories.find((c) => c.name === top[0]) || {}).total || 0;
    result.push({ month: m.month, category: top[0], usual, target: Math.floor((usual * CHALLENGE_SHARE) / 1000) * 1000, spent });
  });
  return result;
}

// Net balance of all accounts (card debt negative) at the end of each day from `from` to today, rebuilt
// backwards from today's booked balances by undoing each later transaction. Transfers between my own accounts
// cancel out. Null without balances.
function balanceHistory(txs, balances, today, from) {
  if (!balances.length || from > today) return null;
  const net = sum(balances.map((a) => (a.booked != null ? a.booked : a.type === "CARD" ? 0 : a.available || 0)));
  const change = new Map();
  for (const t of txs) if (t.date > from && t.date <= today) change.set(t.date, (change.get(t.date) || 0) + t.amount);
  const values = new Array(daysBetween(from, today) + 1);
  values[values.length - 1] = net;
  for (let i = values.length - 1; i > 0; i--) values[i - 1] = values[i] - (change.get(addDays(from, i)) || 0);
  return { start: from, values };
}

// --- Bank data ---

// A transaction from the Enable Banking API as a sheet row object, or undefined if it isn't booked: only
// booked transactions have a stable entry_reference to deduplicate on. acct: the account key.
function fromBank(acct, label, t) {
  const date = t.booking_date || t.value_date || t.transaction_date;
  if (!t.entry_reference || !date || t.status !== "BOOK") return undefined;
  const isDebit = t.credit_debit_indicator === "DBIT";
  const cents = Math.abs(toCents(t.transaction_amount.amount));
  return {
    key: `${acct}|${t.entry_reference}`,
    account: acct,
    accountLabel: label,
    date,
    amount: isDebit ? -cents : cents,
    counterparty: (isDebit ? t.creditor && t.creditor.name : t.debtor && t.debtor.name) || "",
    description: (t.remittance_information || []).join(" "),
    code: (t.bank_transaction_code && t.bank_transaction_code.code) || "",
    subCode: (t.bank_transaction_code && t.bank_transaction_code.sub_code) || "",
    override: "",
    transfer: false,
  };
}

// Booked and available balance in cents (null if missing) from an account's balance list. Banks report different
// balance types: interim (ITBD/ITAV) at S-Pankki, closing (CLBD/CLAV) or expected (XPCD) elsewhere.
function pickBalances(balances) {
  const pick = (...types) => {
    for (const type of types) {
      const b = balances.find((x) => x.balance_type === type);
      if (b) return toCents(b.balance_amount.amount);
    }
    return null;
  };
  return { booked: pick("ITBD", "CLBD", "XPCD", "OPBD"), available: pick("ITAV", "CLAV", "XPCD") };
}

// --- Helpers ---

// Parses a decimal string ("-12.3") to integer cents without going through floats.
function toCents(amount) {
  const match = /^([+-])?(\d+)(?:\.(\d{1,2}))?$/.exec(String(amount).trim());
  if (!match) throw new Error(`Unexpected amount format: ${amount}`);
  const cents = Number(match[2]) * 100 + Number((match[3] || "").padEnd(2, "0"));
  return match[1] === "-" ? -cents : cents;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

// Same day in another month, clamped to that month's length (Mar 31 − 1 month → Feb 28).
function shiftMonth(date, months) {
  const [y, m, d] = date.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}
