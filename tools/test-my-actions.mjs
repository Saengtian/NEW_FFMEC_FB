/**
 * Checks for the My Actions queue:
 *
 *  - a blocked gate is one urgent row, aging from the date the plan needed it,
 *    and is not also listed as an owed signature (one hold, one row)
 *  - an owed signature appears for the approver who has not signed, only when the
 *    plan needs it inside the horizon; an approved gate produces nothing
 *  - a task ages from the day it was due, and a done or not-yet-due task is left out
 *  - an open customer case is stale only once it is older than the case window,
 *    and a closed case never is
 *  - data gaps come from the quality queue with no invented age, and a blocker is
 *    urgent regardless of age
 *  - severity follows the overdue count (7 days is due, 8 is urgent) and the aging
 *    bands follow the day count
 *  - the owner filter narrows the rows and the summary but keeps every owner in
 *    the picker, and the list is ordered worst first
 *  - every row carries the link fields its module needs to open the record
 *
 * The rules are read straight out of Part1_Data.html — the same text tools/build.mjs
 * compiles — so the tests cannot drift from a copy. Tooling only: tools/** is in
 * .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-my-actions.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const source = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");

const DECLARATIONS = [
  /const NPI_GATES = \[[\s\S]*?\n\];/,
  /const GATE_SIGN_OFF_DUE_KEYS = \{[\s\S]*?\n\};/,
  /function gateSignOffDueIso\([\s\S]*?\n}/,
  /const DATA_TRUST_FRESH_DAYS = \d+;/,
  /const DATA_TRUST_AGING_DAYS = \d+;/,
  /function dataTrustDay\([\s\S]*?\n}/,
  /function dataTrustDayText\([\s\S]*?\n}/,
  /function dataTrustDaysBetween\([\s\S]*?\n}/,
  /function isoDateParts\([\s\S]*?\n}/,
  /const MY_ACTION_KINDS = \{[\s\S]*?\n\};/,
  /const MY_ACTION_KIND_ORDER = \[[^\]]*\];/,
  /const MY_ACTION_AGING_BUCKETS = \[[\s\S]*?\n\];/,
  /const MY_ACTION_CASE_STALE_DAYS = \d+;/,
  /const MY_ACTION_SIGNATURE_HORIZON_DAYS = \d+;/,
  /const MY_ACTION_URGENT_DAYS = \d+;/,
  /const MY_ACTION_SEVERITY_ORDER = \[[^\]]*\];/,
  /const MY_ACTION_SEVERITY_LABELS = \{[^}]*\};/,
  /function myActionBucket\([\s\S]*?\n}/,
  /function myActionBucketLabel\([\s\S]*?\n}/,
  /function myActionSeverity\([\s\S]*?\n}/,
  /function myActionItem\([\s\S]*?\n}/,
  /function myActionsQueue\([\s\S]*?\n}/
];

const pieces = DECLARATIONS.map((pattern) => {
  const match = source.match(pattern);
  if (!match) {
    console.error(`Part1_Data.html no longer declares ${pattern} — update this test, the helper moved.`);
    process.exit(1);
  }
  return match[0];
});

const api = new Function(
  `"use strict";\n${pieces.join("\n")}\n` +
    "return { MY_ACTION_KINDS, MY_ACTION_KIND_ORDER, MY_ACTION_AGING_BUCKETS, " +
    "MY_ACTION_CASE_STALE_DAYS, MY_ACTION_SIGNATURE_HORIZON_DAYS, MY_ACTION_URGENT_DAYS, " +
    "myActionBucket, myActionBucketLabel, myActionSeverity, myActionItem, myActionsQueue };"
)();

const {
  MY_ACTION_KINDS,
  MY_ACTION_KIND_ORDER,
  MY_ACTION_AGING_BUCKETS,
  MY_ACTION_CASE_STALE_DAYS,
  MY_ACTION_SIGNATURE_HORIZON_DAYS,
  myActionBucket,
  myActionBucketLabel,
  myActionSeverity,
  myActionItem,
  myActionsQueue
} = api;

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (error) {
    results.push({ label, ok: false, message: error.message });
  }
}
const equal = (actual, expected) => assert.strictEqual(actual, expected);
const deep = (actual, expected) => assert.deepStrictEqual(actual, expected);

const TODAY = "2026-11-28";

// Two lines on one program: every gate the plan needs on a known date.
const SCHEDULE = {
  prepStart: "2026-11-01",
  brrEnd: "2026-11-10",
  mboEnd: "2026-11-15",
  mainEnd: "2026-11-18",
  oqcEnd: "2026-11-22",
  etd: "2026-11-25",
  mih: "2026-12-05",
  pbr: "2026-12-12"
};

const PROJECT = {
  id: "PRJ-A",
  model: "X4152",
  phase: "EVT",
  status: "At Risk",
  buildMatrix: [{ config: "ME11", side: "RHS", total: 1000 }]
};

const variantsFor = () => [{ key: "ME11-RHS", config: "ME11", side: "RHS" }];
const scheduleFor = () => SCHEDULE;

const run = (work, options = {}) =>
  myActionsQueue(work, {
    today: TODAY,
    variantsFor,
    scheduleFor,
    ...options
  });

const gateRecord = (status, approvers = []) => ({ status, approvers });

check("a blocked gate is urgent and ages from the date the plan needed it", () => {
  const queue = run({
    projects: [PROJECT],
    gateRecords: {
      "PRJ-A": {
        "ME11-RHS": {
          prep: gateRecord("Approved"),
          bbr: gateRecord("Approved"),
          brr: gateRecord("Blocked")
        }
      }
    }
  });
  equal(queue.items.length, 1, "one hold makes one row");
  const [item] = queue.items;
  equal(item.kind, "gate");
  equal(item.severity, "urgent");
  assert.match(item.title, /G3 BRR is on hold/);
  equal(item.dueIso, "2026-11-10");
  equal(item.overdueDays, 18);
  equal(item.ageBucket, "month");
  equal(item.gateId, "brr");
  equal(item.lineKey, "ME11-RHS");
  equal(item.projectId, "PRJ-A");
});

check("a hold is not listed twice as an owed signature", () => {
  const queue = run({
    projects: [PROJECT],
    gateRecords: {
      "PRJ-A": {
        "ME11-RHS": {
          brr: gateRecord("Blocked", [
            { name: "Patcharapong", decision: "Pending" },
            { name: "Panida", decision: "Approved" }
          ])
        }
      }
    }
  });
  equal(queue.items.filter((item) => item.kind === "signature").length, 0);
  equal(queue.items.filter((item) => item.kind === "gate").length, 1);
});

check("an owed signature appears for the approver who has not signed", () => {
  const queue = run({
    projects: [PROJECT],
    gateRecords: {
      "PRJ-A": {
        "ME11-RHS": {
          mbo: gateRecord("In Review", [
            { name: "Patcharapong", decision: "Pending" },
            { name: "Panida", decision: "Approved" }
          ])
        }
      }
    }
  });
  equal(queue.items.length, 1, "only the unsigned approver owes something");
  const [item] = queue.items;
  equal(item.kind, "signature");
  equal(item.owner, "Patcharapong");
  assert.match(item.title, /Patcharapong owes a signature/);
  equal(item.dueIso, "2026-11-15");
  equal(item.overdueDays, 13);
  equal(item.severity, "urgent");
  equal(item.gateId, "mbo");
});

check("a signature the plan does not need yet is left out", () => {
  const far = { ...SCHEDULE, pbr: "2026-12-20" };
  const queue = myActionsQueue(
    {
      projects: [PROJECT],
      gateRecords: {
        "PRJ-A": {
          "ME11-RHS": {
            pbr: gateRecord("Pending", [{ name: "Horikawa", decision: "Pending" }])
          }
        }
      }
    },
    { today: TODAY, variantsFor, scheduleFor: () => far }
  );
  equal(queue.items.length, 0, `${MY_ACTION_SIGNATURE_HORIZON_DAYS}d horizon must not reach 22d out`);
});

check("an approved gate produces no action at all", () => {
  const queue = run({
    projects: [PROJECT],
    gateRecords: { "PRJ-A": { "ME11-RHS": { mbo: gateRecord("Approved") } } }
  });
  equal(queue.items.length, 0);
});

check("a task ages from the day it was due", () => {
  const queue = run({
    projects: [PROJECT],
    tasks: [
      { id: "T-1", title: "Close FACA", status: "In Progress", dueDate: "2026-11-20", owner: "Kanya" },
      { id: "T-2", title: "Due today", status: "To Do", dueDate: TODAY, owner: "Kanya" },
      { id: "T-3", title: "Done", status: "Done", dueDate: "2026-11-01", owner: "Kanya" },
      { id: "T-4", title: "No date", status: "To Do", dueDate: "" }
    ]
  });
  equal(queue.items.length, 1);
  const [item] = queue.items;
  equal(item.kind, "task");
  assert.equal(item.recordId, "T-1");
  equal(item.overdueDays, 8);
  equal(item.severity, "urgent");
  equal(item.owner, "Kanya");
});

check("an open case is stale only after the case window", () => {
  const queue = run({
    projects: [],
    customerFeedback: [
      { id: "CF-1", issueItem: "No spin", nmbStatus: "Open", customerStatus: "Open", feedbackDate: "2026-10-01", location: "QSMC" },
      { id: "CF-2", issueItem: "Fresh", nmbStatus: "Open", feedbackDate: "2026-11-20", location: "FXLH" },
      { id: "CF-3", issueItem: "Closed", nmbStatus: "Closed", customerStatus: "Closed", feedbackDate: "2026-01-01" }
    ]
  });
  equal(queue.items.length, 1, `only the case older than ${MY_ACTION_CASE_STALE_DAYS}d is stale`);
  const [item] = queue.items;
  equal(item.kind, "case");
  equal(item.recordId, "CF-1");
  equal(item.ageDays, 58);
  equal(item.overdueDays, 28);
  equal(item.severity, "urgent");
  assert.match(item.detail, /QSMC/);
});

check("data gaps carry no invented age and a blocker is urgent", () => {
  const queue = run({
    projects: [],
    dataQuality: {
      issues: [
        { id: "production:blocker:PR-1", areaLabel: "Production", severity: "blocker", title: "Row cannot describe a run", detail: "Input qty is zero.", view: "production" },
        { id: "products:missing:X9999", areaLabel: "Product Master", severity: "missing", title: "X9999 is not in Product Master", detail: "", view: "setup" }
      ]
    }
  });
  equal(queue.items.length, 2);
  const blocker = queue.items.find((item) => item.recordId === "production:blocker:PR-1");
  equal(blocker.severity, "urgent");
  equal(blocker.ageDays, null);
  equal(blocker.ageBucket, null);
  equal(blocker.ageBucketLabel, "No date on file");
  const missing = queue.items.find((item) => item.recordId === "products:missing:X9999");
  equal(missing.severity, "watch");
  equal(missing.view, "setup");
});

check("severity follows the overdue count, not the wording", () => {
  equal(myActionSeverity(0), "watch");
  equal(myActionSeverity(1), "due");
  equal(myActionSeverity(7), "due");
  equal(myActionSeverity(8), "urgent");
  equal(myActionSeverity(0, { blocked: true }), "urgent");
  equal(myActionSeverity(0, { blocker: true }), "urgent");
});

check("aging bands follow the day count", () => {
  equal(myActionBucket(0), "new");
  equal(myActionBucket(2), "new");
  equal(myActionBucket(3), "week");
  equal(myActionBucket(7), "week");
  equal(myActionBucket(8), "month");
  equal(myActionBucket(30), "month");
  equal(myActionBucket(31), "older");
  equal(myActionBucket(null), null);
  equal(myActionBucketLabel("older"), MY_ACTION_AGING_BUCKETS[3].label);
  equal(myActionBucketLabel(null), "No date on file");
});

check("an owner filter narrows the rows and the summary but keeps every owner", () => {
  const work = {
    projects: [PROJECT],
    gateRecords: {
      "PRJ-A": {
        "ME11-RHS": {
          mbo: gateRecord("In Review", [
            { name: "Patcharapong", decision: "Pending" },
            { name: "Panida", decision: "Pending" }
          ])
        }
      }
    },
    tasks: [{ id: "T-9", title: "Late", status: "To Do", dueDate: "2026-11-10", owner: "Kanya" }]
  };
  const all = run(work);
  equal(all.summary.total, 3);
  const mine = run(work, { owner: "Patcharapong" });
  equal(mine.summary.total, 1);
  equal(mine.items[0].owner, "Patcharapong");
  equal(mine.owners.length, 3, "the picker still lists everyone");
  equal(mine.owners.reduce((sum, entry) => sum + entry.count, 0), 3, "every owner keeps their count");
});

check("the queue is ordered worst first", () => {
  const queue = run({
    projects: [PROJECT],
    gateRecords: {
      "PRJ-A": {
        "ME11-RHS": {
          brr: gateRecord("Blocked"),
          mbo: gateRecord("In Review", [{ name: "Patcharapong", decision: "Pending" }])
        }
      }
    },
    tasks: [
      { id: "T-1", title: "Two days late", status: "To Do", dueDate: "2026-11-26", owner: "Kanya" },
      { id: "T-2", title: "Nine days late", status: "To Do", dueDate: "2026-11-19", owner: "Kanya" }
    ],
    dataQuality: {
      issues: [{ id: "gap-1", areaLabel: "Tasks", severity: "missing", title: "No owner", view: "tasks" }]
    }
  });
  deep(
    queue.items.map((item) => `${item.kind}:${item.overdueDays}`),
    ["gate:18", "signature:13", "task:9", "task:2", "gap:0"],
    "urgent first, oldest first inside a band, undated last"
  );
  equal(queue.items[0].kind, "gate");
  equal(queue.items[queue.items.length - 1].kind, "gap");
  const overdue = queue.items.map((item) => item.overdueDays);
  const firstWatch = overdue.findIndex((days) => days === 0);
  assert.ok(firstWatch > 0, "undated and not-yet-due rows come last");
  assert.ok(
    overdue.slice(0, firstWatch).every((days, index, list) => index === 0 || list[index - 1] >= days),
    `overdue rows must fall from oldest to newest: ${overdue.join(",")}`
  );
});

check("every row carries what its module needs to open the record", () => {
  const queue = run({
    projects: [PROJECT],
    gateRecords: {
      "PRJ-A": { "ME11-RHS": { brr: gateRecord("Blocked") } }
    },
    tasks: [{ id: "T-3", title: "Late", status: "To Do", dueDate: "2026-11-01", owner: "Kanya" }],
    customerFeedback: [
      { id: "CF-9", issueItem: "No spin", nmbStatus: "Open", feedbackDate: "2026-01-02", location: "QSMC" }
    ],
    dataQuality: {
      issues: [{ id: "gap-2", areaLabel: "Cpk", severity: "inconsistent", title: "Missing spec", view: "cpk" }]
    }
  });
  equal(queue.items.length, 4);
  const gate = queue.items.find((item) => item.kind === "gate");
  deep([gate.projectId, gate.lineKey, gate.gateId], ["PRJ-A", "ME11-RHS", "brr"]);
  equal(gate.view, "gates");
  const task = queue.items.find((item) => item.kind === "task");
  equal(task.recordId, "T-3");
  equal(task.view, "tasks");
  const bare = queue.items.find((item) => item.kind === "case");
  equal(bare.recordId, "CF-9");
  equal(bare.view, "feedback");
  const gap = queue.items.find((item) => item.kind === "gap");
  equal(gap.view, "cpk");
  equal(MY_ACTION_KINDS.gap.action, "Fix data");
  equal(MY_ACTION_KIND_ORDER[0], "gate");
});

check("the summary counts the rows by kind, band and severity", () => {
  const queue = run({
    projects: [PROJECT],
    gateRecords: { "PRJ-A": { "ME11-RHS": { brr: gateRecord("Blocked") } } },
    tasks: [{ id: "T-1", title: "Late", status: "To Do", dueDate: "2026-11-20", owner: "Kanya" }],
    dataQuality: {
      issues: [{ id: "gap-3", areaLabel: "Tasks", severity: "missing", title: "No owner", view: "tasks" }]
    }
  });
  equal(queue.summary.total, 3);
  equal(queue.summary.urgent, 2);
  equal(queue.summary.watch, 1);
  equal(queue.summary.overdue, 2);
  equal(queue.summary.undated, 1);
  equal(queue.summary.byKind.gate, 1);
  equal(queue.summary.byKind.task, 1);
  equal(queue.summary.byKind.gap, 1);
  equal(queue.summary.byKind.case, 0);
  equal(queue.summary.byBucket.month, 2);
  equal(queue.summary.oldestDays, 18);
});

check("the queue does not mutate the slices it reads", () => {
  const work = {
    projects: [PROJECT],
    gateRecords: { "PRJ-A": { "ME11-RHS": { brr: gateRecord("Blocked") } } },
    tasks: [{ id: "T-1", title: "Late", status: "To Do", dueDate: "2026-11-20", owner: "Kanya" }],
    customerFeedback: [
      { id: "CF-1", issueItem: "No spin", nmbStatus: "Open", feedbackDate: "2026-01-02" }
    ],
    dataQuality: { issues: [{ id: "gap-4", areaLabel: "Cpk", severity: "missing", title: "Spec", view: "cpk" }] }
  };
  const snapshot = JSON.stringify(work);
  run(work);
  equal(JSON.stringify(work), snapshot);
  equal(work.projects.length, 1);
  equal(work.tasks[0].status, "To Do");
});

check("a row is normalised to the fields the view reads", () => {
  const item = myActionItem({ kind: "task", title: "  Late  ", overdueDays: "4", ageDays: "4" });
  equal(item.title, "Late");
  equal(item.overdueDays, 4);
  equal(item.ageDays, 4);
  equal(item.severity, "due");
  equal(item.kindLabel, "Overdue task");
  equal(item.actionLabel, "Open task");
  equal(item.dueIso, "");
  const undated = myActionItem({ kind: "gap", title: "No date" });
  equal(undated.ageDays, null);
  equal(undated.overdueDays, 0);
  equal(undated.severity, "watch");
});

const passed = results.filter((entry) => entry.ok).length;
results.forEach((entry) => {
  if (entry.ok) {
    console.log(`  pass  ${entry.label}`);
  } else {
    console.log(`  FAIL  ${entry.label}  (${entry.message})`);
  }
});
console.log("");
console.log(`${passed}/${results.length} My Actions checks passed.`);
if (passed !== results.length) process.exit(1);
