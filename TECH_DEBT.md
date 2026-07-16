# Tech Debt — Bank Statement Consolidator

A snapshot of known technical debt. Living document — update as items land or new
ones are discovered. Severity reflects user-visible impact and risk, not effort.

## High

### 1. XSS via unescaped names in dropdown builders
**Status:** Fixed (see commit history).

Dropdown `<option>` strings for accounts, categories, subcategories and banks
were assembled with template literals and `innerHTML +=` without going through
`escapeHtml()`. A user-supplied name like `<img src=x onerror=alert(1)>` would
execute on the next dropdown rebuild.

Affected sites were `updateAccountOptions`, `updateCategoryFilter`,
`updateSubcategoryFilter`, `populateSubcategorySelect`, `updateBankFilter`,
`updateAccountFilter`. All now escape both the id (defence in depth) and the
display name. The rest of the app already used `escapeHtml()` for rendered
descriptions; these were the gaps.

### 2. Money stored as floating-point
**Status:** Fixed (see commit history).

`transactions.amount`, `manual_transactions.amount`, `budget.monthly_limit`,
`expense_commitments.amount`, `activity_items.estimated_cost`/`actual_cost`,
and `bank_balances.balance` were declared `REAL`. Sums of decimal values
accumulate drift (`0.1 + 0.2 = 0.30000000000000004`), and per-row arithmetic
like `credit - debit` can produce display surprises.

Now stored as integer cents. A one-time `migration_money_to_cents` runs on
startup, multiplies existing decimal columns by 100 and rounds to integers,
and records completion in `settings`. New code uses the `toCents` / `fmtMoney`
/ `fmtMoneySigned` helpers; SQL aggregates (`SUM(amount)`, `ABS(amount)`,
`amount < 0`) work unchanged on integers. CSV export and display sites divide
by 100 only at the rendering boundary.

### 3. Locale-dependent date fallback in `normalizeDate`
**Status:** Fixed (see commit history).

When none of the explicit format patterns matched, `normalizeDate` fell back to
`new Date(s)`. Browsers interpret `01/02/2025` differently per locale (US: Jan
2, UK: Feb 1), so an import from a foreign bank could silently produce wrong
dates. The fallback now returns the raw string unchanged so import surfaces the
problem instead of corrupting data, and the user can pick an explicit date
format in the bank profile.

### 4. `JSON.parse` of `localStorage` without `try`/`catch`
**Status:** Fixed (see commit history).

`loadBankProfiles` parsed legacy `localStorage['bankProfiles']` directly. Any
corrupt value (manual DevTools edit, partial write) would throw and stall init.
Now wrapped in `try`/`catch`; on failure the legacy key is removed and defaults
are created.

### 13. XSS via unescaped bank-profile fields in the profile editor
**Status:** Fixed (see commit history).

Same bug class as #1, missed in the sweep. `renderBankProfiles`
(`js/bank-profiles.js`) interpolates the user-editable profile fields into
`value="…"` attributes without `escapeHtml()`:

- line ~158: `value="${profile.name}"`
- line ~178: `value="${profile.dateColumn}"`
- line ~197: `value="${profile.descriptionColumn}"`
- lines ~207/215/219: `amountColumn` / `creditColumn` / `debitColumn`

These are free text (`updateProfile` saves whatever is typed; the
`bankProfileName` validator only checks length and isn't even called on this
path). A value containing `"` breaks out of the attribute; a payload like
`" onfocus="alert(1)" autofocus x="` executes on the next Settings render.
Because the values live in the DB, a malicious imported `.db` / Drive restore
is also a vector. All six interpolations now go through `escapeHtml()` (the
account keyword on line ~248 already did — the profile fields were the gap).

### 14. XSS via unescaped activity item descriptions in the Planner
**Status:** Fixed (see commit history).

`loadUnscheduledActivities` and `loadScheduledActivities` (`js/planner.js`)
built `itemsSummary` from raw `activity_items.description` values and
interpolated it into `innerHTML` without escaping. Item descriptions are
unvalidated free text, so `<img src=x onerror=…>` typed into an activity cost
item executed whenever the Planner section rendered. The activity *name* and
*notes* on the same cards were already escaped — only the items summary was
missed. Both sites now wrap the description in `escapeHtml()`.

