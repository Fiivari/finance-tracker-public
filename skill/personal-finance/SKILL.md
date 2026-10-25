---
name: personal-finance
description: Answers questions about my own money (spending, budget, income, savings, bills, subscriptions, balances, merchants, "can I afford", "how much did I spend on X", "how am I doing this month") by reading my Google Sheet "Finance" from Google Drive. Use it for any question about my personal finances, in English or Finnish (talous, kulutus, rahat, budjetti, säästöt, laskut, palkka).
---

# My finances: the "Finance" Google Sheet

My bank accounts sync into the Google Sheet **"Finance"** in my Google Drive every 4 hours. The sheet is the only source of truth. Open it with the Google Drive connector and
read the tabs you need. Don't answer from memory or guess numbers. If you can't open the sheet, say so and stop.

Reply in the language I asked in. Use euros in Finnish format (`1 234,56 €`) when answering in Finnish. Lead
with the answer and its number, then a short breakdown. Name the period you used, like "1.–24.10." or
"syyskuu".

## Tabs

Amounts are euros. **Spending is negative and income is positive** everywhere except the Summary tab, which
shows spending as a positive number.

| Tab | Columns | Use for |
|---|---|---|
| **Summary** | What, Value | The current snapshot: safe to spend per day and until payday, payday, days left, cash available, credit card owed, spent this month, spent by this day last month, spent last month, income this month, uncategorized count, bank access days left, last sync, warnings, savings goal per pay period, saved this pay period, savings goal status (reached / in reach / tight / out of reach), bills before payday. Start here for "how am I doing" questions. |
| **Transactions** | Date, Amount, Merchant, Category, Override, Account, Type, Transfer, Description, Counterparty, Source, Code, Key | One row per booked transaction, newest first. Use it for anything about specific merchants, days or purchases. |
| **Monthly** | Month (YYYY-MM), Category, Group, Total, Count | Totals per month and category, with transfers already left out. The fastest way to compare months or categories. |
| **Recurring** | Merchant, Kind (income / subscription / bill), Amount, Every (days), Times seen, Last, Next expected | Detected regular payments: salary, rent, subscriptions. |
| **Merchants** | Merchant, My category, Applied, Transactions, Net, Last seen, Key | One row per merchant with lifetime count and net. "My category" is my own choice and overrides everything else. |
| **Balances** | Date, Account, Type, Booked, Available, Account key | One row per account per day of syncing. |
| **Categories** | Name, Group, Icon | Maps each category to its group, including any categories I added myself. |
| **Rules** | Pattern, Category | My text-match rules. |
| **Settings** | Setting, Value, Note | My settings. "Savings goal per pay period" is the euros I aim to move to savings (Savings category) between paydays; 0 = no goal. "Payday (day of month)" is my salary day. |
| **Sync log** | Time, Status, New, Updated, Message | Sync health. Check it if the data looks stale. |

## How to count correctly

- **Spending** means transactions where Transfer is not "yes" and the category's group (from the Categories
  tab) is `needs` or `wants`, plus uncategorized rows. Sum the amounts and flip the sign.
- **Groups** come from the Categories tab. The defaults are:
  - `needs`: Groceries, Transport, Housing, Bills, Loans, Health.
  - `wants`: Bars & eating out, Subscriptions, Shopping, Entertainment, Gambling, Travel, Other.
  - `income`: Income.
  - `savings`: Savings. Money moved to savings is saving, not spending.
  - `transfer`: Transfers.

  Categories I added myself have their group in the Categories tab too.
- **Always leave out rows with Transfer = "yes".** These are moves between my own accounts, such as paying the
  credit card bill from the current account. Counting them double-counts every card purchase.
- **Income** is the Income category. Incoming transfers default to Income, so it can include friends paying me
  back, for example over MobilePay. Mention this if an income figure looks unusually high.
- **Refunds** are positive rows in spending categories. They reduce that category's spending; don't count
  them as income.
- **Category:** the Category column is final. The order of precedence is Override, then my merchant choice,
  then my rule, then the built-in rule. Source shows which one applied.
- **Credit card:** the card account's Booked balance is negative when I owe money. Its Available balance is
  unused credit, not cash. "Cash available" in Summary already handles this.
- **Payday** is the "Payday" row in Summary. The day comes from Settings ("Payday (day of month)", 31 = the
  last day), moved to the last weekday before it when it falls on a weekend. A pay period runs from one payday
  to the day before the next. Use pay periods when I ask about "this period" or
  "until payday".
- **"Safe to spend"** means cash minus credit card debt minus the bills expected before payday. Quote the
  Summary tab rather than recomputing it.
- **Partial months:** the current month is still running. When comparing it with a full month, compare to the
  same day of the month. Summary's "Spent by this day last month" exists for exactly this.
- **History** starts when the sync began. Older months may be missing or partial, and the bank never returns
  more than 90 days back. Say so instead of treating a missing month as zero.
- **Uncategorized** rows have an empty Category. If there are many, mention that totals per category may be
  off and that I can categorize them in the Merchants tab.

## Good habits

- **Totals per month and category:** use Monthly. **Merchants, dates or single purchases:** filter
  Transactions.
- For trends, compare at least 3 months and give the numbers, not just a direction.
- **"Can I afford X?"** questions: answer from Summary (safe to spend until payday, bills before payday), then
  the effect on the daily amount, which is the amount left divided by the days to payday.
- **When the data looks wrong** (a giant expense, a missing salary), check the Sync log and Transfer flags
  before drawing conclusions.
- **This is read-only.** Never suggest you can move money or change anything in the bank. I edit categories
  myself in the sheet: Merchants → "My category", or the Override column in Transactions.
