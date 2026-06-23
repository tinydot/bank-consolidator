# Bank Statement Consolidator

Consolidate multiple bank CSV exports into a single local SQLite database, with
analytics, budgeting, transaction rules, and an emergency-fund planner.

Runs entirely in the browser. No backend of our own — your data stays on your
device (IndexedDB + a localStorage crash-safety backup), with an **optional,
manual** backup to your own Google Drive if you want it.

## Features

- **Overview** — home dashboard with emergency-fund progress + ETA (at your
  recent savings pace), savings-rate trend, and balance-over-time chart.
- **Multi-bank CSV import** — define a profile per bank (columns, date format,
  header rows) and import; bank/account is auto-detected from filename
  keywords where possible.
- **Transactions** — search, filter by bank/account/category/date, bulk
  categorise, ignore, edit, or delete. Paginated table with import-history view.
- **Categories & subcategories** — colour-coded, sortable, with per-row icons.
- **Transaction rules** — keyword → category/subcategory or auto-ignore, with
  priority ordering and case sensitivity toggle.
- **Analytics** — monthly trend chart, category breakdown, top merchants,
  exportable static HTML report.
- **Budget** — monthly limits per category with progress bars.
- **Planner** — emergency-fund target tracking with expense commitments and
  one-off activity costs.
- **Offline-first** — works from `file://` on iPhone Safari with no server.
- **Backup & Sync** — download/import the raw `.sqlite` file, or back up and
  restore to your own Google Drive (optional, manual, `drive.file` scope only).

## Running

No build step, no dependencies to install. Three options:

**Open directly.** Double-click `index.html`, or open it in mobile Safari from
Files. The three CDN libraries (`sql.js`, PapaParse, Chart.js) load on first
run; everything else is local.

**Static server (recommended for desktop dev).**

```sh
python3 -m http.server 8080
# then visit http://localhost:8080
```

`.claude/launch.json` includes ready-made launchers for `python3 -m http.server`
and `npx serve`.

**GitHub Pages.** Pushing to `main` deploys via `.github/workflows/`.

## Data storage

- The full SQLite database is held in memory (`sql.js`) and persisted as a
  single row in IndexedDB (`BankConsolidator` / `database`).
- Writes are debounced 1 s, flushed immediately when the tab is hidden, and
  backed up synchronously to `localStorage` on `beforeunload` so an unexpected
  refresh inside the debounce window is recoverable.
- To wipe everything: clear site data for the page in your browser's dev tools,
  or use Settings → Backup &amp; Sync → Clear All Data.
- To back up: Settings → Backup &amp; Sync lets you download the raw `.sqlite`
  file, re-import one, or push/pull a copy to your own Google Drive. (Individual
  views can still be exported as CSV from the Analytics tab.)

### Google Drive sync

The Drive backup is optional and entirely user-initiated. Because Google OAuth
does not allow `file://` origins, it only works when the app is served over
HTTPS (e.g. GitHub Pages) or from `http://localhost`.

**For end users:** nothing to set up. Open Settings → Backup &amp; Sync →
Google Drive, click **Connect Google Drive**, and grant access. Your data is
backed up to *your own* Drive; the app uses the minimal `drive.file` scope so it
can see *only* the `bank_statements.db` it creates (inside a `BankConsolidator`
folder) — nothing else in your Drive. The access token is held in memory only
and is never persisted.

**Hosting your own copy?** A built-in OAuth Client ID ships in
`js/drive-sync.js` (`DEFAULT_CLIENT_ID`). Client IDs are not secrets — access is
restricted by the OAuth client's **Authorized JavaScript origins** whitelist. If
you fork and deploy to a different origin, create your own OAuth client:

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Google Drive API**.
2. Create an **OAuth client ID** of type **Web application**, and add your
   site's URL (e.g. your GitHub Pages origin, or `http://localhost:8080`) under
   **Authorized JavaScript origins**.
3. Either replace `DEFAULT_CLIENT_ID` in `js/drive-sync.js`, or paste the ID
   into Settings → Backup &amp; Sync → Google Drive → *Advanced* (stored only in
   that browser).

Because `drive.file` is a **non-sensitive** scope, the OAuth consent screen can
be published to production for any Google user without going through Google's
app-verification process.

## Project layout

```
index.html         Single-page UI, inline onclick handlers wire to globals
styles.css
js/
  core.js          Globals, dbHelpers, validators, escapeHtml, loading overlay
  database.js      Schema, money-to-cents migration, init
  import.js        CSV parsing, preview, account matching, commit-to-DB
  dates.js         normalizeDate (explicit formats only — no locale fallback)
  transactions.js  Table render, filters, edit/ignore/delete
  analytics.js     Stats, charts, exports, IndexedDB persistence, markDirty
  categories.js    Categories + subcategories CRUD
  bank-profiles.js Bank/account profile editor
  rules.js         Keyword → category rules
  budget.js        Monthly per-category limits
  planner.js       Emergency fund + commitments + activities
  overview.js      Home dashboard: fund progress + ETA, savings rate, balance trend
  drive-sync.js    Optional manual Google Drive backup/restore (drive.file)
```

The scripts are plain (non-module) and **must** load in the order listed at
the bottom of `index.html`.

## Intentional design choices

- **Duplicates are not auto-detected.** Banks legitimately emit duplicate
  rows (pending → posted, split transactions). Use the Ignore button or the
  Import History tab to manage them.
- **No backend of our own.** Adding auth or server storage we operate is out of
  scope. The optional Google Drive backup is the one exception — it talks
  directly to the user's own Drive (no server in between) and is fully manual.

See `CLAUDE.md` for the architecture notes and `TECH_DEBT.md` for the live
list of known issues.

## License

No license file is included.