## Medium

### 5. Monolithic `app.js`
**Status:** Fixed (see commit history).

`app.js` was a single ~7,000-line file. It is now split into plain
(non-module) scripts under `js/`, loaded in dependency order by `index.html`
(`core → database → import → dates → transactions → analytics → categories →
bank-profiles → rules → budget → planner → overview → drive-sync → ask-ai`).
The split was purely mechanical along the existing section banners —
concatenating the files in load order reproduces the original file — so
behaviour is unchanged.

Classic (non-module) scripts were chosen deliberately: they share one global
scope, so the inline `on*=` handlers (#9) keep working and the mutable
top-level state (`db`, `bankProfiles`, …) stays reassignable across files.
ES modules would have broken both. Remaining debt: globals are still global,
so there is no *enforced* layer boundary — but the code is now navigable.

### 6. Per-row duplicate-detection query during import preview
**Status:** Fixed (see commit history).

`updateImportPreview` used to issue one `SELECT COUNT(*)` per preview row.
It now uses a multi-stage pass: rows strictly older than the account's latest
stored date are flagged without any query, and only rows *on* the boundary
date fall through to exact-match counting, with a per-fingerprint cache so
each `(date, description, amount)` key is queried at most once. Worst case is
now O(rows on one date), not O(all rows).

### 7. Per-row event listeners in `displayTransactions`
Click handlers are wired on every row on every filter/page change. Not a leak
(the DOM is replaced), but event delegation on the table parent would be
simpler and faster.

### 8. Duplicate category-read paths
`loadCategories` and `populateCategoryDropdowns` independently query the
`categories` table. Centralizing into a single read + in-memory cache, with
invalidation after mutation, would reduce drift risk.

### 9. Inline `onclick=` in `index.html` and generated HTML
Tab buttons and several import controls use inline handlers, which couple HTML
to global functions and prevent tightening CSP to disallow `unsafe-inline`.
The pattern has also spread into JS-generated markup: Planner calendar day
cells (`onclick="showPlannerDayDetail('…')"`), activity cards
(`onclick="editActivity(${id})"` etc.), the template picker (inline
`onmouseenter`/`onmouseleave`), and `renderActivityItems` (inline `onchange`
mutating `activityItemsData[idx]`). Newer code (transactions table, rules
list, balance breakdown) already uses `addEventListener` + `data-*`
attributes — converging the remainder on that pattern is the path to a
strict CSP. `switchTab` / `switchPlannerSection` also *select* buttons by
their inline-handler string (`[onclick="switchTab('x')"]`), so the handlers
can't be removed without also fixing those selectors.

### 15. `updateAnalytics()` runs after every mutation, even when hidden
Every write path (toggle ignore, category edit, manual add, rules apply, …)
awaits `updateAnalytics()`, which rebuilds three tables, a Chart.js chart and
`renderCategoryDetailTags` — the latter compiles a RegExp per enabled rule
per transaction in the month. All of this happens even when the Analytics
section isn't visible (it re-renders again anyway on
`switchPlannerSection('analytics')`). On a large DB this makes every small
edit pay a full analytics rebuild. Skipping the rebuild when the section is
hidden (as `saveMonthlyIncome` already does) would fix most of it.
Related: `renderFrequentTransactions` calls `applyTransactionRules` once per
merchant group, and each call re-runs the full rules SELECT — hoisting the
rules query out of the loop would make it O(groups × rules) on in-memory data
instead of O(groups) SQL round-trips.

