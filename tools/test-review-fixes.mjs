/**
 * Regression checks for the review fixes:
 *
 *  - spec limit history is append-only (an edit that changes an existing date
 *    is rejected, not silently rewritten)
 *  - KPI scope labels share one fiscal-year window
 *  - a committed stage drag passes only the fields onReschedule consumes
 *
 * The helpers are read straight out of Part1_Data.html — the same text
 * tools/build.mjs compiles — so the tests cannot drift from a copy of a rule.
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-review-fixes.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const source = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");

/** Top-level declarations the fixes are made of. Functions end at column 0. */
const DECLARATIONS = [
  /const FISCAL_YEAR_START_MONTH = \d+;/,
  /const KPI_FISCAL_YEAR = \d+;/,
  /const SPEC_LIMIT_FIELDS = \[[^\]]*\];/,
  /const SPEC_BASELINE_EFFECTIVE = '[^']+';/,
  /function fiscalYearWindow\([\s\S]*?\n}/,
  /function specLimitSnapshot\([\s\S]*?\n}/,
  /function getSpecRevisions\([\s\S]*?\n}/,
  /function specLimitsDiffer\([\s\S]*?\n}/,
  /function applySpecLimitEdit\([\s\S]*?\n}/,
  /function kpiFiscalScopeLabel\([\s\S]*?\n}/,
  /function stageDragReschedulePayload\([\s\S]*?\n}/,
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
    "return { KPI_FISCAL_YEAR, applySpecLimitEdit, kpiFiscalScopeLabel, stageDragReschedulePayload };"
)();

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

const LIMITS_V1 = { specType: 'upper', lsl: 0, nominal: 1, usl: 2, cpkTarget: 1.33 };
const LIMITS_V2 = { specType: 'upper', lsl: 0, nominal: 1, usl: 1.8, cpkTarget: 1.67 };
const REVISION_V1 = {
  id: 'SPEC-TIR-R1',
  effectiveFrom: '2026-04-01',
  ...LIMITS_V1,
  updatedAt: '2026-04-01T00:00:00.000Z',
  updatedBy: 'owner@example.com'
};
const SPEC_V1 = {
  id: 'SPEC-TIR',
  code: 'TIR',
  name: 'Bearing Runout',
  ...LIMITS_V1,
  effectiveFrom: REVISION_V1.effectiveFrom,
  revisions: [{ ...REVISION_V1 }]
};
const STAMP = '2026-06-01T00:00:00.000Z';
const ACTOR = 'editor@example.com';

// A changed limit on a date already on file must never rewrite that revision.
check("changed limits on an existing date are rejected", () => {
  const before = JSON.stringify(SPEC_V1.revisions);
  const result = api.applySpecLimitEdit(SPEC_V1, LIMITS_V2, '2026-04-01', STAMP, ACTOR);
  equal(result.rejected, true);
  deep(result.history, SPEC_V1.revisions);
  equal(JSON.stringify(SPEC_V1.revisions), before);
});

// A metadata-only save keeps the revision count and the existing entry.
check("metadata-only edit on an existing date adds no revision", () => {
  const result = api.applySpecLimitEdit(SPEC_V1, LIMITS_V1, '2026-04-01', STAMP, ACTOR);
  equal(result.rejected, false);
  equal(result.outcome, 'metadata');
  equal(result.history.length, 1);
  deep(result.history[0], REVISION_V1);
});

// A genuinely new date with different limits gets one new append-only revision.
check("new date with changed limits appends a revision", () => {
  const result = api.applySpecLimitEdit(SPEC_V1, LIMITS_V2, '2026-05-01', STAMP, ACTOR);
  equal(result.rejected, false);
  equal(result.outcome, 'revision');
  equal(result.history.length, 2);
  deep(result.history[1], {
    id: 'SPEC-TIR-R2',
    effectiveFrom: '2026-05-01',
    ...LIMITS_V2,
    updatedAt: STAMP,
    updatedBy: ACTOR
  });
  deep(SPEC_V1.revisions, [REVISION_V1]);
});

// A backdated new revision is sorted into place; the latest entry still wins.
check("backdated revision keeps latest entry last", () => {
  const result = api.applySpecLimitEdit(SPEC_V1, LIMITS_V2, '2026-02-01', STAMP, ACTOR);
  equal(result.rejected, false);
  equal(result.history.length, 2);
  equal(result.history[0].effectiveFrom, '2026-02-01');
  equal(result.history[1].effectiveFrom, '2026-04-01');
});

const SCOPE = 'All programs';
const WINDOW = `FY${api.KPI_FISCAL_YEAR} 2026-04-01 to 2027-03-31`;
check("KPI scope label without suffix", () => {
  equal(api.kpiFiscalScopeLabel(), `${SCOPE} · ${WINDOW}`);
});
check("KPI scope label with suffix", () => {
  equal(api.kpiFiscalScopeLabel('customer claims'), `${SCOPE} · ${WINDOW} · customer claims`);
});

check("stage drag payload drops unused fields", () => {
  const schedule = { prepStart: '2026-04-01', prepEnd: '2026-04-05' };
  const payload = api.stageDragReschedulePayload({
    project: 'PRJ-X4151',
    rowKeys: ['X4151'],
    schedule,
    label: 'MB14" · Case A',
    startIso: '2026-04-01',
    endIso: '2026-04-05',
    stageId: 'prep',
    deltaDays: 2
  });
  deep(payload, { project: 'PRJ-X4151', rowKeys: ['X4151'], schedule });
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} review-fix checks passed.\n`);
process.exit(failed ? 1 : 0);
