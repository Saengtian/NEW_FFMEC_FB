# FFM NPI Ops — Code Review Fixes, Batch 1

Date: 2026-11-25
Status: Draft — awaiting approval

## Intent

A full review of `GAS_FFMEC` (backend `Code.js`, config, and frontend `Part1`–`Part5`) found defects that make the app unsafe to rely on as a system of record. Batch 1 fixes the small set of issues that can leak or destroy data or block normal editing, before any features or larger refactoring.

## Goals

1. Neutralize spreadsheet/CSV formula injection in every write and export path.
2. Stop attributing every user's save to the deployer in `AuditLog`.
3. Unblock editing of seeded cost projects (HTML5 `stepMismatch`).
4. Remove ID generators that reuse IDs after deletion and silently overwrite records.

## Non-goals (deferred to batch 2+)

- Save/reload race and conflict handler discarding local edits (`Part2_App.html:225-234, 214-257`).
- Destructive edits/imports (`Part2_App.html:1086-1099, 1385, 1570`) and index-based gate criteria (`:1583,1596`).
- Fake default defect/downtime rows (`Part4_ViewsB.html:1424-1434`), Cpk chart desync (`:14-15,457-463`), import defaults dropping generated specs (`:2328-2334`).
- Cpk matrix key missing `config` (`Part3_ViewsA.html:42-70,2816-2839`), side-filtered roll-up mismatch (`:454-473`), hardcoded `TODAY_ISO` (`Part1_Data.html:1615`).
- KPI logic errors in `Part5_Modules.html:42-46,1055-1079,1150-1157`, ROI display (`Part5:442-443`, `Part1:490-491`).
- Accessibility (dialog semantics, Escape, focus trap, labels), CSV multi-line parser, test harness, performance, seed-data corrections.

## Constraints

- Google Apps Script V8 backend; React 18 UMD + Babel standalone + Tailwind Play CDN frontend.
- `Index.html` concatenates all template files server-side via `<?!= include(...) ?>`; every top-level `const` shares one global scope. New helper names must be unique across all files.
- `appsscript.json`: `executeAs: USER_DEPLOYING`, `access: DOMAIN`.
- Deployed web app backed by a live Sheet (`_FFM_STATE_STORE` + mirror tabs); changes go out via clasp push.
- No test runner exists in the repo yet.

## Approaches considered

- **A. Surgical in-place patches (chosen).** Add one shared sanitizer in `Code.js` and one in `Part1_Data.html`; change two `step` attributes; replace four ID generators. Small diff, no schema change, low deployment risk.
- **B. Shared utility module + full call-site refactor.** Cleaner long-term, but touches every exporter and modal at once — larger blast radius on a live deployment.
- **C. Persistence-layer rewrite.** Overkill for these defects.

Chosen A: the defects are localized and the app is in production.

## How it will be built

1. **`Code.js` — `safeSheetText_(v)`**: for string values whose trimmed form starts with `=`, `+`, `-`, `@`, tab or CR, prefix a single quote. Apply to the `summary` argument appended to `AuditLog` (`:342-348`) and to every text cell written by `syncMirrorSheets_` (`:377-460`). Numeric cells stay numeric.
2. **`Part1_Data.html` — `csvText(v)`**: same neutralization plus `"` doubling. Replace hand-built quoted cells in `exportCostProjectsCsv` (`:518`), `exportCustomerFeedbackCsv` (`:974`), `exportMasterSpecsCsv` (`:2778`). Add a UTF-8 BOM so Thai text and `฿` open correctly in Excel.
3. **Attribution**: stop falling back to `getEffectiveUser()` as if it were the actor. `getActiveUserEmail_()` returns `''` when no active user is available; `AuditLog` records that as `unknown` and separately records the executor email. This is honest but does not by itself produce per-person attribution — see Open decision below.
4. **`Part5_Modules.html:889-907`**: change `step="10000"` to `step="any"` on `budgetThb` and `quotedCostThb`.
5. **ID generation**: introduce `nextId(prefix, array, maxSeen)` using the highest existing numeric suffix + 1 (plus time/random where no numeric suffix exists). Replace `Part2_App.html:776` (projects), `:1012` (tasks), `:1275` (cost), `:1401` (feedback), and `Part4_ViewsB.html:971` (build-matrix config). Keep human-readable prefixes.

## Open decision (needs your answer)

Attribution can only be truly per-user if either:
- **(a)** `appsscript.json` changes to `executeAs: USER_ACCESSING` (each user needs Sheet access; simpler attribution, changes permissions model), or
- **(b)** the app adds an explicit sign-in/identity step and signs audit entries with it (no permission change, more UI work).

Batch 1 as written takes neither route — it only stops mislabeling the deployer as the actor. Tell me which route you want and I'll fold it in or schedule it.

## Verification (manual, no test runner yet)

- Edit a seeded cost project with a non-multiple-of-10,000 budget → save succeeds.
- Put `=1+1` in a title/remark, export CSV, open in Excel → literal text, not a formula.
- Put `=1+1` in a user-editable field, sync, open the mirror tab → literal text.
- Save as two different domain users → `AuditLog` no longer shows the deployer for both.
- Delete a cost project/feedback/task, add a new one → IDs are unique, no overwritten rows.
- Confirm no change to `_FFM_STATE_STORE` chunk format or revision protocol.
