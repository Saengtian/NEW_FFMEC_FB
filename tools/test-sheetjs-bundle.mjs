/**
 * SheetJS bundle checks.
 *
 * The app parses uploaded .xlsx / .xls files. That parser must come from the
 * compiled bundle (window.XLSX), never from a runtime CDN fetch: Workspace
 * networks block it, and an offline moment would break every Excel import.
 *
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-sheetjs-bundle.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const read = (name) => readFileSync(join(ROOT, name), "utf8");
const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (err) {
    results.push({ label, ok: false, message: err.message });
  }
}

check("Part1_Data.html has no CDN URL", () => {
  assert.ok(!read("Part1_Data.html").includes("cdn.sheetjs.com"));
});

check("loadSheetJsLib injects no script tag", () => {
  const body = read("Part1_Data.html").match(/async function loadSheetJsLib\(\)[\s\S]*?\n}/)?.[0];
  assert.ok(body, "loadSheetJsLib not found");
  assert.ok(!body.includes("createElement('script')"));
});

check("tools/build.mjs imports xlsx", () => {
  assert.ok(read("tools/build.mjs").includes("from 'xlsx'"));
});

check("Bundle.html has no CDN URL", () => {
  assert.ok(!read("Bundle.html").includes("cdn.sheetjs.com"));
});

check("Bundle.html contains SheetJS 0.20.2", () => {
  assert.ok(read("Bundle.html").includes("0.20.2"));
});

check("Bundle.html contains sheet_to_json", () => {
  assert.ok(read("Bundle.html").includes("sheet_to_json"));
});

check("Bundle.html has no raw http:// (Apps Script truncates the line)", () => {
  assert.ok(!read("Bundle.html").includes("http://"));
});

check("Bundle.html escapes http:// as http:\\/\\/", () => {
  assert.ok(read("Bundle.html").includes("http:\\/\\/"));
});

check("Bundle.html has no raw https:// (Apps Script truncates the line)", () => {
  assert.ok(!read("Bundle.html").includes("https://"));
});

check("Bundle.html escapes https:// as https:\\/\\/", () => {
  assert.ok(read("Bundle.html").includes("https:\\/\\/"));
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} SheetJS bundle checks passed.\n`);
process.exit(failed ? 1 : 0);
