/**
 * Regression checks for the spec-gap fixes. Task 1 covers ID high-water marks:
 *
 *  - deleting the highest-numbered cost initiative must not reissue its CI- id
 *  - deleting the highest ME## build-matrix line must not reissue its config
 *  - a persisted counter never moves backwards
 *  - the plain numeric scan still works for older exports with no counter
 *
 * The helpers are read straight out of Part1_Data.html and Part4_ViewsB.html —
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
  part4: readFileSync(join(ROOT, "Part4_ViewsB.html"), "utf8")
};

/** Top-level declarations the checks are made of. Functions end at column 0. */
const DECLARATIONS = [
  { file: "part1", pattern: /function nextId\([\s\S]*?\n}/ },
  { file: "part1", pattern: /function withIdCounter\([\s\S]*?\n}/, optional: true },
  { file: "part1", pattern: /function getSideList\([\s\S]*?\n}/ },
  { file: "part4", pattern: /function nextBuildMatrixConfig\([\s\S]*?\n}/ }
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
    "withIdCounter: typeof withIdCounter === 'function' ? withIdCounter : undefined };"
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

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} spec-gap checks passed.\n`);
process.exit(failed ? 1 : 0);
