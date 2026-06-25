# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running locally

No build step. Open `index.html` directly via `file://` (works on iPhone Safari)
or serve the directory statically:

```
python3 -m http.server 8080   # see .claude/launch.json for other launchers
```

There is no `package.json`, no linter, no test suite, and no CI. The GitHub
Actions workflow (`.github/workflows/`) only deploys the static site to GitHub
Pages on push to `main`.

## Architecture

Single-page vanilla-JS app that consolidates bank CSV exports into a
client-side SQLite database (via `sql.js`) with analytics, budgeting, rules,
and an emergency-fund planner.

### Intended user workflow

The tabs are built to be used in this order — keep them coherent when changing
any one of them:

1. **Import** bank CSV exports (`js/import.js`). Each bank gets a profile
   (columns, date format) and the account is auto-detected from the filename.
2. **Categorise** using the Analytics category breakdown to see where the money
   goes, then add/refine **Categories** (`js/categories.js`) and **Rules**
   (`js/rules.js`) so future imports self-categorise. A rule can assign both a
   category **and** an optional subcategory (`transaction_rules.subcategory_value`);
   `applyTransactionRules` returns `{ shouldIgnore, category, subcategoryId,
   categorized }` and both `insertTransaction` and `applyRulesToExisting` persist
   the subcategory. Rules are editable (`editRule`), and the Rules tab also shows a
   **frequent-merchant** panel (`renderFrequentTransactions` / `normalizeMerchant`)
   that groups transactions by a noise-stripped merchant key and previews which
   rule currently tags each group — the main lever for filling in subcategories.
3. **Budget** (`js/budget.js`) — set a monthly limit per category. The workflow
   is **monthly**: both Budget and Analytics have a month navigator, so you can
   step through past months and see how each month's actual spend compares
   against the same limits, and tune the limits over time.
4. **Emergency fund (baseline)** — the 6-month target starts from the budget:
   the sum of all category limits is the steady monthly run-rate
   (`budgetMonthlyTotal()` in `js/planner.js`), × 6 months.
5. **Planner** (`js/planner.js`) refines that estimate. A flat monthly budget
   misses lumpy, calendar-specific costs, so the Planner adds **expense
   commitments** that land in specific months — e.g. Singapore school-term fees
   (`term` type, explicit dates), or fixed-cadence costs like aircon servicing
   and dental scaling (`interval` type, every N months from a first-due date).
   The fund target = budget baseline every month **plus** every commitment that
   actually falls in the next 6 months (`emergencyFundTargetTotal()`), which is
   what makes it more accurate than `monthly run-rate × 6`.

   To avoid **double-counting**, a `monthly` commitment tagged to a budgeted
   category is netted against that category's limit: the budget contributes
   `max(limit − that category's monthly commitments, 0)` per month
   (`netBudgetBaselineForMonth()`), so steady spend is counted once at the
   larger of the two figures. The commitment shows as its own row; the budget
   only tops it up if the limit is higher. Lumpy commitments (`term`,
   `interval`, `workday`, `nonworkday`) never overlap a flat budget, so they
   always add in full. The Planner table, Financial Health card, Overview, and
   exported report all reconcile to the same netted total.

The **Overview** dashboard and the exported Analytics report both read the same
`budgetMonthlyTotal()` / `emergencyFundTargetTotal()` helpers, so every screen
agrees on the target. There is **no** separate manually-typed "variable spend"
figure any more — the budget is the single source of the baseline.

#### Expense-commitment types (`commitmentAmountForMonth`)

`expense_commitments.type` drives how much a commitment contributes in a given
month. All amounts are integer cents:

- `monthly` — every month (optional `active_months` CSV restricts which months).
- `term` — only on the explicit `payment_dates` (`YYYY-MM-DD`, comma-separated).
- `interval` — every `interval_months` months counting from `anchor_date` (the
  first due date); used for aircon/dental-style fixed cadences.
- `workday` / `nonworkday` — a per-day amount × the count of Mon–Fri / Sat–Sun
  days in the month.

When adding a new type, update **every** `commitmentAmountForMonth` call site
plus the parallel switches in the Planner month-view/day-detail calendars
(`js/planner.js`) and the exported report (`rpt_planner` in `js/analytics.js`).

