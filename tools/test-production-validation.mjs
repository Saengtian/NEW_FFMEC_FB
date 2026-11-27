/**
 * Checks for the shared production-record rules.
 *
 * The form, the CSV / hydration loader and the save handler all judge a row with
 * `productionRecordIssues` / `sanitizeProductionRecords`, so these cases are the
 * contract every entry point has to meet:
 *
 *  - a good quantity above the input, or rejects that would make good negative,
 *    is refused
 *  - a non-positive input or planned time is refused (every yield and UPH
 *    divides by them)
 *  - a negative downtime is repairable: the row is kept with the value zeroed
 *  - the same date × line × station cannot be counted twice — the duplicate is
 *    refused in the form and dropped on load, and editing a row never clashes
 *    with itself
 *  - the seeded demo records pass the same rules, so the app does not greet a
 *    fresh workspace by dropping its own data
 *
 * The helpers are read straight out of Part1_Data.html — the same text
 * tools/build.mjs compiles — so the tests cannot drift from a copy of a rule.
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-production-validation.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const source = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");

/** Top-level declarations the rules are made of. Functions end at column 0. */
const DECLARATIONS = [
  /const PRODUCTION_RECORD_ISSUES = \{[\s\S]*?\n\};/,
  /function computeProductionMetrics\([\s\S]*?\n}/,
  /function productionLineKey\([\s\S]*?\n}/,
  /function productionRecordLabel\([\s\S]*?\n}/,
  /function productionRecordGoodUnits\([\s\S]*?\n}/,
  /function productionRecordIssues\([\s\S]*?\n}/,
  /function productionRecordBlockingIssues\([\s\S]*?\n}/,
  /function clampProductionDowntime\([\s\S]*?\n}/,
  /function createColumnFinder\([\s\S]*?\n}/,
  /function normalizeProductionDate\([\s\S]*?\n}/,
  /function productionRecordImportPlan\([\s\S]*?\n}/,
  /function sanitizeProductionRecords\([\s\S]*?\n}/,
  /function parseIsoDate\([\s\S]*?\n}/,
  /function isoDateParts\([\s\S]*?\n}/,
  /function formatMonthDay\([\s\S]*?\n}/,
  /function productionDropReport\([\s\S]*?\n}/,
  /function productionDropRowLines\([\s\S]*?\n}/,
  /function productionDropMessage\([\s\S]*?\n}/,
  /function productionDropSummary\([\s\S]*?\n}/,
  /const INITIAL_PRODUCTION_RECORDS = \[[\s\S]*?\n\];/,
];

const pieces = DECLARATIONS.map((pattern) => {
  const match = source.match(pattern);
  if (!match) {
    console.error(`Part1_Data.html no longer declares ${pattern} — update this test, the rule moved.`);
    process.exit(1);
  }
  return match[0];
});

const api = new Function(
  `"use strict";\n${pieces.join("\n")}\n` +
    "return { PRODUCTION_RECORD_ISSUES, computeProductionMetrics, productionLineKey, productionRecordLabel, " +
    "productionRecordGoodUnits, productionRecordIssues, productionRecordBlockingIssues, clampProductionDowntime, " +
    "sanitizeProductionRecords, productionDropReport, productionDropRowLines, productionDropMessage, " +
    "productionDropSummary, productionRecordImportPlan, normalizeProductionDate, INITIAL_PRODUCTION_RECORDS };"
)();

const {
  PRODUCTION_RECORD_ISSUES,
  computeProductionMetrics,
  productionLineKey,
  productionRecordLabel,
  productionRecordGoodUnits,
  productionRecordIssues,
  productionRecordBlockingIssues,
  productionDropReport,
  productionDropMessage,
  productionDropSummary,
  productionRecordImportPlan,
  normalizeProductionDate,
  clampProductionDowntime,
  sanitizeProductionRecords,
  INITIAL_PRODUCTION_RECORDS,
} = api;

const codes = (issues) => issues.map((issue) => issue.code);

