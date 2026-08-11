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
   (columns, date format) and the account is auto-detected by matching each
   account's configured keyword against the first line of the file
   (`autoDetectBankAccount`); the bank/account/date-format selectors are shown
   while a preview is active so a wrong or failed detection can be corrected.
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

Alongside that flow sits the **Purchases** tab (`js/purchases.js`), which is
deliberately *outside* it — see below.

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

### Purchases are descriptive, never monetary

`purchase_orders` / `purchase_items` / `product_catalog` (`js/purchases.js`)
hold itemised marketplace order exports — currently Shopee, via
`PURCHASE_SOURCES`, where a second marketplace is a new column mapping rather
than a new parser. They answer *what was inside* a charge: which products, at
what unit price, how often rebought.

**They are not transactions and must never be summed as money.** The spend is
already in `transactions` — it arrived on the card/bank CSV as one charge per
order — so adding orders to that table would double-count in every
`SUM(amount)` across analytics, budget, planner, and Overview (24 `FROM
transactions` sites). `purchase_orders.transaction_id` links an order to the
bank row that paid for it; the link is the point, not a second copy of the
amount. If you add a spending figure anywhere, it reads `transactions`.

Three things that are easy to get wrong:

- **Item prices do not sum to what was paid.** They are pre-voucher and
  pre-shipping; in the reference Shopee export 726 of 1003 orders differ.
  `purchase_items.allocated_amount` is each item's share of the order total,
  apportioned by gross value with the rounding drift absorbed by the largest
  item, so an order's allocations sum *exactly* to `purchase_orders.total`.
  It is the only item-level figure that reconciles — use it, not `unit_price`,
  whenever an item needs a dollar value.
- **Cancelled orders are stored but excluded** from every total (see
  `purchaseIsSpend`), because that money never reached the bank.
- **`product_key` is a seed, not an identity.** Marketplace titles are SEO
  keyword soup: in the reference export one nappy appears under 28 seed keys,
  while unrelated products share long prefixes. Normalisation aggressive enough
  to merge the first wrongly merges the second, so `purchaseProductKey` stays
  conservative (it yields ~1000 groups from 1217 items) and real merging is a
  curation step in the Products sub-tab. Unit-price trends additionally need
  `pack_size`/`unit` — a 100-pack and a 40-pack are not comparable — which no
  export supplies.

#### Product identity comes from parsed titles, not from string matching

`js/purchases-ai.js` parses each distinct title into `{brand, item, pack size,
category}` via the Anthropic API and caches it in `title_extractions`, keyed by
the title. **That cache is the rule set.** The rejected alternative — having the
model emit keyword→field rules — yields patterns nobody has read firing across
every row, where one over-broad rule silently mis-brands dozens of products;
per-title extraction is inspectable and correctable one row at a time.

Three things this design depends on:

- **Identity is `brand|item`; pack size is deliberately excluded.** A 50-pack
  and a 40-pack of the same nappy must land in one product or there is no price
  trend to plot. Size is an attribute of the purchase, not part of what the
  product is.
- **Unit arithmetic happens in code, never in the model.** The model reports
  `{value, unit, multiplier}` against a fixed enum; `normalizeSize` converts to
  a base unit and resolves the multiplier, so `24x200ml` is stored as 4800 ml.
- **A null size is a correct answer.** Only ~27% of titles carry a size at all
  (a phone grip has none), and those cluster in exactly the consumables that
  need one. Do not treat null as an extraction failure.

`resolveProductKey()` is the single resolution order, shared by the import path
and the re-apply pass: **manual merge → title extraction → seed key**. Each step
is a fallback for the one above being absent, so extraction improves identity
without overriding a correction made by hand.

One consequence is easy to miss: a merge made *before* extraction points its
members at a **seed** key, so after extraction those members would keep the seed
key while everything else moved to the extracted key — splitting one product in
two. `extractApply()` therefore re-points each alias at the extracted identity
of its own target *before* re-keying items, and prunes catalog rows the re-key
strands. Hand-edited extractions (`edited = 1`) are never overwritten by a
re-run.

#### Merges live in `product_aliases`, not in the item rows

`purchase_items.product_key` is **derived**, never authoritative:
`alias(source_key) ?? source_key`. `source_key` is what the row's own name
seeds and is never rewritten.

This indirection is load-bearing. Re-importing an order deletes and re-inserts
its items, so a merge recorded only in `product_key` would be silently
discarded by the next overlapping export — the exact workflow the idempotent
import is designed for. The import path therefore resolves every item through
`product_aliases`, and merging writes there first. It also makes merges
reversible: `unmergeProduct` drops the aliases and restores `product_key` from
`source_key`, so a wrong merge is not a one-way door.

When merging, repoint *nested* aliases too (`UPDATE product_aliases SET
product_key = …`), or keys aliased into an absorbed group get stranded.
`product_catalog` rows for absorbed groups are dropped, since nothing can
reach them again.

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
     → categories → bank-profiles → rules → budget → planner → overview
     → purchases → drive-sync → ask-ai → purchases-ai
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

### Balance snapshots are append-only, one per account per day

