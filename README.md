# Oma talous: a personal savings coach on Google Sheets

Your bank transactions sync into a Google Sheet in your own Drive every 4 hours. A phone dashboard (in Finnish)
shows how much you can spend per day until payday, nudges you to save, and lets you fix categories with a tap.

- **Your bank** through [Enable Banking](https://enablebanking.com) (PSD2, read-only; works with Finnish banks).
- **Your Google account:** the Sheet is the database, and Google Apps Script runs the sync. There's no server
  to host and nothing goes through anyone else.
- **Free.** Each user registers their own Enable Banking app in restricted mode, which covers only their own
  accounts.

## Set up your own copy

You need [Claude Code](https://claude.com/claude-code), a Google account, and your bank app on your phone.
Open Claude Code in a folder where you keep projects and paste this:

> Clone https://github.com/Fiivari/finance-tracker-public.git into a folder called `oma-talous`, then read
> `ONBOARDING.md` there and guide me through setting up my own copy.

Claude runs the setup and tells you when to click something. That's an email link, approving access in your
bank app, signing in to Google, and pasting a setup code into your Sheet. Along the way it goes through your
spending with you to set up categories that fit you. Expect about 45 minutes.

## How it works

- `gas/` is the Apps Script project bound to the Sheet:
  - `Logic.js`: categorization, transfers, recurring payments, safe-to-spend and savings.
  - `Bank.js`: the Enable Banking client.
  - `Sync.js`: the 4-hourly sync.
  - `Web.js` and `Dashboard.html`: the dashboard.
- `scripts/onboard.ts` holds the onboarding steps Claude runs on your computer.
- [PLAN.md](PLAN.md) has the design decisions and findings. [ONBOARDING.md](ONBOARDING.md) is the setup guide
  (written for Claude).

Privacy: [privacy.html](https://fiivari.github.io/finance-tracker-public/privacy.html) ·
Terms: [terms.html](https://fiivari.github.io/finance-tracker-public/terms.html)
