/**
 * Fiscal-year helper checks for the KPI scorecard.
 *
 * The claims tile counts a feedback record only when `isInKpiFiscalYear` accepts
 * its date, so the FY window edges are the whole rule. This reads those helpers
 * straight out of Part1_Data.html — the same text tools/build.mjs compiles — so
 * the test cannot drift from a copy of the rule.
 *
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-fy-helpers.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const source = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");

/** Top-level declarations the FY rule is made of. Functions end at column 0. */
const DECLARATIONS = [
  /const FISCAL_YEAR_START_MONTH = \d+;/,
  /const KPI_FISCAL_YEAR = \d+;/,
  /function fiscalYearWindow\([\s\S]*?\n}/,
  /function isInKpiFiscalYear\([\s\S]*?\n}/,
  /function isKpiFiscalYearTag\([\s\S]*?\n}/,
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
    "return { KPI_FISCAL_YEAR, fiscalYearWindow, isInKpiFiscalYear, isKpiFiscalYearTag };"
)();

const results = [];
function check(label, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    results.push({ label, expected, ok: true });
  } catch {
    results.push({ label, expected, actual, ok: false });
  }
}

const inFy = (date) => api.isInKpiFiscalYear(date);

// FY2026 runs 1 Apr 2026 → 31 Mar 2027: both ends inclusive, nothing outside.
check("window FY2026", api.fiscalYearWindow(2026), { start: "2026-04-01", end: "2027-03-31" });
check("2026-03-31 (day before start) excluded", inFy("2026-03-31"), false);
check("2026-04-01 (first day) included", inFy("2026-04-01"), true);
check("2027-03-31 (last day) included", inFy("2027-03-31"), true);
check("2027-04-01 (day after end) excluded", inFy("2027-04-01"), false);

// A claim with no readable date can never be counted against the ceiling.
check("blank date excluded", inFy(""), false);
check("undefined date excluded", inFy(undefined), false);
check("null date excluded", inFy(null), false);
check("non-date text excluded", inFy("pending"), false);
check("slash-separated date excluded", inFy("2026/04/01"), false);

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (expected ${JSON.stringify(r.expected)}, got ${JSON.stringify(r.actual)})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} fiscal-year checks passed (KPI_FISCAL_YEAR=${api.KPI_FISCAL_YEAR}).\n`);
process.exit(failed ? 1 : 0);
