/**
 * Checks for the program (project) CRUD helpers:
 *
 *  - editing a program header cannot rename its id or drop its build matrix,
 *    and a blank field keeps the value already on file
 *  - deleting a program names exactly what it removes (tasks, gate lines and
 *    dossiers, Gantt overrides) and leaves every other program's records alone
 *  - the family picker never hides a family the workspace already runs
 *
 * The helpers are read straight out of Part1_Data.html — the same text
 * tools/build.mjs compiles — so the tests cannot drift from a copy of a rule.
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-project-crud.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const source = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");

const DECLARATIONS = [
  /const PROGRAM_STATUS_OPTIONS = \[[^\]]*\];/,
  /const PROGRAM_FAMILY_GROUPS = \[[^\]]*\];/,
  /function normalizeProductKey\([\s\S]*?\n}/,
  /function projectFamilyGroupOptions\([\s\S]*?\n}/,
  /function projectFromSettingsForm\([\s\S]*?\n}/,
  /function projectDeletionImpact\([\s\S]*?\n}/,
  /function pruneProjectFromWorkspace\([\s\S]*?\n}/
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
    "return { PROGRAM_STATUS_OPTIONS, PROGRAM_FAMILY_GROUPS, projectFamilyGroupOptions, projectFromSettingsForm, projectDeletionImpact, pruneProjectFromWorkspace };"
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

const PROJECT = {
  id: "PRJ-X4151-01",
  model: "x4151",
  phase: "EVT",
  status: "On Track",
  familyGroup: 'MB14"',
  family: 'MB 14" FDB Fan Module',
  customer: "QSMC",
  moRange: "SPP0890–SPP0895",
  etdDate: "2027-03-25",
  mihDate: "2027-03-29",
  pm: "Horikawa / Saengtian",
  leader: "Saengtian N.",
  owner: "Patcharapong J.",
  spec: "DC5V · Standard FDB Fan Spec",
  lineSpec: "FFM Auto Line @ 340 UPH · HC 34.25",
  currentGateId: "mbo",
  buildMatrix: [{ config: "ME11", side: "RHS", total: 662 }]
};

check("a settings edit normalizes the model but keeps the record id and matrix", () => {
  const next = api.projectFromSettingsForm(PROJECT, {
    model: "  x4151x ",
    phase: "PVT",
    status: "At Risk",
    customer: " MTCE ",
    mihDate: "2027-04-01"
  });
  equal(next.id, "PRJ-X4151-01");
  equal(next.model, "X4151X");
  equal(next.phase, "PVT");
  equal(next.status, "At Risk");
  equal(next.customer, "MTCE");
  equal(next.mihDate, "2027-04-01");
  deep(next.buildMatrix, PROJECT.buildMatrix);
  equal(next.leader, PROJECT.leader);
  equal(next.currentGateId, "mbo");
});

check("a blank field keeps the value already on file", () => {
  const next = api.projectFromSettingsForm(PROJECT, { customer: "   ", family: "", leader: null });
  equal(next.customer, "QSMC");
  equal(next.family, PROJECT.family);
  equal(next.leader, PROJECT.leader);
});

check("a blank model is not a way to rename a program to nothing", () => {
  const next = api.projectFromSettingsForm(PROJECT, { model: "   " });
  equal(next.model, "X4151");
});

check("a program with no family name derives one from its family group", () => {
  const next = api.projectFromSettingsForm(
    { ...PROJECT, family: "", familyGroup: "" },
    { familyGroup: "iMac" }
  );
  equal(next.familyGroup, "iMac");
  equal(next.family, "iMac FDB Fan Module");
});

const TASKS = [
  { id: "TSK-1", projectId: "PRJ-A" },
  { id: "TSK-2", projectId: "PRJ-A" },
  { id: "TSK-3", projectId: "PRJ-B" },
  { id: "TSK-4" }
];
const GATE_RECORDS = {
  "PRJ-A": {
    "ME11-RHS": { prep: {}, bbr: {}, brr: {} },
    "ME12-LHS": { prep: {}, bbr: {} }
  },
  "PRJ-B": { "ME11-RHS": { prep: {} } }
};
const OVERRIDES = {
  "PRJ-A::ME11-RHS": { start: "2026-11-01" },
  "PRJ-A::ME12-LHS": { start: "2026-11-02" },
  "PRJ-B::ME11-RHS": { start: "2026-11-03" }
};

check("deletion impact counts only the program's own working records", () => {
  deep(api.projectDeletionImpact("PRJ-A", TASKS, GATE_RECORDS, OVERRIDES), {
    tasks: 2,
    lines: 2,
    dossiers: 5,
    scheduleOverrides: 2
  });
});

check("a program with nothing on file has an empty impact", () => {
  deep(api.projectDeletionImpact("PRJ-MISSING", TASKS, GATE_RECORDS, OVERRIDES), {
    tasks: 0,
    lines: 0,
    dossiers: 0,
    scheduleOverrides: 0
  });
  deep(api.projectDeletionImpact("", TASKS, GATE_RECORDS, OVERRIDES), {
    tasks: 0,
    lines: 0,
    dossiers: 0,
    scheduleOverrides: 0
  });
});

check("pruning removes the program's tasks, dossiers and overrides only", () => {
  const pruned = api.pruneProjectFromWorkspace("PRJ-A", TASKS, GATE_RECORDS, OVERRIDES);
  deep(pruned.tasks.map((t) => t.id), ["TSK-3", "TSK-4"]);
  deep(Object.keys(pruned.gateRecords), ["PRJ-B"]);
  deep(Object.keys(pruned.scheduleOverrides), ["PRJ-B::ME11-RHS"]);
});

check("pruning never mutates the state it was given", () => {
  const tasksBefore = TASKS.map((t) => t.id);
  const gatesBefore = Object.keys(GATE_RECORDS);
  const overridesBefore = Object.keys(OVERRIDES);
  api.pruneProjectFromWorkspace("PRJ-A", TASKS, GATE_RECORDS, OVERRIDES);
  deep(TASKS.map((t) => t.id), tasksBefore);
  deep(Object.keys(GATE_RECORDS), gatesBefore);
  deep(Object.keys(OVERRIDES), overridesBefore);
});

check("the family picker keeps live families, dedupes and appends the presets", () => {
  const options = api.projectFamilyGroupOptions([
    { familyGroup: 'MB14"' },
    { familyGroup: "mb14\"" },
    { familyGroup: "iMac" },
    { familyGroup: "" },
    null
  ]);
  equal(options[0], 'MB14"');
  equal(options[1], "iMac");
  equal(options.filter((o) => o.toLowerCase() === 'mb14"').length, 1);
  api.PROGRAM_FAMILY_GROUPS.forEach((preset) => {
    assert.ok(
      options.some((o) => o.toLowerCase() === preset.toLowerCase()),
      `missing preset ${preset}`
    );
  });
  assert.ok(!options.includes(""));
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} program CRUD checks passed.\n`);
process.exit(failed ? 1 : 0);
