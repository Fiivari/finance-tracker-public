# Onboarding: set up your own copy

**This file is for Claude Code.** A friend of the author has cloned this repo and wants their own copy of the
app: their bank, their Google account, their categories. Guide them through it. Expect about 45 minutes.

The result:
- A Google Sheet **"Finance"** in their Drive. Apps Script syncs their bank transactions into it every 4 hours.
- A phone dashboard (Finnish UI) on their home screen.
- Categories fitted to their own spending, set up in an interview with you.

It costs nothing, and nothing goes through the author. They get their own Enable Banking app (their own key,
"restricted mode" = only their own accounts) and their own Google Apps Script project.

## How to work with them

- **Assume no developer experience.** Run every command yourself. Only ask them to do what needs their hands:
  clicking an email link, approving in their bank app, signing in to Google, pasting into the Sheet. For each of
  those, say exactly what they'll see and what to click. One step at a time.
- **Speak their language** (probably Finnish). Keep messages short.
- **Secrets:** never print, cat or paste `.env`, `secrets/*`, the setup code or the private key into the chat.
  The scripts never print them either.
- **Their data:** the review step prints their transactions (merchants, amounts) so you can categorize them
  together. That's their own data, shown to them, on their computer. Use it for the interview and don't copy it
  anywhere else. `data/` and `secrets/` are git-ignored.
- **Bank access is read-only.** The app can't move money. Never add payment features.
- Steps are re-runnable. If something fails, read the error, check the troubleshooting section at the end, and
  retry. Don't improvise around Enable Banking or Google security prompts.
- **Steps 1, 4 and 5 haven't been run end to end with a new user yet.** If one fails, use the fallback where
  one is given, fix what's clearly a bug, and at the end tell them to report it at
  https://github.com/Fiivari/finance-tracker-public/issues (no personal data in the report).
- Read [CLAUDE.md](CLAUDE.md) for the code's rules. [PLAN.md](PLAN.md) explains how it works and why.

## 0. Before you start

Check, and install if missing (ask before installing):
- **Node.js 24 or newer**: `node --version`. Install it with `winget install OpenJS.NodeJS` on Windows or
  `brew install node` on a Mac.
