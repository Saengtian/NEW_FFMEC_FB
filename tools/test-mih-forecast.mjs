/**
 * Checks for the MIH risk and capacity forecast:
 *
 *  - historical cycle time is the median stage from approvals already on file,
 *    and no history reads as `none` instead of a made-up default
 *  - an on-plan line slips nothing; a gate past the date its signature was needed
 *    is the first driver and names the gate
 *  - late and blocked program tasks cost days, capped so one pile cannot swallow
 *    the forecast
 *  - a build behind the share of its window spent costs days
 *  - remaining gates longer than the calendar left cost the structural shortfall,
 *    from history when there is any and from the plan when there is not
 *  - a blocked program is high risk even with no slip, and a line with no MIH date
 *    is unknown rather than on time
 *  - the predicted date is the plan plus the slip, and the summary counts bands
 *  - capacity is load against an explicit rate, flagging over, tight and free
 *    owners with the items already late
 *
 * The helpers are read straight out of Part1_Data.html — the same text
 * tools/build.mjs compiles — so the tests cannot drift from a copy of a rule.
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-mih-forecast.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const source = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");

const DECLARATIONS = [
  /const NPI_GATES = \[[\s\S]*?\n\];/,
  /const MIH_FORECAST_GATES = [^;]*;/,
  /const MIH_FORECAST_CYCLE_MAX_DAYS = \d+;/,
  /const MIH_FORECAST_GATE_CAP_DAYS = \d+;/,
  /const MIH_FORECAST_TASK_CAP_DAYS = \d+;/,
  /const MIH_FORECAST_BUILD_CAP_DAYS = \d+;/,
  /const MIH_FORECAST_CYCLE_CAP_DAYS = \d+;/,
  /const MIH_FORECAST_MEDIUM_SLIP_DAYS = \d+;/,
  /const MIH_FORECAST_HIGH_SLIP_DAYS = \d+;/,
  /const MIH_FORECAST_ITEMS_PER_WEEK = \d+;/,
  /const MIH_FORECAST_WEEKS_AHEAD = \d+;/,
  /const MIH_FORECAST_RISK_ORDER = \[[^\]]*\];/,
  /function forecastMedian\([\s\S]*?\n}/,
  /const forecastClamp = [^;]*;/,
  /function forecastDaysBetween\([\s\S]*?\n}/,
  /function historicalGateCycleDays\([\s\S]*?\n}/,
  /function mihRiskForecast\([\s\S]*?\n}/,
  /function capacityForecast\([\s\S]*?\n}/,
  /function buildMihForecast\([\s\S]*?\n}/,
  /const GATE_SIGN_OFF_DUE_KEYS = \{[\s\S]*?\n\};/,
  /function gateSignOffDueIso\([\s\S]*?\n}/,
  /function gateApprovalIso\([\s\S]*?\n}/,
  /function addDaysIso\([\s\S]*?\n}/,
  /function diffDaysIso\([\s\S]*?\n}/,
  /function parseIsoDate\([\s\S]*?\n}/,
  /function isoDateParts\([\s\S]*?\n}/,
  /function formatMonthDay\([\s\S]*?\n}/
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
    "return { NPI_GATES, MIH_FORECAST_GATES, MIH_FORECAST_ITEMS_PER_WEEK, MIH_FORECAST_WEEKS_AHEAD, " +
    "forecastMedian, forecastClamp, forecastDaysBetween, historicalGateCycleDays, mihRiskForecast, " +
    "capacityForecast, buildMihForecast, gateApprovalIso, gateSignOffDueIso, addDaysIso, diffDaysIso };"
)();

const {
  MIH_FORECAST_GATES,
  forecastMedian,
  historicalGateCycleDays,
  mihRiskForecast,
  capacityForecast,
  buildMihForecast
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
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 0.001, `${label}: ${actual} != ${expected}`);

const TODAY = "2026-11-28";
const SCHEDULE = {
  prepStart: "2026-11-05",
  brrEnd: "2026-11-20",
  mboEnd: "2026-11-24",
  mainStart: "2026-12-01",
  mainEnd: "2026-12-01",
  oqcStart: "2026-12-02",
  oqcEnd: "2026-12-02",
  etd: "2026-12-03",
  mih: "2026-12-05",
  pbr: "2026-12-09"
};

/** One day per remaining gate: gates that are left always fit the week. */
const QUICK_CYCLE = {
  byGate: {
    main: { median: 1, samples: 3 },
    oqc: { median: 1, samples: 3 },
    ship: { median: 1, samples: 3 },
    mih: { median: 1, samples: 3 }
  },
  median: 1,
  samples: 12,
  basis: "history"
};

