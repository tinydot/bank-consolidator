# Vendored third-party libraries

`index.html` loads its two third-party libraries from this folder instead of a
CDN. They are served same-origin (and resolve over `file://`), so there is no
external script the page has to trust, and the app runs with no network access
at all.

## Why vendored rather than CDN + SRI

A CodeQL alert flagged the CDN `<script src>` tags as "inclusion of
functionality from an untrusted source" — no `integrity` attribute, so a
compromised or hijacked CDN could serve arbitrary code into a page that holds
the user's entire financial database. Adding SRI hashes would close the
tampering hole but still leaves the app dependent on two third-party hosts at
runtime, which sits badly with an offline-first, client-side-only app whose
documented workflow is opening `index.html` from `file://`. Vendoring closes
both at once: the bytes are in the repository, reviewed and diffable, and the
GitHub Pages workflow already uploads the whole repository, so they ship as-is.

## Contents and provenance

Both files were taken verbatim out of the official npm package tarballs, whose
SHA-512 digests were checked against the `dist.integrity` value published by
`registry.npmjs.org` for that exact version:

| Path | Package | npm tarball integrity (verified) |
| --- | --- | --- |
| `sql.js-1.8.0/sql-asm.js` | `sql.js@1.8.0` (`package/dist/sql-asm.js`) | `sha512-3HD8pSkZL+5YvYUI8nlvNILs61ALqq34xgmF+BHpqxe68yZIJ1H+sIVIODvni25+CcxHUxDyrTJUL0lE/m7afw==` |
| `chart.js-4.4.0/chart.umd.js` | `chart.js@4.4.0` (`package/dist/chart.umd.js`) | `sha512-vQEj6d+z0dcsKLlQvbKIMYFHd3t8W/7L2vfJIbYcfyPcRx92CsHqECpueN8qVGNlKyDcr5wBrYAYKnfu/9Q1hQ==` |

Per-file SHA-384 digests, so a later change to these files is detectable:

```
sql.js-1.8.0/sql-asm.js       sha384-lJQGJ26r89i4hDPcMDnFg2BHiI4bG8U6LYvE+KO1QalxaV6JPstYbnO+7gKh0RwD
chart.js-4.4.0/chart.umd.js   sha384-FcQlsUOd0TJjROrBxhJdUhXTUgNJQxTMcxZe6nHbaEfFL1zjQ+bq/uRoBQxb0KMo
```

Verify a file with:

```
openssl dgst -sha384 -binary vendor/sql.js-1.8.0/sql-asm.js | openssl base64 -A
```

Notes on the two builds:

- **`sql-asm.js`, not `sql-wasm.js`** — the asm.js build is a single
  self-contained script with no sibling `.wasm` fetch, which is what makes
  `file://` work in Safari. Keep it that way.
- **`chart.umd.js`** is Chart.js's own distributed UMD build (already
  minified upstream). The previous CDN URL pointed at `chart.umd.min.js`,
  which jsDelivr generates on the fly — that file does not exist in the npm
  package, so the published `chart.umd.js` is the authentic equivalent.

Upstream licences are kept alongside each library (`sql.js-1.8.0/LICENSE`,
`chart.js-4.4.0/LICENSE.md`); both are MIT.

## Updating a library

1. Download the tarball: `npm pack sql.js@<version>` (or
   `curl -O https://registry.npmjs.org/sql.js/-/sql.js-<version>.tgz`).
2. Check its SHA-512 against `dist.integrity` from
   `https://registry.npmjs.org/sql.js/<version>` before extracting anything.
3. Extract the dist file into a new `vendor/<pkg>-<version>/` folder, copy the
   licence across, delete the old folder, and update the `<script src>` in
   `index.html`.
4. Update the digests in this file.

## Still loaded from a third party

`js/drive-sync.js` injects Google Identity Services from
`https://accounts.google.com/gsi/client` when the user connects Google Drive.
That endpoint is deliberately unversioned and Google rotates its contents, so
SRI is not possible for it; it is also loaded only on an explicit user action
and never on `file://` (Google OAuth rejects `file://` origins, and the Drive
panel hides itself there).
