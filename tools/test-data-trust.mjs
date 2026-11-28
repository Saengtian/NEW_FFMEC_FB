/**
 * Checks for the data-trust and data-quality layer:
 *
 *  - a KPI source is fresh for a week, aging for a month and stale after that,
 *    and a source with no rows says so instead of looking healthy
 *  - as-of, age and coverage are derived from the newest usable day, and an
 *    unusable date is not silently read as today
 *  - production feeds FPY, FY and efficiency from one set of runs, so all three
 *    tiles carry the same verdict; claims and saving name their own source
 *  - the queue names a refused production row, a model missing from Product
 *    Master, a Cpk reading whose spec is gone, a program with no plan or no
 *    owner, work and dossiers that outlive their program, a claim with no FACA
 *    number, and a source nobody has fed for a month
 *  - the queue is read-only and orders blockers first
 *
 * The helpers are read straight out of Part1_Data.html — the same text
 * tools/build.mjs compiles — so the tests cannot drift from a copy of a rule.
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-data-trust.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const source = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");

const DECLARATIONS = [
  // Data-trust helpers.
  /const DATA_TRUST_FRESH_DAYS = \d+;/,
  /const DATA_TRUST_AGING_DAYS = \d+;/,
  /const DATA_QUALITY_AREAS = \{[\s\S]*?\n\};/,
  /const DATA_QUALITY_SEVERITY_ORDER = \[[^\]]*\];/,
  /const DATA_QUALITY_SEVERITY_LABELS = \{[\s\S]*?\n\};/,
  /function dataTrustDay\([\s\S]*?\n}/,
  /function dataTrustDayText\([\s\S]*?\n}/,
  /function dataTrustStamp\([\s\S]*?\n}/,
  /function dataTrustDaysBetween\([\s\S]*?\n}/,
  /function dataTrustLatestDay\([\s\S]*?\n}/,
  /function dataTrustFreshness\([\s\S]*?\n}/,
  /function dataTrustTone\([\s\S]*?\n}/,
  /function dataTrustBadgeText\([\s\S]*?\n}/,
  /function dataTrustBadgeClass\([\s\S]*?\n}/,
  /function kpiDataTrust\([\s\S]*?\n}/,
  /function dataQualityIssue\([\s\S]*?\n}/,
  /function dataQualityQueue\([\s\S]*?\n}/,
  // The production rules the queue judges a row with.
  /const PRODUCTION_RECORD_ISSUES = \{[\s\S]*?\n\};/,
  /function computeProductionMetrics\([\s\S]*?\n}/,
  /function productionLineKey\([\s\S]*?\n}/,
  /function productionRecordGoodUnits\([\s\S]*?\n}/,
  /function parseIsoDate\([\s\S]*?\n}/,
  /function isoDateParts\([\s\S]*?\n}/,
  /function normalizeProductionDate\([\s\S]*?\n}/,
  /function productionRecordIssues\([\s\S]*?\n}/,
  /function productionRecordBlockingIssues\([\s\S]*?\n}/
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
    "return { DATA_TRUST_FRESH_DAYS, DATA_TRUST_AGING_DAYS, DATA_QUALITY_AREAS, " +
    "DATA_QUALITY_SEVERITY_ORDER, DATA_QUALITY_SEVERITY_LABELS, dataTrustDay, dataTrustDayText, " +
    "dataTrustStamp, dataTrustDaysBetween, dataTrustLatestDay, dataTrustFreshness, dataTrustTone, " +
    "dataTrustBadgeText, dataTrustBadgeClass, kpiDataTrust, dataQualityIssue, dataQualityQueue };"
)();

const {
  DATA_TRUST_FRESH_DAYS,
  DATA_TRUST_AGING_DAYS,
  DATA_QUALITY_SEVERITY_ORDER,
  dataTrustDay,
  dataTrustDayText,
  dataTrustStamp,
  dataTrustDaysBetween,
  dataTrustLatestDay,
  dataTrustFreshness,
  dataTrustTone,
  dataTrustBadgeText,
  kpiDataTrust,
  dataQualityQueue
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

/** A production row that passes every rule unless a case overrides a field. */
const record = (overrides = {}) => ({
  id: "REC-T1",
  model: "X4151",
  phase: "EVT",
  station: "Fan Assembly",
  config: "ME11",
  side: "RHS",
  date: "2026-11-20",
  input: 500,
  plannedTimeHr: 1.5,
  defectItems: [{ id: "d1", mode: "Z Para OOS", falloutQty: 12, salvageQty: 8 }],
  downtimeEvents: [{ id: "dt1", category: "Equipment / Machine", reason: "Fixture", durationMin: 8 }],
  ...overrides
});