**No bundler, no modules.** `js/*.js` files are plain classic scripts loaded
in dependency order from `index.html` (see the `<script src>` block near the
bottom). They share one global scope on purpose — inline `onclick=` handlers
in `index.html` call those globals, and mutable top-level state (`db`,
`bankProfiles`, `selectedTransactionIds`, …) lives in `js/core.js` and is
reassigned across files. Switching to ES modules would break both. When
adding code, append to the appropriate file rather than introducing imports.

Script load order (fixed; do not reorder without checking call sites):

```
core → database → import → dates → transactions → analytics
     → categories → bank-profiles → rules → budget → planner → overview → drive-sync
     → ask-ai
```

To bundle into a single offline HTML file, inline the 3 CDN libs, `styles.css`,
and each `js/*.js` in the load order above — concatenation reproduces the
original behaviour byte-for-byte (the split was purely mechanical along the
section banners in `js/core.js`).

### Persistence model

- **In-memory:** one `sql.js` `Database` instance, held in the `db` global.
- **Durable:** the entire DB is exported as bytes and stored as a single
  IndexedDB row (`BankConsolidator` / `database` / `id=1`). See
  `saveDatabaseToIndexedDB` / `loadDatabaseFromIndexedDB` in `js/analytics.js`.
- **Write flow:** every mutating function calls `markDirty()` (defined in
  `js/analytics.js`), which debounces a 1 s flush to IndexedDB. The
  `visibilitychange` handler flushes immediately when the tab is hidden.
- **Crash safety:** `beforeunload` synchronously base64-encodes the current
  DB into `localStorage['bankConsolidator_backup']` because IndexedDB writes
  cannot complete during unload. `initSQLite` prefers this backup over the
  IndexedDB copy on next load and clears it after restoring.

When you add a new write path, you must call `markDirty()` — otherwise the
change is lost on refresh.

### Money is stored as integer cents

`transactions.amount`, `manual_transactions.amount`, `budget.monthly_limit`,
`expense_commitments.amount`, `activity_items.{estimated,actual}_cost`,
`bank_balances.balance`, and the `monthly_expected_income` / `variable_spend`
key-value rows are all integer cents. A one-shot `migration_money_to_cents`
in `js/database.js` converts legacy decimal databases on startup (idempotent
via the `settings` table).

Use the `toCents` / `fmtMoney` / `fmtMoneySigned` helpers at I/O boundaries.
SQL aggregates (`SUM`, `ABS`, `amount < 0`) work unchanged on integers. Only
divide by 100 at the rendering / CSV-export boundary.

### Database access

Go through `dbHelpers` in `js/core.js` (`safeRun`, `queryAll`, `queryFirst`,
`queryValue`) rather than calling `db.run` / `db.exec` directly — they handle
error reporting via `showMessage`.

### Foreign keys are enforced

`PRAGMA foreign_keys = ON` is set on every load (in `setupSchema`, `js/database.js`).
The schema declares `ON DELETE CASCADE` for ownership edges
(`banks→accounts→imports→transactions`, `categories→subcategories`,
`accounts→bank_balances`/`account_purpose`, `planned_activities→activity_items`,
`categories→budget`) and `ON DELETE SET NULL` for optional tags
(`transactions`/`expense_commitments`/`transaction_rules`/`activity_items`
category & subcategory refs). Consequences when writing code:

- **Insert parents before children** (e.g. the import row before its
  transactions) or the insert fails.
- **Deleting a bank/account/category cascades** to its dependent rows — no
  manual cleanup needed, but warn the user in the confirm dialog.
- A one-shot, idempotent migration (`migrateToForeignKeys`, guarded by the
  `migration_fk_constraints` settings flag) rebuilds legacy tables to add these
  actions, cleans pre-existing orphans, and re-keys `bank_balances` /
  `account_purpose` from `account_name` to `account_id`. Any new path that
  loads a DB from bytes (import `.db`, Drive restore) must call `setupSchema()`
  so an older file gets migrated and enforcement enabled.

### Input safety

Always pass user-supplied strings through `escapeHtml()` (in `js/core.js`)
before interpolating into `innerHTML`, including inside `<option>` builders
for dropdowns. Past XSS bugs lived in dropdown rebuilders (`updateAccountOptions`,
`updateCategoryFilter`, `updateSubcategoryFilter`, `populateSubcategorySelect`,
`updateBankFilter`, `updateAccountFilter`). Validators for names live in
the `validators` object in `js/core.js`.

