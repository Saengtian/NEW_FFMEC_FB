# FFM NPI Ops — Product Definition

> One screen of truth for the FDB fan-assembly NPI program: what is being built, who signs it off,
> what it was measured at, and what the portfolio looks like this month.

## 1. The problem

The program runs on a spreadsheet plus four kinds of meeting. Plans live in the Gantt tab, gate
approvals live in email and signed PDFs, yields live in a production report, capability lives in a
metrology file, and the monthly KPI pack is rebuilt by hand. Nobody can answer, in one place and with
evidence:

- Which programs exist right now, in which phase, for which configuration and side?
- Which gates are cleared, by whom, on what evidence, and what is blocked behind them?
- Is first-pass yield inside its floor this month, and did it move or drift?
- Are the CTQ parameters actually capable, or are we reporting a number against a guessed limit?
- What is the team carrying, and which work has no owner?

The app answers those, and refuses to answer the rest with invented numbers.

## 2. Users and jobs

| User | Job to be done | Where they live in the app |
| --- | --- | --- |
| Program leader | Run the portfolio, chair gate reviews, publish the monthly KPI pack | Overview, Timeline, Gate sign-off, Reports |
| NPI engineer | Own a program's tasks and build sequence, keep dates honest | Projects, Tasks, Timeline |
| Quality / metrology | Judge capability against real limits, track claims and 8D | Cpk & Master Specs, Customer Feedback |
| Manufacturing engineer | Record yield, UPH and efficiency, see station losses | Production Records |
| Cost / VA-VE owner | Track saving ideas from proposal to booked saving | Projects & Cost Saving |
| Engineering / QA manager | Sign gates, check workload, approve capacity | Gate sign-off, Team & Workload |
| Anyone signed in | Find the number, print it, export it | Global scope, KPI deep dive, CSV / print |

## 3. Product principles

1. **Stored data is evidence.** Nothing fabricated is seeded into the store: a fresh workspace has no
   Cpk rows at all (import is the only source), the invented demo rows are stripped by id on load,
   and placeholder Drive links are purged.
2. **A limit that is not real capability.** Six CTQs still carry placeholder limits. They are
   flagged provisional, render neutral, and never count as capable.
3. **Every gate decision is attributable.** Approvals record who, when, role, decision, remark and
   the signed-in email; decision rows are append-only, and a commit marker distinguishes them from rows
   left by a save whose state write failed.
4. **One scope, everywhere.** A single Global Scope (family · model · phase · side · process) narrows
   every view, the KPI tiles, the deep dives and the report.
5. **The report is the app, printed.** The KPI deck is generated from the same model the screen uses;
   there is no second spreadsheet to keep in sync.

## 4. Capability map