/** A line that is on plan unless a case overrides a field. */
const entry = (over = {}) => ({
  projectId: "PRJ-A",
  model: "X4151",
  phase: "EVT",
  lineKey: "ME11-RHS",
  config: "ME11",
  side: "RHS",
  programStatus: "On Track",
  plannedMih: "2026-12-05",
  schedule: SCHEDULE,
  gates: {
    prep: { status: "Approved" },
    bbr: { status: "Approved" },
    brr: { status: "Approved" },
    mbo: { status: "Approved" },
    main: { status: "In Review" },
    oqc: { status: "Pending" },
    ship: { status: "Pending" },
    mih: { status: "Pending" }
  },
  openTasks: [],
  plannedQty: 1000,
  builtQty: 900,
  ...over
});

const run = (entries, cycle = QUICK_CYCLE, options = {}) =>
  mihRiskForecast(entries, { today: TODAY, cycle, ...options });

check("the forecast covers the eight gates before MIH and not PBR", () => {
  deep(
    MIH_FORECAST_GATES.map((gate) => gate.id),
    ["prep", "bbr", "brr", "mbo", "main", "oqc", "ship", "mih"]
  );
});

check("cycle time is the median stage from the approvals on file", () => {
  const gateRecords = {
    "PRJ-A": {
      "ME11-RHS": {
        prep: { status: "Approved", approvers: [{ decision: "Approved", updatedAt: "2026-10-01" }] },
        bbr: { status: "Approved", approvers: [{ decision: "Approved", updatedAt: "2026-10-04" }] },
        brr: { status: "Approved", approvers: [{ decision: "Approved", updatedAt: "2026-10-08" }] },
        mbo: { status: "Approved", approvers: [{ decision: "Approved", updatedAt: "2026-10-12" }] }
      }
    }
  };
  const cycle = historicalGateCycleDays(gateRecords, [{ projectId: "PRJ-A", lineKey: "ME11-RHS" }], {
    today: TODAY
  });
  equal(cycle.basis, "history");
  equal(cycle.samples, 3);
  equal(cycle.byGate.bbr.median, 3);
  equal(cycle.byGate.brr.median, 4);
  equal(cycle.byGate.mbo.median, 4);
  equal(cycle.median, 4);
});

check("no approved stage pairs reads as no history, not a default cycle", () => {
  const cycle = historicalGateCycleDays({}, [{ projectId: "PRJ-A", lineKey: "ME11-RHS" }], {
    today: TODAY
  });
  equal(cycle.basis, "none");
  equal(cycle.samples, 0);
  equal(cycle.median, null);
});

check("same-day approvals are a bulk sign-off, not a zero-day stage", () => {
  const gateRecords = {
    "PRJ-A": {
      "ME11-RHS": {
        prep: { status: "Approved", approvers: [{ decision: "Approved", updatedAt: "2026-11-20" }] },
        bbr: { status: "Approved", approvers: [{ decision: "Approved", updatedAt: "2026-11-20" }] },
        brr: { status: "Approved", approvers: [{ decision: "Approved", updatedAt: "2026-11-20" }] }
      }
    }
  };
  const cycle = historicalGateCycleDays(gateRecords, [{ projectId: "PRJ-A", lineKey: "ME11-RHS" }], {
    today: TODAY
  });
  equal(cycle.samples, 0, "stages stamped the same day carry no duration");
  equal(cycle.basis, "none");
  equal(cycle.median, null);
});

check("an on-plan line slips nothing and reads low risk", () => {
  const out = run([entry()]);
  const line = out.lines[0];
  equal(line.slipDays, 0);
  equal(line.predictedMih, "2026-12-05");
  equal(line.risk, "low");
  deep(line.drivers, []);
  equal(line.daysToMih, 7);
  equal(line.gatesApproved, 4);
  equal(line.nextGate.code, "G5");
});

check("a gate past the date its signature was needed is the first driver", () => {
  const out = run([
    entry({ schedule: { ...SCHEDULE, mainEnd: "2026-11-20" } })
  ]);
  const line = out.lines[0];
  const gates = line.drivers.find((driver) => driver.key === "gates");
  assert.ok(gates, "an overdue gate must be a driver");
  equal(gates.days, 8);
  assert.match(gates.detail, /G5 Main Build/);
  equal(line.slipDays, 8);
  equal(line.predictedMih, "2026-12-13");
  equal(line.risk, "medium");
});

