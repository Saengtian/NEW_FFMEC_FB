# FFM NPI Ops

A single-page React application that runs entirely inside Google Apps Script, backed by one Google
Sheet. It is the working system for the FDB fan-assembly NPI program: projects and split builds,
gate sign-off, tasks, production yield, Cpk against master specs, cost saving, customer feedback,
the team roster and the executive KPI report.

- **Product overview:** [product.md](product.md)
- **Architecture:** [blueprint.md](blueprint.md)
- **User SOP:** [docs/SOP.md](docs/SOP.md)

## How it runs

Apps Script serves one HTML document (`Index.html`) and evaluates its `<?!= include(...) ?>` tags.
Only two included files carry the app: `Bundle.html` (compiled React) and `Styles.html` (compiled
Tailwind). The browser then talks to `Code.js` through `google.script.run`; every save is written to
the `_FFM_STATE_STORE` tab of the backing spreadsheet, chunked, revision-stamped and mirrored to
read-only tabs.

```
browser ── Index.html + Bundle.html + Styles.html ──► React app
   │  google.script.run
   ▼
Code.js ── _FFM_STATE_STORE (chunks) ── _FFM_STATE_HISTORY (last 5 revisions)
        ├─ AuditLog, SignOffLog, mirror tabs (Projects, Tasks, CpkRecords, ...)
        └─ daily trigger ── Drive: FFM NPI Ops State Backups/*.json (newest 30)
```

## Quick start

```bash
bun install            # once
bun run preview        # local preview on http://127.0.0.1:5183
bun run test           # every test suite
bun run deploy:login   # once: sign the staging browser profile in to Google
bun run deploy         # build → push → version → staging → browser check → production
```

Prerequisites for anything that touches Google: Node ≥ 20 (Bun is used as the runner and packager),
`@google/clasp` installed globally, and `clasp login` as an account with edit rights on the script
and the backing spreadsheet.

## Commands

| Command | What it does |
| --- | --- |
| `bun run build` | Compiles `Icons.html` + `Part*.html` into `Bundle.html` and Tailwind CSS into `Styles.html` |
| `bun run preview` | Local server that rebuilds on change and shims `google.script.run` with `localStorage` |
| `bun run test` | Fiscal-year, Cpk-freeze, SheetJS, review-fix, state-history and generated-bundle checks |
| `bun run deploy` | Build, `clasp push -f`, `clasp version`, put that version on the staging deployment, prove it in a real browser, then point production at it |
| `bun run deploy:login` | One-time Google sign-in for the profile the staging check uses (`.preview/staging-browser`) |
| `bun tools/verify-deployment.mjs <url>` | Load any deployment URL in headless Chrome; fails unless the page parses and `#root` renders |
| `bun run state:import` | Imports a `_FFM_STATE_STORE` CSV export into the local preview |

## Project layout

| Path | Role |
| --- | --- |
| `Code.js` | Server: `doGet`, state load/save, chunking, history, audit, sign-off ledger, mirrors |
| `Index.html` | The only page Apps Script serves; splash, error overlay, config injection |
| `Icons.html` | Icon set used by the views |
| `Part1_Data.html` | Seed data, spec library, domain helpers (dates, Cpk math, product keys) |
| `Part2_App.html` | The `App` component: state, hydration, save/conflict, nav, global scope, modals |
| `Part3_ViewsA.html` | Overview, Projects, Timeline, Tasks, Gate sign-off, Production, Cpk views |
| `Part4_ViewsB.html` | Cpk charts, distribution compare, spec correction modal |
| `Part5_Modules.html` | Cost saving, Customer feedback, Team & workload, KPI deep dive |
| `Part6_Reports.html` | Executive KPI report, presets, SVG charts, printable A4 deck |
| `Bundle.html`, `Styles.html` | **Generated. Never hand-edit.** Rebuild with `bun run build` |
| `tools/` | Build, preview server, deploy version parser, test suites |
| `appsscript.json` | Manifest: V8, Asia/Bangkok, domain-only access, Sheets + email scopes |

## Rules that keep this repo healthy

1. **Edit sources, never artifacts.** `Bundle.html` and `Styles.html` are rebuilt; `bun run test`
   fails when the committed artifacts do not match a fresh build.
2. **Never leave in-flight state in the store.** Seed data may be incomplete, but nothing fabricated
   may be written to the spreadsheet; the app strips known fabricated Cpk seeds on load.
3. **Provisional limits stay provisional** until a planner enters the real limit. The six CTQs in
   `PROVISIONAL_LIMIT_SPEC_IDS` render neutral, and `hasProvisionalLimits` keeps every capability figure —
   the Overview line, the Cpk matrix share, the report — off a limit nobody confirmed. Confirming one
   happens in Cpk & Master Specs: enter the real LSL / nominal / USL and clear *limits provisional*.
4. **Do not commit** machine-specific files: `.clasprc.json`, `.env*`, `.preview/`, `.gemini/`,
   `.github/hooks/` are already ignored.

## Troubleshooting

**"FFM NPI Ops Startup Error — SyntaxError: Invalid or unexpected token"** after a deploy.
Apps Script's HTML pipeline re-parses the served page and mangles sequences that are legal inside a
script tag: a raw `http://`, a literal `<?` (it reads it as a template scriptlet), and `//` or `/*`
inside template literals. `tools/build.mjs` escapes `</script`, `http://` and `<?`; keep those rules
in mind before adding inline HTML in a string. Check the pushed content with `clasp status` (only the
twelve app files should be tracked) and roll back with:

```bash
clasp list-versions
clasp update-deployment <deployment-id> -V <last-good-version> -d "rollback"
```

**`bun run deploy` stopped at the browser check.** Production was not touched — the new version is on the staging
deployment only. The check exits `1` when the served page throws a parse error or `#root` never replaces the
splash, and `2` when it could not test anything (signed-out browser, no Chrome/Edge, unreachable page). Sign in
once with `bun run deploy:login`, open the staging URL it prints, and re-run the deploy. If the version is
broken, fix it and deploy again; the untouched production deployment keeps serving the last good version.

**Preview shows an old bundle.** The preview server keeps its own copy; restart `bun run preview`
after a build if the change does not appear.

**"Another user is currently saving"** — `LockService` held the script lock for 15 s. Retry; if it
persists, check for a stuck execution in the Apps Script editor.

**"Save refused: could not read your Google Workspace identity"** — the web app runs as the
accessing user (`executeAs: USER_ACCESSING`). Sign in with the Minebea account and grant the email
scope.
