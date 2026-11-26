/**
 * State-history checks.
 *
 * Two rules make a restore trustworthy:
 *   1. the per-slice diff is a faithful comparison of the workspace against an
 *      archived revision (that is what the History panel shows before you
 *      restore), and
 *   2. pruning only drops the oldest archived revisions, never a newer one.
 *
 * The helpers are read straight out of Part1_Data.html and Code.js — the same
 * text tools/build.mjs and clasp ship — so the tests cannot drift from a copy.
 *
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-state-history.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const part1 = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");
const code = readFileSync(join(ROOT, "Code.js"), "utf8");

function sliceText(source, from, to, label) {
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  if (start < 0 || end <= start) {
    console.error(`${label}: "${from}" … "${to}" not found — update this test, the helper moved.`);
    process.exit(1);
  }
  return source.slice(start, end);
}

const diffBlock = sliceText(
  part1,
  "// Human labels for the persisted workspace slices",
  "function triggerCsvDownload",
  "Part1_Data.html"
);
const pruneMatch = code.match(/function historyRevisionsToDrop_\([\s\S]*?\n}/);
if (!pruneMatch) {
  console.error("Code.js no longer declares historyRevisionsToDrop_ — update this test.");
  process.exit(1);
}

const api = new Function(
  `"use strict";\n${diffBlock}\n${pruneMatch[0]}\n` +
    "return { diffWorkspacePayloads, PAYLOAD_SLICE_LABELS, historyRevisionsToDrop_ };"
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
const eq = (actual, expected) => assert.deepStrictEqual(actual, expected);
const sliceOf = (slices, name) => slices.find((item) => item.slice === name);

const project = (id, overrides = {}) => ({ id, model: 'X4151', ...overrides });

check("identical payloads produce no differences", () => {
  const payload = { projects: [project('PRJ-1')], tasks: [] };
  eq(api.diffWorkspacePayloads(payload, JSON.parse(JSON.stringify(payload))), []);
});

check("a record added since the revision shows as only-in-current", () => {
  const local = { projects: [project('PRJ-1'), project('PRJ-2')] };
  const revision = { projects: [project('PRJ-1')] };
  const slices = api.diffWorkspacePayloads(local, revision);
  eq(slices.length, 1);
  eq(slices[0].onlyMine, ['PRJ-2 · X4151']);
  eq(slices[0].onlyTheirs, []);
  eq(slices[0].differing, []);
});

check("a record removed since the revision shows as only-in-revision", () => {
  const local = { projects: [project('PRJ-1')] };
  const revision = { projects: [project('PRJ-1'), project('PRJ-2')] };
  const slices = api.diffWorkspacePayloads(local, revision);
  eq(slices[0].onlyTheirs, ['PRJ-2 · X4151']);
  eq(slices[0].onlyMine, []);
});

check("an edited record is reported as changed, not added", () => {
  const local = { projects: [project('PRJ-1', { phase: 'DVT' })] };
  const revision = { projects: [project('PRJ-1', { phase: 'EVT' })] };
  const slices = api.diffWorkspacePayloads(local, revision);
  eq(slices[0].differing, ['PRJ-1 · X4151']);
  eq(slices[0].onlyMine, []);
  eq(slices[0].onlyTheirs, []);
});

check("object-keyed slices (gate records) diff by key", () => {
  const local = { gateRecords: { 'PRJ-1': { 'ME11-RHS': { mbo: { status: 'Approved' } } } } };
  const revision = { gateRecords: {} };
  const slices = api.diffWorkspacePayloads(local, revision);
  const gates = sliceOf(slices, 'gateRecords');
  eq(gates.label, 'Gate records');
  eq(gates.onlyMine, ['PRJ-1']);
});

check("slices that are empty on both sides are omitted", () => {
  const slices = api.diffWorkspacePayloads({ tasks: [], customerFeedback: [] }, { tasks: [], customerFeedback: [] });
  eq(slices, []);
});

check("every persisted slice has a human label", () => {
  eq(Object.keys(api.PAYLOAD_SLICE_LABELS).length, 10);
  eq(api.PAYLOAD_SLICE_LABELS.masterSpecs, 'Master specs');
  eq(api.PAYLOAD_SLICE_LABELS.scheduleOverrides, 'Schedule overrides');
  eq(api.PAYLOAD_SLICE_LABELS.teamMembers, 'Team members');
});

check("pruning drops only the oldest revisions", () => {
  eq(api.historyRevisionsToDrop_(['3', '4', '5', '6', '7', '8', '9'], 5), ['3', '4']);
  eq(api.historyRevisionsToDrop_(['1', '2', '3'], 5), []);
  eq(api.historyRevisionsToDrop_(['1', '2'], 1), ['1']);
  eq(api.historyRevisionsToDrop_([], 5), []);
});

check("pruning never keeps fewer than one revision", () => {
  eq(api.historyRevisionsToDrop_(['1', '2'], 0), ['1']);
  eq(api.historyRevisionsToDrop_(['1', '2'], undefined), ['1']);
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} state-history checks passed.\n`);
process.exit(failed ? 1 : 0);