check("late and blocked tasks cost days, capped", () => {
  const overdue = Array.from({ length: 12 }, (_, index) => ({
    id: `T-${index}`,
    status: "In Progress",
    dueDate: "2026-11-20"
  }));
  const blocked = [
    { id: "T-B1", status: "Blocked", dueDate: "2026-12-04" },
    { id: "T-B2", status: "Blocked", dueDate: "" }
  ];
  const out = run([entry({ openTasks: [...overdue, ...blocked] })]);
  const line = out.lines[0];
  const tasks = line.drivers.find((driver) => driver.key === "tasks");
  assert.ok(tasks, "late work must be a driver");
  equal(tasks.days, 10, "12 late + 2 blocked (2 days each) is capped at 10");
  equal(line.overdueTasks, 12);
  equal(line.openTasks, 14);
  assert.match(tasks.detail, /14 open on the program, 2 of them blocked/);
  equal(line.slipDays, 10);
});

check("a build behind the share of its window spent costs days", () => {
  const out = run([entry({ builtQty: 500 })]);
  const line = out.lines[0];
  const build = line.drivers.find((driver) => driver.key === "build");
  assert.ok(build, "a build behind the window must be a driver");
  equal(build.days, 2);
  near(line.progressPct, 50, "progress");
  near(line.windowSpentPct, (23 / 30) * 100, "window share spent");
  equal(line.slipDays, 2);
  equal(line.risk, "low");
});

check("remaining gates longer than the calendar left cost the shortfall", () => {
  const slow = {
    byGate: {
      main: { median: 3, samples: 4 },
      oqc: { median: 3, samples: 4 },
      ship: { median: 3, samples: 4 },
      mih: { median: 3, samples: 4 }
    },
    median: 3,
    samples: 16,
    basis: "history"
  };
  const out = run([entry()], slow);
  const cycle = out.lines[0].drivers.find((driver) => driver.key === "cycle");
  assert.ok(cycle, "four gates at 3 days each cannot fit a week");
  equal(cycle.days, 5, "12 days of gate work against 7 days left");
  assert.match(cycle.detail, /12d of gate work at the 3d median stage/);
  equal(out.lines[0].cycleBasis, "history");
  equal(out.lines[0].slipDays, 5);
});

