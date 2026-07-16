---
name: verify
description: Build/launch/drive recipe for verifying changes to this static SPA end-to-end in headless Chromium.
---

# Verifying bank-consolidator changes

No build step. Serve statically and drive the real page with Playwright.

## Launch

```bash
python3 -m http.server 8123 --directory <repo-root> &   # any static server works
```

## Drive (headless Chromium via playwright-core)

- Chromium is pre-installed; the executable is
  `/opt/pw-browsers/chromium-<rev>/chrome-linux/chrome` (glob for the rev —
  it is NOT `chromium/chrome-linux64/chrome`). `npm install playwright-core`
  in a scratch dir is enough; do not run `playwright install`.
- The page loads `sql.js` (sql-asm.js) and `chart.js` from CDNs that the
  sandbox network policy blocks. `npm install sql.js@1.8.0 chart.js@4.4.0`
  (npm registry IS allowed) and `page.route('**/sql-asm.js', ...)` /
  `page.route('**/chart.umd.min.js', ...)` to fulfill from
  `node_modules/sql.js/dist/sql-asm.js` and
  `node_modules/chart.js/dist/chart.umd.js`.
- App globals (`db`, `bankProfiles`, `previewTransactions`, `dbHelpers`, all
  functions) are top-level `let`/`function` in classic scripts — reachable
  from `page.evaluate` by bare name, but NOT as `window.db` (`let` doesn't
  attach to window). Wait for boot with
  `page.waitForFunction(() => { try { return !!(db && bankProfiles.length) } catch { return false } })`.
- Auto-accept dialogs: several flows call `confirm()`
  (`page.on('dialog', d => d.accept())`).

## Flows worth driving

- CSV import: seed an account with a keyword
  (`db.run("INSERT INTO accounts (bank_id, account_name, account_number, keyword) VALUES (?, 'Checking', '1234', 'TESTBANK')", [bankProfiles[0].id])`),
  build a `File` in page context, `await handleFiles([file])`, wait for
  `#importPreview .import-preview-box`, click the Import button. Auto-detect
  matches the keyword against the FIRST LINE of the file (not the filename).
- Read back state with `dbHelpers.queryAll('SELECT ...')` in page context.
- Persistence: `markDirty()` flushes to IndexedDB after a 1 s debounce — wait
  ~1.5 s before `page.reload()` when checking durability.
