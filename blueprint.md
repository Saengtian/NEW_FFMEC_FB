# FFM NPI Ops — Application Architecture (Blueprint)

Companion documents: [README.md](README.md) for commands, [product.md](product.md) for behaviour,
[docs/SOP.md](docs/SOP.md) for the operator routine.

## 1. System context

```
┌──────────────────────────┐        ┌───────────────────────────────────────────┐
│ Browser (domain user)    │        │ Google Apps Script (V8)                    │
│                          │        │                                           │
│  Index.html              │◄──────►│ doGet()  → Index template                 │
│   ├─ Bundle.html  (JS)   │  HTML  │   └─ <?!= include('Bundle') ?>            │
│   ├─ Styles.html  (CSS)  │        │   └─ <?!= include('Styles') ?>            │
│   └─ bootstrap script    │        │   └─ serverConfigJson (spreadsheet, user)  │
│                          │        │                                           │
│  React app (single page) │        │ loadWorkspaceState / saveWorkspaceState   │
│   └─ google.script.run   │◄──────►│ listStateRevisions / loadStateRevision    │
│                          │  RPC   │ refreshMirrorSheets / getServerInfo       │
└──────────────────────────┘        └──────────────────┬────────────────────────┘
                                                       │ Sheets API
                                                       ▼
                                    ┌──────────────────────────────────────┐
                                    │ Backing spreadsheet (one file)        │
                                    │  _FFM_STATE_STORE     ← the document  │
                                    │  _FFM_STATE_HISTORY   ← last 5 copies │
                                    │  AuditLog, SignOffLog                 │
                                    │  Projects, Tasks, ProductionRecords,  │
                                    │  MasterSpecs, CpkRecords, CostProjects│
                                    │  CustomerFeedback   ← read-only mirror│
                                    └──────────────────────────────────────┘
```

There is no Node server in production. Apps Script is the runtime; the sheet is the database; the
browser holds the entire working set in memory and saves it back as one revisioned document.

**Manifest facts** (`appsscript.json`): V8 runtime, `Asia/Bangkok`, `executeAs: USER_ACCESSING`,
`access: DOMAIN`, exception logging to Stackdriver, scopes `spreadsheets`, `userinfo.email`,
`script.container.ui`.

## 2. Source → artifact pipeline

```
Icons.html ─┐
Part1_Data ─┤
Part2_App  ─┤   esbuild (JSX → ES2019, minify, React 18 from node_modules)
Part3_ViewsA┤        │
Part4_ViewsB┤        ├─ escape  </script → <\/script
Part5_Modules        ├─ escape  http://  → http:\/\/
Part6_Reports        └─ escape  <?       → <\?
            │        │
            └────────┴──► Bundle.html   (one <script> block, committed)

xlsx (node_modules) ─► esbuild (own IIFE, minified, same escapes)
                    ─► SheetJs.html (committed; Code.js serves it on the
                       first Excel import, never at startup)
Part*.html classes ──► Tailwind CLI ──► Styles.html (committed)
```

Why the escaping: Apps Script's HTML pipeline re-parses the served document. A raw `http://` is
treated as a comment start and deleted to end of line, `<?` opens a template scriptlet, and a literal
`</script>` closes the tag early. `tools/build.mjs` neutralises all three with no-op escapes (`\/`,
`\?`), so runtime strings are unchanged. `bun run test` fails if `Bundle.html` does not match a fresh
build.

## 3. Client architecture

### 3.1 One component tree

`App` (Part2) owns everything: navigation, global scope, every data slice, save state and all modals.
Views (Part3–Part6) are pure functions of props. There is no router, no store library, no context
provider; the URL never changes.

```
App
├─ Sidebar (nav) + Topbar (global scope, sync badge, state history, backup/restore)
├─ view switch → OverviewView | ProjectsView | TimelineView | TasksManagerView
│                GateSignOffView | CpkMasterSpecsView | CostSavingView
│                CustomerFeedbackView | ProductionRecordsView | TeamMembersView | ReportsView
└─ modals → KpiDeepDiveModal, MasterSpecModal, CpkImportPipelineModal,
            ProcessCapabilityChartModal, CpkDistributionCompareModal,
            new/edit task, new program, new production record, sync conflict, state history
```

### 3.2 State slices

```js
{ projects, tasks, gateRecords, productionRecords, masterSpecs,
  cpkRecords, costProjects, customerFeedback, teamMembers, scheduleOverrides }
```