- **git** (they used it to clone this repo, so it's probably there).

Ask them to have these ready:
- Their **email address**, for the Enable Banking account.
- Their **bank app** on their phone, to approve access.
- A **Google account**. Ideally the browser on this computer is signed in to only that one Google account,
  because Apps Script web apps break when several accounts are signed in.
- A **desktop browser** (Chrome works best). The Sheet's Finance menu doesn't exist in the phone app.

One bank per copy: the app syncs the accounts of one bank. If they have a credit card from the same bank, it
can be included in the same link.

## 1. Enable Banking app

Enable Banking is the licensed Finnish service that gets the transactions from the bank (PSD2).

```
npm run onboard -- register --email <their email>
```

Run it in the background: it waits up to 15 minutes. Tell them an email from Enable Banking is on its way and
that they should open the sign-in link **on this computer**. A browser tab saying "Kirjautuminen onnistui"
completes it. If they open it on their phone, ask them to copy the link from the email and send it to you, then
run the same command with `--link "<link>"`.

The script creates their private key (`secrets/enablebanking.pem`), signs them in to the Enable Banking control
panel, registers a production app called "Oma talous" and saves its id to `.env`.

**Activate the app** (this one has no API): ask them to open https://enablebanking.com/cp/applications, find
"Oma talous", click **"Activate by linking accounts"**, pick their country and bank, and approve in their bank
app. The status changes to active (restricted mode: only their own accounts). This doesn't give the app access
yet; step 2 does.

If the registration API fails (it isn't formally documented), do it by hand together: in the control panel,
API applications → add a new application. Environment **Production**, name "Oma talous", redirect URL
`https://localhost:8443/callback`, description "Personal finance tracker for my own accounts only", their email
as the data protection email, privacy URL https://fiivari.github.io/finance-tracker-public/privacy.html, terms
URL https://fiivari.github.io/finance-tracker-public/terms.html. The browser generates the key and downloads a
`.pem` file: move it to `secrets/enablebanking.pem` and put `EB_APP_ID=<the app id>` in `.env`. Then activate
as above.

## 2. Link the bank

```
npm run onboard -- banks            # Finnish banks as Enable Banking names them
```

Confirm their bank from the list with them. Then:

```
npm run onboard -- link --bank "<name from the list>"
```

Give them the address it prints. They log in, choose the accounts (current account, and their credit card if
it's offered; see the savings note in step 3), and approve. The bank then sends them to a page that **doesn't
load. That's expected.** Ask them to copy that page's full address from the address bar and paste it to you.
Then:

```
npm run onboard -- link --url "<the address they pasted>"
```

This saves the bank session (`secrets/session.json`, valid up to 180 days). The Sheet reuses it, so they don't
approve twice.

## 3. Fetch and categorize together (the interview)

```
npm run onboard -- fetch     # the last 89 days, saved locally to data/onboarding/bank.json
npm run onboard -- review    # categorizes with the Sheet's own code and prints the report
```

Their choices go in `data/onboarding/choices.json`, which the review creates. You edit it and run review again
after each batch:

```json
{
  "payday": 15,
  "savingsGoal": 200,
  "categories": [["Auto", "needs", "🚗"]],
  "merchants": { "<merchant key exactly as printed>": "<category>" },
  "rules": [["<text that appears in merchant, counterparty or message>", "<category>"]]
}
```

### 3a. Check the bank data first

Read the **Bank data check** and **Accounts** sections. The code was tuned on S-Pankki data, so other banks can
differ:
- Bank codes mapped to `other` lose card/transfer detection. If a code clearly means a card purchase, an
  incoming transfer or similar, extend `txType()` in `gas/Logic.js` (it's pure, see CLAUDE.md), add a test,
  run `npm test`, and tell them the change is worth sending to the author.
- **No CARD account but they have a credit card:** some banks list cards as a separate entry in Enable
  Banking. Check the banks list and tell them. One bank per copy, so that card isn't covered and card debt
  won't be subtracted from the safe-to-spend amount.
- A missing balance type or entry_reference is reported with the place to fix it.

### 3b. A few questions about their life

Ask in one short message: do they have a car, pets or kids? Are they studying? Do they have big hobbies (gym,
sports)? Do they invest or save somewhere (Nordnet, a savings account, funds)? Do they have their own accounts
at other banks (Revolut and so on)? Do they share costs with someone over MobilePay (rent with a flatmate,
for example)?

Suggest **extra categories** only where there's real spending, at most 3–4. Give them **Finnish names**
("Auto", "Lemmikit", "Lapset", "Harrastukset"). The dashboard translates the built-in categories to Finnish
but shows added ones exactly as written. Groups:
- `needs`: necessary costs
- `wants`: optional spending (the monthly challenge picks from these)
- `savings`: money put aside; it fills the savings goal
- `income`
- `transfer`: their own money moving between their own accounts, which isn't spending

### 3c. Merchants, biggest first

Built-in rules already know common Finnish chains (K-Market, Prisma, Wolt, HSL, VR…). Go through the
**uncategorized merchants** in batches of 10–15. Propose a category for each in a small table, using what you
know about Finnish businesses and their answers from 3b. Ask only about the unclear ones. Typical questions:
- `MobilePay <person>`: splitting bills with friends (Other), or rent to a flatmate (Housing)?
- Incoming transfers default to **Income**, which includes friends paying them back. Anything that isn't
  salary, benefits or other real income should be `Transfers` (their own money) or `Other`.
- Payments to investment services and their own savings → `Savings`. Transfers to their own accounts at other
  banks → `Transfers`.
- Landlord → `Housing`. Loan payments → `Loans`.

Put the answers in `merchants` using the **key** column exactly. Use `rules` when the same merchant shows up
under varying names, or for transactions with no counterparty (match text from the message). Run review again.

Then run `review --all` once and skim the merchants the built-in rules categorized. Ask about any that look
wrong for them.

Done when no merchant with 2 or more transactions, or more than 20 €, is left uncategorized. Small one-offs can
stay; they can fix those from the phone later.

**Savings note:** the savings goal counts money going to `Savings`-category merchants. If their savings
account is at the same bank and was linked too, money moved there is paired as an own transfer, and that
doesn't count as saving. If saving matters to them and that's the case, suggest relinking without the savings
account (step 2 again) and categorizing the transfers to it as `Savings`.

### 3d. Payday and savings goal

The **Payday and saving** section lists their biggest incomes. Ask them to confirm their payday: a day of the
month, 1–31, where 31 means the last day of the month. A payday on a weekend moves to the Friday before. Save it
as `payday`.

Show their average monthly income, spending and savings. Suggest a realistic round **savings goal per pay
period** in euros (`savingsGoal`; 0 = no goal) and let them decide.

## 4. Create their Google Sheet

1. Ask them to open https://script.google.com/home/usersettings and switch **Google Apps Script API** on.
2. Sign in to Google: run `npx -y @google/clasp@3.4.1 login` in the background. A browser tab opens. They pick
   their Google account and allow access. This lets *this computer* create and update their script; it's not
   the app's own permission.
3. Create the Sheet and upload the code:
   ```
   npm run onboard -- google
   ```
   It prints the **Sheet** and **Dashboard** addresses. Give both to them, and suggest bookmarking the Sheet.

## 5. Put the setup into the Sheet

1. They open the Sheet on the computer and wait a few seconds for the **Finance** menu to appear (reload the page
   if it doesn't).
2. You run `npm run onboard -- code`. It copies the setup code to the clipboard. It holds their bank key, so
   don't print it.
3. They click **Finance → Set up from setup code…**. The first time, Google asks for permissions:
   - Click **Continue** and choose their account.
   - "Google hasn't verified this app" appears. That's because the script is their own, not published by a
     company. Click **Advanced → Go to Finance (unsafe) → Allow**.
   - The permissions: edit this one spreadsheet, connect to `api.enablebanking.com` only, run on a timer, show
     dialogs.
   - After allowing, they may need to click the menu item again.
4. They paste (Ctrl+V / Cmd+V) and press **Set up**. About a minute later it says
   `Done: N transactions synced…`.
5. Clear the clipboard. Windows: `cmd /c "echo off | clip"`. Mac: `pbcopy < /dev/null`.

Look at the Summary tab with them. If anything looks off (a huge expense, missing salary, everything
uncategorized), check the Sync log tab and the Transfer column before changing anything.

## 6. Dashboard on the phone

1. They open the **Dashboard** address on the computer first and allow access if asked.
2. They send the address to themselves (email or a chat), open it on the phone in a browser signed in to the
   same Google account, then add it to the home screen:
   - **iPhone (Safari):** Share → Add to Home Screen.
   - **Android (Chrome):** ⋮ → Add to Home screen.
3. Show them around: Koti (safe to spend per day until payday, savings, this week), Tapahtumat (tap a
   transaction to change its category, for that merchant or just that one), Kuukaudet (months and
   categories).

## 7. Optional: ask Claude about their money

The `personal-finance` skill lets claude.ai answer questions like "how much did I spend on food in September"
from their Sheet.
1. Make the zip. Windows: `Compress-Archive -Path skill/personal-finance -DestinationPath dist/personal-finance.zip`.
   Mac: `cd skill && zip -r ../dist/personal-finance.zip personal-finance`. Create `dist/` first.
2. In claude.ai: Settings → Capabilities → Skills → upload the zip. Also connect **Google Drive** under
   Settings → Connectors.

## 8. Wrap up

- Delete the local copy of their transactions: `data/onboarding/bank.json`. Their Sheet has everything.
  `choices.json` holds their categorization choices; keep it.
- The bank key and session are also in their Sheet now. Ask whether to keep the local copies in `secrets/`
  as a backup. Deleting them is fine; nothing local is needed to run the app.
- Tell them the three things to remember:
  1. **Bank access lasts up to 180 days.** The dashboard warns 14 days ahead. To renew, open the Sheet on a
     computer → Finance → Reconnect bank, approve in the bank app, then Finance → Finish reconnect and paste
     the address. Renew in time: the bank only gives 90 days of history, so a long gap loses transactions for
     good.
  2. **New merchants** appear uncategorized. Tap them on the phone and pick a category for the whole merchant.
  3. **Updates:** they open Claude Code in this folder and say "update my finance app". You then run
     `git pull`, `npm test` and `npm run gas:push`.

## Troubleshooting

| Problem | Fix |
|---|---|
| register: 401/403 from `/api/applications` | Their control panel account may need terms accepted first. Ask them to sign in at https://enablebanking.com/cp once, then rerun register. If it still fails, register by hand (end of step 1). |
| No sign-in email | Check spam. Rerun register (the key is kept). |
| link: bank not found | Use the exact name from `banks`. Some banks have separate entries for business or card accounts. |
| link: "app not active" or 403 | The app isn't activated yet (step 1, "Activate by linking accounts"). |
| clasp: "User has not enabled the Apps Script API" | Step 4.1, then wait a minute and retry. |
| `onboard -- google` says a Sheet already exists | It was created earlier. Check `.clasp.json`; `npm run gas:push` uploads code changes. |
| No Finance menu in the Sheet | Reload the page. It only appears in a desktop browser. |
| Dashboard: "Sorry, unable to open the file" | Several Google accounts are signed in. Use a browser profile or private window with only theirs. |
| Sync log shows an error | Read the message. "consent has expired" → Finance → Reconnect bank. |