/** A row that describes a real run unless a case overrides a field. */
const record = (overrides = {}) => ({
  id: "REC-TEST-1",
  model: "X4151",
  phase: "EVT",
  station: "Fan Assembly",
  config: "ME11",
  side: "RHS",
  date: "2026-11-20",
  input: 500,
  plannedTimeHr: 1.5,
  defectItems: [
    { id: "d1", mode: "Z Para OOS", falloutQty: 12, salvageQty: 8 },
  ],
  downtimeEvents: [{ id: "dt1", category: "Equipment / Machine", reason: "Fixture", durationMin: 8 }],
  ...overrides,
});

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (error) {
    results.push({ label, ok: false, message: error.message });
  }
}

// ---------------------------------------------------------------------------

check("the seeded demo records pass the rules and are unique", () => {
  assert.equal(INITIAL_PRODUCTION_RECORDS.length > 0, true);
  INITIAL_PRODUCTION_RECORDS.forEach((row) => {
    const issues = productionRecordBlockingIssues(row, null, null);
    assert.deepEqual(issues.map((issue) => issue.code), [], `${row.id} is rejected by its own seed`);
  });
  const cleaned = sanitizeProductionRecords(INITIAL_PRODUCTION_RECORDS);
  assert.equal(cleaned.dropped.length, 0, `the seed loses ${cleaned.dropped.length} row(s) on load`);
  assert.equal(cleaned.records.length, INITIAL_PRODUCTION_RECORDS.length);
  assert.equal(cleaned.repaired, 0);
});

check("a well-formed row has no issues at all", () => {
  assert.deepEqual(productionRecordIssues(record()), []);
  assert.deepEqual(productionRecordBlockingIssues(record()), []);
});

check("an input of zero or a missing input is refused", () => {
  [0, -5, "", null, undefined, "abc"].forEach((input) => {
    const issues = productionRecordIssues(record({ input }));
    assert.deepEqual(codes(issues), [PRODUCTION_RECORD_ISSUES.INPUT_NOT_POSITIVE], `input=${String(input)}`);
    assert.equal(issues[0].severity, "block");
    assert.equal(issues[0].field, "input");
    assert.match(issues[0].message, /above zero/);
  });
});

check("planned time of zero or less is refused", () => {
  [0, -1, "", null, "n/a"].forEach((plannedTimeHr) => {
    const issues = productionRecordIssues(record({ plannedTimeHr }));
    assert.deepEqual(codes(issues), [PRODUCTION_RECORD_ISSUES.PLANNED_HOURS_MISSING], `planned=${String(plannedTimeHr)}`);
    assert.equal(issues[0].field, "plannedTimeHr");
    assert.match(issues[0].message, /greater than zero/);
  });
});

check("good units above the input are refused, from a reading or from rejects", () => {
  const claimed = productionRecordIssues(record({ goodQty: 501 }));
  assert.deepEqual(codes(claimed), [PRODUCTION_RECORD_ISSUES.GOOD_EXCEEDS_INPUT]);
  assert.match(claimed[0].message, /cannot exceed the input \(500\)/);

  // A row that carries its own good count is judged on it, whatever the defects say.
  assert.equal(productionRecordGoodUnits(record({ good: 480 })), 480);
  assert.equal(productionRecordGoodUnits(record({ finalGood: 0 })), 0);
  assert.equal(productionRecordGoodUnits(record()), null);

  const rejected = productionRecordIssues(
    record({ input: 10, defectItems: [{ id: "d1", mode: "Crack", falloutQty: 12, salvageQty: 0 }] })
  );
  assert.deepEqual(codes(rejected), [PRODUCTION_RECORD_ISSUES.GOOD_EXCEEDS_INPUT]);
  assert.match(rejected[0].message, /Rejects \(12\) exceed the input \(10\)/);

  // Salvage can never lift good above the input: it is capped at the fallout.
  const salvaged = productionRecordIssues(
    record({ input: 100, defectItems: [{ id: "d1", mode: "Crack", falloutQty: 5, salvageQty: 999 }] })
  );
  assert.deepEqual(codes(salvaged), []);
});

check("a negative good count is refused", () => {
  const issues = productionRecordIssues(record({ goodQty: -1 }));
  assert.deepEqual(codes(issues), [PRODUCTION_RECORD_ISSUES.GOOD_NEGATIVE]);
  assert.equal(issues[0].field, "good");
});