### Date parsing

`normalizeDate` (`js/dates.js`) only accepts the explicit format patterns
configured per bank profile. There is intentionally **no** `new Date(s)`
fallback — locale-dependent parsing of `01/02/2025` silently corrupted
foreign-bank imports. If no pattern matches, the raw string is returned so
the import surfaces the problem.

## Intentional design decisions

### No duplicate transaction detection
Duplicate transactions are **intentionally allowed**. Some banks legitimately
issue duplicate rows in their CSV exports (e.g. pending → posted transactions
appearing twice, or split transactions). Silently deduplicating would cause
data loss. The user manages duplicates via the Ignore button or Import
History tab.

Do **not** add automatic deduplication (hash-based or otherwise) without
explicit user request.

### No server-side / cross-device data storage (with opt-in exceptions)
The app is **client-side only** (IndexedDB + localStorage). Server-side
storage we operate (Firebase, Supabase, Cloudflare D1, etc.) was considered and
rejected. Do **not** add authentication, a backend, or automatic cloud sync
without explicit user request.

There are two opt-in exceptions that send data off-device, both user-initiated
and both BYO-credential (no backend we run): the Google Drive backup below, and
the **Ask AI** chat in `js/ask-ai.js` (added at the user's request). Ask AI is
the only feature that sends transaction *contents* to a third party: when the
user presses Send, it calls Anthropic's API (`api.anthropic.com`) with the live
DB schema and gives Claude a single read-only `run_sql` tool, runs the SELECTs
locally via `dbHelpers`, and feeds rows back until Claude answers. The API key
is user-supplied, stored only in localStorage (`askAi_apiKey`). The chat history
is persisted in the `ask_ai_messages` table (rather than localStorage) so it
survives reloads and rides inside the single exported DB blob — i.e. it is part
of both the local `.db` download/import and the Google Drive backup/restore.
Only the plain question/answer **text** is stored: `askAiSanitizedHistory`
strips the SQL (`tool_use`) and the fetched rows (`tool_result`) blocks before
saving, so no row-level data ever lands in the DB or its backups, and merges
same-role runs so the saved transcript stays a valid alternating conversation to
resend. `askAiPersistHistory` rewrites the table after every completed turn
(then `markDirty()`); `askAiLoadHistory` reloads + re-renders it on startup and
after a DB import / Drive restore; the **Delete history** button (`askAiClear`)
wipes both memory and the table after a `confirm()`. **Read-only is
load-bearing:** `askAiIsReadOnly`
rejects anything but a single SELECT/WITH statement, and every query runs inside
a `SAVEPOINT … ROLLBACK` so the AI can never mutate the DB — keep both guards if
you touch that path. A **privacy gate** (`askAiNeedsConfirmation`) sits between
running a query and sending its rows back: aggregate results (a single row, no
free-text columns) go automatically, but row-level results (multiple rows, or a
`description`/`note`/`account_number`-style column) prompt the user with
`confirm()` first — the query already ran in the rolled-back savepoint, so a
denial keeps the rows on-device and returns an error tool_result telling Claude
to use an aggregate instead. The panel works on `file://` too (unlike Drive).
Do **not** make it send data automatically or without an explicit Send action.

The sole exception is the **optional, manual Google Drive backup** in
`js/drive-sync.js` (added at the user's request). There is no backend we run:
it uses Google Identity Services (token model) + the minimal `drive.file` scope
to push/pull the single exported DB blob to a file the user owns. It is
entirely user-initiated (Connect / Back up / Restore buttons), the OAuth Client
ID is user-supplied and stored only in localStorage, and the access token lives
in memory only (never persisted). Google OAuth refuses `file://` origins, so the
Drive panel hides itself there and the local Download/Import .db buttons remain
the offline-first fallback. Do **not** turn this into automatic/background sync
without explicit user request.

## Known tech debt

See `TECH_DEBT.md` for the live list. Notable open items: per-row duplicate-
detection query in `updateImportPreview`, inline `onclick=` handlers in
`index.html` (blocks CSP tightening), unpinned/unhashed CDN deps.