- Seeded from `INITIAL_*` constants in `Part1_Data.html`.
- Replaced wholesale by `hydrateFromPayload()` after a load or restore.
- Hydration is a migration point: `applyProvisionalLimitDefaults`, `purgePlaceholderEvidence`,
  `stripLegacyFabricatedCpkRows` clean old rows as they arrive. `INITIAL_CPK_RECORDS` is empty: a
  fresh workspace has no capability readings, and the 16 demo rows it used to seed are on the strip
  list by id, so a saved workspace that still carries them drops them on load.

### 3.3 Derived state

Everything else is `useMemo` over the slices: `scopedProjects`, `scopedProductionRecords`,
`scopedCostProjects`, `scopedCustomerFeedback`, portfolio stats, workload, Cpk roll-ups, report model.
The global scope is the only filter input that crosses modules.

### 3.4 Save path

```
edit → setState → debounce → buildWorkspacePayload() → JSON
     → google.script.run.saveWorkspaceState(json, summary, revisionRef, refreshMirrors)
     → { ok, revision, lastSavedAt, lastSavedBy, warnings } | { ok:false, conflict:true, revision }
```

- `revisionRef` guards against clobbering: a stale client receives a conflict, the UI opens the
  conflict dialog and offers reload.
- `LockService.getScriptLock()` serialises concurrent saves for 15 s.
- Saves are attributed: the email must be present or the save is refused server-side.
- Saves are authorised before anything is written: a program the roster does not assign to the actor,
  a roster edit by anyone but the file owner, or a signature recorded (or erased) under another
  person's name throws `Save refused: …`, and the store is untouched.
- Backup/Restore exchanges the same payload as a JSON file.

## 4. Server architecture (`Code.js`)

| Function | Purpose |
| --- | --- |
| `doGet(e)` | Fail-closed entry: no email → sign-in page; otherwise evaluate the `Index` template with `serverConfigJson` |
| `include(name)` | `HtmlService.createHtmlOutputFromFile(name).getContent()` |
| `loadWorkspaceState()` | Reads chunks, parses `__META__`, returns `{data, revision, lastSavedAt, lastSavedBy}` |
| `saveWorkspaceState(json, summary, expectedRevision, refreshMirrors)` | Revision check, permission check, archive old copy, write new chunks, audit row, sign-off ledger rows, optional mirror refresh |
| `authorizeWorkspaceSave_(previous, payload, email, isOwner)` | Program ownership, roster protection and signature identity, judged against the stored state |
| `listStateRevisions()` / `loadStateRevision(rev)` | History sheet access (last `HISTORY_LIMIT = 5`) |
| `refreshMirrorSheets()` / `readMirrorStatus_()` | Rebuild the human-readable tabs from the store |
| `getServerInfo()` | Spreadsheet id/URL, web app URL, user email |
| `getSignOffLedger()` | Read-only `SignOffLog` rows + tab URL, for the ledger view and its reconciliation |
| `reconcileSignOffLedger()` | Self-healing ledger: replays the archived revisions, appends decisions the tab is missing, runs at app load under the save lock |
| `exportStateBackup()` | Trigger handler and *Back up now*: writes the store to a dated JSON file in Drive, then prunes |
| `installDailyBackupTrigger()` | Idempotent daily 01:30 trigger on `exportStateBackup` (replaces any earlier one) |
| `backupFileName_` / `backupFilesToDelete_` / `buildStateBackup_` | Pure naming, retention and file-shape rules the trigger is made of |
| `previousSlice_(rows, key)` | One slice of the store already on file, or null when it was never written |
| `ensureAllTabs_()` | Creates/repairs the state, history, audit, ledger and mirror tabs |
| `onOpen()` | Sheet menu: open app, refresh mirrors, verify tabs, protect tabs |
| `initializeDatabase(json)` | One-shot bootstrap with a seed payload |

### 4.1 Storage layout

`_FFM_STATE_STORE` — 5 columns, one row per 40 000-character chunk per slice:

```
SliceKey | ChunkIndex | ChunkCount | UpdatedAt | PayloadChunk
__META__ | 0 | 1 | <iso> | {"revision":N,"lastSavedAt":…,"lastSavedBy":…}
projects | 0 | 3 | <iso> | <json chunk 0>
projects | 1 | 3 | <iso> | <json chunk 1>
```

`_FFM_STATE_HISTORY` — same idea plus `Revision`, `SavedAt`, `SavedBy`; whole-store copies, pruned.