check("negative downtime is repairable, not refused", () => {
  const row = record({
    downtimeEvents: [
      { id: "dt1", category: "Equipment / Machine", reason: "Swap", durationMin: -12 },
      { id: "dt2", category: "Material / IQC Hold", reason: "Wait", durationMin: 8 },
    ],
  });
  const issues = productionRecordIssues(row);
  assert.deepEqual(codes(issues), [PRODUCTION_RECORD_ISSUES.DOWNTIME_NEGATIVE]);
  assert.equal(issues[0].severity, "clamp");
  assert.match(issues[0].message, /-12 min/);
  assert.deepEqual(productionRecordBlockingIssues(row), [], "a repairable issue does not block the save");

  const clamped = clampProductionDowntime(row);
  assert.equal(clamped.downtimeEvents[0].durationMin, 0);
  assert.equal(clamped.downtimeEvents[1].durationMin, 8);
  assert.equal(row.downtimeEvents[0].durationMin, -12, "the original row is left alone");
  assert.equal(computeProductionMetrics(clamped).downtimeMin, 8);

  const legacy = productionRecordIssues(record({ downtimeEvents: [], downtimeHr: -2 }));
  assert.deepEqual(codes(legacy), [PRODUCTION_RECORD_ISSUES.DOWNTIME_NEGATIVE]);
  assert.equal(clampProductionDowntime(record({ downtimeEvents: [], downtimeHr: -2 })).downtimeHr, 0);
});

check("the same date × line × station cannot be logged twice", () => {
  const first = record();
  const second = record({ id: "REC-TEST-2" });
  const issues = productionRecordIssues(second, [first], null);
  assert.deepEqual(codes(issues), [PRODUCTION_RECORD_ISSUES.DUPLICATE_LINE]);
  assert.match(issues[0].message, /X4151 · ME11 RHS · Fan Assembly · 2026-11-20/);

  // A different side, station, date or model is a different measurement.
  assert.deepEqual(codes(productionRecordIssues(record({ side: "LHS" }), [first], null)), []);
  assert.deepEqual(codes(productionRecordIssues(record({ station: "Fan Test & Accessory" }), [first], null)), []);
  assert.deepEqual(codes(productionRecordIssues(record({ date: "2026-11-21" }), [first], null)), []);
  assert.deepEqual(codes(productionRecordIssues(record({ model: "X4152" }), [first], null)), []);

  // Editing the row that is already on file must not clash with itself.
  assert.deepEqual(codes(productionRecordIssues(first, [first], first.id)), []);
  // …but an actual second copy still does.
  assert.deepEqual(
    codes(productionRecordIssues(second, [first, second], "REC-TEST-9")),
    [PRODUCTION_RECORD_ISSUES.DUPLICATE_LINE]
  );

  // Line identity is case- and space-insensitive.
  assert.equal(
    productionLineKey(record({ config: " me11 ", side: "rhs" })),
    productionLineKey(record())
  );
  assert.equal(productionRecordLabel(first), "X4151 · ME11 RHS · Fan Assembly · 2026-11-20");
});

check("a row with no line identity at all does not collide with another", () => {
  const blank = { date: "2026-11-20", input: 10, plannedTimeHr: 1, defectItems: [], downtimeEvents: [] };
  const other = { date: "2026-11-21", input: 20, plannedTimeHr: 2, defectItems: [], downtimeEvents: [] };
  assert.deepEqual(codes(productionRecordIssues(blank, [other], null)), []);
});