const TODAY = "2026-11-28";

check("a source is fresh for a week, aging for a month, stale after that", () => {
  const at = (asOf, today) => dataTrustFreshness({ asOf, rows: 3, today }).status;
  equal(at("2026-11-25", TODAY), "fresh");
  equal(at("2026-11-14", TODAY), "aging");
  equal(at("2026-09-01", TODAY), "stale");
  equal(DATA_TRUST_FRESH_DAYS, 7);
  equal(DATA_TRUST_AGING_DAYS, 30);
});

check("a source with no rows is empty, not fresh", () => {
  const empty = dataTrustFreshness({ asOf: "2026-11-27", rows: 0, today: TODAY });
  equal(empty.status, "empty");
  equal(empty.coverageText, "no rows in scope");
  equal(dataTrustBadgeText(empty), "no data");
  equal(dataTrustTone("empty"), "neutral");
});

check("rows with no date are undated rather than current", () => {
  const undated = dataTrustFreshness({ asOf: "", rows: 4, today: TODAY });
  equal(undated.status, "undated");
  equal(undated.asOfText, "no source date");
  equal(dataTrustBadgeText(undated), "no date");
  equal(dataTrustTone("undated"), "neutral");
});

check("age and coverage come from the newest usable day", () => {
  equal(dataTrustDay("2026-1-5"), "2026-01-05");
  equal(dataTrustDay("2026-11-20T08:30:00.000Z"), "2026-11-20");
  equal(dataTrustDay("not a date"), "");
  equal(dataTrustDay("2026-13-01"), "");
  equal(dataTrustDayText("2026-11-20"), "11/20");
  equal(dataTrustLatestDay(["2026-11-20", "", "2026-11-27", "2026-1-3"]), "2026-11-27");
  equal(dataTrustDaysBetween("2026-11-20", "2026-11-28"), 8);
  equal(dataTrustDaysBetween("2026-11-28", "2026-11-20"), -8);
  equal(dataTrustDaysBetween("", TODAY), null);
  equal(dataTrustStamp("2026-11-28T09:12:44.000Z"), "11/28 09:12");
  equal(dataTrustStamp(null), "");

  const aged = dataTrustFreshness({ asOf: "2026-11-14", rows: 350, today: TODAY });
  equal(aged.daysOld, 14);
  equal(aged.coverageText, "350 rows");
  equal(dataTrustBadgeText(aged), "aging · 14d");
  equal(dataTrustTone("aging"), "warn");

  const stale = dataTrustFreshness({ asOf: "2026-09-01", rows: 1, today: TODAY });
  equal(dataTrustBadgeText(stale), `stale · ${stale.daysOld}d`);
  equal(dataTrustTone("stale"), "bad");
  equal(dataTrustTone("fresh"), "good");
});

check("a record dated after today is future, not fresh", () => {
  const ahead = dataTrustFreshness({ asOf: "2027-01-27", rows: 86, today: TODAY });
  equal(ahead.status, "future");
  equal(ahead.daysOld, -60);
  equal(dataTrustBadgeText(ahead), "future · 60d ahead");
  equal(dataTrustTone("future"), "bad");
});

check("production backs FPY, FY and efficiency with one verdict", () => {
  const trust = kpiDataTrust({
    records: [record({ date: "2026-11-18" }), record({ id: "REC-T2", date: "2026-11-24" })],
    feedbackRows: [
      { category: "Claim", feedbackDate: "2026-10-02" },
      { category: "FA", feedbackDate: "2026-11-26" }
    ],
    savingRows: [{ fyTarget: "FY2026" }, { fyTarget: "FY2026", updatedAt: "2026-11-27T04:00:00.000Z" }],
    today: TODAY
  });
  equal(trust.fpy, trust.fy, "the three production tiles must share one source object");
  equal(trust.fy, trust.eff);
  equal(trust.fpy.asOf, "2026-11-24");
  equal(trust.fpy.rows, 2);
  equal(trust.fpy.source, "Production records");
  equal(trust.claims.asOf, "2026-11-26");
  equal(trust.claims.rows, 2);
  equal(trust.claims.source, "Customer feedback");
  equal(trust.saving.source, "Cost-saving initiatives");
  equal(trust.saving.asOf, "2026-11-27");
});

