/**
 * Regression checks for the spec-gap fixes. Task 1 covers ID high-water marks:
 *
 *  - deleting the highest-numbered cost initiative must not reissue its CI- id
 *  - deleting the highest ME## build-matrix line must not reissue its config
 *  - a persisted counter never moves backwards
 *  - the plain numeric scan still works for older exports with no counter
 *  - deleting a seeded ME12 (whose ME: counter is still 0) records the config
 *    so the next add cannot reissue it
 *
 * Task 3 covers CSV/state safety:
 *
 *  - KPI CSV exports neutralize cells that would open as spreadsheet formulas
 *  - every CSV download carries a UTF-8 BOM
 *  - archived state history rows neutralize formula-like payload text
 *
 * The helpers are read straight out of Part1_Data.html, Part2_App.html,
 * Part4_ViewsB.html and Part5_Modules.html —
 * the same text tools/build.mjs compiles — so the tests cannot drift from a copy
 * of a rule. Later tasks add their checks to this same file and `api` object.
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-spec-gap-fixes.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const sources = {
  part1: readFileSync(join(ROOT, "Part1_Data.html"), "utf8"),
  part2: readFileSync(join(ROOT, "Part2_App.html"), "utf8"),
  part4: readFileSync(join(ROOT, "Part4_ViewsB.html"), "utf8"),
  part5: readFileSync(join(ROOT, "Part5_Modules.html"), "utf8"),
  code: readFileSync(join(ROOT, "Code.js"), "utf8")
};

/** Top-level declarations the checks are made of. Functions end at column 0. */
const DECLARATIONS = [
  { file: "part1", pattern: /function nextId\([\s\S]*?\n}/ },
  { file: "part1", pattern: /function withIdCounter\([\s\S]*?\n}/, optional: true },
  { file: "part1", pattern: /function getSideList\([\s\S]*?\n}/ },
  { file: "part4", pattern: /function nextBuildMatrixConfig\([\s\S]*?\n}/ },
  { file: "code", pattern: /function saveIdentity_\([\s\S]*?\n}/, optional: true },
  { file: "part1", pattern: /function csvText\([\s\S]*?\n}/ },
  { file: "part1", pattern: /function csvDownloadText\([\s\S]*?\n}/, optional: true },
  { file: "part5", pattern: /function kpiDeepDiveCsv\([\s\S]*?\n}/ },
  { file: "code", pattern: /function safeSheetText_\([\s\S]*?\n}/ },
  { file: "code", pattern: /function safeSheetRow_\([\s\S]*?\n}/ },
  { file: "code", pattern: /function stateHistoryRows_\([\s\S]*?\n}/, optional: true }
];

const pieces = DECLARATIONS.flatMap(({ file, pattern, optional }) => {
  const match = sources[file].match(pattern);
  if (!match) {
    if (optional) return [];
    console.error(`${file} no longer declares ${pattern} — update this test, the helper moved.`);
    process.exit(1);
  }
  return [match[0]];
});

const api = new Function(
  `"use strict";\n${pieces.join("\n")}\n` +
    "return { nextId, getSideList, nextBuildMatrixConfig, " +
    "withIdCounter: typeof withIdCounter === 'function' ? withIdCounter : undefined, " +
    "saveIdentity_: typeof saveIdentity_ === 'function' ? saveIdentity_ : undefined, " +
    "csvDownloadText: typeof csvDownloadText === 'function' ? csvDownloadText : undefined, " +
    "kpiDeepDiveCsv, " +
    "stateHistoryRows_: typeof stateHistoryRows_ === 'function' ? stateHistoryRows_ : undefined };"
)();

/**
 * The delete handler contains no JSX, so evaluate the shipped handler itself
 * against plain state stubs instead of mirroring its logic in the test.
 */
const deleteSource = sources.part2.match(
  /const handleDeleteBuildMatrixRow = \([\s\S]*?\n  };/
);
if (!deleteSource) {
  console.error(
    "Part2_App.html no longer declares handleDeleteBuildMatrixRow — update this test, the handler moved."
  );
  process.exit(1);
}

/** The shipped save path is checked statically: no GAS service stubs needed. */
const saveStateSource = sources.code.match(/function saveWorkspaceState\([\s\S]*?\n}/);
if (!saveStateSource) {
  console.error("Code.js no longer declares saveWorkspaceState — update this test, the save path moved.");
  process.exit(1);
}