check("loading a list drops the rows the KPIs cannot trust", () => {
  const good = record();
  const duplicate = record({ id: "REC-DUP" });
  const zeroHours = record({ id: "REC-NOHR", date: "2026-11-21", plannedTimeHr: 0 });
  const impossibleGood = record({ id: "REC-GOOD", date: "2026-11-22", goodQty: 900 });
  const negativeInput = record({ id: "REC-NEG", date: "2026-11-23", input: -3 });
  const negativeDowntime = record({
    id: "REC-DT",
    date: "2026-11-24",
    downtimeEvents: [{ id: "dt1", category: "Equipment / Machine", reason: "Swap", durationMin: -30 }],
  });

  const cleaned = sanitizeProductionRecords([
    good,
    duplicate,
    zeroHours,
    impossibleGood,
    negativeInput,
    negativeDowntime,
    null,
    "not a record",
  ]);

  assert.equal(cleaned.records.length, 2, "only the valid row and the repairable one survive");
  assert.deepEqual(cleaned.records.map((row) => row.id), ["REC-TEST-1", "REC-DT"]);
  assert.equal(cleaned.repaired, 1);
  assert.equal(cleaned.records[1].downtimeEvents[0].durationMin, 0, "the repairable row is saved clean");

  assert.equal(cleaned.dropped.length, 6);
  const droppedCodes = cleaned.dropped.map((entry) => codes(entry.issues));
  assert.deepEqual(droppedCodes[0], [PRODUCTION_RECORD_ISSUES.DUPLICATE_LINE]);
  assert.deepEqual(droppedCodes[1], [PRODUCTION_RECORD_ISSUES.PLANNED_HOURS_MISSING]);
  assert.deepEqual(droppedCodes[2], [PRODUCTION_RECORD_ISSUES.GOOD_EXCEEDS_INPUT]);
  assert.deepEqual(droppedCodes[3], [PRODUCTION_RECORD_ISSUES.INPUT_NOT_POSITIVE]);
  assert.deepEqual(droppedCodes[4], [PRODUCTION_RECORD_ISSUES.NOT_A_RECORD]);
  assert.deepEqual(droppedCodes[5], [PRODUCTION_RECORD_ISSUES.NOT_A_RECORD]);
  assert.deepEqual(cleaned.dropped.map((entry) => entry.index), [1, 2, 3, 4, 6, 7]);

  // Whatever the loader keeps is exactly what the form would have accepted.
  cleaned.records.forEach((row) => assert.deepEqual(productionRecordBlockingIssues(row), []));
});

check("a refused row is reported with its day, line, station and reason", () => {
  const cleaned = sanitizeProductionRecords([
    record(),
    record({ id: "REC-GOOD", date: "2026-11-22", goodQty: 900 }),
    "not a record",
  ]);
  const report = productionDropReport(cleaned.dropped);
  assert.equal(report.length, 2);

  const impossibleGood = report[0];
  assert.equal(impossibleGood.dateIso, "2026-11-22");
  assert.equal(impossibleGood.dateText, "11/22");
  assert.equal(impossibleGood.line, "X4151 · ME11 RHS");
  assert.equal(impossibleGood.station, "Fan Assembly");
  assert.deepEqual(impossibleGood.codes, [PRODUCTION_RECORD_ISSUES.GOOD_EXCEEDS_INPUT]);
  assert.match(impossibleGood.reason, /exceed/);

  // A row too broken to name a line still names a row and a reason.
  const unreadable = report[1];
  assert.equal(unreadable.line, "unidentified line");
  assert.equal(unreadable.station, "no station");
  assert.equal(unreadable.dateText, "—");
  assert.deepEqual(unreadable.codes, [PRODUCTION_RECORD_ISSUES.NOT_A_RECORD]);
});

check("the drop report is what the toast and the save summary say", () => {
  const rows = [1, 2, 3, 4, 5].map((n) =>
    record({ id: `R${n}`, date: `2026-11-2${n}`, input: 0 })
  );
  const report = productionDropReport(sanitizeProductionRecords(rows).dropped);
  assert.equal(report.length, 5);

  const message = productionDropMessage(report);
  const lines = message.split("\n");
  assert.match(lines[0], /^5 production rows rejected on load/);
  assert.equal(lines.length, 6, "headline, four rows, then the count held back");
  assert.match(lines[1], /^11\/21 · X4151 · ME11 RHS · Fan Assembly: /);
  assert.match(lines[5], /^…and 1 more$/);

  const summary = productionDropSummary(report, 3);
  assert.match(summary, /^Dropped 5 invalid production record\(s\): /);
  assert.equal(summary.includes("\n"), false, "the save summary lives on one cell");
  assert.match(summary, /more$/);
  assert.match(summary, /11\/21 · X4151 · ME11 RHS · Fan Assembly: /);

  // Nothing dropped is nothing to say.
  assert.equal(productionDropMessage([]), "");
  assert.equal(productionDropSummary([]), "");
  assert.equal(productionDropMessage(productionDropReport(sanitizeProductionRecords([record()]).dropped)), "");
});

