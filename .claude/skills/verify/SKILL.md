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
- `sql.js` and `chart.js` are vendored under `vendor/` and load same-origin,
  so no `page.route` interception is needed and the page works with the
  sandbox's CDN block in place. Asserting `requests` contains no non-local
  URL is a cheap regression check that nothing has crept back onto a CDN.
- `file:///<repo-root>/index.html` works too, and is worth driving whenever a
  change touches script/asset paths — that is the iPhone-Safari workflow.
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
  matches the keyword against the FIRST LINE of the file (not the filename) —
  but with the default profiles (`has_header = 1`, `skip_rows = 0`) that same
  first line is the header, so a synthetic CSV that opens with a bank banner
  parses as a one-column file and previews "No rows found". Either set the
  account keyword to a header column name, or set `skip_rows` to match.
- Build the CSV from `bankProfiles[0]`'s own column names
  (`dateColumn`/`descriptionColumn`/`amountColumn`, camelCase) so it matches
  whichever profile you target. Note `dbHelpers.queryAll` returns row
  **arrays**, not objects — use `bankProfiles` for a keyed view.
- Read back state with `dbHelpers.queryAll('SELECT ...')` in page context.
- Chart.js: `Chart.instances` is gone in v4 — use `Chart.getChart(canvas)`.
  Charts on hidden tabs render to a 0×0 canvas, so assert on
  `chart.data.datasets`, not on pixels.
- Persistence: `markDirty()` flushes to IndexedDB after a 1 s debounce — wait
  ~1.5 s before `page.reload()` when checking durability.
