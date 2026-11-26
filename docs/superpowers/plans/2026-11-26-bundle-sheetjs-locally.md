# Bundle SheetJS Locally Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the runtime `cdn.sheetjs.com` fetch by bundling a pinned SheetJS copy into the compiled Apps Script bundle.

**Architecture:** `tools/build.mjs` imports SheetJS with esbuild and exposes it as `window.XLSX` inside `Bundle.html`. `Part1_Data.html`'s `loadSheetJsLib()` returns that local binding instead of injecting a `<script>` tag. The async signature is kept, so `.xlsx` import callers do not change.

**Tech Stack:** Google Apps Script V8, React 18 + esbuild-built `Bundle.html`, Tailwind CSS, Bun toolchain, SheetJS 0.20.2.

**Spec:** `docs/superpowers/specs/2026-11-26-bundle-sheetjs-locally-design.md`

## Global Constraints

- SheetJS version is pinned to the tarball URL `https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz` (HEAD returned 200, 2,393,376 bytes).
- No `cdn.sheetjs.com` string may remain in `Part1_Data.html` or `Bundle.html`.
- Apps Script V8; `Index.html` inlines files with `<?!= include(...) ?>`; all top-level names share one global scope, so keep helper names unique.
- `tools/**` is excluded by `.claspignore`; tests never ship to Apps Script.
- Test runner: `bun run test` currently runs `tools/test-fy-helpers.mjs`; extend it to also run the new bundle test. Bare `bun test` is Bun's built-in file-discovery runner and does not execute package scripts here.
- Compiled output must remain a single `Bundle.html` accepted by `clasp push -f`. Baseline size: 646,367 bytes.
- Deployment is a separate, explicitly confirmed operation. This plan stops at local verification.

## Review Focus

- **CDN URL survives in output** → Task 1 test asserts `cdn.sheetjs.com` is absent from both `Part1_Data.html` and `Bundle.html`.
- **Bundled namespace lacks `read` / `utils.sheet_to_json`** → Task 1 test asserts `Bundle.html` contains `0.20.2` and `sheet_to_json`; Task 3 rebuilds and re-runs it.
- **Existing fiscal-year helpers break when `Part1_Data.html` changes** → Task 3 runs the unchanged `bun tools/test-fy-helpers.mjs` as part of `bun run test`.
- **Bundle grows past what Apps Script accepts** → Task 3 records size before/after and runs `clasp status` to confirm the same 11 tracked files.
- **Offline/restricted network still fails via script injection** → Task 1 test asserts the `loadSheetJsLib` body contains no `createElement('script')`.

---

### Task 1: Add failing tests for local SheetJS

**Files:**
- Create: `tools/test-sheetjs-bundle.mjs`
- Modify: `package.json:6` (test script)

**Interfaces:**
- Consumes: none
- Produces: `bun run test` runs both `tools/test-fy-helpers.mjs` and `tools/test-sheetjs-bundle.mjs`.

- [ ] **Step 1: Write the failing test**

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const read = (name) => readFileSync(join(ROOT, name), "utf8");
const results = [];
function check(label, fn) {
  try { fn(); results.push({ label, ok: true }); }
  catch (err) { results.push({ label, ok: false, message: err.message }); }
}

check("Part1_Data.html has no CDN URL", () => {
  assert.ok(!read("Part1_Data.html").includes("cdn.sheetjs.com"));
});

check("loadSheetJsLib injects no script tag", () => {
  const body = read("Part1_Data.html").match(/async function loadSheetJsLib\(\)[\s\S]*?\n}/)?.[0];
  assert.ok(body, "loadSheetJsLib not found");
  assert.ok(!body.includes("createElement('script')"));
});

check("tools/build.mjs imports xlsx", () => {
  assert.ok(read("tools/build.mjs").includes("from 'xlsx'"));
});

check("Bundle.html has no CDN URL", () => {
  assert.ok(!read("Bundle.html").includes("cdn.sheetjs.com"));
});

check("Bundle.html contains SheetJS 0.20.2", () => {
  assert.ok(read("Bundle.html").includes("0.20.2"));
});

