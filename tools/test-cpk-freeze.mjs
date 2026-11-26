/**
 * Cpk limit-freeze checks.
 *
 * A Cpk record is judged by the limits that were in force when it was measured.
 * Once those limits are frozen onto the record, correcting an existing Master
 * Spec revision (or adding a newer one that cannot apply retroactively) must not
 * move a result that has already been reported.
 *
 * The helpers are read straight out of Part1_Data.html — the same text
 * tools/build.mjs compiles — so the test cannot drift from a copy of the rule.
 *
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-cpk-freeze.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const source = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");

function slice(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  if (start < 0 || end <= start) {
    console.error(`Part1_Data.html no longer contains "${from}" … "${to}" — update this test, the helper moved.`);
    process.exit(1);
  }
  return source.slice(start, end);
}

// Limit-revision helpers (through effectiveSpecForRecord) and the statistics.
const limitsBlock = slice("const SPEC_LIMIT_FIELDS", "function specLimitsDiffer");
const statsBlock = slice("function normalCdf", "function getCpkTone");

const api = new Function(
  `"use strict";\n${limitsBlock}\n${statsBlock}\n` +
    "return { effectiveSpecForRecord, computeCapabilityStats, withFrozenSpecLimits, " +
    "hasFrozenSpecLimits, migrateCpkRecords, recordsFrozenToRevision, " +
    "refreezeCpkRecordsToRevision, correctSpecRevision };"
)();

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (err) {
    results.push({ label, ok: false, message: err.message });
  }
}
function eq(actual, expected) {
  assert.deepStrictEqual(actual, expected);
}

/** Two-sided spec with a revision that tightens the limits from 2026-06-01. */
function makeSpec() {
  return {
    id: "SPEC-T",
    code: "T_CODE",
    name: "Test parameter",
    unit: "mm",
    specType: "two-sided",
    lsl: 9.9,
    nominal: 10,
    usl: 10.1,
    cpkTarget: 1.67,
    revisions: [
      {
        id: "SPEC-T-R1",
        effectiveFrom: "2025-01-01",
        specType: "two-sided",
        lsl: 9.8,
        nominal: 10,
        usl: 10.2,
        cpkTarget: 1.33
      },
      {
        id: "SPEC-T-R2",
        effectiveFrom: "2026-06-01",
        specType: "two-sided",
        lsl: 9.9,
        nominal: 10,
        usl: 10.1,
        cpkTarget: 1.67
      }
    ]
  };
}

const measuredBefore = { id: "CPK-A", specId: "SPEC-T", mean: 10, stdDev: 0.05, date: "2026-05-01" };
const measuredAfter = { id: "CPK-B", specId: "SPEC-T", mean: 10, stdDev: 0.05, date: "2026-07-01" };

check("freezes the revision in force on the measurement date", () => {
  const spec = makeSpec();
  const frozen = api.withFrozenSpecLimits(measuredBefore, spec);
  eq(frozen.specRevisionId, "SPEC-T-R1");
  eq(frozen.specRevisionNumber, 1);
  eq(frozen.specEffectiveFrom, "2025-01-01");
  eq(frozen.lsl, 9.8);
  eq(frozen.usl, 10.2);
  eq(frozen.cpkTarget, 1.33);
  eq(frozen.specType, "two-sided");
  eq(api.hasFrozenSpecLimits(frozen), true);
});

check("a later revision is frozen onto a later measurement", () => {
  const frozen = api.withFrozenSpecLimits(measuredAfter, makeSpec());
  eq(frozen.specRevisionId, "SPEC-T-R2");
  eq(frozen.usl, 10.1);
  eq(frozen.cpkTarget, 1.67);
});

check("correcting the measured revision does not move a frozen Cpk", () => {
  const spec = makeSpec();
  const frozen = api.withFrozenSpecLimits(measuredBefore, spec);
  const before = api.computeCapabilityStats(frozen, api.effectiveSpecForRecord(spec, frozen)).cpk;

  // Someone corrects R1 in place: USL 10.2 → 10.05, target 1.33 → 1.67.
  const corrected = makeSpec();
  corrected.revisions[0] = { ...corrected.revisions[0], usl: 10.05, cpkTarget: 1.67 };
  const after = api.computeCapabilityStats(frozen, api.effectiveSpecForRecord(corrected, frozen)).cpk;

  eq(after, before);
  // The frozen snapshot keeps the target it was judged against, too.
  eq(api.effectiveSpecForRecord(corrected, frozen).cpkTarget, 1.33);
  eq(api.effectiveSpecForRecord(corrected, frozen).usl, 10.2);
});

