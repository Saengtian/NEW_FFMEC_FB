# Spec gap fixes — short design

Date: 2026-11-27
Status: Draft — awaiting approval

## Intent

The two-axis review of `origin/main...HEAD` found three concrete gaps against
`2026-11-25-ffm-npi-ops-review-fixes-batch1-design.md` (still Draft). Fix them
before the clasp deploy so the live web app does not ship ID reuse, CSV formula
injection, or an audit path that cannot write the `unknown` row the spec asks for.

## Goals

1. Deleting the highest-numbered record must not let the next add reuse its ID,
   for `nextId` and for the build-matrix `ME##` generator.
2. The KPI deep-dive CSV and `_FFM_STATE_HISTORY` writes must neutralize
   spreadsheet formulas; the KPI CSV must carry a UTF-8 BOM like other exports.
3. A save with no active identity must still append an `AuditLog` row naming
   `unknown` as actor and the executor email separately, instead of throwing.

## Non-goals

- The unspecced scope-creep findings (reports, KPI deck, ledger, CTQ flags,
  workload, Gantt, state history UI) stay as-is; no new design work on them.
- No permission-model change: `appsscript.json` stays `USER_ACCESSING` / `DOMAIN`,
  and `doGet` keeps failing closed without a Google identity.
- No change to the `_FFM_STATE_STORE` chunk format or revision protocol beyond
  adding one new persisted slice.

## Constraints

- Apps Script V8; `Index.html` inlines the parts, so top-level helper names are
  shared globally and must stay unique.
- `PERSISTED_SLICES` in `Code.js` and `SLICE_TYPES` in `tools/import-state.mjs`
  must agree with the hydrated app state and the preview server.
- Existing exports use `csvText` plus `'\uFEFF'`; keep that convention.
- Tests are standalone scripts under `tools/`, run via `bun run test`;
  `tools/**` is excluded by `.claspignore`. TDD: each behavior gets a failing
  test before production code changes.

## Approaches

- **A. Persist per-prefix high-water marks (chosen).** Add an `idCounters`
  object slice; `nextId(prefix, items, maxSeen)` uses the larger of the current
  numeric scan and `maxSeen`, bumps the counter in the same state update that
  adds the record, and keeps the collision check for non-numeric suffixes.
  `nextBuildMatrixConfig(project, maxSeen)` uses a project-scoped key. Keeps
  short readable IDs and matches the spec's three-argument signature. Costs
  edits to every call site plus hydrate/import/preview wiring.
- **B. Time-based suffixes.** Generate IDs from a monotonic timestamp; no new
  persisted slice and no call-site counter plumbing, but IDs and displayed
  case numbers stop being short sequential numbers.
- **C. Infer high-water marks from the history sheet.** No client schema change,
  but requires server reads on every add and reconstructs counters from rows
  that may have been pruned; dropped as unreliable.

A is chosen because readable sequential IDs are used in user-facing case
numbers and the spec explicitly names `maxSeen`.

## Design

1. **State:** add `idCounters: {}` to the default state, `PERSISTED_SLICES`
   (`object`), `SLICE_TYPES`, the hydrate label map, and the preview/import
   fixtures. Existing exports without the slice hydrate to `{}`.
2. **IDs:** `nextId(prefix, items, maxSeen)` starts from `max(maxSeen || 0,
   highest current suffix)` and returns the first candidate not in `used`.
   Update the seven `Part2_App.html` call sites and the build-matrix generator
   to pass the relevant counter; bump the counter where the record is added.
3. **CSV:** have `kpiDeepDiveCsv` use the shared `csvText`, and route the KPI
   blob through a shared BOM-prepending helper already used by other exports.
   Extract `stateHistoryRows_(rows, revision, savedBy)` and apply
   `safeSheetRow_` before `setValues`.
4. **Audit:** `saveIdentity_(userEmail)` returns `unknown` for a missing actor;
   `saveWorkspaceState` no longer throws for that case and keeps recording the
   executor email separately. The sign-off ledger keeps the existing typed
   `userEmail` where it has one.

## Verification

- New `tools/test-spec-gap-fixes.mjs` tests, written and watched failing first:
  delete-then-add does not reuse an ID; a deleted `ME##` line is not reissued;
  `=1+1` is neutralized in KPI CSV and history rows; the KPI export text begins
  with a BOM; a missing email yields `unknown` plus the executor email.
- `bun run test` (all suites) exits 0; `bun run build` leaves `Bundle.html` and
  `Styles.html` matching a fresh build.
- Deploy remains a separate, explicitly confirmed operation after re-review.
