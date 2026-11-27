/**
 * Checks for the KPI deep-dive drill-through.
 *
 * A Pareto bar is a sum over the defect modes (FPY/FY) or downtime categories
 * (efficiency) on each production record; clicking it must list exactly the
 * records that contributed to that bar, with the matching fallout/salvage or
 * minutes. A variant row must list every record on that line. The helpers are
 * read straight out of Part1_Data.html and Part5_Modules.html, the same text the
 * build compiles, so the test cannot drift from a copied rule.
 *
 * Run: bun tools/test-kpi-drill.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const dataSource = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");
const moduleSource = readFileSync(join(ROOT, "Part5_Modules.html"), "utf8");

const DECLARATIONS = [
  { source: dataSource, file: "Part1_Data.html", pattern: /function computeProductionMetrics\([\s\S]*?\n}/ },
  { source: moduleSource, file: "Part5_Modules.html", pattern: /function kpiInRange\([\s\S]*?\n}/ },
  { source: moduleSource, file: "Part5_Modules.html", pattern: /function kpiVariantKey\([\s\S]*?\n}/ },
  { source: moduleSource, file: "Part5_Modules.html", pattern: /function kpiDrillRows\([\s\S]*?\n}/ }
];

const pieces = DECLARATIONS.map(({ source, file, pattern }) => {
  const match = source.match(pattern);
  if (!match) {
    console.error(`${file} no longer declares ${pattern} — update this test, the helper moved.`);
    process.exit(1);
  }
  return match[0];
});

const api = new Function(
  `"use strict";\n${pieces.join("\n")}\n` +
    "return { computeProductionMetrics, kpiInRange, kpiVariantKey, kpiDrillRows };"
)();

const BASE = {
  id: "R1",
  date: "2026-11-20",
  model: "X4151",
  config: "ME11",
  side: "RHS",
  phase: "EVT",
  station: "Fan Assembly",
  input: 100,
  plannedTimeHr: 8,
  defectItems: [],
  downtimeEvents: []
};

let nextId = 1;
const record = (over = {}) => ({
  ...BASE,
  id: `R${nextId++}`,
  ...over,
  defectItems: over.defectItems || [],
  downtimeEvents: over.downtimeEvents || []
});
const drill = (records, selection, kpiKey = "fpy", cutoffIso = "2026-11-01") =>
  api.kpiDrillRows({ records, cutoffIso, kpiKey, selection });
const ids = (rows) => rows.map((row) => row.record.id).join(",");
const values = (rows, key) => rows.map((row) => row[key]);

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (error) {
    results.push({ label, ok: false, message: error.message });
  }
}
const deep = (actual, expected) => assert.deepStrictEqual(actual, expected);
const equal = (actual, expected) => assert.strictEqual(actual, expected);

check("the variant key is exactly what the quality builder groups by", () => {
  equal(api.kpiVariantKey(BASE), "X4151 · ME11 RHS");
});

check("a variant lists every record on its line, newest first, including totals", () => {
  const older = record({
    date: "2026-11-18",
    defectItems: [{ mode: "Crack", falloutQty: 6, salvageQty: 2 }]
  });
  const newer = record({ date: "2026-11-22", defectItems: [{ mode: "Crack", falloutQty: 3, salvageQty: 1 }] });
  const otherSide = record({ side: "LHS", date: "2026-11-21" });
  const outOfRange = record({ date: "2026-10-31" });

  const rows = drill([older, newer, otherSide, outOfRange], {
    kind: "variant",
    key: "X4151 · ME11 RHS"
  });
  equal(ids(rows), `${newer.id},${older.id}`);
  deep(values(rows, "fallout"), [3, 6]);
  deep(values(rows, "salvage"), [1, 2]);
  deep(values(rows, "match"), [null, null]);
  equal(rows[0].record.station, "Fan Assembly");
});

check("FPY lists only records contributing fallout to the selected mode", () => {
  const contributing = record({
    date: "2026-11-20",
    defectItems: [
      { mode: "Crack", falloutQty: 6, salvageQty: 2 },
      { mode: "Paint", falloutQty: 4, salvageQty: 0 }
    ]
  });
  const zeroMode = record({
    date: "2026-11-21",
    defectItems: [{ mode: "Crack", falloutQty: 0, salvageQty: 0 }]
  });
  const otherMode = record({ date: "2026-11-22", defectItems: [{ mode: "Paint", falloutQty: 5, salvageQty: 0 }] });

  const rows = drill([contributing, zeroMode, otherMode], { kind: "pareto", key: "Crack" }, "fpy");
  equal(ids(rows), contributing.id);
  equal(rows[0].fallout, 6);
  equal(rows[0].salvage, 2);
  equal(rows[0].match, 6);
});

check("FY excludes a mode whose fallout was fully salvaged", () => {
  const netReject = record({
    date: "2026-11-20",
    defectItems: [
      { mode: "Crack", falloutQty: 6, salvageQty: 2 },
      { mode: "Paint", falloutQty: 3, salvageQty: 1 }
    ]
  });
  const fullySalvaged = record({
    date: "2026-11-21",
    defectItems: [{ mode: "Crack", falloutQty: 4, salvageQty: 4 }]
  });

  const rows = drill([netReject, fullySalvaged], { kind: "pareto", key: "Crack" }, "fy");
  equal(ids(rows), netReject.id);
  equal(rows[0].fallout, 6);
  equal(rows[0].salvage, 2);
  equal(rows[0].match, 4);
});

check("efficiency lists records with selected downtime minutes, not total downtime", () => {
  const contributing = record({
    date: "2026-11-20",
    downtimeEvents: [
      { category: "Equipment", durationMin: 8 },
      { category: "Quality", durationMin: 4 }
    ]
  });
  const zeroCategory = record({
    date: "2026-11-21",
    downtimeEvents: [{ category: "Equipment", durationMin: 0 }]
  });
  const otherCategory = record({ date: "2026-11-22", downtimeEvents: [{ category: "Quality", durationMin: 3 }] });

  const rows = drill([contributing, zeroCategory, otherCategory], { kind: "pareto", key: "Equipment" }, "eff");
  equal(ids(rows), contributing.id);
  equal(rows[0].match, 8);
});

check("an Others row follows every folded key", () => {
  const both = record({
    date: "2026-11-20",
    defectItems: [
      { mode: "Crack", falloutQty: 4, salvageQty: 1 },
      { mode: "Paint", falloutQty: 3, salvageQty: 1 }
    ]
  });
  const one = record({ date: "2026-11-21", defectItems: [{ mode: "Crack", falloutQty: 2, salvageQty: 0 }] });
  const outside = record({ date: "2026-11-22", defectItems: [{ mode: "Dent", falloutQty: 9, salvageQty: 0 }] });

  const rows = drill(
    [both, one, outside],
    { kind: "pareto", key: "__others__", keys: ["Crack", "Paint"] },
    "fpy"
  );
  equal(ids(rows), `${one.id},${both.id}`);
  deep(values(rows, "fallout"), [2, 7]);
  deep(values(rows, "salvage"), [0, 2]);
});

check("a Pareto row opened while a variant is scoped stays on that line", () => {
  const rhs = record({ date: "2026-11-20", defectItems: [{ mode: "Crack", falloutQty: 4, salvageQty: 0 }] });
  const lhs = record({ side: "LHS", date: "2026-11-21", defectItems: [{ mode: "Crack", falloutQty: 5, salvageQty: 0 }] });
  const otherModel = record({
    model: "X4152",
    date: "2026-11-22",
    defectItems: [{ mode: "Crack", falloutQty: 6, salvageQty: 0 }]
  });

  const rows = drill(
    [rhs, lhs, otherModel],
    { kind: "pareto", key: "Crack", variantKey: "X4151 · ME11 RHS" },
    "fpy"
  );
  equal(ids(rows), rhs.id);
});

check("empty mode/category falls back to Unclassified", () => {
  const defect = record({
    date: "2026-11-20",
    defectItems: [{ mode: "", falloutQty: 3, salvageQty: 1 }]
  });
  const downtime = record({
    date: "2026-11-21",
    downtimeEvents: [{ durationMin: 7 }]
  });

  const defectRows = drill([defect], { kind: "pareto", key: "Unclassified" }, "fpy");
  equal(ids(defectRows), defect.id);
  equal(defectRows[0].fallout, 3);

  const downtimeRows = drill([downtime], { kind: "pareto", key: "Unclassified" }, "eff");
  equal(ids(downtimeRows), downtime.id);
  equal(downtimeRows[0].match, 7);
});

check("the date cutoff is applied and records without a date are skipped", () => {
  const current = record({ date: "2026-11-01" });
  const old = record({ date: "2026-10-31" });
  const undated = record({ date: "" });

  equal(ids(drill([current, old, undated], { kind: "variant", key: "X4151 · ME11 RHS" })), current.id);
  equal(drill([current, old], { kind: "variant", key: "X4151 · ME11 RHS" }, "fpy", null).length, 2);
});

check("a selection that matches no line or mode returns no rows", () => {
  const rows = drill([record()], { kind: "variant", key: "X4151 · ME11 LHS" });
  equal(rows.length, 0);
  deep(drill([record()], null), []);
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} KPI drill-through checks passed.\n`);
process.exit(failed ? 1 : 0);
