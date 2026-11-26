# Spec Gap Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three concrete gaps found by the code review — ID reuse after deletion, unneutralized KPI/history writes, and the missing `unknown` audit actor — before the clasp deploy.

**Architecture:** A new `idCounters` object slice carries per-prefix high-water marks from the client into `_FFM_STATE_STORE`; `nextId` and `nextBuildMatrixConfig` take a `maxSeen` argument so a deleted top record's number is never reissued. CSV and history writes share the existing sanitizer and BOM convention; a small `saveIdentity_` helper normalizes a missing actor to `unknown` while keeping the executor email.

**Tech Stack:** Google Apps Script V8 (`Code.js` + inlined HTML parts), React 18 UMD, Bun test/build scripts, SheetJS bundle, clasp.

**Spec:** `docs/superpowers/specs/2026-11-27-spec-gap-fixes-design.md`

## Global Constraints

- Apps Script V8; `Index.html` inlines the parts, so top-level names share one global scope and helper names must be unique.
- `PERSISTED_SLICES` in `Code.js`, `SLICE_TYPES` in `tools/import-state.mjs`, `PAYLOAD_SLICE_LABELS` in `Part1_Data.html`, and `buildWorkspacePayload`/`hydrateFromPayload` in `Part2_App.html` must agree on slice names and types.
- `idCounters` is an object, default `{}`; older exports without it hydrate as `{}`. No change to the chunk format or revision protocol.
- Existing CSV exports use `csvText` and `'\uFEFF'`; keep that convention everywhere.
- `appsscript.json` stays `USER_ACCESSING` / `DOMAIN`; `doGet` keeps failing closed without a Google identity.
- Tests are standalone scripts under `tools/`, run by `bun run test`; `tools/**` is excluded by `.claspignore`.
- TDD: each behavior gets a test that is watched failing before production code changes.
- Deploy is a separate, explicitly confirmed operation; this plan stops at local verification.

## Review Focus

- Deleting the highest-numbered `CI-`/`CF-26-`/`TM-`/`TSK-`/project ID then adding → next ID is above the deleted number, not equal to it (Task 1 `deleted CI-12 is not reissued`).
- Deleting the highest `ME##` line and opening the add-row modal → no `ME` config is reused for that project (Task 1 `deleted ME12 is not reissued`).
- A user types `=1+1` into a KPI label or a state row → the exported CSV and `_FFM_STATE_HISTORY` contain literal text, never a formula (Task 3 `KPI CSV neutralizes a formula`, `history rows neutralize a formula`).
- Excel opens the KPI deep-dive with Thai text and `฿` intact → the export text begins with a UTF-8 BOM (Task 3 `KPI export text carries a BOM`).
- Google returns no active email on a save → an `AuditLog` row is still appended with actor `unknown` and the executor email (Task 4 `missing email yields unknown actor`).

---

### Task 1: ID high-water marks

**Files:**
- Create: `tools/test-spec-gap-fixes.mjs`
- Modify: `package.json:6`
- Modify: `Part1_Data.html:3895-3915` (`nextId`), `Part1_Data.html:3955-3966` (`PAYLOAD_SLICE_LABELS`)
- Modify: `Part2_App.html:176` (state), `Part2_App.html:248-259` (`buildWorkspacePayload`), `Part2_App.html:268-299` (`hydrateFromPayload`), `Part2_App.html:634` (effect deps), `Part2_App.html:1123,1362,1385,1758,1980,2012,2343` (call sites), `Part2_App.html:1198-1243,3328-3341` (build-matrix counter)
- Modify: `Part4_ViewsB.html:1649-1659,1683` (`nextBuildMatrixConfig`, modal default)
- Modify: `Code.js:65-76` (`PERSISTED_SLICES`)
- Modify: `tools/import-state.mjs:35-46` (`SLICE_TYPES`)

**Interfaces:**
- Consumes: nothing.
- Produces: `nextId(prefix, items, maxSeen) -> string`; `withIdCounter(counters, prefix, number) -> counters`; `nextBuildMatrixConfig(project, maxSeen) -> string`; state slice `idCounters` (object keyed by full prefix, plus `ME:<projectId>` for build matrices).

- [ ] **Step 1: Write the failing tests**