check("a cost initiative with no date is reported undated, not current", () => {
  const trust = kpiDataTrust({
    records: [],
    feedbackRows: [],
    savingRows: [{ fyTarget: "FY2026" }],
    today: TODAY
  });
  equal(trust.saving.status, "undated");
  equal(dataTrustBadgeText(trust.saving), "FY tag");
  equal(trust.fpy.status, "empty");
  equal(trust.claims.status, "empty");
});

const PRODUCTS = [
  { id: "PRD-X4151", model: "X4151", familyGroup: 'MB14"' },
  { id: "PRD-X3082", model: "X3082", familyGroup: 'MB14"' }
];
const CLEAN_PROGRAM = {
  id: "PRJ-X4151",
  model: "X4151",
  owner: "Patcharapong J.",
  buildMatrix: [{ config: "ME11", side: "RHS", total: 662 }]
};

check("a refused production row is named as a blocker", () => {
  const broken = record({ id: "REC-BAD", good: 900 });
  const queue = dataQualityQueue(
    { productionRecords: [broken], projects: [CLEAN_PROGRAM], products: PRODUCTS },
    { today: TODAY }
  );
  const blocker = queue.issues.find((issue) => issue.severity === "blocker");
  assert.ok(blocker, "an impossible good quantity must be queued");
  equal(blocker.area, "production");
  equal(blocker.view, "production");
  assert.match(blocker.title, /X4151 · 11\/20 · Fan Assembly/);
  assert.ok(blocker.detail.length > 0, "the blocker must say which rule refused the row");
  equal(queue.summary.blocker, 1);
});

check("a model missing from Product Master is one aggregated issue", () => {
  const queue = dataQualityQueue(
    {
      productionRecords: [record({ model: "X9999" }), record({ id: "REC-T2", model: "X9999" })],
      projects: [CLEAN_PROGRAM],
      products: PRODUCTS
    },
    { today: TODAY }
  );
  const issues = queue.issues.filter((issue) => issue.area === "products");
  equal(issues.length, 1);
  equal(issues[0].severity, "inconsistent");
  equal(issues[0].count, 2);
  equal(issues[0].view, "setup");
  assert.match(issues[0].title, /X9999/);
});

check("a Cpk reading whose spec is gone cannot pass silently", () => {
  const queue = dataQualityQueue(
    {
      cpkRecords: [
        { specId: "SPEC-MISSING", date: "2026-11-20" },
        { specId: "SPEC-MISSING", date: "2026-11-18" }
      ],
      masterSpecs: [{ id: "SPEC-OK" }],
      projects: [CLEAN_PROGRAM],
      products: PRODUCTS
    },
    { today: TODAY }
  );
  const issue = queue.issues.find((item) => item.area === "cpk" && item.title.includes("SPEC-MISSING"));
  assert.ok(issue, "a reading with no spec must be queued");
  equal(issue.count, 2);
  equal(issue.view, "cpk");
});

check("a program with no plan or no owner is queued", () => {
  const queue = dataQualityQueue(
    {
      projects: [
        { id: "PRJ-EMPTY", model: "X4151", owner: "Someone" },
        { id: "PRJ-ZERO", model: "X4151", owner: "Someone", buildMatrix: [{ config: "ME11", total: 0 }] },
        { id: "PRJ-ORPHAN", model: "X3082" }
      ],
      products: PRODUCTS
    },
    { today: TODAY }
  );
  const titles = queue.issues.filter((issue) => issue.area === "programs").map((issue) => issue.title);
  assert.ok(titles.includes("PRJ-EMPTY has no build matrix"), titles.join(" | "));
  assert.ok(titles.includes("PRJ-ZERO plans zero units"), titles.join(" | "));
  assert.ok(titles.includes("PRJ-ORPHAN has no owner"), titles.join(" | "));
});

check("work and dossiers that outlive their program are queued", () => {
  const queue = dataQualityQueue(
    {
      projects: [CLEAN_PROGRAM],
      tasks: [{ id: "TSK-1", projectId: "PRJ-GONE" }, { id: "TSK-2", projectId: "PRJ-GONE" }],
      gateRecords: { "PRJ-GONE": { "ME11-RHS": {} }, "PRJ-X4151": { "ME11-RHS": {} } },
      products: PRODUCTS
    },
    { today: TODAY }
  );
  const task = queue.issues.find((issue) => issue.area === "tasks");
  equal(task.count, 2);
  assert.match(task.title, /PRJ-GONE/);
  const dossiers = queue.issues.find((issue) => issue.area === "gates");
  equal(dossiers.count, 1);
  equal(dossiers.view, "gates");
});