check("a production date is read from the shapes a file writes", () => {
  assert.equal(normalizeProductionDate("2026-11-20"), "2026-11-20");
  assert.equal(normalizeProductionDate("2026-11-20T00:00:00.000Z"), "2026-11-20");
  assert.equal(normalizeProductionDate("2026/11/20"), "2026-11-20");
  assert.equal(normalizeProductionDate("11/20/2026"), "2026-11-20");
  assert.equal(normalizeProductionDate("2026-13-45"), "", "an impossible date is not read as one");
  assert.equal(normalizeProductionDate(""), "");
  assert.equal(normalizeProductionDate(null), "");
});

check("a record with no readable date is refused by every entry point", () => {
  const badDates = ["", "   ", "not a date", "2026-02-30", "11/20/2026", 20261120, null, undefined];
  badDates.forEach((date) => {
    const issues = productionRecordIssues(record({ date }), null, null);
    assert.deepEqual(
      codes(issues),
      [PRODUCTION_RECORD_ISSUES.DATE_MISSING],
      `date ${JSON.stringify(date)} should be refused`
    );
    assert.equal(issues[0].severity, "block");

    // The form's gate and the loader's filter both read this one rule.
    assert.equal(productionRecordBlockingIssues(record({ date }), [], null).length, 1);
    const cleaned = sanitizeProductionRecords([record({ date })]);
    assert.equal(cleaned.records.length, 0, "a row without a date is never kept");
    assert.deepEqual(codes(cleaned.dropped[0].issues), [PRODUCTION_RECORD_ISSUES.DATE_MISSING]);
  });

  // A real day is accepted in both ISO shapes a record may hold.
  ["2026-11-20", "2026-11-20T08:30:00.000Z"].forEach((date) => {
    assert.deepEqual(codes(productionRecordIssues(record({ date }), null, null)), []);
    assert.equal(sanitizeProductionRecords([record({ date })]).records.length, 1);
  });
});

check("the duplicate rule is keyed on the date, so a blank date cannot hide a repeat", () => {
  const dated = record({ date: "2026-11-20" });
  const sameDayOtherShape = record({ id: "REC-TEST-2", date: "2026-11-20T00:00:00.000Z" });
  assert.equal(productionLineKey(dated), productionLineKey(sameDayOtherShape), "one day is one key");

  const blank = record({ id: "REC-TEST-3", date: "" });
  assert.notEqual(productionLineKey(blank), productionLineKey(dated), "an empty date cannot key onto the dated row");

  // …which is exactly why the blank row is refused before dedupe could miss it.
  assert.deepEqual(codes(productionRecordIssues(blank, [dated], null)), [PRODUCTION_RECORD_ISSUES.DATE_MISSING]);

  // The same day written two ways is still a duplicate.
  assert.deepEqual(
    codes(productionRecordIssues(sameDayOtherShape, [dated], null)),
    [PRODUCTION_RECORD_ISSUES.DUPLICATE_LINE]
  );
});

