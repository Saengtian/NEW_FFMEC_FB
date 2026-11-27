# FFM NPI Ops — Standard Operating Procedure

Audience: program leaders, NPI engineers, quality, manufacturing engineers and managers who use the
web app. For how the app is built and deployed, see [../blueprint.md](../blueprint.md).

---

## 0. Before you start

1. Open the web app link in Chrome or Edge and sign in with your **@minebea.co.th** account.
2. Accept the permissions when asked (Google Sheets and your email address). Without the email the
   app cannot attribute a save and will refuse it.
3. Check the top-right badge: **Sheet Synced · Rev #n** means your copy matches the sheet. Any other
   state (Saving…, Offline, Error) must be resolved before you continue.
4. Set the **Global Scope** (Family · Model · Phase · Side · Process) at the top. Everything —
   tiles, tables, dives, report — narrows to it. "All …" means no narrowing on that dimension.

> Rule of thumb: if a number looks wrong, check the Global Scope before checking the data.

---

## 1. Daily routine (5 minutes)

| Step | Where | What to check |
| --- | --- | --- |
| 1 | Program Overview | KPI tiles against target; any red tile |
| 2 | Tasks & AIL | Tasks due today or overdue; anything with no owner |
| 3 | NPI Gate Sign-Off | Pending sign-offs on your program |
| 4 | Team & Workload | "Unassigned work" count; claim what belongs to your team |

---

## 2. Programs and build lines

**Create a program**
1. *NPI Projects & Matrix → New Program*.
2. Fill model, family, phase, configuration(s), sides, owner and the gate plan dates.
3. Save. The program appears in the matrix, the Gantt and every scope dropdown.

**Edit or split a build**
1. Open the program card → *Edit*.
2. Add a configuration (e.g. ME11/ME12) or a side (RHS/LHS) — each combination becomes its own line
   with its own gate dossier.
3. Assign products so the team workload and product coverage stay accurate.

**Move a stage in the Gantt**
1. Open *Build Timeline*. Drag a bar to its new dates.
2. The app refuses a move that would break the stage sequence or fall outside FATP MIH, and tells you
   why. Fix the neighbouring stage first.
3. Bars are coloured by gate sign-off, so a red bar means the gate behind it is not cleared.

---

## 3. Tasks

**Raise a task**: *Tasks & AIL → New Task*. Required: title, program (and line if the work is
line-specific), owner, due date, priority.

**Work a task**: open it in the drawer, update status and notes. Status changes are saved with the
next sync.

**Claim unassigned work**: *Team & Workload → Unassigned work* lists open tasks with no owner and a
picker. Choosing a name assigns the task to that roster member. Work owned by someone outside this
workspace is listed separately and is not counted as unassigned.

---

## 4. Gate sign-off (the controlled step)

Gate decisions are the audit record. Do them carefully.

1. *NPI Gate Sign-Off* → choose the configuration × side chip set at the top
   (e.g. ME11 · RHS). The dossier below is for exactly those lines.
2. **Exit criteria**: tick each criterion only when the evidence exists. Ticking is a statement, not
   a plan.
3. **Evidence**: *Add Drive link* for the folder or file that holds the proof. Do not paste links you
   have not opened — dead links are refused in the Gantt evidence panel.
4. **Cross-functional sign-off**: each authorised role signs with a decision and a remark. The signed
   identity is recorded, not typed.
5. *Approve & Lock* becomes available only when every criterion and signature is in place.
6. The **audit trail** under the dossier shows every recorded decision, newest first, with the
   approver and timestamp.

**What not to do**
- Do not sign for another person or on their behalf.
- Do not attach a plan or an email thread as evidence; attach the artefact.
- Do not delete a criterion comment after signing — the ledger already holds the decision.

**If a gate is blocked**: the dependency matrix and the Gantt both show which upstream gate holds it.
Clearing the upstream gate is the only unblock path.

---

## 5. Production records

1. *Production Records → New Record*.
2. Enter date, program, line, station, input quantity, good quantity, UPH and efficiency.
3. Check the computed FPY/FY before saving; a mistyped input shows immediately as an impossible
   yield.
4. Edit an existing row rather than adding a duplicate for the same date/line/station.

These rows feed the yield KPIs, the report and the deep dives. A wrong row is visible everywhere.

---

## 6. Cpk and master specs