check("a claim with no FACA number is queued, a claim with one is not", () => {
  const queue = dataQualityQueue(
    {
      projects: [CLEAN_PROGRAM],
      products: PRODUCTS,
      customerFeedback: [
        { category: "Claim", facaNo: "", feedbackDate: "2026-11-20" },
        { category: "Claim", facaNo: "FACA-2601-01", feedbackDate: "2026-11-20" },
        { category: "FA", facaNo: "", feedbackDate: "2026-11-20" }
      ]
    },
    { today: TODAY }
  );
  const claims = queue.issues.filter((issue) => issue.area === "feedback");
  equal(claims.length, 1);
  equal(claims[0].count, 1);
  equal(claims[0].severity, "missing");
});

check("a source nobody has fed for a month is flagged stale, a current one is not", () => {
  const staleQueue = dataQualityQueue(
    {
      projects: [CLEAN_PROGRAM],
      products: PRODUCTS,
      productionRecords: [record({ date: "2026-09-01" })]
    },
    { today: TODAY }
  );
  const stale = staleQueue.issues.find((issue) => issue.severity === "stale");
  assert.ok(stale, "a two-month-old production source must be flagged");
  equal(stale.title, "Production records are 88 days old");

  const freshQueue = dataQualityQueue(
    {
      projects: [CLEAN_PROGRAM],
      products: PRODUCTS,
      productionRecords: [record({ date: "2026-11-27" })]
    },
    { today: TODAY }
  );
  equal(freshQueue.issues.filter((issue) => issue.severity === "stale").length, 0);
});

check("a run dated after today is queued as inconsistent", () => {
  const queue = dataQualityQueue(
    {
      projects: [CLEAN_PROGRAM],
      products: PRODUCTS,
      productionRecords: [record({ date: "2026-11-27" }), record({ id: "REC-T2", date: "2027-01-27" })],
      cpkRecords: [{ specId: "SPEC-A", date: "2027-01-10" }],
      masterSpecs: [{ id: "SPEC-A" }]
    },
    { today: TODAY }
  );
  const production = queue.issues.find((issue) => issue.title === "Production records include 1 date after today");
  assert.ok(production, "a future-dated run must be queued");
  equal(production.severity, "inconsistent");
  assert.match(production.detail, /01\/27/);
  const cpk = queue.issues.find((issue) => issue.title === "Cpk readings include 1 date after today");
  assert.ok(cpk, "a future-dated Cpk reading must be queued");
  equal(queue.issues.filter((issue) => issue.severity === "stale").length, 0);
});

check("a clean workspace produces no queue entries", () => {
  const queue = dataQualityQueue(
    {
      projects: [CLEAN_PROGRAM],
      products: PRODUCTS,
      productionRecords: [record({ date: "2026-11-27" })],
      cpkRecords: [{ specId: "SPEC-OK", date: "2026-11-27" }],
      masterSpecs: [{ id: "SPEC-OK" }],
      tasks: [{ id: "TSK-1", projectId: "PRJ-X4151" }],
      gateRecords: { "PRJ-X4151": { "ME11-RHS": {} } },
      customerFeedback: [],
      costProjects: []
    },
    { today: TODAY }
  );
  deep(queue.issues, []);
  deep(queue.summary, { total: 0, blocker: 0, inconsistent: 0, missing: 0, stale: 0 });
});

check("the queue is read-only and orders blockers first", () => {
  const workspace = {
    projects: [{ id: "PRJ-EMPTY", model: "X4151", owner: "Someone" }, CLEAN_PROGRAM],
    products: PRODUCTS,
    productionRecords: [record({ id: "REC-BAD", good: 900 }), record({ id: "REC-STALE", date: "2026-09-01" })]
  };
  const before = JSON.stringify(workspace);
  const queue = dataQualityQueue(workspace, { today: TODAY });
  equal(JSON.stringify(workspace), before);
  assert.ok(queue.issues.length > 1);
  equal(queue.issues[0].severity, "blocker");
  assert.deepStrictEqual(
    [...new Set(queue.issues.map((issue) => issue.severity))],
    DATA_QUALITY_SEVERITY_ORDER.filter((severity) =>
      queue.issues.some((issue) => issue.severity === severity)
    )
  );
  equal(queue.summary.total, queue.issues.length);
  equal(
    queue.summary.blocker + queue.summary.inconsistent + queue.summary.missing + queue.summary.stale,
    queue.summary.total
  );
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} data-trust checks passed.\n`);
process.exit(failed ? 1 : 0);