check("with no history the shortfall is measured from the plan stage length", () => {
  const out = run([entry()], { byGate: {}, median: null, samples: 0, basis: "none" });
  const cycle = out.lines[0].drivers.find((driver) => driver.key === "cycle");
  assert.ok(cycle, "the plan stage length must still be weighed");
  equal(cycle.days, 8, "4 gates of 3.75 plan days against 7 days left");
  assert.match(cycle.detail, /the plan's own stage length/);
  equal(out.lines[0].cycleBasis, "plan");
});

check("a blocked program is high risk even with no slip", () => {
  const out = run([entry({ programStatus: "Blocked" })]);
  equal(out.lines[0].slipDays, 0);
  equal(out.lines[0].risk, "high");
  equal(run([entry({ programStatus: "At Risk" })]).lines[0].risk, "medium");
});

check("a line with no MIH date is unknown, not on time", () => {
  const out = run([entry({ plannedMih: "", schedule: {} })]);
  equal(out.lines[0].risk, "unknown");
  equal(out.lines[0].predictedMih, "");
  equal(out.lines[0].daysToMih, null);
  equal(out.summary.dated, 0);
});

check("the summary counts the bands and sorts the worst line first", () => {
  const out = run([
    entry(),
    entry({ lineKey: "ME11-LHS", side: "LHS", programStatus: "Blocked" }),
    entry({ lineKey: "ME12-RHS", config: "ME12", schedule: { ...SCHEDULE, mainEnd: "2026-11-21" } })
  ]);
  equal(out.summary.lines, 3);
  equal(out.summary.high, 1);
  equal(out.summary.medium, 1);
  equal(out.summary.low, 1);
  equal(out.summary.atRisk, 2);
  equal(out.summary.totalSlip, 7);
  equal(out.summary.averageSlip, 2.3);
  equal(out.lines[0].risk, "high");
  equal(out.lines[1].slipDays, 7);
  equal(out.summary.nextMih, "2026-12-05");
});

check("capacity flags owners against an explicit rate", () => {
  const out = capacityForecast(
    [
      {
        memberId: "TM-1",
        name: "Alice",
        role: "NPI Engineer",
        load: 40,
        openTasks: [
          { dueDate: "2026-11-20" },
          { dueDate: "2026-11-25" },
          { dueDate: "2026-12-04" }
        ],
        signOffs: [{ dueIso: "2026-11-01" }]
      },
      { memberId: "TM-2", name: "Bob", load: 6, openTasks: [{ dueDate: "2026-12-04" }], signOffs: [] },
      { memberId: "TM-3", name: "Cara", load: 26, openTasks: [], signOffs: [] },
      { memberId: "TM-4", name: "Dan", load: 0, openTasks: [], signOffs: [] }
    ],
    { today: TODAY }
  );
  const byName = Object.fromEntries(out.owners.map((owner) => [owner.name, owner]));
  equal(byName.Alice.status, "over");
  equal(byName.Alice.overdue, 3);
  equal(byName.Alice.weeksToClear, 5);
  equal(byName.Alice.capacity, 32);
  equal(byName.Bob.status, "ok");
  equal(byName.Cara.status, "tight");
  equal(byName.Dan.status, "idle");
  deep(out.owners.map((owner) => owner.name), ["Alice", "Cara", "Bob", "Dan"]);
  equal(out.summary.over, 1);
  equal(out.summary.tight, 1);
  equal(out.summary.idle, 1);
  equal(out.summary.totalLoad, 72);
  equal(out.summary.overdue, 3);
  equal(out.summary.weeksToClear, 9);
  deep(out.summary.constrained, ["Alice"]);
});

check("the assembled forecast reads built units, program tasks and gates", () => {
  const out = buildMihForecast(
    {
      projects: [
        {
          id: "PRJ-A",
          model: "X4151",
          phase: "EVT",
          status: "On Track",
          buildMatrix: [{ config: "ME11", side: "RHS" }]
        }
      ],
      tasks: [
        { id: "T1", projectId: "PRJ-A", status: "In Progress", dueDate: "2026-11-20" },
        { id: "T2", projectId: "PRJ-A", status: "Done", dueDate: "2026-11-20" },
        { id: "T3", projectId: "PRJ-B", status: "In Progress", dueDate: "2026-11-20" }
      ],
      gateRecords: {
        "PRJ-A": { "ME11-RHS": { prep: { status: "Approved" }, bbr: { status: "Approved" } } }
      },
      productionRecords: [
        { model: "X4151", config: "ME11", side: "RHS", input: 600 },
        { model: "X4151", config: "ME11", side: "LHS", input: 400 }
      ],
      teamMembers: [{ id: "TM-1", name: "Ann", role: "NPI Engineer" }],
      scheduleOverrides: {}
    },
    {
      today: TODAY,
      variantsFor: () => [
        { key: "ME11-RHS", config: "ME11", side: "RHS", fatpMih: "2026-12-05", qty: 1000 }
      ],
      scheduleFor: () => SCHEDULE,
      workloadFor: () => ({
        load: 3,
        openTasks: [{ dueDate: "2026-11-20" }],
        signOffs: [],
        lines: 1
      })
    }
  );

  equal(out.lines.length, 1);
  const line = out.lines[0];
  equal(line.builtQty, 600, "only the line's own config and side counts as built");
  equal(line.plannedQty, 1000);
  equal(line.openTasks, 1, "done tasks and other programs' tasks stay out");
  equal(line.nextGate.code, "G3");
  equal(out.cycle.basis, "none", "two approvals with no dates make no stage sample");
  equal(out.capacity.owners.length, 1);
  equal(out.capacity.owners[0].overdue, 1);
  equal(out.capacity.owners[0].load, 3);
});

check("the forecast helpers do not mutate their inputs", () => {
  const entries = [entry({ builtQty: 500 })];
  const before = JSON.stringify(entries);
  run(entries);
  equal(JSON.stringify(entries), before);
  const rows = [{ name: "Alice", load: 40, openTasks: [], signOffs: [] }];
  const rowsBefore = JSON.stringify(rows);
  capacityForecast(rows, { today: TODAY });
  equal(JSON.stringify(rows), rowsBefore);
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} MIH forecast checks passed.\n`);
process.exit(failed ? 1 : 0);
