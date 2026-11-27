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
Part2_App  ─┤   esbuild (JSX → ES2017, minify, React 18 + xlsx from node_modules)
Part3_ViewsA┤        │
Part4_ViewsB┤        ├─ escape  </script → <\/script
Part5_Modules        ├─ escape  http://  → http:\/\/
Part6_Reports        └─ escape  <?       → <\?
            │        │
            └────────┴──► Bundle.html   (one <script> block, committed)
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
  `stripLegacyFabricatedCpkRows`, `backfillSeedCpkSamples` clean old rows as they arrive.

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
- Backup/Restore exchanges the same payload as a JSON file.

## 4. Server architecture (`Code.js`)

| Function | Purpose |
| --- | --- |
| `doGet(e)` | Fail-closed entry: no email → sign-in page; otherwise evaluate the `Index` template with `serverConfigJson` |
| `include(name)` | `HtmlService.createHtmlOutputFromFile(name).getContent()` |
| `loadWorkspaceState()` | Reads chunks, parses `__META__`, returns `{data, revision, lastSavedAt, lastSavedBy}` |
| `saveWorkspaceState(json, summary, expectedRevision, refreshMirrors)` | Revision check, archive old copy, write new chunks, audit row, sign-off ledger rows, optional mirror refresh |
| `listStateRevisions()` / `loadStateRevision(rev)` | History sheet access (last `HISTORY_LIMIT = 5`) |
| `refreshMirrorSheets()` / `readMirrorStatus_()` | Rebuild the human-readable tabs from the store |
| `getServerInfo()` | Spreadsheet id/URL, web app URL, user email |
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

`AuditLog` — one row per save: `Timestamp, UserEmail, Revision, Action, Summary, Executor`.

Mirror tabs are for humans reading the sheet; the app never reads them back.

### 4.2 Access and safety

- Domain-restricted web app; identity is always the signed-in Workspace account.
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
| Report model | `buildReportModel` (Part6) | Six KPIs, bars, Pareto, Cpk section, movement, deck HTML |

## 6. Testing

| Suite | Guards |
| --- | --- |
| `test-fy-helpers` | Fiscal-year window math and presets |
| `test-cpk-freeze` | Provisional limits never produce capability verdicts |
| `test-sheetjs-bundle` | SheetJS import path and bundle integrity |
| `test-review-fixes` | Assignment, date formatting, quantiles, product families |
| `test-state-history` | Revision list/load/prune behaviour |
| `test-generated-bundle` | `Bundle.html` / `Styles.html` match a fresh build byte for byte |

Tests are Node scripts that read the source files and assert behaviour of pure helpers; there is no
DOM test yet, so "the page renders" is only proven by the preview or a deploy.

## 7. Delivery

```
bun run build → clasp push -f (12 files) → clasp version "deploy <sha>"
              → clasp update-deployment <prod-id> -V <n> -d "deploy <sha>"
```

- `.claspignore` keeps tooling, docs and local agent folders out of the pushed project; only
  `appsscript.json`, `Code.js`, `Index.html`, `Icons.html`, `Part1…Part6`, `Bundle.html`,
  `Styles.html` are tracked.
- Deployments are named by version; the production deployment id is pinned in `package.json`.
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
5. **Bundle size.** ~1.3 MB inline script, including SheetJS; startup on weak hardware is measurable
   and splitting is the obvious relief valve.
