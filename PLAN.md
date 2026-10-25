# Personal Finance App — Implementation Plan

A private, single-user web app (installed to the iPhone home screen) that syncs my S-Pankki transactions,
tracks spending, encourages saving and helps plan purchases. Think "personal savings coach", not investment advisor.

Last updated: 2026-10-25 (sharing with friends: public repo + Claude Code onboarding, Phase 7)

---

## 1. Decisions made

> **2026-10-24 direction change:** no self-hosted server, no public URL. The bank sync runs in **Google Apps Script**
> (time trigger every 4 h) bound to a **Google Sheet**, which is the database and the phone view (Sheets app).
> A Claude-made dashboard and Claude Q&A read the sheet (Looker Studio as fallback). Reason: free, simplest, nothing
> to host or secure ourselves. Trade-off accepted: the Enable Banking private key (Script Properties) and the data
> live in my Google account, so that account's security (2FA) is what protects them.
> The Node server / PWA / passkey / Fly.io rows below are superseded; that code was deleted (never committed). `src/` keeps the Phase 1–2 local tooling.

| Topic | Decision | Why |
|---|---|---|
| Bank | Keep **S-Pankki** (no switch to Revolut) | Revolut has no personal-account API; PSD2 aggregators reach S-Pankki anyway |
| Bank data access | **Enable Banking**, production app in *restricted mode* (only my own linked accounts, free) | GoCardless/Nordigen closed to new sign-ups since July 2025; Enable Banking is Finnish with good Nordic coverage |
| Access type | **Read-only** (account information only; no payment initiation) | App never needs to move money |
| Platform | **Progressive Web App** on iPhone home screen | No Mac / Xcode / $99 Apple account needed; I develop on Windows |
| Language | **TypeScript** end to end, Node 24 | One language front + back; Node 24 runs `.ts` natively |
| Priorities | **Fast and secure** over feature breadth | |
| Server | **Plain Node server** (`node:http`), no framework | Zero dependencies; the UI is small enough to hand-write (confirmed 2026-10-24) |
| Database | **SQLite** via built-in `node:sqlite` (`data/finance.db`, `DB_PATH` to override) | Single user, a few thousand rows a year; no ORM/driver dependency; migrations = SQL list + `PRAGMA user_version` |
| Hosting | **Fly.io**, region `arn` (Stockholm); SQLite on an encrypted Fly volume (+ Litestream or volume snapshots for backup) | Data stays in the EU; flyctl already installed |

| Auth | **Passkeys, hand-written WebAuthn** on `node:crypto` (`src/webauthn.ts`), no library (decided 2026-10-24) | Zero dependencies; narrow scope ("none" attestation, ES256/EdDSA/RS256, UV required) keeps it small and fully tested |
| Bank session | **`bank_sessions.data` in the DB**, written by the in-app reconnect flow; `secrets/session.json` only a local fallback (2026-10-24) | Renewing consent from the phone without `fly secrets set`; the session is useless without the private key |
| Safe-to-spend | **Cash available − credit card owed − recurring bills before payday, ÷ days to payday** (2026-10-24) | Card purchases count as spent immediately |

### Still proposed
- **LLM:** not used for categorization (dropped 2026-10-24). Phase 6 AI coach needs a provider decision; no Anthropic key available.
- **Network exposure:** public HTTPS app with passkey auth (a private-network/Tailscale-only setup was considered and rejected 2026-10-24).

---

## 2. Current state