`SignOffLog` — append-only, 11 columns:
`Timestamp, Revision, ProgramID, Program, Line, Gate, Approver, Role, Decision, Remark, SignedInEmail`.
Rows are derived by diffing the gate records already on file against the incoming payload, so a save
that changes nothing writes nothing. The rows are built before the store is rewritten; the append runs
after it commits, so a failed append is not reported as a failed save — the response carries `warnings`
and `AuditLog` gets a `SIGN_OFF_LEDGER_ERROR` row naming the decisions missing from the ledger.

That warning is not the end of it. Script properties keep `FFM_SIGN_OFF_LEDGER_ROWS`, the number of rows
the tab should hold once a save's decisions are in it (incremented even when the append failed). On app
load the client calls `reconcileSignOffLedger()`: under the save lock it compares that count with the tab
and, only when they disagree, replays the archived revisions — each adjacent pair, newest one being the
live store — rebuilding every changed decision the ledger does not already hold with the same timestamp,
revision, gate label, role and signed-in email the save would have written. Seeded dossiers were never a
signature and an erased one is not a decision, so neither produces a row; a second pass appends nothing.
The repair is bounded by `HISTORY_LIMIT`: a gap older than the archived window is reported, never
guessed at.

`AuditLog` — one row per save: `Timestamp, UserEmail, Revision, Action, Summary, Executor`.

Mirror tabs are for humans reading the sheet; the app never reads them back.