function deleteSeededMe12(project, counters) {
  let projects = [project];
  let gateRecords = { [project.id]: {} };
  let nextCounters = counters;
  const runDelete = new Function(
    "withIdCounter", "projectMap", "setIdCounters", "setProjects",
    "setGateRecords", "setDeletingMatrixRow", "showToast",
    `${deleteSource[0]}\nreturn handleDeleteBuildMatrixRow;`
  )(
    api.withIdCounter,
    { [project.id]: project },
    (updater) => {
      nextCounters = typeof updater === "function" ? updater(nextCounters) : updater;
    },
    (updater) => {
      projects = typeof updater === "function" ? updater(projects) : updater;
    },
    (updater) => {
      gateRecords = typeof updater === "function" ? updater(gateRecords) : updater;
    },
    () => {},
    () => {}
  );
  runDelete(project.id, { config: "ME12", side: "RHS" });
  return { nextCounters, projects };
}

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

check('deleted CI-12 is not reissued', () =>
  equal(api.nextId('CI-', [{ id: 'CI-11' }], 12), 'CI-13'));
check('deleted ME12 is not reissued', () =>
  equal(api.nextBuildMatrixConfig(
    { id: 'PRJ-X4151', side: 'RHS', buildMatrix: [{ config: 'ME11', side: 'RHS' }] }, 12
  ), 'ME13'));
check('counter never moves backwards', () =>
  deep(api.withIdCounter({ 'CI-': 15 }, 'CI-', 12), { 'CI-': 15 }));
check('numeric scan still works without a counter', () =>
  equal(api.nextId('TM-', [{ id: 'TM-02' }]), 'TM-03'));
check('deleting a seeded ME12 records the high-water mark', () => {
  const seeded = {
    id: 'PRJ-X4151',
    side: 'RHS & LHS',
    buildMatrix: [
      { config: 'ME11', side: 'RHS' }, { config: 'ME11', side: 'LHS' },
      { config: 'ME12', side: 'RHS' }, { config: 'ME12', side: 'LHS' }
    ]
  };
  const { nextCounters, projects } = deleteSeededMe12(seeded, {});
  deep(nextCounters, { 'ME:PRJ-X4151': 12 });
  equal(api.nextBuildMatrixConfig(projects[0], nextCounters['ME:PRJ-X4151'] || 0), 'ME13');
});

check('missing email yields unknown actor', () =>
  deep(api.saveIdentity_('', 'deployer@example.com'),
    { actorLabel: 'unknown', executorEmail: 'deployer@example.com' }));
check('real email stays the actor', () =>
  deep(api.saveIdentity_('user@example.com', 'deployer@example.com'),
    { actorLabel: 'user@example.com', executorEmail: 'deployer@example.com' }));
check('saveWorkspaceState binds the typed email for ledger and response', () => {
  const src = saveStateSource[0];
  assert.ok(/const userEmail = getActiveUserEmail_\(\);/.test(src),
    'saveWorkspaceState must bind the typed email');
  assert.ok(/saveIdentity_\(userEmail, getExecutorEmail_\(\)\)/.test(src),
    'saveIdentity_ must receive the typed email');
  assert.ok((src.match(/userEmail: userEmail/g) || []).length === 2,
    'ledger and response must both use the typed email');
  assert.ok(!/userEmail: actorLabel/.test(src),
    'the fallback actorLabel must not replace the typed email');
});

// Task 3: exported CSV and archived state rows must not evaluate as formulas.
check('KPI CSV neutralizes a formula', () => {
  const kpi = api.kpiDeepDiveCsv(
    { digits: 0 },
    { trend: [{ label: '=1+1', value: 1, meta: '', thin: false }], variant: [], pareto: [] }
  );
  assert.match(kpi, /"'=1\+1"/);
});
check('KPI export text carries a BOM', () =>
  equal(api.csvDownloadText('a,b'), '\uFEFFa,b'));
check('history rows neutralize a formula', () => {
  const rows = api.stateHistoryRows_(
    [['k', 0, 1, '2026-01-01', '=1+1']], 7, 'user@example.com'
  );
  equal(rows[0][5], "'=1+1");
  equal(rows[0][6], 'user@example.com');
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} spec-gap checks passed.\n`);
process.exit(failed ? 1 : 0);