### Phase 3 (revised) — Google Sheets + Apps Script (code done, not yet installed in Google)
- `gas/` is the Apps Script project (pushed with clasp, `rootDir` = gas): `Logic.js` (pure: categorization incl. the built-in rules, transfers, recurring, safe-to-spend summary, monthly totals), `Bank.js` (Enable Banking client, RS256 JWT via `Utilities.computeRsaSha256Signature`), `Sheets.js` (layout, setup, row I/O), `Sync.js` (the 4-hourly job), `Menu.js` (Finance menu: Sync now, Reconnect bank, Finish reconnect, Set up).
- Sheets: Summary, Transactions (Override column = per-transaction category), Merchants ("My category" = apply to all from merchant), Monthly, Recurring, Rules, Balances, Categories, Sync log. Category columns have dropdowns.
- Script Properties: `EB_APP_ID`, `EB_PRIVATE_KEY` (PKCS#8 PEM; flattened line breaks are repaired), `SESSION` (written by the reconnect flow).
- Consent renewal: menu → link → approve in S-mobiili → paste the redirected `https://localhost:8443/callback?...` address (already-registered redirect URL, so no web app endpoint is exposed). Menus only work in a desktop browser.
- Security: minimal OAuth scopes (`spreadsheets.currentonly`, `script.external_request` limited by `urlFetchWhitelist` to api.enablebanking.com, `script.scriptapp`, `script.container.ui`); bank text is escaped so it can't become a formula; accounts are keyed by a SHA-256 of the IBAN, IBANs aren't stored.
- Verified: `Logic.js` gives identical results to the TypeScript version on the first user's real transactions (categories, merchants, transfers, recurring). `test/gas.test.ts` runs the whole sync against a fake spreadsheet + fake bank (`test/fake-apps-script.ts`).
- Migration: only my merchant choices needed to move (`node --env-file=.env scripts/export-merchant-choices.ts` → `data/export/merchant-choices.csv`, import into the Merchants tab). The 90 days of transactions are fetched again by the first sync.
- **Installed and syncing** (2026-10-24).
- **Dashboard** (`gas/Web.js` + `gas/Dashboard.html`): Apps Script web app, access "Only myself" (manifest `webapp`), opened at `https://script.google.com/macros/s/<@HEAD deployment id>/dev`; get the id from `clasp list-deployments`. The script id in that URL gives a 404. The page always runs the latest pushed code and only the owner can open it. Rebuilt from the sheet on every visit via `buildDashboard()` in Logic.js. UI in Finnish (category names translated in the page; the sheet keeps English names) with three tabs: Koti (safe-to-spend hero with pay-period progress, spending pace vs last month, regular payments, latest 5), Tapahtumat (all transactions: search, category and month chips, grouped by day), Kuukaudet (daily net balance line — all accounts' booked balance minus card debt, rebuilt backwards from today's balances by undoing later transactions (`balanceHistory()`), so no extra sheet is needed; 6-month income vs spending columns with "Jäi yli" and % of income → needs/wants split and category bars with a 6-month mini trend each, opening the filtered transactions). Light and dark theme (follows the system setting; the sun/moon button next to the bank chip overrides it, saved in localStorage under `theme`). Koti also has "Tämä viikko" (day-to-day spending per weekday vs the daily budget, streak, biggest purchase). Feel: views are cached per tab and slide in by direction, pull to refresh calls the public `dashboardData()` via `google.script.run` (no page reload, numbers tick from old to new), swipe between months, look: "light terminal" (grid hero panel — white graph paper in light mode, dark instrument panel in dark mode (2026-10-25), Inter + JetBrains Mono from Google Fonts, hairline borders, merchant monogram tiles and category colour dots instead of the sheet's emoji icons; decided 2026-10-25), hero accent follows the month's pace (blue / amber ≤25 % over last month / red), confetti once a day when ahead of last month (or tap the big number). Bank access countdown is always shown: green, yellow from 30 days, red from 3 days, plus a banner from 14 days. Inline SVG, no libraries; data embedded as JSON with `<` escaped; text only via textContent.
- **Saving nudges** (2026-10-25, picked from a comparison with YNAB/Monarch/Copilot/Rocket Money/Cleo; criteria: makes saving easier, no configuration, rewards good decisions). Koti → "Säästöt": *pay yourself first* suggestion = safe-to-spend − 1.2 × the usual day-to-day spending of the last 28 days × days to payday, in whole tens (`savingsPlan()`); a jar fills with this pay period's Savings-category transfers (withdrawals subtract), coins + confetti once per new transfer (remembered in localStorage per period). A monthly challenge (one wants category to keep 15 % under its usual amount) was tried and removed on 2026-10-25. Rejected for now to avoid feature overload: configurable budgets, notifications, wishlist, bill calendar.
- `clasp push` silently skips when `appsscript.json` changed; use `clasp push --force` then.
- **Claude Q&A** works account-wide: claude.ai Google Drive connector + the `personal-finance` skill (`skill/personal-finance/SKILL.md`; zip it to upload in Settings → Capabilities → Skills).
- **Demo video** (`demo/`): 45 s 9:16 English mock-data animation in `index.html` (every frame is `seek(t)`, no CSS transitions); `cd demo && npm install && npm run render` captures it at 60 fps with Edge (playwright-core) + ffmpeg-static into `dist/finance-demo.mp4`.
- **Recategorizing from the phone** (2026-10-25): tap a transaction (not own transfers) → bottom sheet with the categories and a "Kaikki kaupan tapahtumat" switch (on by default, off when the row already has its own override). Calls `setCategory(key, category, forMerchant)` in `Web.js`: writes Override (one) or My category in Merchants (all, and clears this row's override), then `recompute_()` in `Sync.js` (the sync's post-fetch step, split out) recategorizes and rewrites every derived sheet without calling the bank; the summary keeps the last sync's time and warnings. "Palauta automaattinen" / "Poista kaupan oma kategoria" removes my choice. Uses the script lock, so it can't collide with the 4-hourly sync.
- Checked with real data (2026-10-25): the "Tämä viikko" streak is meaningful.
- **Savings goal** (2026-10-25): Settings sheet (`Settings` → "Savings goal per pay period", 1000 € by default, 0 = off; created with the default on first read, so no setup re-run is needed). Measured per pay period (payday to the day before the next) as the net of Savings-category transactions (withdrawals subtract). `savingsPlan()` gives the status: *done*; *ok* if after moving the rest there's still ≥ 1.2 × the usual day-to-day spending per day until payday; *tight* if ≥ 0.8 ×; else *out of reach*, with a realistic end amount. The Säästöt jar fills towards the goal; Summary also shows goal, saved and status for Claude Q&A.
- Next: nothing open in Phase 3; Phases 4–6 are optional (kept small on purpose).

### Phase 3 — Web app MVP (SHELVED 2026-10-24, code deleted; kept here as a record of what was tried)
- `src/app.ts` (routes, testable without the bank), `src/server.ts` (listen + sync timer), `src/http.ts` (CSP/HSTS/etc., rate limiter, JSON, cookies, static files loaded once from `public/`).
- **Auth** (`src/auth.ts`, `src/webauthn.ts`): discoverable passkeys, user verification required. First passkey needs `REGISTRATION_TOKEN` (env/Fly secret); once one exists, registration only from a logged-in session ("Add a passkey on another device"). Sessions: random 32-byte token in an `HttpOnly; SameSite=Strict` cookie (`__Host-session` + `Secure` on https), only its SHA-256 stored (`auth_sessions`), 14-day idle / 90-day absolute expiry. Challenges in memory, one-time, 5 min.
- **CSRF**: SameSite=Strict + every non-GET API request must carry `Origin` = `ORIGIN`. **Rate limits**: 300 req/min per IP, 20/min on `/api/auth/*` (`CLIENT_IP_HEADER=fly-client-ip` behind Fly).
- **Bank reconnect**: Settings → "Reconnect bank" → `POST /api/bank/connect` issues a one-time `state` (15 min) → S-Pankki → `GET /bank/callback`. The callback has no cookie (the bank redirect lands in Safari, and SameSite=Strict isn't sent cross-site anyway); the one-time state is the authorization. Saves the session to the DB and triggers a sync. `npm run link` now also writes the DB.
- **Screens** (`public/`, vanilla JS, no build, DOM built with textContent only): Home (safe-to-spend hero, cash/card/bills-before-payday breakdown, this month vs same day last month, balances, banners for consent ≤14 days / failed sync / uncategorized), Transactions (search, category/month filters in the URL, tap → category sheet with "apply to all from merchant"), Months (spent/income/saved, needs vs wants, bars per category → drill into transactions), Settings (consent, sync now, reconnect, add passkey, log out).
- **PWA**: manifest, icons (`scripts/icons.ts` generates PNGs with zero deps), service worker caches only the app shell (stale-while-revalidate), never `/api`.
- Privacy and terms pages at `/privacy` and `/terms`.
- Deploy files: `Dockerfile` (node:24-slim, chowns the volume then drops to `node`), `.dockerignore` (only src/public/package.json), `fly.toml` (arn, volume at /data, always on, /healthz check). **Not built or deployed yet** (Docker Desktop wasn't running).
- Migration 4: `bank_sessions.data`, `credentials`, `auth_sessions`. Applied to the real DB (backup `data/finance.pre-phase3.db`).
- Tests: 35 (WebAuthn with a software authenticator for all 3 algorithms + tampering cases, HTTP end-to-end auth/CSRF/headers/rate limit/recategorize/bank callback, safe-to-spend math).

### Findings from Phase 3
- **Card balance**: the CARD account's `ITBD` (booked) is the current balance, negative = owed; `ITAV` (available) is unused credit, so it's not cash. Verified: booked was 0 right after the bill, and past bills equalled the card purchases between them. `/accounts/{uid}/details` has a `credit_limit` field, but it's empty for both accounts.
- Payday is a fixed day of the month, or the last weekday before it on a weekend (Settings → "Payday (day of month)", default 14; `setPaydayDay()` in `gas/Logic.js`). Guessing it from the largest recurring income was less reliable. Recurring detection splits a merchant's payments into similar-amount groups, so rent is found even when the same payee also charges small extra fees.

### Phase 2 — Categorization (DONE ✅)
- `src/categorize.ts`: `txType()` maps bank codes → `card | card_refund | card_bill | cash | transfer_in | transfer_out | other`; `normalizeMerchant()` strips processor prefixes (`SUMUP *`, `PAYPAL *`…), store numbers and codes, and maps chains to one canonical name (all K-markets → "K-Market"); `categorize()` recomputes type/merchant/category for every transaction (except manual ones) after each sync.
- Precedence: manual (`setCategory`) > transfer > merchant category I set ("apply to all from this merchant") > my pattern rules (`rules` table, `addRule`) > built-in rules (regex list in code, Finnish chains) > type fallback (incoming transfer → Income, cash → Other).
- **No LLM categorization** (decided 2026-10-24): no Anthropic key, and Gemini free tier / local models weren't worth the extra party or hosting cost. Unknown merchants stay uncategorized until I pick a category once in the UI ("apply to all from this merchant"); results are per merchant, so this is a one-off pass over the merchant list, then a few new ones a month.
- `src/recurring.ts`: per merchant and direction, ≥3 payments at a regular weekly/biweekly/monthly/quarterly interval with amounts within ±25%, still active → `recurring` table (income / subscription / bill, next expected date). Rebuilt each sync.
- `npm run categorize` re-applies categorization and prints totals per category; `-- --list` also prints uncategorized merchants and recurring items (contains merchant names).
- Personal care (barbers, hairdressers) goes under Health.
- Migration 3 renames Eating out → **Bars & eating out** (bars and restaurants can't be told apart reliably) and adds **Gambling** and **Loans**.
- Migration 2 adds `categories` (14 defaults with group needs/wants/savings/income/transfer), `merchants`, `rules`, `recurring`, and `transactions.type/merchant_id/category_id/category_source`.

### Findings from Phase 2
- Built-in rules cover the chains; what's left is typically small bars and venues, MobilePay payments to people, the landlord and large transfers, which one-time merchant choices cover. That's why onboarding has a categorization interview.
- MobilePay payments to people default to Other; business MobilePay payments follow the normal rules.
- Trustly is a generic payment rail (gambling, shops), so it's a per-merchant choice, not a built-in rule.
- S-Pankki merchant name quirks: processor prefixes `Mob.Pay*` (MobilePay, often a person: kept as "MobilePay <name>"), `Vfi*`, `Zettle_*`, `Sp `, `Paytrail Oyj <shop>`; glued codes (`SIXT1234567890`), glued city names (`Lidlturkukeskusta`, `Mcdtampereasema`), HTML entities (`&amp;`). Rules match the cleaned name as well as the raw text.
- S-Group bonus arrives as `OTHR/OTHR` credits from the regional cooperative → Income (type-limited rule, so card purchases there aren't Income). Withdrawals from investment services land in Savings, not Income.
- Normalization cuts the merchant count by about a quarter (one name per chain).
- Only monthly-or-faster patterns are detectable with this much history.
- `RCDT` incoming transfers default to Income, which includes friends paying me back; fix with merchant/rule choices in the UI.

### Phase 1 — Data foundation (DONE ✅)

- `npm run sync` — upserts accounts, transactions (dedup on `(account, entry_reference)`) and today's balance snapshot into SQLite, then pairs transfers. Idempotent; the first run backfills 90 days.
- `npm start` — `src/server.ts`: `/healthz` + runs the sync on start and every `SYNC_INTERVAL_HOURS` (default 4).
- `npm test` — `node:test` suite in `test/` (in-memory DB, fake bank client).
- Files: `src/db.ts` (schema + migrations), `src/sync.ts` (sync job, consent check, cents/date helpers), `src/transfers.ts` (transfer matching), `scripts/sync.ts`.

### Findings from Phase 1
- **History limit is 90 days** even right after consent: older `date_from` → 422 "Wrong transactions period requested". Sync clamps to 89 days. Our DB is the only long-term history, so **a consent gap of >90 days loses data permanently**; sync warns about gaps.
- **Consent is 180 days** (`maximum_consent_validity`), so renew roughly twice a year. Sync warns at ≤14 days and fails after expiry.
- **S-Pankki gives a current account (`CACC`) and the credit card as its own account (`CARD`).** Card purchases are booked on the card account; the monthly bill is paid from the current account (`ICDT/ESCT`) and arrives on the card as `CCRD/OTHR`. These pairs are marked `is_transfer` so purchases aren't counted twice.
- Card purchases sometimes match an incoming payment of the same amount (friends paying back a share), so card purchase codes (`CCRD/POSC|POSD|XBCP|CWDL|CDPT`) are excluded from transfer matching.
- Account `uid` changes with each consent → accounts are keyed by IBAN.
- Balances: `ITBD` (booked) and `ITAV` (available), both with a reference date. Stored as `balances_daily.booked` / `.available`.
- Fields that exist but are always null: `merchant_category_code`, `balance_after_transaction`, `creditor_account`/`debtor_account` IBANs, `transaction_id`. So no own-IBAN transfer detection and no MCC-based categorization.

## Phase 0 (DONE ✅)

- Enable Banking production app created and activated by linking my S-Pankki accounts.
  App ID is in `.env` (`EB_APP_ID`); private key at `secrets/enablebanking.pem`.
- Privacy/terms URLs registered in Enable Banking point to simple public pages (to be moved to the app's own domain later).
- `npm run link` — starts a consent session (prints bank URL, I approve in S-mobiili, paste redirected URL back). Saves `secrets/session.json`.
- `npm run transactions` — prints balances + last 90 days of transactions per account, dumps raw JSON to `data/`.
- Verified working against real data on 2026-10-24.
- Redirect URL: `https://localhost:8443/callback` (page doesn't load; code is copied manually from the address bar).

### Files
- `src/enablebanking.ts` — zero-dependency client: RS256 JWT signing (`kid` = app id), `api()` helper, `getTransactions()` with pagination, types.
- `scripts/link.ts`, `scripts/transactions.ts` — Phase 0 scripts.
- `.gitignore` excludes `.env`, `secrets/*`, `data/`. **Never commit those or paste their contents into chat.**

### Findings about S-Pankki data (current account + credit card, 90 days)
- All transactions are `status: "BOOK"` — **no pending transactions**. Card purchases appear only after booking (~1–3 day lag).
- `entry_reference` present on 100% → use as the stable dedup key.
- `creditor.name` (for debits) / `debtor.name` (for credits) present on ~85–95% → merchant/counterparty name for categorization.
- `bank_transaction_code.code` + `.sub_code` on 100% → distinguishes card purchase / transfer / etc. (map the codes in Phase 2).
- `remittance_information` on ~20%, `reference_number` occasionally (bill payments).
- Only `booking_date` is filled (no `value_date` / `transaction_date`).
- Consent lasts up to ~180 days, then `npm run link` (later: an in-app flow) must be redone.

---

## 3. Architecture

```
iPhone (PWA, passkey login)
   │  HTTPS
   ▼
Node server on Fly.io (EU)
   ├── UI routes + JSON API
   ├── Scheduled sync job (every ~4h)  ──►  Enable Banking API  ──►  S-Pankki
   ├── Categorizer (rules + my merchant choices)
   ├── Notifications (Web Push)
   └── SQLite (Fly volume)
```

Secrets (Enable Banking key, session, API keys) live in Fly secrets, never in the client.

### Data model (draft)
- `accounts` — uid (Enable Banking), iban, name, product, currency, type (CACC/SVGS/CARD), is_savings
- `bank_sessions` — session_id, valid_until, status (to warn before consent expiry)
- `transactions` — id, account_id, entry_reference (unique per account), booking_date, amount (signed, integer cents), currency,
  counterparty, description, bank_code, sub_code, category_id, is_transfer, transfer_peer_id, merchant_id, raw (JSON text)
- `merchants` — normalized name ("K-MARKET KESKUSTA 123" → "K-Market"), default category
- `categories` — name, group (needs / wants / savings / income), icon
- `rules` — pattern → category (created automatically when I recategorize a transaction)
- `budgets` — category, month, amount, rollover
- `goals` — name, target_amount, target_date, linked_account, current_amount
- `planned_purchases` — item, price, desired_date, priority, status
- `recurring` — detected subscriptions/bills/salary: counterparty, amount, interval, next_expected_date
- `balances_daily` — snapshot per account per day (for trends and forecasting)

Money is stored as integer cents everywhere.

---

## 4. Roadmap

### Phase 1 — Data foundation
- [x] Confirm stack → plain Node server + SQLite (`node:sqlite`) + Fly.io; kept `src/enablebanking.ts`
- [x] SQLite schema + migrations (`src/db.ts`)
- [x] Sync job: fetch since newest stored booking − 10-day overlap, upsert by `(account, entry_reference)`, store raw JSON
- [x] Initial backfill: S-Pankki allows only 90 days (see findings)
- [x] Daily balance snapshots (`balances_daily`, latest sync of the day wins)
- [x] Detect transfers between my own accounts (amount/date matching; own IBANs aren't returned) → `is_transfer` + `transfer_peer_id`
- [x] Track consent expiry; warn 14 days before (sync output/logs; push notification in Phase 4)

### Phase 2 — Categorization
- [x] Default category set (Groceries, Bars & eating out, Transport, Housing, Bills, Loans, Subscriptions, Shopping, Health, Entertainment, Gambling, Travel, Income, Savings, Transfers, Other)
- [x] Map `bank_transaction_code` to transaction types
- [x] Merchant name normalization
- [x] Rule engine; recategorizing a transaction offers "apply to all from this merchant" (`setCategory(..., applyToMerchant)`; UI in Phase 3)
- [~] ~~LLM fallback for unknown merchants~~ — dropped; manual one-time merchant categorization instead
- [x] Recurring payment detection (subscriptions, rent, salary date)
- [x] Tune built-in rules against my real merchant list (`npm run categorize -- --list`)

### Phase 3 — Web app MVP (first thing on the phone)
- [x] Passkey auth, single user, registration lock
- [x] Security headers (CSP, HSTS), rate limiting, session cookies (HttpOnly, Secure, SameSite=Strict)
- [x] PWA manifest + icons + service worker; installable from Safari "Add to Home Screen" (verify on the iPhone after deploy)
- [x] Home: balance, spending this month vs last, **safe-to-spend** figure
- [x] Transaction list with search, filter and quick recategorize
- [x] Monthly breakdown by category
- [~] Deploy to Fly.io (EU), custom domain, update privacy/terms URLs in Enable Banking: files ready, needs domain + `fly deploy`
- [~] In-app "Reconnect bank" flow: built and tested with a fake bank; needs the redirect URL `https://<domain>/bank/callback` registered in Enable Banking

### Phase 4 — Budgets & saving
- [ ] Monthly budgets per category with rollover option
- [ ] Safe-to-spend = income − upcoming recurring bills − savings goal contributions − spent, ÷ days left
- [ ] Weekly review screen (summary + transactions to confirm)
- [ ] Web Push notifications (iOS 16.4+, requires home-screen install): budget at 80%/100%, large purchase, salary arrived, consent expiring. Keep them few.

### Phase 5 — Goals & purchase planning
- [~] Pay-yourself-first suggestion + savings goal per pay period done (2026-10-25); named goals with target dates not yet
- [ ] Savings goals with target date → required monthly amount and on-track status
- [ ] Purchase planner: "Can I afford X by date Y?" based on cash-flow forecast (recurring income/bills + average variable spend)
- [ ] Wishlist with cooling-off period (e.g. wait 7 days before non-essential purchases above a threshold)
- [ ] Unused/duplicate subscription detection

### Phase 6 — AI coach
- [ ] Chat over my own data (tools: query spending, budgets, goals, forecast — the LLM explains, deterministic code calculates)
- [ ] Monthly review written by the coach
- [ ] Scope: budgeting, saving and purchase planning only — no specific investment recommendations

### Phase 7 — Share with friends (planned 2026-10-25)
Each friend gets their **own** Enable Banking app (own key, restricted mode = only their accounts) and their **own**
Sheet + Apps Script project; nothing passes through me. Friends use **Claude Code** and are on **different banks**.
Their Claude clones the repo and follows `ONBOARDING.md`.

Findings: the control panel has an API (`POST https://enablebanking.com/api/applications`, Bearer = Firebase-style
id token from an email-link sign-in; this is what the official `enablebanking-cli` uses), so app registration can be
scripted. Activation ("Activate by linking accounts") is control-panel UI only, so that one step stays in the browser.
A session made locally (`npm run link`) belongs to the app, not the client, so the Sheet can reuse it (one bank approval).

Onboarding flow (Claude Code does everything except the marked clicks):
1. Prereqs check (Node 24, git); clasp via `npx`.
2. Enable Banking: generate the key with `node:crypto`, email-link sign-in (*friend clicks the email*), register the
   production app (redirect `https://localhost:8443/callback`, privacy/terms on GitHub Pages), write `.env`;
   *friend clicks "Activate by linking accounts" and approves in their bank*.
3. Bank link + 90-day fetch locally (*approve in the bank app*); bank picked from `/aspsps`.
4. **Personal categorization interview**: run `gas/Logic.js` in Node over the fetched transactions (same result as the
   Sheet will give), Claude shows uncategorized merchants by spend, proposes categories in batches and asks about the
   ambiguous ones (MobilePay people, own accounts at other banks, investment services → Savings, landlord → Housing).
   Lifestyle questions offer custom categories (Car, Pets, Kids…). Payday detected from income and confirmed; savings
   goal suggested from history. Also a data check for the bank (field coverage, codes not mapped by `txType`, card
   account shape, transfer pairs) so bank-specific gaps show up before the Sheet is made. Output `data/onboarding/setup.json`.
5. Google: `clasp login` (*browser*), Apps Script API toggle (*one click*), `clasp create --type sheets` (restore our
   `appsscript.json`), `clasp push --force`, read the dashboard URL from the deployments.
6. *Friend opens the Sheet → Finance → Set up → pastes the setup code* (Claude copies it to the clipboard: app id, key,
   session, setup.json). Writes Script Properties + Merchants/Rules/Categories/Settings, creates the trigger, first sync.
7. Phone: dashboard URL → Add to Home Screen; zip the `personal-finance` skill.
8. Updates later: "update my finance app" → `git pull && clasp push --force`.

- [x] Public repo: fresh history (old PLAN.md history has personal details); personal findings out of PLAN.md (2026-10-25); CLAUDE.md points new users to ONBOARDING.md
- [~] Privacy/terms pages in `docs/` (GitHub Pages must be switched on: repo Settings → Pages → master /docs)
- [x] Bank is a setting: Script Property `BANK` (`ebBank_()`, defaults to S-Pankki for my sheet), `.env` `EB_BANK_NAME` locally
- [x] Payday is a setting: Settings → "Payday (day of month)" (31 = last day), `applySettings_()` → `setPaydayDay()`; missing default rows are added to existing Settings sheets
- [x] Custom categories work in the dashboard (name shown as written, colour from a hash of the name)
- [x] `scripts/onboard.ts` (register, banks, link, fetch, review, google, code); `src/logic.ts` runs `gas/Logic.js` in Node; `fromBank()` and `pickBalances()` moved into Logic.js (balance fallbacks CLBD/XPCD/OPBD for other banks). fetch + review checked on my data; register, google and code not yet run for real
- [x] Finance → Set up from setup code (`importSetupCode()` in Menu.js: Script Properties incl. BANK, extra categories, merchant choices, rules, settings, trigger, first sync); tested in `test/gas.test.ts`
- [~] `ONBOARDING.md` written for the friend's Claude, README has the message to paste; no dry run (user's decision 2026-10-25): the first friend's setup is the real test of register, google and code

---

## 5. Best practices borrowed from existing apps
- **YNAB:** zero-based budgeting, rollover of unspent money.
- **Copilot Money:** polished UI, learn-from-corrections categorization.
- **Monarch:** goals tied to accounts, cash-flow forecast, recurring calendar.
- **Rocket Money:** subscription detection.
- **Cleo:** conversational coach with personality.
- **Revolut:** savings pots, round-ups.
- **Actual Budget / Firefly III (open source):** reference implementations for import, dedup and rules.

---

## 6. Security checklist (applies throughout)
- Secrets only in `.env` / `secrets/` locally and Fly secrets in production; never in git, logs or chat.
- Read-only bank access; consent revocable from S-Pankki or the Enable Banking dashboard.
- Single-user passkey auth; no public sign-up.
- Data hosted in the EU; DB encrypted at rest; TLS everywhere.
- Minimal data to the LLM (merchant names, amounts, categories); no IBANs, no names of private persons.
- Keep dependencies few and pinned; review before adding.

## 7. Open questions
- Domain for the app (needed for deploy, passkey RP ID and the Enable Banking redirect URL). Changing it later invalidates the passkeys.
- Backups: Fly volume snapshots (daily, default 5 days) vs Litestream to object storage.
