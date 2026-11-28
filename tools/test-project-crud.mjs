/**
 * Checks for the program (project) CRUD helpers:
 *
 *  - editing a program header cannot rename its id or drop its build matrix,
 *    and a blank field keeps the value already on file
 *  - only X4151/X4152/X4026 keep an NPI phase; every other model is MP
 *  - deleting a program names exactly what it removes (tasks, gate lines and
 *    dossiers, Gantt overrides) and leaves every other program's records alone
 *  - the family picker never hides a family the workspace already runs
 *  - Product Master adds, edits, protects and deletes models, propagates a
 *    family change across every model-bearing slice, and survives a JSON reload
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
  /const ACTIVE_NPI_MODELS = \[[^\]]*\];/,
  /const NPI_PHASES = \[[^\]]*\];/,
  /const NPI_PHASE_FILTER = '[^']*';/,
  /function phaseInScope\([\s\S]*?\n}/,
  /function phaseFilterHasMatch\([\s\S]*?\n}/,
  /function isActiveNpiModel\([\s\S]*?\n}/,
  /function modelPortfolio\([\s\S]*?\n}/,
  /function canonicalProgramPhase\([\s\S]*?\n}/,
  /function withCanonicalProgramPhase\([\s\S]*?\n}/,
  /function withCanonicalModelPhase\([\s\S]*?\n}/,
  /const PROGRAM_STATUS_OPTIONS = \[[^\]]*\];/,
  /(?:const|let) MODEL_FAMILY_GROUPS = \{[\s\S]*?\n\};/,
  /const MODEL_FAMILY_ORDER = Object\.keys\(MODEL_FAMILY_GROUPS\);|const MODEL_FAMILY_ORDER = \[[^\]]*\];/,
  /function inferFamilyFromModel\([\s\S]*?\n}/,
  /function normalizeProductRegistry\([\s\S]*?\n}/,
  /function productModelsForScope\([\s\S]*?\n}/,
  /function countProductUsage\([\s\S]*?\n}/,
  /function productFamilyUpdate\([\s\S]*?\n}/,
  /function applyProductFamilyToWorkspace\([\s\S]*?\n}/,
  /function saveProductToRegistry\([\s\S]*?\n}/,
  /function deleteProductFromRegistry\([\s\S]*?\n}/,
  /function nextId\([\s\S]*?\n}/,
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
    "return { ACTIVE_NPI_MODELS, NPI_PHASES, NPI_PHASE_FILTER, phaseInScope, phaseFilterHasMatch, isActiveNpiModel, modelPortfolio, canonicalProgramPhase, withCanonicalProgramPhase, withCanonicalModelPhase, MODEL_FAMILY_GROUPS, MODEL_FAMILY_ORDER, inferFamilyFromModel, normalizeProductRegistry, productModelsForScope, countProductUsage, productFamilyUpdate, applyProductFamilyToWorkspace, saveProductToRegistry, deleteProductFromRegistry, PROGRAM_STATUS_OPTIONS, PROGRAM_FAMILY_GROUPS, projectFamilyGroupOptions, projectFromSettingsForm, projectDeletionImpact, pruneProjectFromWorkspace };"
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
  equal(next.phase, "MP");
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

check("the NPI phase scope covers P1-PVT and excludes MP", () => {
  for (const phase of ['P1', 'P2', 'EVT', 'DVT', 'PVT']) {
    equal(api.phaseInScope(phase, api.NPI_PHASE_FILTER), true);
  }
  equal(api.phaseInScope('MP', api.NPI_PHASE_FILTER), false);
  equal(api.phaseInScope('DVT', 'PVT'), false);
  equal(api.phaseFilterHasMatch(new Set(['DVT']), api.NPI_PHASE_FILTER), true);
  equal(api.phaseFilterHasMatch(new Set(['MP']), api.NPI_PHASE_FILTER), false);
});

check("the product registry normalizes, dedupes and infers a family", () => {
  const rows = api.normalizeProductRegistry([
    { id: 'p1', model: 'x9999', familyGroup: 'Display' },
    { id: 'p2', model: 'X9999', familyGroup: 'iMac' },
    { model: 'not-a-model' },
    { model: 'X1111', familyGroup: 'Unknown' }
  ]);
  deep(rows.map((row) => row.model), ['X9999', 'X1111']);
  equal(rows[0].id, 'p1');
  equal(rows[0].familyGroup, 'Display');
  equal(rows[1].familyGroup, 'MB14"');
});

check("the product registry supplies model options before any records exist", () => {
  const rows = api.normalizeProductRegistry([
    { model: 'X9999', familyGroup: 'Display' },
    { model: 'X4151', familyGroup: 'MB14"' },
    { model: 'X3082', familyGroup: 'MB14"' }
  ]);
  deep(api.productModelsForScope(rows, 'MP', 'Display'), ['X9999']);
  deep(api.productModelsForScope(rows, 'MP'), ['X9999', 'X3082']);
  deep(api.productModelsForScope(rows, 'NPI'), ['X4151']);
  deep(api.productModelsForScope(rows, 'MP', 'MB14"'), ['X3082']);
  deep(api.productModelsForScope(rows, 'NPI', 'Display'), []);
});

check("Product Master adds a product with a generated id and a valid family", () => {
  const rows = api.normalizeProductRegistry([
    { id: 'PRD-X3082', model: 'X3082', familyGroup: 'MB14"' }
  ]);
  const result = api.saveProductToRegistry(rows, { model: ' x9999 ', familyGroup: 'Display' });
  equal(result.ok, true);
  equal(result.products.length, 2);
  equal(result.product.model, 'X9999');
  equal(result.product.familyGroup, 'Display');
  assert.match(result.product.id, /^PRD-\d{2}$/);
  equal(result.existing, null);

  const duplicate = api.saveProductToRegistry(result.products, {
    model: 'X9999',
    familyGroup: 'iMac'
  });
  equal(duplicate.ok, false);
  equal(duplicate.error, 'X9999 is already assigned to Display.');
});

check("Product Master edits a family without changing the model or id", () => {
  const rows = api.normalizeProductRegistry([
    { id: 'PRD-X3082', model: 'X3082', familyGroup: 'MB14"' },
    { id: 'PRD-X4151', model: 'X4151', familyGroup: 'MB14"' }
  ]);
  const result = api.saveProductToRegistry(
    rows,
    { model: 'X3082', familyGroup: 'iMac' },
    'PRD-X3082'
  );
  equal(result.ok, true);
  equal(result.familyChanged, true);
  equal(result.product.id, 'PRD-X3082');
  equal(result.product.model, 'X3082');
  equal(result.product.familyGroup, 'iMac');
  equal(result.products.find((p) => p.id === 'PRD-X3082').familyGroup, 'iMac');
  equal(result.products.find((p) => p.id === 'PRD-X4151').familyGroup, 'MB14"');
});

check("active NPI models cannot be renamed or deleted but can change family", () => {
  const rows = api.normalizeProductRegistry([
    { id: 'PRD-X4151', model: 'X4151', familyGroup: 'MB14"' }
  ]);
  const renamed = api.saveProductToRegistry(
    rows,
    { model: 'X9999', familyGroup: 'MB14"' },
    'PRD-X4151'
  );
  equal(renamed.ok, false);
  equal(renamed.error, 'X4151 is a fixed active NPI model and cannot be renamed.');

  const deleted = api.deleteProductFromRegistry(rows, rows[0]);
  equal(deleted.ok, false);
  equal(deleted.error, 'X4151 is a fixed active NPI model and cannot be deleted.');

  const familyEdit = api.saveProductToRegistry(
    rows,
    { model: 'X4151', familyGroup: 'iMac' },
    'PRD-X4151'
  );
  equal(familyEdit.ok, true);
  equal(familyEdit.product.familyGroup, 'iMac');
});

check("in-use products cannot be renamed or deleted", () => {
  const usage = api.countProductUsage({
    projects: [{ model: 'x3082' }],
    productionRecords: [{ model: 'X3082' }],
    cpkRecords: [{ model: 'X3082' }],
    costProjects: [{ model: 'X3082' }],
    customerFeedback: [{ model: 'X3082' }],
    masterSpecs: [{ model: 'X3082' }],
    teamMembers: [{ products: ['x3082'] }]
  });
  equal(usage.X3082, 7);

  const rows = api.normalizeProductRegistry([
    { id: 'PRD-X3082', model: 'X3082', familyGroup: 'MB14"' }
  ]);
  const renamed = api.saveProductToRegistry(
    rows,
    { model: 'X9999', familyGroup: 'MB14"' },
    'PRD-X3082',
    usage
  );
  equal(renamed.ok, false);
  equal(renamed.error, 'X3082 is used by 7 record(s); update those records before renaming it.');

  const deleted = api.deleteProductFromRegistry(rows, rows[0], usage);
  equal(deleted.ok, false);
  equal(
    deleted.error,
    'X3082 is used by 7 record(s); reassign or remove them before deleting the product.'
  );
});

check("editing a product family propagates across every model-bearing slice", () => {
  const target = (extra) => [
    { id: 'a', model: 'x9999', familyGroup: 'Display', ...extra },
    { id: 'b', model: 'X3082', familyGroup: 'MB14"' }
  ];
  const workspace = {
    projects: target({ project: true }),
    productionRecords: target({ record: true }),
    cpkRecords: target({ cpk: true }),
    costProjects: target({ cost: true }),
    customerFeedback: target({ feedback: true }),
    untouched: [{ model: 'X9999', familyGroup: 'Display' }]
  };
  const before = JSON.stringify(workspace);
  const updated = api.applyProductFamilyToWorkspace(workspace, 'X9999', 'iMac');
  ['projects', 'productionRecords', 'cpkRecords', 'costProjects', 'customerFeedback'].forEach(
    (key) => {
      equal(updated[key][0].familyGroup, 'iMac');
      equal(updated[key][1].familyGroup, 'MB14"');
    }
  );
  equal(updated.untouched[0].familyGroup, 'Display');
  equal(JSON.stringify(workspace), before);
});

check("Product Master deletes an unused product", () => {
  const rows = api.normalizeProductRegistry([
    { id: 'PRD-X9999', model: 'X9999', familyGroup: 'Display' },
    { id: 'PRD-X3082', model: 'X3082', familyGroup: 'MB14"' }
  ]);
  const result = api.deleteProductFromRegistry(rows, rows[0]);
  equal(result.ok, true);
  deep(result.products.map((p) => p.model), ['X3082']);
});

check("a saved product survives a JSON reload with its edited family", () => {
  const rows = api.normalizeProductRegistry([
    { id: 'PRD-X3082', model: 'X3082', familyGroup: 'MB14"' }
  ]);
  const added = api.saveProductToRegistry(rows, { model: 'X9999', familyGroup: 'Display' });
  const edited = api.saveProductToRegistry(
    added.products,
    { model: 'X9999', familyGroup: 'iMac' },
    added.product.id
  );
  const payload = JSON.parse(JSON.stringify({ products: edited.products }));
  const reloaded = api.normalizeProductRegistry(payload.products);
  const product = reloaded.find((p) => p.model === 'X9999');
  equal(product.familyGroup, 'iMac');
  equal(product.id, added.product.id);
  deep(api.productModelsForScope(reloaded, 'MP', 'iMac'), ['X9999']);
  deep(api.productModelsForScope(reloaded, 'NPI', 'iMac'), []);
});

check("model families match the published family map", () => {
  deep(api.MODEL_FAMILY_GROUPS['MB14"'], ['X3466', 'X3082', 'X4151', 'X4026']);
  deep(api.MODEL_FAMILY_GROUPS['MB16"'], ['X3439', 'X3083', 'X4152']);
  deep(api.MODEL_FAMILY_GROUPS.iMac, ['X2867', 'X3721']);
  deep(api.MODEL_FAMILY_GROUPS.MacMini, ['X2977', 'X3784', 'X4171']);
  deep(api.MODEL_FAMILY_GROUPS.Display, ['X2689']);
  equal(api.MODEL_FAMILY_ORDER.join('|'), 'MB14"|MB16"|iMac|MacMini|Display');
  equal(api.inferFamilyFromModel('x2867'), 'iMac');
  equal(api.inferFamilyFromModel('X2977'), 'MacMini');
  equal(api.inferFamilyFromModel('X4171'), 'MacMini');
});

check("modelPortfolio separates the three NPI models from every MP model", () => {
  equal(api.modelPortfolio("X4151"), "NPI");
  equal(api.modelPortfolio(" x4026 "), "NPI");
  equal(api.modelPortfolio("X3082"), "MP");
  equal(api.modelPortfolio(""), "MP");
});

check("a non-active feedback row also becomes an MP build", () => {
  const row = api.withCanonicalModelPhase({
    model: "x3784",
    phase: "DVT",
    build: "NPI",
    buildConfig: "PPVT"
  });
  equal(row.phase, "MP");
  equal(row.build, "MP");
  equal(row.buildConfig, "MP");
});

check("active NPI models keep their phase; every other model is MP", () => {
  equal(api.canonicalProgramPhase("X4151", "PVT"), "PVT");
  equal(api.canonicalProgramPhase(" x4152 ", "dvt"), "DVT");
  equal(api.canonicalProgramPhase("X4026", ""), "EVT");
  equal(api.canonicalProgramPhase("X3082", "EVT"), "MP");
  equal(api.isActiveNpiModel("X4026"), true);
  equal(api.isActiveNpiModel("X3082"), false);

  const other = { id: "PRJ-X3082", model: "X3082", phase: "EVT" };
  const normalized = api.withCanonicalProgramPhase(other);
  equal(normalized.phase, "MP");
  equal(other.phase, "EVT");
  equal(api.withCanonicalProgramPhase({ model: "X4151", phase: "EVT" }).phase, "EVT");

  equal(api.projectFromSettingsForm(PROJECT, { model: "X4152", phase: "DVT" }).phase, "DVT");
  equal(api.projectFromSettingsForm(PROJECT, { model: "X3082", phase: "EVT" }).phase, "MP");
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
