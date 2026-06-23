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

### No server-side / cross-device data storage (with one opt-in exception)
The app is **client-side only** (IndexedDB + localStorage). Server-side
storage we operate (Firebase, Supabase, Cloudflare D1, etc.) was considered and
rejected. Do **not** add authentication, a backend, or automatic cloud sync
without explicit user request.

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