check("a CSV import plans the rows that pass and names the ones it refuses", () => {
  const headers = ["ID", "Date", "Model", "Phase", "Side", "Config", "Station", "InputQty", "PlannedHr", "Fallout", "Salvage", "FPY", "FY"];
  const rows = [
    { ID: "", Date: "2026-11-20", Model: "X4151", Phase: "EVT", Side: "RHS", Config: "ME11", Station: "Fan Assembly", InputQty: "500", PlannedHr: "1.5", Fallout: "12", Salvage: "8", FPY: "97.6%", FY: "99.2%" },
    { ID: "", Date: "2026-11-21", Model: "X4152", Phase: "EVT", Side: "LHS", Config: "ME12", Station: "Fan Test & Accessory", InputQty: "0", PlannedHr: "2", Fallout: "0", Salvage: "0" },
    { ID: "", Date: "2026-11-20", Model: "X4151", Phase: "EVT", Side: "RHS", Config: "ME11", Station: "Fan Assembly", InputQty: "500", PlannedHr: "1.5", Fallout: "12", Salvage: "8" },
    { ID: "", Date: "", Model: "X3082", Phase: "MP", Side: "RHS", Config: "MP-POR", Station: "Fan Assembly", InputQty: "100", PlannedHr: "10", Fallout: "1", Salvage: "0" }
  ];

  const plan = productionRecordImportPlan(headers, rows, { existing: [] });
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.accepted.length, 1, "only the good row is imported");
  assert.equal(plan.rejected.length, 3);

  const good = plan.accepted[0];
  assert.equal(good.model, "X4151");
  assert.equal(good.date, "2026-11-20");
  assert.equal(good.input, 500);
  assert.equal(good.defectItems[0].falloutQty, 12);
  assert.equal(good.defectItems[0].salvageQty, 8);
  assert.deepEqual(productionRecordIssues(good, [good], null).filter((i) => i.severity !== "clamp"), []);

  // The refused rows carry the shared rule and the file line they sit on.
  assert.deepEqual(codes(plan.rejected[0].issues), [PRODUCTION_RECORD_ISSUES.INPUT_NOT_POSITIVE]);
  assert.equal(plan.rejected[0].lineNumber, 3);
  assert.deepEqual(codes(plan.rejected[1].issues), [PRODUCTION_RECORD_ISSUES.DUPLICATE_LINE]);
  assert.equal(plan.rejected[1].lineNumber, 4);
  assert.deepEqual(codes(plan.rejected[2].issues), [PRODUCTION_RECORD_ISSUES.DATE_MISSING]);

  // The toast names the line, the day, the line and the station.
  const message = productionDropMessage(productionDropReport(plan.rejected), 4);
  assert.match(message, /^3 production rows rejected on load/);
  assert.match(message, /row 3 · 11\/21 · X4152 · ME12 LHS · Fan Test & Accessory: Input quantity/);

  // A file that repeats a row already on file is refused the same way.
  const againstExisting = productionRecordImportPlan(headers, [rows[0]], { existing: [record({ date: "2026-11-20" })] });
  assert.equal(againstExisting.accepted.length, 0);
  assert.deepEqual(codes(againstExisting.rejected[0].issues), [PRODUCTION_RECORD_ISSUES.DUPLICATE_LINE]);

  // A file with no usable Model / Date / Input / Planned column imports nothing.
  const blind = productionRecordImportPlan(["Notes", "Something"], [{ Notes: "x" }], {});
  assert.deepEqual(blind.missing, ["Model", "Date", "Input", "Planned (h)"]);
  assert.equal(blind.accepted.length, 0);

  // Planned hours is the one column the Sheet mirror does not carry yet: say so
  // rather than importing a file full of rows the rules would all refuse.
  const noPlanned = productionRecordImportPlan(
    ["Date", "Model", "Station", "InputQty"],
    [{ Date: "2026-11-20", Model: "X4151", Station: "Fan Assembly", InputQty: "500" }],
    {}
  );
  assert.deepEqual(noPlanned.missing, ["Planned (h)"]);
});

check("loading does not mutate the rows it keeps", () => {
  const row = record({
    downtimeEvents: [{ id: "dt1", category: "Equipment / Machine", reason: "Swap", durationMin: -5 }],
  });
  const before = JSON.stringify(row);
  const cleaned = sanitizeProductionRecords([row]);
  assert.equal(JSON.stringify(row), before);
  assert.notEqual(cleaned.records[0], row, "the repaired row is a copy");
});

check("an empty or non-array load is an empty list, not an error", () => {
  [undefined, null, "nope", 42].forEach((input) => {
    const cleaned = sanitizeProductionRecords(input);
    assert.deepEqual(cleaned.records, []);
    assert.deepEqual(cleaned.dropped, []);
    assert.equal(cleaned.repaired, 0);
  });
});

check("the cleaned list and the metric helpers agree on what a run is", () => {
  // The refusal exists so a tile never divides by these rows: prove the metrics
  // would have produced a nonsense figure, which is what the rule prevents.
  const zeroHours = record({ plannedTimeHr: 0 });
  assert.equal(computeProductionMetrics(zeroHours).uph, 0);
  assert.equal(computeProductionMetrics(zeroHours).efficiency, 0);
  assert.equal(productionRecordBlockingIssues(zeroHours).length, 1);

  const clean = computeProductionMetrics(record());
  assert.equal(clean.fpy > 0 && clean.fpy < 100, true);
  assert.equal(clean.efficiency > 0, true);
});

// ---------------------------------------------------------------------------

let passed = 0;
for (const result of results) {
  if (result.ok) {
    passed += 1;
    console.log(`  pass  ${result.label}`);
  } else {
    console.log(`  FAIL  ${result.label}  (${result.message})\n`);
  }
}

console.log(`\n${passed}/${results.length} production validation checks passed.`);
if (passed !== results.length) process.exit(1);