`bank_balances` is a history table: each "Update Balance" / "Record month-end"
(`js/planner.js`) appends a dated snapshot, and `js/overview.js` charts
net-worth-over-time by carrying each account's last-known balance forward.
`setupBalanceSnapshotIndex` (run from `setupSchema`, **after**
`migrateToForeignKeys`, which would otherwise drop the index) enforces
`UNIQUE(account_id, as_of_date)`, so `saveBalance` / `saveBatchBalances` upsert
`ON CONFLICT(account_id, as_of_date)` — re-recording a date corrects it in
place instead of stacking duplicates. A one-shot dedupe
(`migration_balance_snapshot_dedupe`) collapses legacy duplicates first. Edit or
delete individual snapshots via the per-account history modal (`showBalanceHistory`);
the per-account ✕ (`deleteBalanceAccount`) still wipes them all.

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
foreign-bank imports. If no pattern matches (or a matched pattern produces an
out-of-range month/day, e.g. an MM/DD profile fed DD/MM data), `null` is
returned and the import preview counts the row as an unparseable date so the
problem surfaces. Amounts behave the same way: `parseAmount` (`js/dates.js`)
returns `null` for cells it cannot understand and the preview reports them as
unparseable amounts instead of importing $0.00.

## Intentional design decisions

### No silent duplicate-transaction deduplication
Duplicate transactions are **intentionally allowed**. Some banks legitimately
issue duplicate rows in their CSV exports (e.g. pending → posted transactions
appearing twice, or split transactions). Silently deduplicating would cause
data loss. The user manages duplicates via the Ignore button or Import
History tab.

The only dedup that exists is advisory and lives in the **import preview**
(`updateImportPreview` in `js/import.js`): rows whose exact
`(date, description, amount)` already exists for the target account are
flagged "already imported" and unchecked by default, with a per-key count so
N identical rows in a file are only flagged up to the count already stored.
A visible checkbox ("tick to import anyway", backed by `_showDuplicates`)
lets the user import them regardless — nothing is ever dropped without that
choice being shown. Because matching is exact rather than date-based,
backfilling older statements works, and manual entries only match when all
three fields coincide.

Do **not** add automatic deduplication at insert time (hash-based or
otherwise), and do not remove the user override, without explicit user
request.

The **one** exception is the itemised-purchase import (`js/purchases.js`),
which upserts on `UNIQUE(purchase_orders.source, external_id)`. The rule above
protects bank CSVs, where duplicate rows are legitimate data and no stable row
id exists; a marketplace export supplies a real order id, and overlapping
re-exports are the normal workflow, so re-importing must refresh rather than
restate. It does not touch the `transactions` table. A consequence: file-level
undo is not offered for purchases (one order is typically carried by several
exports, so "undo that file" is ill-defined) — removal is per-order or
per-source via `clearPurchaseSource()`.

The second, equally advisory, place duplicates surface is the **duplicate
review** in the Transactions tab (`filterDuplicatesOnly` →
`loadDuplicateTransactions` in `js/transactions.js`). Ticking it re-renders the
normal transaction table showing only rows that share their `(date, amount)`
with another row **in the current filter set** — deliberately looser than the
import preview's `(date, description, amount)` so a pending/posted pair with
differing descriptions still groups. All the other filters still apply, so
scoping to one account or a date range narrows what counts as a duplicate.
Rows are grouped under a `(date, amount)` header and **pagination counts
groups, not rows** (`CONFIG.DUPLICATE_GROUP_PAGE_SIZE`), so a group is never
split across pages. Nothing is deleted or auto-ignored: the user presses the
per-row Ignore, or selects rows ("Select all but first" ticks every row of a
group except the earliest) and uses the bulk **Ignore Selected** /
**Unignore Selected** buttons (`setIgnoredForSelection`). With the default
"Active only" status filter, ignoring rows shrinks the group until it no longer
has two matching rows and it drops out of the view.

`buildTransactionFilter()` is the single source of the filter-bar WHERE clause;
both the normal list and the duplicate view use it, so a new filter added there
applies to grouping and row fetching alike.

### No server-side / cross-device data storage (with opt-in exceptions)
The app is **client-side only** (IndexedDB + localStorage). Server-side
storage we operate (Firebase, Supabase, Cloudflare D1, etc.) was considered and
rejected. Do **not** add authentication, a backend, or automatic cloud sync
without explicit user request.

There are three opt-in exceptions that send data off-device, all user-initiated
and all BYO-credential (no backend we run): the Google Drive backup below, the
**Ask AI** chat in `js/ask-ai.js`, and **title extraction** in
`js/purchases-ai.js` (all added at the user's request). The latter two are the
features that send transaction *contents* to a third party.

**Title extraction** (`js/purchases-ai.js`) sends *only marketplace product
titles* — never prices, dates, shops, order ids, or anything from the bank
tables — to `api.anthropic.com`, using the same user-supplied key as Ask AI
(`askAi_apiKey`; there is deliberately no second credential). It runs only on
an explicit button press, shows the exact count in the confirm dialog before
sending, and is never triggered by an import. Results are cached in
`title_extractions` keyed by the title, so a title is sent at most once and
re-running costs only what is new. Do **not** make it automatic, and do not
widen what it sends beyond the title.

Ask AI is the older of the two: when the
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

An optional **personal-context box** (`askAiStoredContext`, localStorage key
`askAi_context`) lets the user describe their situation, local cost norms and
goals (e.g. "I'm in Singapore, hawker meals under $6 are normal — don't suggest
meal-prep"). When non-empty it is injected into `askAiSystemPrompt` as an
authoritative "USER-PROVIDED CONTEXT" block so answers fit the user's life
instead of generic personal-finance defaults; the prompt also tells Claude to
weigh local norms and ask a clarifying question before labelling spend as a "bad
habit". It is plain text the user edits in the Ask AI setup panel, stored only
in this browser, and sent to the API as part of the system prompt on every Send.

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
