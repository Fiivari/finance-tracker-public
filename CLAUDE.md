# Personal Finance App

Single-user savings coach: Google Apps Script (`gas/`) syncs one bank's transactions via Enable Banking into the user's own Google Sheet every 4 hours. Each user runs their own copy (own Enable Banking app, own Sheet). The Node code (`src/`, `scripts/`) is local tooling: onboarding plus the Phase 1–2 tools.

**New user setting up their own copy** (no `.clasp.json` in this folder yet): follow [ONBOARDING.md](ONBOARDING.md).

**Start here otherwise:** read [PLAN.md](PLAN.md) — decisions, current state, findings about the bank data, and the phased roadmap with checkboxes. Update PLAN.md (tick boxes, add findings) as work progresses.

## Rules
- Never read out, print or commit `.env`, `secrets/*` or `data/*` contents. `data/` holds real personal transactions — inspect structure (field names, counts), not values, unless the user asks. Exception: during onboarding, `npm run onboard -- review` shows the user their own transactions for the categorization interview.
- Bank access is read-only; never add payment initiation.
- `gas/*.js` share one global scope in Apps Script (no modules). Keep `gas/Logic.js` free of Apps Script APIs so it runs in Node tests and in the onboarding scripts (`src/logic.ts` loads it).
- Node 24 runs `.ts` directly (type stripping): use only erasable TS syntax (no enums, namespaces, parameter properties) and `.ts` import extensions.
- Keep dependencies minimal; prefer Node built-ins.
- The repo is public: no personal data, account details or real transaction examples in code, tests or docs.

## Commands
- `npm run onboard -- <step>` — onboarding steps for a new user (register, banks, link, fetch, review, google, code); see ONBOARDING.md
- `npm run link` — renew bank consent locally (interactive; the user runs it, approves in the bank app)
- `npm run transactions` — print balances and last 90 days of transactions
- `npm run sync` — sync accounts, transactions and balances into `data/finance.db`
- `npm run gas:push` — upload `gas/` to the Apps Script project (clasp via npx; `rootDir` is `gas`). `clasp create` overwrites `gas/appsscript.json`: keep our scopes, timezone and `urlFetchWhitelist`.
- `npm test` — run tests
