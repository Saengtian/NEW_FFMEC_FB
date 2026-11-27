# Bundle SheetJS locally — short design

Date: 2026-11-26
Status: Draft — awaiting approval

## Intent

`Part1_Data.html:2498-2511` loads the Excel parser at runtime from
`https://cdn.sheetjs.com/xlsx-0.20.2/...`. That is the app's only third-party CDN
dependency. Bundling it locally makes Excel import deterministic, removes a runtime
network dependency, and works in restricted/offline networks.

## Goals

- No runtime `cdn.sheetjs.com` request.
- `loadSheetJsLib()` still resolves to the same `XLSX` API; call sites at
  `Part1_Data.html:2520-2525` keep working unchanged.
- The version is pinned in the repo and reproduced by `tools/build.mjs`.

## Non-goals

- Changing Excel parse/export behaviour, the state/revision protocol, or the UI.
- Adding new spreadsheet features.
- Migrating the existing CDN URL to another host.

## Constraints

- Apps Script V8; `Index.html` inlines files with `<?!= include(...) ?>`; all
  top-level names share one global scope, so helper names must stay unique.
- `tools/build.mjs` compiles `Icons.html` + `Part1`–`Part5` into `Bundle.html`
  with esbuild, and Tailwind into `Styles.html`.
- `clasp push -f` uploads the compiled files; a much larger `Bundle.html` must
  still be accepted by Apps Script.
- A narrow test runner exists (`bun test` → `tools/test-fy-helpers.mjs`).

## Approaches

- **A. Bundle into `Bundle.html` via esbuild (chosen).** Add `xlsx` as a pinned
  devDependency, import it in `tools/build.mjs`'s prelude, expose it as
  `window.XLSX`, and make `loadSheetJsLib()` resolve immediately. One file, no
  runtime fetch; trade-off is a larger `Bundle.html`.
- **B. Separate `SheetJs.html` included from `Index.html`.** Keeps `Bundle.html`
  smaller and isolates the library; trade-off is another 1 MB HTML file and an
  extra include, with no real caching benefit because HtmlService serves no-store.
- **C. Self-host a versioned copy on Cloud Storage/Drive.** Deterministic but
  reintroduces a runtime fetch and needs a hosting/permission decision.
- **D. Keep the CDN with SRI/fallback.** Cheapest diff, but the CDN remains a
  single point of failure — the thing being fixed.

A is chosen because the app already ships a single precompiled bundle and the
only consumer needs `XLSX.read` and `XLSX.utils.sheet_to_json`.

## Design

1. Add `xlsx` to `devDependencies`, pinned to the SheetJS 0.20.2 tarball
   (`https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz`) if npm's registry copy
   is older; otherwise pin that exact npm version.
2. In `tools/build.mjs`, add `import * as XLSX from 'xlsx'` to `PRELUDE` and set
   `window.XLSX = XLSX` before the parts are concatenated.
3. Replace `loadSheetJsLib()` in `Part1_Data.html` with a function that returns
   `XLSX` (or `window.XLSX`) directly; remove the `<script>` injection and its
   CDN URL. Keep the async signature so callers need no change.
4. Update the build-file header comment to say SheetJS is bundled locally too.

## Verification

- `bun run build` exits 0; report `Bundle.html` size before and after.
- `grep` confirms `cdn.sheetjs.com` is absent from `Bundle.html` and `Part1_Data.html`.
- `bun test` passes.
- Preview at `http://127.0.0.1:5183` returns 200; manually upload an `.xlsx` and
  confirm columns parse (browser check needs the paired browser connected).
- `clasp push -f` accepts the larger bundle, then redeploy the existing web-app
  deployment only after the above pass.