| Module | What it does | Key interactions |
| --- | --- | --- |
| **Program Overview** | Portfolio header, KPI tiles, inline KPI deep dive (trend · by variant worst first · Pareto of loss), gate matrix, scope summary | Open a KPI deep dive, switch the deep dive KPI or range; jump into a program |
| **My Actions** | One queue over every source of open work: gates on hold, signatures the plan needs within 7 days, tasks past their date, customer cases open more than 30 days and the data-quality gaps. Every row ages from its own clock and opens the record it came from; the owner picker narrows the list to one person and the summary follows the rows shown | Pick an owner, filter by kind, open the gate dossier, task drawer, case form or owning module |
| **NPI Projects & Matrix** | Program records, split build across vendors/configs, product assignment | Edit / delete program, add config/side, assign products |
| **Program Setup & Products** | Combined setup workspace: initialize a PEN-81-0002 program, and maintain the model-to-family registry behind the scope filters, program forms and product assignments | Initialize program; add a product, change its family, delete an unused product |
| **MIH Risk & Capacity** | Predicted FATP MIH per line, from the gates still unsigned, the program's late and blocked work, the build against the share of its window spent, and the median stage time of the gates already passed on other lines; every driver is shown as days with its evidence, and the slip is their sum. Also sizes each owner's open tasks plus owed signatures against an explicit items-per-week assumption | Read the predicted date and its drivers, open the gate dossier, the task drawer or the timeline, check which owners cannot clear their load |
| **Data Quality** | The trust behind the scorecard: every KPI tile carries the newest source date, its row coverage and a stale warning once that source is over a month old, and one queue lists records that are missing, contradict a stored rule, or point at a program/spec that no longer exists | Filter the queue by severity, open the module that owns the record |
| **Build Timeline (Gantt)** | Stage sequence per line, gate-coloured bars, drag to reschedule | Drag a bar (refused when it breaks the sequence), open a dossier |
| **Tasks & AIL** | Action items with owner, due date, status, linked program/gate | New task, claim unassigned work, open drawer |
| **NPI Gate Sign-Off** | Nine gates (PEN-81-0002 Rev B) per configuration × side, exit criteria, cross-functional signatures, evidence links, audit trail; the matrix cell shows status + date (mm/dd) — the pass date once signed, the plan date otherwise, and `gateStatusPrefix` keeps that word the same in the ledger (`Pass 11/21`) and in the signatures-owed list (`Dep. 01/03`) | Tick criteria, sign, attach evidence, open matrix cell |
| **Cpk & Master Specs** | Spec library, capability roll-up, distribution compare, spec correction, import pipeline; one provisional-limits panel lists every CTQ still on placeholder limits with its limit owner and confirm-by date (overdue flagged), opens that spec's editor, and its *Show only these* toggle narrows both tabs to those CTQs, including ones no upload has reached | Upload Cpk data, correct a spec, compare distributions, filter to provisional CTQs |
| **Projects & Cost Saving** | VA/VE, yield and HC saving ideas with computed annual saving | Edit item, compare against the 10M THB target |
| **Customer Feedback** | Claims and FA/8D cases with severity, stage and closure status | Open case, update 8D stage |
| **Production Records** | Yield, UPH, efficiency and loss per station per day, plus a daily % fallout (of input) / % salvage recovered (of fallout) trend fed by the filtered records; CSV/Excel import judged by the same rules as the form (a real production date is required — every trend, range and duplicate is keyed on it), and any refused row — on import or on load — is named with its day, line, station and the rule in a dismissible warning (the save summary repeats it) | Import CSV / Excel, add / edit / delete a record, filter by station |
| **Team & Workload** | Roster, product ownership, external programs, derived workload, unassigned work; each owed signature reads as its gate's prefix plus the plan date (`Dep. 01/03 · 5d overdue`), closest deadline first | Claim a task, edit a member, open the workload drawer |
| **Reports & Snapshots** | Six-KPI executive report for a fiscal period, printable A4 deck, CSV/print | Pick a preset, export the deck, print |

MIH forecast method: each line's prediction is the plan date plus the sum of four capped drivers —
the worst gate past the date its signature was needed (≤ 45 d), late tasks at one day each plus two
per blocked task (≤ 10 d), the build gap against the spent share of the build window (≤ 30 d), and
the remaining gates' historical median stage time minus the days left (≤ 30 d). Cycle time is the
median, not the mean, so one stalled line cannot set it. Approvals stamped on the same day are one
bulk sign-off rather than a stage that took no time, so they are not a sample; with no approved
stage pairs the forecast falls back to the plan's own stage length and says so.

My Actions method: severity comes from the overdue count alone — a hold or a blocker, or more than
7 days late, is urgent; 1–7 days is due; anything not yet late is watch. Each row ages from its own
clock: the date the plan needed a gate signature, a task's due date, the day a customer case was
raised (stale after 30 days open), and a data gap carries no age rather than a made-up one. A gate on
hold is one row, not also an owed signature, so the queue never inflates itself.

Cross-cutting: Global Scope filter, KPI deep-dive modal (live scope + range + variant filters),
KPI data-trust strip (as-of · sheet revision · source coverage · stale warning), data-quality
queue, state history, JSON backup/restore, sync badge, dark mode.

## 5. Domain model