### 16. Styling is ~90% inline `style="…"` strings in JS templates
`styles.css` is 733 lines, but most of the UI is styled through repeated
inline style strings in template literals (hundreds of occurrences of the
same paddings, borders and hex colours like `#7f8c8d`/`#ecf0f1`/`#2c3e50`).
Consequences: no single place to retheme, easy drift between screens that
should match (e.g. four visually-similar modal implementations — see #17),
and `style-src 'unsafe-inline'` is forced forever. Extracting the recurring
patterns (cards, badges, pills, table cells, summary grids) into classes
would shrink the JS and make #9/CSP work meaningful.

### 17. Four ad-hoc modal implementations
Modals are built four different ways: `.modal-overlay`/`.modal-content`
classes (analytics tag drill-down), inline-styled overlay divs
(`showEditNote`, `showEditCategory`, `showBulkEditCategory`,
`showAddSubcategoryForm`, `showBalanceHistory`, `showBatchBalanceForm`), and
two show/hide `<div>` forms in `index.html` (planner form, balance form).
Behaviour differs: only some close on overlay click, only the tag drill-down
and note modal handle Escape, and the tag drill-down's `keydown` listener is
only removed when Escape is pressed — closing it via the ✕ button or overlay
click leaks one document-level listener per open. A single `openModal()`
helper would fix consistency, the leak, and (eventually) focus trapping.

## Low

### 10. `.gitignore` is sparse and contains `/.claude` twice
No editor (`.vscode/`, `.idea/`), OS (`.DS_Store`), or backup file patterns.
Trivial cleanup.

### 11. No `package.json`, linter, formatter, or tests
`.github/workflows/static.yml` now exists, but it only deploys the static
site to GitHub Pages on push to `main` — there is still no lint/test CI.
ESLint + Prettier + a single Playwright smoke test would catch most of the
high-severity items above (both #13 and #14 are the exact bug class a
`no-unsanitized` lint rule flags). Constraint: keep the runtime no-build
(CDN deps + plain script tags).

### 12. CDN deps pinned but unhashed
**Status:** Partially fixed. `sql.js` (1.8.0) and Chart.js (4.4.0) are now
pinned to exact versions in `index.html`, and PapaParse was replaced by the
in-house `parseCSV`. Remaining: no `integrity` (SRI) attributes, so a
compromised CDN can still inject code; `crossorigin` + SRI hashes would
close that.

### 18. Category icons rendered unescaped in two headers
`renderCategoryDetailTags` (`js/analytics.js`, `${cat.icon}`) and
`renderPlannerTable` (`js/planner.js`, `${cat.icon}`) interpolate the
category icon into `innerHTML` raw, while `budget.js` / `categories.js`
escape the same value. The add-category form caps the field at
`maxlength="2"`, but the DB column is unconstrained (imported `.db` files
bypass the form), and the inconsistency invites copy-paste of the unescaped
variant. Same low-risk family: `showAddSubcategoryForm` interpolates
`categoryName` into its modal heading unescaped — currently harmless only
because `validators.categoryName` rejects `<`/`>`.

### 19. Dead code and vestigial state
- `_showDuplicates` (`js/core.js`) is written in two places, never read —
  leftover from the removed preview-table duplicate toggle.
- `dbHelpers.queryForEach` has no callers.
- `renderPlannerTable` creates `tdGrand` (colSpan 2) for the grand-total row
  but never appends it, so the row is two cells short (invisible only because
  the total row lives in its own table).
- `expandTagToTransactions(bodyContainer, …, categoryColor)` ignores its
  first and last parameters.

### 20. No keyboard/ARIA support on interactive elements
Tabs are plain `<button>`s without `role="tab"`/`aria-selected`; collapsible
category/rule group headers, analytics month rows, planner calendar days and
tag chips are `<div>`/`<tr>` with `onclick` + `cursor:pointer` — not
focusable, not activatable by keyboard. Modals don't trap or restore focus.
Fine for a personal tool, but worth knowing it's a mouse-only UI today.

## Explicitly out of scope (per CLAUDE.md)

These are recurring suggestions that should **not** be implemented without an
explicit user request:

- Automatic duplicate-transaction detection. Duplicates in bank CSVs are often
  legitimate (pending → posted, splits). Silent dedup would lose data.
- Any server-side storage, authentication, or cloud sync. The app is
  intentionally client-side only (IndexedDB + localStorage).
