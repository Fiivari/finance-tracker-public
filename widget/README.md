# Savings jar widget (iPhone, Scriptable)

A home screen widget that shows the dashboard's savings jar: how full this pay period's savings are, and the
lighter "potential" layer. It shows no euro amounts, only the jar and a percentage.

The finance sheet and the dashboard stay "only myself". The widget reads from a separate, tiny Apps Script
project (`apps-script/`) that anyone with its secret address can call, and that only ever returns the jar's two
fill levels from the Summary tab (written by every sync).

## Setup

1. **Sync once with the new code** (`npm run gas:push`, then Finance → Sync now in the sheet) so Summary has
   the rows "Savings jar level" and "Savings jar potential".
2. **Create the endpoint project.** Go to [script.google.com](https://script.google.com), click New project,
   and name it e.g. "Finance widget". Paste `apps-script/Code.js` into `Code.gs`. In Project Settings, tick
   "Show appsscript.json" and replace its contents with `apps-script/appsscript.json` (it turns on the Sheets
   API service, which can read the sheet with read-only access).
3. **Script properties** (Project Settings → Script properties): add `SHEET_ID` = the finance sheet's ID
   (the part of its address between `/d/` and `/edit`).
4. **Token:** in the editor, choose `createToken` and click Run. Allow access when asked (read-only access to
   your sheets). Copy the token from the execution log.
5. **Deploy:** Deploy → New deployment → Web app, execute as Me, access Anyone. Copy the web app address.
6. **On the iPhone:** install [Scriptable](https://scriptable.app), add a new script, paste `savings-jar.js`
   and run it. Paste the address with the token on the end: `https://script.google.com/macros/s/…/exec?token=…`.
   It's stored in the iOS Keychain. Then add a small Scriptable widget to the home screen, long-press it →
   Edit Widget, and pick the script.

Keep the address private: anyone who has it can see the two fill levels (nothing else). To revoke it, run
`createToken` again and paste the new address into the script (run it in the app → Vaihda osoite).

iOS decides when widgets refresh (usually every 15–60 minutes); the sheet syncs every 4 hours anyway. When the
endpoint can't be reached, the widget keeps showing the last levels, slightly dimmed.
