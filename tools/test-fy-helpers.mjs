/**
 * Fiscal-year helper checks for the KPI scorecard.
 *
 * The claims tile counts a feedback record only when `isInKpiFiscalYear` accepts
 * its date, so the FY window edges are the whole rule. This reads those helpers
 * straight out of Part1_Data.html — the same text tools/build.mjs compiles — so
 * the test cannot drift from a copy of the rule.
 *
 * It also reads `reportFiscalYearOf` from Part6_Reports.html, because the report
 * presets derive their fiscal year from the report date, and checks the shared
 * `currentFiscalYear` rule the scorecard tiles and cost-saving tags now use. Those
 * checks fail if any of them ever gets pinned back to a fixed year.
 *
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-fy-helpers.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const SOURCES = {
  "Part1_Data.html": readFileSync(join(ROOT, "Part1_Data.html"), "utf8"),
  "Part6_Reports.html": readFileSync(join(ROOT, "Part6_Reports.html"), "utf8"),
};

/** Top-level declarations the FY rule is made of. Functions end at column 0. */
const DECLARATIONS = [
  { file: "Part1_Data.html", pattern: /const FISCAL_YEAR_START_MONTH = \d+;/ },
  { file: "Part1_Data.html", pattern: /function currentFiscalYear\([\s\S]*?\n}/ },
  { file: "Part1_Data.html", pattern: /const APP_TIME_ZONE = '[^']*';/ },
  { file: "Part1_Data.html", pattern: /const APP_DATE_FORMATTER = new Intl\.DateTimeFormat\('en-GB', \{[\s\S]*?\n}\);/ },
  { file: "Part1_Data.html", pattern: /function todayIso\([\s\S]*?\n}/ },
  { file: "Part1_Data.html", pattern: /function fiscalYearWindow\([\s\S]*?\n}/ },
  { file: "Part1_Data.html", pattern: /function isInKpiFiscalYear\([\s\S]*?\n}/ },
  { file: "Part1_Data.html", pattern: /function isKpiFiscalYearTag\([\s\S]*?\n}/ },
  { file: "Part6_Reports.html", pattern: /function reportFiscalYearOf\([\s\S]*?\n}/ },
];

const pieces = DECLARATIONS.map(({ file, pattern }) => {
  const match = SOURCES[file].match(pattern);
  if (!match) {
    console.error(`${file} no longer declares ${pattern} — update this test, the helper moved.`);
    process.exit(1);
  }
  return match[0];
});

const api = new Function(
  `"use strict";\n${pieces.join("\n")}\n` +
    "return { fiscalYearWindow, currentFiscalYear, isInKpiFiscalYear, isKpiFiscalYearTag, reportFiscalYearOf };"
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

// Pinned to FY2026 so these window-edge checks do not change meaning when the
// plant clock reaches the next 1 April; the default (today) is covered below.
const inFy = (date, year = 2026) => api.isInKpiFiscalYear(date, year);

// FY2026 runs 1 Apr 2026 → 31 Mar 2027: both ends inclusive, nothing outside.
check("window FY2026", api.fiscalYearWindow(2026), { start: "2026-04-01", end: "2027-03-31" });
check("2026-03-31 (day before start) excluded", inFy("2026-03-31"), false);
check("2026-04-01 (first day) included", inFy("2026-04-01"), true);
check("2027-03-31 (last day) included", inFy("2027-03-31"), true);
check("2027-04-01 (day after end) excluded", inFy("2027-04-01"), false);

// The scorecard tiles and cost-saving tags take their year from the date they are
// judging, so nothing on the dashboard is tied to a deploy-time constant.
check("currentFiscalYear 2026-03-31 is still FY2025", api.currentFiscalYear("2026-03-31"), 2025);
check("currentFiscalYear 2026-04-01 opens FY2026", api.currentFiscalYear("2026-04-01"), 2026);
check("currentFiscalYear 2027-03-31 closes FY2026", api.currentFiscalYear("2027-03-31"), 2026);
check("currentFiscalYear 2027-04-01 opens FY2027", api.currentFiscalYear("2027-04-01"), 2027);
check("claims window follows the year it is scored for", api.isInKpiFiscalYear("2027-04-15", 2027), true);
check("claims window rejects the previous year", api.isInKpiFiscalYear("2026-04-15", 2027), false);
check("saving tag matches the scored year", api.isKpiFiscalYearTag("FY2027", 2027), true);
check("saving tag rejects the previous year", api.isKpiFiscalYearTag("FY2026", 2027), false);
check("saving tag accepts the current-year tag", api.isKpiFiscalYearTag("FY2026", 2026), true);
check("untagged saving item belongs to the scored year", api.isKpiFiscalYearTag(undefined, 2027), true);

// A default that reads `currentFiscalYear()` is invisible to the checks above, which
// pass their year explicitly; these read the declarations themselves so a helper
// cannot quietly go back to a literal year.
const part1 = SOURCES["Part1_Data.html"];
check("claims helper defaults to the current year",
  /function isInKpiFiscalYear\(iso, fiscalYear = currentFiscalYear\(\)\)/.test(part1), true);
check("saving helper defaults to the current year",
  /function isKpiFiscalYearTag\(fyTarget, fiscalYear = currentFiscalYear\(\)\)/.test(part1), true);
check("scope label uses the current year",
  /function kpiFiscalScopeLabel\(suffix\) \{\n  const fiscalYear = currentFiscalYear\(\);/.test(part1), true);
check("no pinned fiscal-year constant left in the app",
  /KPI_FISCAL_YEAR/.test(Object.values(SOURCES).join("\n")), false);

// The report derives its fiscal year from the report date, so the 1 April boundary
// has to hand the next window to the presets. These fail if the report is ever
// pinned back to a constant year.
check("reportFiscalYearOf 2027-04-01", api.reportFiscalYearOf("2027-04-01"), 2027);
check(
  "window for 2027-04-01 rolls to FY2027",
  api.fiscalYearWindow(api.reportFiscalYearOf("2027-04-01")),
  { start: "2027-04-01", end: "2028-03-31" }
);
check("reportFiscalYearOf 2027-03-31 stays FY2026", api.reportFiscalYearOf("2027-03-31"), 2026);
check("reportFiscalYearOf 2026-04-01 opens FY2026", api.reportFiscalYearOf("2026-04-01"), 2026);
check(
  "window for 2028-04-01 rolls again to FY2028",
  api.fiscalYearWindow(api.reportFiscalYearOf("2028-04-01")),
  { start: "2028-04-01", end: "2029-03-31" }
);
check(
  "window for 2031-05-15 is not pinned to KPI_FISCAL_YEAR",
  api.fiscalYearWindow(api.reportFiscalYearOf("2031-05-15")),
  { start: "2031-04-01", end: "2032-03-31" }
);

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
console.log(`\n${results.length - failed}/${results.length} fiscal-year checks passed (FY starts 1 April).\n`);
process.exit(failed ? 1 : 0);