Create `tools/test-spec-gap-fixes.mjs` using the extraction harness from `tools/test-review-fixes.mjs:30-121`: read `nextId`, `withIdCounter`, `getSideList` from `Part1_Data.html` and `nextBuildMatrixConfig` from `Part4_ViewsB.html`, evaluate them with `new Function`, and expose an `api` object. Add these checks (literal expected values, no computed mirror):

```js
check('deleted CI-12 is not reissued', () =>
  equal(api.nextId('CI-', [{ id: 'CI-11' }], 12), 'CI-13'));
check('deleted ME12 is not reissued', () =>
  equal(api.nextBuildMatrixConfig(
    { id: 'PRJ-X4151', side: 'RHS', buildMatrix: [{ config: 'ME11', side: 'RHS' }] }, 12
  ), 'ME13'));
check('counter never moves backwards', () =>
  deep(api.withIdCounter({ 'CI-': 15 }, 'CI-', 12), { 'CI-': 15 }));
check('numeric scan still works without a counter', () =>
  equal(api.nextId('TM-', [{ id: 'TM-02' }]), 'TM-03'));
```

Extend `package.json:6` so `test` runs the new script after the existing six.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun tools/test-spec-gap-fixes.mjs`
Expected: FAIL on the first two checks (`nextId` and `nextBuildMatrixConfig` ignore the third argument and return `CI-12` / `ME12`), with `withIdCounter` also missing.

- [ ] **Step 3: Implement the counters**

In `Part1_Data.html`, change `nextId` to `nextId(prefix, items, maxSeen)`, start from `Math.max(maxSeen || 0, highest current suffix)`, keep the `used.has(candidate)` collision loop, and add `withIdCounter(counters, prefix, number)` returning a new object whose key is `Math.max(existing || 0, number)`. In `Part4_ViewsB.html`, change the signature to `nextBuildMatrixConfig(project, maxSeen)`, start from `Math.max(11, maxSeen || 0)`, and pass that value from the modal's new `maxSeen` prop at line 1683.

- [ ] **Step 4: Wire the persisted slice**

Add `idCounters: {}` state in `Part2_App.html`, include it in `buildWorkspacePayload`, hydrate it with `if (data.idCounters && typeof data.idCounters === 'object') setIdCounters(data.idCounters);`, add it to the effect dependency list, and add `'idCounters'` (type `object`, label `ID counters`) to `PERSISTED_SLICES`, `SLICE_TYPES` and `PAYLOAD_SLICE_LABELS`. Pass `maxSeen={idCounters[prefix] || 0}` at all seven `nextId` call sites and `maxSeen={idCounters['ME:' + project.id] || 0}` to `BuildMatrixRowModal`; after each successful add call `setIdCounters((prev) => withIdCounter(prev, prefix, suffix))`, including `ME:<projectId>` in `handleSaveBuildMatrixRow` when a new row is added (not on edit).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test`
Expected: all suites pass, including the four new checks.

- [ ] **Step 6: Commit**

```bash
git add tools/test-spec-gap-fixes.mjs package.json Part1_Data.html Part2_App.html Part4_ViewsB.html Code.js tools/import-state.mjs
git commit -m "fix: keep ID counters monotonic across deletions"
```

### Task 2: Audit identity fallback

**Files:**
- Modify: `Code.js:448-457` (`saveWorkspaceState`), `Code.js:157-171` area (new helper)
- Test: `tools/test-spec-gap-fixes.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `saveIdentity_(userEmail, executorEmail) -> { actorLabel, executorEmail }`.

- [ ] **Step 1: Write the failing test**

Add to the test file, extracting `saveIdentity_` from `Code.js` into the same `api` object:

```js
check('missing email yields unknown actor', () =>
  deep(api.saveIdentity_('', 'deployer@example.com'),
    { actorLabel: 'unknown', executorEmail: 'deployer@example.com' }));