**Upload measurements**
1. *Cpk & Master Specs → Import*.
2. Choose the file (raw measurements or a summary with mean/σ/n) and map the columns.
3. Check the preview: spec match, sample count, unit, date. Rows that cannot be matched to a spec are
   reported, not silently accepted.

**Read capability honestly**
- A **provisional** spec (dashed, neutral, "Provisional limits") means the limit is a placeholder.
  The app deliberately refuses to call it capable or incapable. Get the real limit entered.
- Compare distributions only within the same spec revision; a changed limit invalidates the
  comparison.

**Correct a spec**: open the spec → *Edit*. Enter LSL/nominal/USL from the controlled document, plus
metrology and doc reference. Clear *limits provisional* only when the number is the real one.

**Six CTQs are currently provisional**: coverage height (mount), pillow coverage gap, current at 20
and 100, speed at 20 and 100. They stay neutral until a planner confirms real limits.

---

## 7. Cost saving, feedback and the roster

- **Cost saving**: add an item with type (VA/VE, yield, HC), baseline, after, volume and annual
  saving. The tile compares the portfolio against the 10M THB target.
- **Customer feedback**: log a claim or FA/8D case with customer, category, severity and stage;
  advance the 8D steps as the case progresses. Claims count toward the claims KPI.
- **Team & Workload**: keep the roster current — role, reports-to, owned products. Workload is
  derived (open tasks + gates still missing your signature); it is never typed in. Mark programs you
  support but do not own under *External programs*.

---

## 8. Monthly KPI report

1. *Reports & Snapshots*.
2. Choose the period preset: `FY YTD` (1 Apr → today), `FY2026` (the whole fiscal year), `YTD`
   (calendar year), `MTD`/`WTD`/`TODAY`, `Last 90 days`, `Last 12 months` — or type a custom
   from/to range.
3. Review the six KPI tiles: value, target, delta and the period movement.
4. *Export report (3 pages)* produces a self-contained HTML deck (three A4 landscape pages): cover with the
   scorecard, KPI tiles with trend and target, deep dive and method. Open it, then **Print → Save as
   PDF**; the deck is already laid out for print.
5. Attach the PDF to the monthly pack. The deck states its scope, period and generation time, so two
   copies are never confused.

**Printing from the app**: the deep dive has *Print* and *CSV*; the print view drops the filters and
toolbar.

---

## 9. Housekeeping

| Need | How |
| --- | --- |
| Take a personal backup | Sidebar → *Backup* (downloads the workspace JSON) |
| Restore a backup | Sidebar → *Restore*, pick the JSON; it saves back to the sheet immediately |
| Look at an older revision | Topbar → *State history* (last 5 saves), preview and restore |
| Force a reload from the sheet | Topbar → *Sync* / the reload icon |
| Rebuild the human-readable tabs | Sheet menu → *FFM NPI Ops → Refresh Mirror Tabs…* |

---

## 10. When something goes wrong

**"Save refused: could not read your Google Workspace identity"**
Sign in with your Minebea account, grant the email permission, reload.

**"Another user is currently saving…"**
Someone else's save holds the lock for up to 15 s. Wait a few seconds and change something again.

**Sync conflict dialog**
Another user saved while you had unsaved edits; your edits are still in the browser. Open the
differing-record summary, then choose *Use their version* (your edits are discarded) or *Keep my
version* (their change is overwritten). Do not keep yours without reading the difference list.

**"FFM NPI Ops Startup Error"**
The page did not load. Reload once. If it repeats, send the message shown to the maintainer with the
time and the URL; do not keep retrying in the same tab.

**A number looks stale**
Press *Sync*. If a tile still disagrees with its table, check the Global Scope and the period/date
filter on that view.

**You saved something wrong**
*State history* keeps the last five saves: load the revision before the mistake, check it, restore.
Otherwise use your JSON backup.

---

## 11. Data rules (non-negotiable)

1. **No invented numbers.** If a measurement, limit or date is unknown, leave it out or mark it
   provisional — never fill it in to make a chart look complete.
2. **Evidence or it did not happen.** Gate criteria are ticked against an artefact, not a promise.
3. **One owner per task.** Unassigned work is an explicit list; it is not someone's private backlog.
4. **Do not hand-edit the app-owned tabs** (`_FFM_STATE_STORE`, `_FFM_STATE_HISTORY`, `AuditLog`,
   `SignOffLog`). Read the mirror tabs instead; hand edits can corrupt the store.
5. **Sign as yourself.** The signature records your Workspace identity; a signature you did not make
   invalidates the gate.