| Object | Identity | Important fields |
| --- | --- | --- |
| Product (`products`) | `PRD-X####` | Model code and family group; active NPI/MP status derives from the model |
| Program (`projects`) | `X####` + phase | Family, model, phase, configs, sides, owner, dates, gate schedule |
| Line / variant | Program + configuration + side | Stage sequence, current gate, schedule overrides |
| Gate record (`gateRecords`) | Program → line key → gate | Status, criteria ticks, signatures, evidence links, remarks, history |
| Task | `T-###` | Program, line, gate, owner, due date, status, priority |
| Production record | Generated | Date, program, line, station, input, good, FPY, FY, UPH, efficiency |
| Master spec | `SPEC-…` | Parameter, station, unit, LSL/nominal/USL, Cpk target, metrology, doc ref, `limitsProvisional` |
| Cpk record | `CPK-…` | Spec, sample date, n, mean, σ, Cp/Cpk/PPM, upload batch, raw values |
| Cost item | `CS-…` | Type (VA/VE, yield, HC), baseline, after, volume, annual saving |
| Feedback case | `CF-…` | Customer, category, severity, stage, 8D steps, claim amount |
| Team member | `TM-…` | Role, reports-to, products, external programs, email |

Only **X4151, X4152 and X4026** are active NPI models. A program on any other model is
normalized to **MP** on load and on save. The header **Portfolio** switch defaults to
NPI; Program Overview and every module show either the NPI or the MP portfolio, never both.

Persisted client slices: `projects`, `products`, `tasks`, `gateRecords`, `productionRecords`,
`masterSpecs`, `cpkRecords`, `costProjects`, `customerFeedback`, `teamMembers`, `scheduleOverrides`.

## 6. Metrics

Fiscal year runs **1 April – 31 March**. Dashboard tiles and the report share the same targets
(`KPI_TARGETS`):

| KPI | Target | Direction | Source |
| --- | --- | --- | --- |
| First Pass Yield | ≥ 98.0 % | higher is better | Production records |
| Final Yield | ≥ 99.5 % | higher is better | Production records |
| Line Efficiency | ≥ 90.0 % | higher is better | Production records |
| Customer Claims | < 5 cases | lower is better | Customer feedback |
| Annual Cost Saving | > 10,000,000 THB | higher is better | Cost projects |
| Shipment to MIH | 100 % | higher is better | Gate / schedule |

The report computes its own period (TODAY, WTD, MTD, YTD, FY YTD, FY<year>, last 90 days, last 12
months, or a custom range) from the fiscal window, so the FY presets roll over on 1 April. The
dashboard's claims and saving tiles derive their year from the same `currentFiscalYear` rule, so the
whole app crosses into the next fiscal year together on 1 April rather than on a redeploy.

## 7. Out of scope (deliberate)

- No user administration or role management: identity is the Google Workspace account, authorisation
  lives in the sign-off table.
- No second backend, database or API. The Sheet is the database; Apps Script is the server.
- No email or chat notifications (the data to drive them exists; the sender does not).
- No mobile app, no offline mode, no per-line data entry on a tablet beyond what the web page offers.
- No automatic SPC alarming or forecasting beyond the MIH slip forecast, which is driver-based and
  reads the workspace on screen rather than projecting a run-rate curve. No scheduling solver and
  no second capacity model: owner load is the workload board's own count, judged against a stated
  items-per-week assumption.
- No multilingual UI: the interface is English; source data may be Thai.

## 8. Known limitations

1. Six CTQs carry provisional limits and cannot be certified capable until real limits are entered.
2. The whole workspace is one JSON document in chunked rows: every save rewrites all slices, so two
   people saving at once end in a revision conflict rather than a merge.
3. The sign-off ledger records only decisions changed by a save, and is appended before the state
   write; a ledger failure refuses the save rather than committing a signature without its audit row.
   A row from a state write that failed remains uncommitted and is reported by reconciliation, not
   silently re-baselined.
   The next app load still repairs legacy gaps (the client calls `reconcileSignOffLedger()`, which
   appends only the missing decisions), but only while the two revisions that bracket the legacy gap
   are still in history — five saves deep.
4. History keeps five revisions of the whole store, not per-record history.
5. The bundle is ~1.3 MB of inline script; startup cost on weak hardware is noticeable.

## 9. Where this should go next

Ordered by value, not by effort: a deploy smoke test and staging deployment; closing out the six
provisional limits with an owned confirmation queue; versioned specs so historic Cpk stays comparable;
SPC drift monitoring on each upload; a readable audit-trail view; scheduled nudges for owed
signatures and unassigned work; point-in-time snapshots so trends are real; bundle splitting; global
search; render-level tests.