check("Bundle.html contains sheet_to_json", () => {
  assert.ok(read("Bundle.html").includes("sheet_to_json"));
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} SheetJS bundle checks passed.\n`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun tools/test-sheetjs-bundle.mjs`
Expected: FAIL — the CDN URL is still present in `Part1_Data.html` and `Bundle.html`, and `tools/build.mjs` does not import `xlsx`.

- [ ] **Step 3: Extend the test script**

Change `package.json:6` from:
`"test": "bun tools/test-fy-helpers.mjs"`
to:
`"test": "bun tools/test-fy-helpers.mjs && bun tools/test-sheetjs-bundle.mjs"`

- [ ] **Step 4: Commit the tests**

```bash
git add tools/test-sheetjs-bundle.mjs package.json
git commit -m "test: pin local SheetJS bundle expectations"
```

### Task 2: Bundle SheetJS from a pinned local dependency

**Files:**
- Modify: `package.json:9-14` (devDependencies)
- Modify: `tools/build.mjs:26-29` (`PRELUDE`)
- Modify: `Part1_Data.html:2498-2511` (`loadSheetJsLib`)

**Interfaces:**
- Consumes: the failing test from Task 1.
- Produces: `window.XLSX` in the compiled bundle; `loadSheetJsLib(): Promise<XLSX>` resolving locally.

- [ ] **Step 1: Add the pinned dependency**

Add this exact entry to `devDependencies` in `package.json`:
`"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz"`

Run: `bun install`
Expected: `bun.lock` updated and `node_modules/xlsx/package.json` present with version `0.20.2`.

- [ ] **Step 2: Import SheetJS in the build prelude**

In `tools/build.mjs`, change `PRELUDE` from:
```js
const PRELUDE = `import React from 'react';
import ReactDOM from 'react-dom';
const { useState, useMemo, useEffect, useRef, useCallback } = React;
`;
```
to:
```js
const PRELUDE = `import React from 'react';
import ReactDOM from 'react-dom';
import XLSX from 'xlsx';
const { useState, useMemo, useEffect, useRef, useCallback } = React;
window.XLSX = XLSX;
`;
```
Use a default import so esbuild exposes the CommonJS `module.exports` directly as `XLSX.read` and `XLSX.utils.sheet_to_json`.

- [ ] **Step 3: Replace the CDN loader**

Replace `Part1_Data.html:2498-2511` with:
```js
async function loadSheetJsLib() {
  return XLSX;
}
```
Keep the function name and async signature; remove the CDN URL and the `<script>` injection entirely.

- [ ] **Step 4: Rebuild the bundle, then run the new test to verify it passes**

Run: `bun run build && bun run test`
Expected: PASS — all 6 checks pass. `Bundle.html` must be regenerated from the new sources before the compiled-output checks are evaluated.

- [ ] **Step 5: Commit the implementation**

```bash
git add package.json bun.lock tools/build.mjs Part1_Data.html Bundle.html
git commit -m "feat: bundle SheetJS locally instead of CDN"
```

### Task 3: Verify build, tests, and deployability

**Files:** none

**Interfaces:**
- Consumes: `bun run test` from Task 1 and the compiled `Bundle.html` from Task 2.
- Produces: evidence that the local bundle is complete and still ships as 11 Apps Script files.

- [ ] **Step 1: Rebuild and record size**

Run: `bun run build`
Expected: exit 0. Record the new `Bundle.html` byte size; it must exceed the 646,367-byte baseline.

- [ ] **Step 2: Run the full test suite**

Run: `bun run test`
Expected: both suites pass — fiscal-year checks and all 6 SheetJS bundle checks.

- [ ] **Step 3: Confirm no CDN reference remains**

Run a grep for `cdn.sheetjs.com` in `Bundle.html` and `Part1_Data.html`.
Expected: no matches in either file.

- [ ] **Step 4: Confirm the file set is unchanged**

Run: `clasp status`
Expected: the same 11 tracked Apps Script files as before, with nothing from `tools/**`.

- [ ] **Step 5: Confirm the preview still serves the app**

Ensure the preview on `http://127.0.0.1:5183` is running, then request `/`.
Expected: HTTP 200. The end-to-end `.xlsx` upload check needs a connected browser; if the paired browser is offline, state that explicitly rather than claiming the upload was tested.
