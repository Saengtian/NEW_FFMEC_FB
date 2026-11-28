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
bun run deploy         # build → push → version → staging → browser check → production → check → rollback on failure
bun run deploy:verify  # smoke-test the live production URL, changing nothing
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
| `bun run deploy` | Build, `clasp push -f`, `clasp version`, prove that version on the staging deployment in a real browser, point production at it, then prove it again on production — rolling production back if the promoted version does not render |
| `bun run deploy:verify` | Load the live production URL in headless Chrome and report the verdict; changes nothing |
| `bun run deploy:rollback` | Point production back at `lastGoodVersion` from `deploy.config.json` (`--to=<version>` for a specific one), then smoke-test the result |
| `bun run deploy:login` | One-time Google sign-in for the profile the deployment checks use (`.preview/staging-browser`) |
| `bun tools/verify-deployment.mjs <url>` | Load any deployment URL in headless Chrome; exit 0 rendered, 1 broken, 2 could not test, 3 permission dialog |
| `bun tools/diagnose-deployment.mjs <url>` | When a deployment will not render: report every frame, its bytes, whether `#root` is there, and any console errors |
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
   fails when the committed artifacts do not match a fresh build. CI runs that same suite on every
   push (`.github/workflows/ci.yml`), so a stale artifact cannot sit unnoticed until someone deploys.
2. **Never leave in-flight state in the store.** Seed data may be incomplete, but nothing fabricated
   may be written to the spreadsheet; the app strips known fabricated Cpk seeds on load.
3. **Provisional limits stay provisional** until a planner enters the real limit. The six CTQs in
   `PROVISIONAL_LIMIT_SPEC_IDS` render neutral, and `hasProvisionalLimits` keeps every capability figure —
   the Overview line, the Cpk matrix share, the report — off a limit nobody confirmed. Confirming one
   happens in Cpk & Master Specs: enter the real LSL / nominal / USL and clear *limits provisional*. The
   *N provisional* chip on that view filters the matrix and the spec list down to those CTQs — including
   the ones without a capability reading, so a placeholder cannot drop out of sight.
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
bun run deploy:rollback            # back to the recorded last good version
bun run deploy:rollback --to=49    # or to a version you name
```

**The page is blank, or says "Authorization required — Review permissions".** The deployment is fine and the
app is not broken: Apps Script runs the page in a sandbox iframe, and because the web app runs as the accessing
user (`executeAs: USER_ACCESSING`) every Google account must allow the script's scopes once. Until it does,
that iframe holds the permission dialog and the app HTML is never loaded. Open the URL, press
*Review permissions* → *Allow*, and the app appears; it is a one-time grant per account, not per visit. Prove it
without guessing:

```bash
bun run deploy:verify        # exit 3 = permission dialog; exit 0 = the app rendered
bun tools/diagnose-deployment.mjs <url>   # frame-by-frame: who holds the page, and what it contains
```

The check reads the app where Apps Script puts it. The deployment URL is only a shell: it embeds the app in a
cross-origin `userCodeAppPanel` frame, which embeds the served HTML in a same-origin `userHtmlFrame`. That shell
always ships the dialog's markup — a hidden `#review-permissions-button` — and its frame URL always says
`?createOAuthDialog=true`, so neither is evidence of a missing grant. `tools/verify-deployment.mjs` walks every
reachable document, takes `#root` from whichever one holds it, and reports `3` only while that dialog is
actually laid out on screen and nothing rendered. A green check therefore means the served bundle mounted, not
just that the shell answered.

If a user sees this and cannot allow (wrong account, or a scope denied on the consent screen), the app cannot
run for that account at all: it signs every save and gate decision as that user, and refuses to work
anonymously on purpose.

**`bun run deploy` stopped at the staging check.** Production was not touched — the new version is on the staging
deployment only. The check exits `1` when the served page throws a parse error or `#root` never replaces the
splash, `2` when it could not test anything (signed-out browser, no Chrome/Edge, unreachable page), and `3` when
Apps Script served a *visible* permission dialog instead of the app. Sign in once with `bun run deploy:login`,
open the staging URL it prints and allow the scopes, then re-run the deploy. If the version is broken, fix it and deploy again; the untouched
production deployment keeps serving the last good version.

**A deploy reached production but the production check failed.** The deploy rolls production back to
`lastGoodVersion` itself and re-runs the check there, exiting `1`. The failed version stays on the staging
deployment for debugging. If the rollback could not name a target, it prints the `clasp update-deployment`
command to run by hand. A permission dialog (`3`) never triggers a rollback: it says nothing about the version.
Manual rollback at any time:

```bash
bun run deploy:rollback            # to the lastGoodVersion recorded by the last good deploy
bun run deploy:rollback --to=49    # to a specific version (see `clasp deployments`)
```

**Preview shows an old bundle.** The preview server keeps its own copy; restart `bun run preview`
after a build if the change does not appear.

**"Another user is currently saving"** — `LockService` held the script lock for 15 s. Retry; if it
persists, check for a stuck execution in the Apps Script editor.

**"Save refused: could not read your Google Workspace identity"** — the web app runs as the
accessing user (`executeAs: USER_ACCESSING`). Sign in with the Minebea account and grant the email
scope.