check("an unfrozen legacy row still follows the edited revision (the bug)", () => {
  const frozen = api.withFrozenSpecLimits(measuredBefore, makeSpec());
  const legacy = { ...measuredBefore };
  const frozenCpk = api.computeCapabilityStats(frozen, api.effectiveSpecForRecord(makeSpec(), frozen)).cpk;

  const corrected = makeSpec();
  corrected.revisions[0] = { ...corrected.revisions[0], usl: 10.05 };
  const legacyCpk = api.computeCapabilityStats(legacy, api.effectiveSpecForRecord(corrected, legacy)).cpk;

  assert.notEqual(legacyCpk, frozenCpk);
});

check("a newer revision cannot be applied retroactively", () => {
  const spec = makeSpec();
  const frozen = api.withFrozenSpecLimits(measuredBefore, spec);
  const newer = makeSpec();
  newer.revisions.push({
    id: "SPEC-T-R3",
    effectiveFrom: "2026-08-01",
    specType: "two-sided",
    lsl: 9.95,
    nominal: 10,
    usl: 10.05,
    cpkTarget: 1.67
  });
  const applied = api.effectiveSpecForRecord(newer, frozen);
  eq(applied.usl, 10.2);
  eq(applied.revisionNumber, 1);
});

check("migration freezes legacy rows at their own date", () => {
  const spec = makeSpec();
  const migrated = api.migrateCpkRecords([measuredBefore, measuredAfter], [spec]);
  eq(migrated[0].specRevisionId, "SPEC-T-R1");
  eq(migrated[0].usl, 10.2);
  eq(migrated[1].specRevisionId, "SPEC-T-R2");
  eq(migrated[1].usl, 10.1);
  // Migration is idempotent: already-frozen rows are returned untouched.
  eq(api.migrateCpkRecords(migrated, [spec])[0], migrated[0]);
});

check("migration leaves rows alone when the spec is missing", () => {
  const orphan = { ...measuredBefore, specId: "SPEC-GONE" };
  const migrated = api.migrateCpkRecords([orphan], [makeSpec()]);
  eq(api.hasFrozenSpecLimits(migrated[0]), false);
  eq(migrated[0], orphan);
});

check("freezing does not mutate the record it is given", () => {
  const record = { ...measuredBefore };
  api.withFrozenSpecLimits(record, makeSpec());
  eq(record.lsl, undefined);
  eq(record.specRevisionId, undefined);
});

check("one-sided (upper) limits freeze without inventing an LSL", () => {
  const spec = {
    id: "SPEC-U",
    code: "U_CODE",
    unit: "mm",
    specType: "upper",
    lsl: null,
    nominal: 0.005,
    usl: 0.015,
    cpkTarget: 1.33,
    revisions: [
      { id: "SPEC-U-R0", effectiveFrom: "2000-01-01", specType: "upper", lsl: null, nominal: 0.005, usl: 0.015, cpkTarget: 1.33 }
    ]
  };
  const rec = { id: "CPK-U", specId: "SPEC-U", mean: 0.0052, stdDev: 0.002, date: "2026-11-20" };
  const frozen = api.withFrozenSpecLimits(rec, spec);
  eq(frozen.lsl, null);
  const applied = api.effectiveSpecForRecord(spec, frozen);
  const stats = api.computeCapabilityStats(frozen, applied);
  eq(stats.cpk, (0.015 - 0.0052) / (3 * 0.002));
  eq(stats.cpl, null);
});

check("a record measured before the first revision uses the earliest limits", () => {
  const spec = makeSpec();
  const early = { id: "CPK-E", specId: "SPEC-T", mean: 10, stdDev: 0.05, date: "2024-01-01" };
  const frozen = api.withFrozenSpecLimits(early, spec);
  eq(frozen.specRevisionId, "SPEC-T-R1");
  eq(api.effectiveSpecForRecord(spec, early).predatesFirstRevision, true);
});

check("finds only the records frozen to one revision", () => {
  const spec = makeSpec();
  const r1 = api.withFrozenSpecLimits(measuredBefore, spec);
  const r2 = api.withFrozenSpecLimits(measuredAfter, spec);
  const otherSpec = { ...r1, specId: "SPEC-OTHER" };
  eq(
    api.recordsFrozenToRevision([r1, r2, otherSpec], "SPEC-T", "SPEC-T-R1").map((r) => r.id),
    ["CPK-A"]
  );
});

const CORRECTED_LIMITS = {
  specType: "two-sided",
  lsl: 9.85,
  nominal: 10,
  usl: 10.15,
  cpkTarget: 1.5
};

check("correcting a revision keeps its id, date and count", () => {
  const corrected = api.correctSpecRevision(makeSpec(), CORRECTED_LIMITS, "SPEC-T-R1", "2026-11-26T00:00:00Z", "qa@x");
  eq(corrected.revisions.length, 2);
  eq(corrected.revisions[0].id, "SPEC-T-R1");
  eq(corrected.revisions[0].effectiveFrom, "2025-01-01");
  eq(corrected.revisions[0].usl, 10.15);
  eq(corrected.revisions[0].updatedBy, "qa@x");
  // The later revision is untouched.
  eq(corrected.revisions[1].usl, 10.1);
});

