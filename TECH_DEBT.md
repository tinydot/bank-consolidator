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

## Medium

### 5. 6,700-line monolithic `app.js`
No modules, all globals. Section banners help, but there's no enforced
boundary between layers (DB / parsing / UI). Largest barrier to safe
refactoring. Reasonable next step: split into ES modules and load with
`<script type="module">` (no bundler required to stay within the no-build
constraint in `CLAUDE.md`).

### 6. Per-row duplicate-detection query during import preview
`updateImportPreview` issues one `SELECT COUNT(*)` per preview row against
`transactions` (`app.js` around line 825). An in-memory cache keyed on
`(date, description, amount)` reduces repeats but the worst case is still
O(rows). A single pre-fetch of `(date, description, amount)` into a `Set` for
the target account would be O(rows + matches).

### 7. Per-row event listeners in `displayTransactions`
Click handlers are wired on every row on every filter/page change. Not a leak
(the DOM is replaced), but event delegation on the table parent would be
simpler and faster.

### 8. Duplicate category-read paths
`loadCategories` and `populateCategoryDropdowns` independently query the
`categories` table. Centralizing into a single read + in-memory cache, with
invalidation after mutation, would reduce drift risk.

### 9. Inline `onclick=` in `index.html`
Tab buttons and several import controls use inline handlers, which couple HTML
to global functions and prevent tightening CSP to disallow `unsafe-inline`. Not
urgent; would need event delegation or `addEventListener` wiring after DOM
parse.

## Low

### 10. `.gitignore` is sparse and contains `/.claude` twice
No editor (`.vscode/`, `.idea/`), OS (`.DS_Store`), or backup file patterns.
Trivial cleanup.

### 11. No `package.json`, linter, formatter, tests, or CI
`.github/workflows/` exists but has no workflow files. ESLint + Prettier + a
single Playwright smoke test would catch most of the high-severity items above
in CI. Constraint: keep the runtime no-build (CDN deps + plain script tags).

### 12. CDN deps unpinned and unhashed
`sql.js`, PapaParse and Chart.js are loaded by `<script src>` without `integrity`
attributes or pinned major.minor versions. Supply-chain and reproducibility
risk.

## Explicitly out of scope (per CLAUDE.md)

These are recurring suggestions that should **not** be implemented without an
explicit user request:

- Automatic duplicate-transaction detection. Duplicates in bank CSVs are often
  legitimate (pending → posted, splits). Silent dedup would lose data.
- Any server-side storage, authentication, or cloud sync. The app is
  intentionally client-side only (IndexedDB + localStorage).