check('real email stays the actor', () =>
  deep(api.saveIdentity_('user@example.com', 'deployer@example.com'),
    { actorLabel: 'user@example.com', executorEmail: 'deployer@example.com' }));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun tools/test-spec-gap-fixes.mjs`
Expected: FAIL because `saveIdentity_` is not declared in `Code.js`.

- [ ] **Step 3: Implement the helper and use it**

Add `saveIdentity_(userEmail, executorEmail)` returning `actorLabel: userEmail || 'unknown'` and `executorEmail: executorEmail || ''`. In `saveWorkspaceState`, remove the throw at lines 451-457, derive `const identity = saveIdentity_(getActiveUserEmail_(), getExecutorEmail_());`, use `identity.actorLabel` as `actorLabel` and `identity.executorEmail` as `executorEmail`, and keep the remaining lock/save path unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add Code.js tools/test-spec-gap-fixes.mjs
git commit -m "fix: audit unknown actors instead of refusing the save"
```

### Task 3: CSV formula neutralization and BOM

**Files:**
- Modify: `Part5_Modules.html:2585-2588,2655,3348-3349`
- Modify: `Part1_Data.html:4034-4037` (`triggerCsvDownload` and new `csvDownloadText`)
- Modify: `Code.js:669-699` (`archiveStateRevision_` and new `stateHistoryRows_`)
- Test: `tools/test-spec-gap-fixes.mjs`

**Interfaces:**
- Consumes: `csvText(value)` from `Part1_Data.html:3880` and `safeSheetRow_(row)` from `Code.js:185`.
- Produces: `csvDownloadText(csv) -> string`; `stateHistoryRows_(rows, revision, savedBy) -> string[][]`.

- [ ] **Step 1: Write the failing tests**

Add to the test file, extracting `kpiDeepDiveCsv` from `Part5_Modules.html`, `csvDownloadText` from `Part1_Data.html`, and `stateHistoryRows_` plus `safeSheetText_`/`safeSheetRow_` from `Code.js`:

```js
const kpi = api.kpiDeepDiveCsv(
  { digits: 0 },
  { trend: [{ label: '=1+1', value: 1, meta: '', thin: false }], variant: [], pareto: [] }
);
check('KPI CSV neutralizes a formula', () => assert.match(kpi, /"'=1\+1"/));
check('KPI export text carries a BOM', () =>
  equal(api.csvDownloadText('a,b'), '\uFEFFa,b'));
check('history rows neutralize a formula', () => {
  const rows = api.stateHistoryRows_(
    [['k', 0, 1, 1, '2026-01-01', '=1+1']], 7, 'user@example.com'
  );
  equal(rows[0][5], "'=1+1");
  equal(rows[0][6], 'user@example.com');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun tools/test-spec-gap-fixes.mjs`
Expected: FAIL — `kpiCsvCell` emits `"=1+1"`, no `csvDownloadText` exists, and no `stateHistoryRows_` exists.

- [ ] **Step 3: Implement the shared helpers**

Add `csvDownloadText(csv)` in `Part1_Data.html` returning `'\uFEFF' + csv` and use it inside `triggerCsvDownload`. Replace `kpiCsvCell` with `csvText` at the `kpiDeepDiveCsv` row-mapping line and delete the now-unused `kpiCsvCell`; change `handleExportCsv` in `Part5_Modules.html` to `new Blob([csvDownloadText(kpiDeepDiveCsv(meta, view))], ...)`. Extract the `out` mapping in `archiveStateRevision_` into `stateHistoryRows_(rows, revision, savedBy)` and apply `.map(safeSheetRow_)` to the result before `setValues`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test`
Expected: all suites pass, including the three new checks.

- [ ] **Step 5: Commit**

```bash
git add Part1_Data.html Part5_Modules.html Code.js tools/test-spec-gap-fixes.mjs
git commit -m "fix: neutralize KPI CSV and history rows, keep BOM"
```

### Task 4: Rebuild, full verification, review gate

**Files:**
- Modify: `Bundle.html`, `Styles.html` (generated by `bun run build` only if changed)

- [ ] **Step 1: Rebuild the compiled assets**

Run: `bun run build`
Expected: exit 0.

- [ ] **Step 2: Run the full suite**

Run: `bun run test`
Expected: all suites pass with pristine output; the generated-bundle suite confirms `Bundle.html` and `Styles.html` match a fresh build.

- [ ] **Step 3: Confirm clasp project state is unchanged in shape**

Run: `clasp status`
Expected: the same 12 tracked files, no appsscript.json change.

- [ ] **Step 4: Hand back for re-review and deploy approval**

Report the diff of these commits and the test output. Do not push, version, or update the deployment until the human partner explicitly approves.