check("the spec's current limits follow its latest revision, not the corrected one", () => {
  const corrected = api.correctSpecRevision(makeSpec(), CORRECTED_LIMITS, "SPEC-T-R1", "now", "qa@x");
  eq(corrected.usl, 10.1);
  eq(corrected.effectiveFrom, "2026-06-01");
});

check("correcting the latest revision updates the spec's current limits", () => {
  const corrected = api.correctSpecRevision(makeSpec(), CORRECTED_LIMITS, "SPEC-T-R2", "now", "qa@x");
  eq(corrected.usl, 10.15);
  eq(corrected.cpkTarget, 1.5);
  eq(corrected.effectiveFrom, "2026-06-01");
});

check("an unknown revision cannot be corrected", () => {
  eq(api.correctSpecRevision(makeSpec(), CORRECTED_LIMITS, "SPEC-T-R9", "now", "qa@x"), null);
});

check("re-freezing moves only that revision's records", () => {
  const spec = makeSpec();
  const r1 = api.withFrozenSpecLimits(measuredBefore, spec);
  const r2 = api.withFrozenSpecLimits(measuredAfter, spec);
  const corrected = api.correctSpecRevision(spec, CORRECTED_LIMITS, "SPEC-T-R1", "now", "qa@x");
  const next = api.refreezeCpkRecordsToRevision([r1, r2], corrected, "SPEC-T-R1");
  eq(next[0].usl, 10.15);
  eq(next[0].cpkTarget, 1.5);
  eq(next[1].usl, 10.1);
  // Neither input record is mutated.
  eq(r1.usl, 10.2);
  eq(r2.cpkTarget, 1.67);
});

check("a re-frozen record is judged by the corrected limits", () => {
  const spec = makeSpec();
  const r1 = api.withFrozenSpecLimits(measuredBefore, spec);
  const corrected = api.correctSpecRevision(spec, CORRECTED_LIMITS, "SPEC-T-R1", "now", "qa@x");
  const [refrozen] = api.refreezeCpkRecordsToRevision([r1], corrected, "SPEC-T-R1");
  const stats = api.computeCapabilityStats(refrozen, api.effectiveSpecForRecord(corrected, refrozen));
  // USL 10.15 with mean 10.00 and sd 0.05 → (0.15) / (3 × 0.05) = 1.00
  eq(Math.round(stats.cpk * 100) / 100, 1);
});

check("migration preserves every visible Cpk and the revision it used", () => {
  const spec = makeSpec();
  const legacy = [
    { id: "A", date: "2024-12-31" }, // before the first revision
    { id: "B", date: "2025-01-01" }, // first day of R1
    { id: "C", date: "2026-05-31" }, // last day of R1
    { id: "D", date: "2026-06-01" }, // first day of R2
    { id: "E", date: "" },           // undated: the same fallback as before
    { id: "F", date: "2027-01-01" }  // after every revision
  ].map((record) => ({ ...record, specId: "SPEC-T", mean: 10, stdDev: 0.05 }));
  const migrated = api.migrateCpkRecords(legacy, [spec]);

  legacy.forEach((before, index) => {
    const after = migrated[index];
    const beforeSpec = api.effectiveSpecForRecord(spec, before);
    const afterSpec = api.effectiveSpecForRecord(spec, after);
    const beforeStats = api.computeCapabilityStats(before, beforeSpec);
    const afterStats = api.computeCapabilityStats(after, afterSpec);
    eq(afterStats.cpk, beforeStats.cpk);
    eq(afterStats.ppm, beforeStats.ppm);
    eq(afterSpec.usl, beforeSpec.usl);
    eq(afterSpec.lsl, beforeSpec.lsl);
    eq(afterSpec.cpkTarget, beforeSpec.cpkTarget);
    eq(afterSpec.revisionNumber, beforeSpec.revisionNumber);
    eq(afterSpec.effectiveFrom, beforeSpec.effectiveFrom);
    eq(afterSpec.predatesFirstRevision, beforeSpec.predatesFirstRevision);
  });
});

check("a record measured before the first revision keeps its warning after migration", () => {
  const early = { id: "EARLY", specId: "SPEC-T", mean: 10, stdDev: 0.05, date: "2024-01-01" };
  const [migrated] = api.migrateCpkRecords([early], [makeSpec()]);
  eq(api.effectiveSpecForRecord(makeSpec(), migrated).predatesFirstRevision, true);
});

check("records frozen to another revision are left out of a re-freeze", () => {
  const spec = makeSpec();
  const r2 = api.withFrozenSpecLimits(measuredAfter, spec);
  const corrected = api.correctSpecRevision(spec, CORRECTED_LIMITS, "SPEC-T-R1", "now", "qa@x");
  const next = api.refreezeCpkRecordsToRevision([r2], corrected, "SPEC-T-R1");
  eq(next[0], r2);
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Cpk limit-freeze checks passed.\n`);
process.exit(failed ? 1 : 0);