**Drive backups** — the third ring, outside the sheet: `exportStateBackup()` writes the whole store to
`FFM NPI Ops State Backups/FFM_NPI_Ops_state_<yyyy-MM-dd>_<HHmm>.json` (script time zone, so names sort
chronologically) and trashes everything past the newest `CONFIG.BACKUP_KEEP = 30`. The file is the
same shape as the sidebar's export — `{app, version, exportedAt, revision, lastSavedAt, lastSavedBy,
data}` — so Restore accepts it with no conversion. Pruning only touches names carrying the job's own
prefix and `.json` suffix; a hand-saved backup in that folder survives. The trigger runs as the script
owner, reads the store and never writes to it, so a backup run cannot change a revision.

### 4.2 Access and safety

- Domain-restricted web app; identity is always the signed-in Workspace account.
- Scopes stay minimal: Sheets, the user's email, container UI, `drive.file` (only files this script
  creates — the backup folder and its JSON) and `script.scriptapp` (install its own daily trigger).
  Adding them re-prompts for consent on the next run.
- **Permissions are server-side and judged on the stored state**, never on the payload: two rules,
  both checked before the first row is written (`authorizeWorkspaceSave_`, `foreignSignOffEdits_`).
  1. **Programs.** A program may only be added, rewritten or removed by a roster member whose
     `products` / `externalProducts` name its model (the `teamMembers` slice *is* the roster). Renaming
     a model needs both the old and the new one. A save that carries programs forward unchanged needs
     no program permission, so task and production work is unaffected.
  2. **Signatures.** A gate decision this save records or erases must carry the signed-in user's own
     roster name; the ledger's `Role` is the signer's roster role. Unchanged signatures are history,
     not a violation. The quality team signs across programs it does not own — that split is deliberate:
     ownership governs the program record, identity governs the signature.
- The roster is owner data: only the spreadsheet owner (who is also exempt from rule 1) may change who
  is on it, their role, their email or their owned programs. Without that, rule 1 could be undone in a
  single save by granting yourself every product. A refused save leaves the store, the history and the
  ledger exactly as they were. If the file's owner cannot be read (a shared drive, no access), no
  account is admin and the roster becomes read-only from the app — failing closed on purpose.
- App-owned tabs get a warning-only protection so hand-editing is deliberate, not accidental
  (blocking protection would also block the app, which writes as the accessing user).
- No secrets in the repo: `SPREADSHEET_ID` is configuration, not a credential; OAuth is the
  platform's.

## 5. Domain logic worth knowing

| Concern | Where | Rule |
| --- | --- | --- |
| Fiscal window | `Part1_Data.html` | 1 Apr – 31 Mar; report presets derive from today |
| Capability | `computeCapabilityStats`, `cpkBoxSummary` | Cp/Cpk/PPM from mean, σ and spec limits; provisional specs are excluded |
| Line variants | `getLineVariantsForProject` | Configuration × side |
| Gate sequence | `NPI_GATES`, `getDefaultScheduleForRow` | G1…G9 with plan dates; a drag that breaks order is refused |
| Product matching | `normalizeProductKey`, `productMatchesProject` | Free-text products resolve to live programs; unmatched strings are flagged |
| Workload | `computeTeamWorkload` | Open tasks on owned programs + gates still missing a signature |
| Production record rules | `productionRecordIssues`, `sanitizeProductionRecords` (Part1) | Input above zero, good never above input, planned hours above zero, no negative downtime, no duplicate date × line × station |
| Report model | `buildReportModel` (Part6) | Six KPIs, bars, Pareto, Cpk section, movement, deck HTML |

## 6. Testing

| Suite | Guards |
| --- | --- |
| `test-fy-helpers` | Fiscal-year window math and presets |
| `test-cpk-freeze` | Provisional limits never produce capability verdicts |
| `test-sheetjs-bundle` | SheetJS stays out of the startup bundle, loads on demand, and CSV never touches it |
| `test-review-fixes` | Assignment, date formatting, quantiles, product families |
| `test-project-crud` | Program create/edit/delete pruning only what the program owns |
| `test-state-history` | Revision list/load/prune behaviour |
| `test-signoff-ledger` | The append-only ledger's client-side view |
| `test-server-permissions` | Program ownership, roster ownership and signature rules |
| `test-state-backup` | Drive backup naming, pruning and the manifest scopes |
| `test-production-validation` | The shared production-record rules: impossible input / good / planned hours, negative downtime, duplicate date × line × station, and the loader's drop-and-repair pass |
| `test-code-js` | Code.js run against a mocked `SpreadsheetApp`: chunked state read/write, save permissions through the real save path, the SignOffLog append (including one that fails after the store committed) and its repair on the next reconcile, including a gap that later saves have moved past |
| `test-generated-bundle` | `Bundle.html` / `Styles.html` match a fresh build byte for byte |

Most suites are Node scripts that read the source files and assert behaviour of pure helpers. The
exception is `test-code-js`, which loads `Code.js` — the exact text clasp ships — into a sandbox with
in-memory sheets, `Session`, `LockService` and `PropertiesService`, so the server is exercised locally
instead of only in Apps Script. There is still no DOM test, so "the page renders" is only proven by
the preview or a deploy.

## 7. Delivery

```
bun run build → clasp push -f (12 files) → clasp version "deploy <sha>"
              → clasp update-deployment <staging-id> -V <n>
              → bun tools/verify-deployment.mjs <staging-url>   (real Chrome: parses? #root renders?)
              → clasp update-deployment <prod-id> -V <n> -d "deploy <sha>"   (only on a pass)
```

- `bun run test` also runs on every push in GitHub Actions (`.github/workflows/ci.yml`, bun 1.4.0,
  frozen lockfile). It is the same suite a deploy assumes: helper suites plus the byte-identical
  generated-bundle check, so a commit whose `Bundle.html` does not match its sources fails without a
  person running anything.
- `.claspignore` keeps tooling, docs and local agent folders out of the pushed project; only
  `appsscript.json`, `Code.js`, `Index.html`, `Icons.html`, `Part1…Part6`, `Bundle.html`,
  `Styles.html` are tracked.
- Deployments are named by version; the staging and production deployment ids are pinned in
  `deploy.config.json`. The staging gate is not skippable: the production id is only updated after
  `tools/verify-deployment.mjs` reports that the staging URL parsed and mounted React.
- The gate fails closed. It runs on a dedicated Chrome profile (`.preview/staging-browser`) because the
  web app is domain-only and `executeAs: USER_ACCESSING`; a signed-out browser exits `2` rather than
  passing, so an untested version can never reach production.
- Rollback is `clasp update-deployment <id> -V <last-good> -d "rollback"`; versions are immutable.
- A deploy is only "done" when the deployment URL loads and the app renders; `clasp push` succeeding
  proves nothing about the served page.

## 8. Architectural risks

1. **HTML-service payload handling.** The pipeline that escapes `http://` and `<?` is undocumented and
   version-sensitive; large bundles have failed to load on freshly created versions. Keep the bundle
   free of scriptlet-like sequences and treat a deploy as unverified until the page loads.
2. **Whole-document saves.** Every edit rewrites all slices. Concurrency is handled by revision
   conflict, not merge; growth past a few MB will hit Sheets cell and payload limits.
3. **Single runtime, no local dev server for Code.js.** The preview shims the RPC layer, so server
   changes are only exercised in Apps Script.
4. **History is coarse.** Five whole-store snapshots; no per-record audit of spec edits.
5. **Bundle size.** ~840 KB inline script, plus a ~486 KB SheetJs.html fetched only on the first
   Excel import. React and every view still parse at startup; smaller splits are still possible.
6. **Ledger repair is bounded by history.** Reconcile can only rebuild decisions whose pair of
   snapshots still sits in `_FFM_STATE_HISTORY`; a gap older than those five revisions is reported as
   unreconciled rather than reconstructed from the current state, which would make a seed look like a
   signature.
