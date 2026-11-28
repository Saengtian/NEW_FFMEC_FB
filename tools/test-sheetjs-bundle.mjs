/**
 * SheetJS lazy-load checks.
 *
 * The app parses uploaded .xlsx / .xls files, but the parser is ~486 KB minified
 * and only an Excel import needs it. It must live in SheetJs.html, outside the
 * startup Bundle.html, and load once on the first Excel import. It must also
 * come from the project, never from a runtime CDN fetch: Workspace networks
 * block it, and an offline moment would break every Excel import.
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

const bundle = read("Bundle.html");
const sheetjs = read("SheetJs.html");
const part1 = read("Part1_Data.html");
const build = read("tools/build.mjs");
const code = read("Code.js");
const preview = read("tools/preview-server.mjs");

check("Part1_Data.html has no CDN URL", () => {
  assert.ok(!part1.includes("cdn.sheetjs.com"));
});

check("Bundle.html leaves the parser out", () => {
  assert.ok(!bundle.includes("cdn.sheetjs.com"));
  assert.ok(!bundle.includes("0.20.2"), "Bundle.html still contains the SheetJS version");
  // A ceiling on the app's own code, not a byte budget to squeeze under: the
  // parser is ~486 KB, so a bundle that inlined it would land near 1.4 MB.
  assert.ok(bundle.length < 1200 * 1024, `Bundle.html is ${(bundle.length / 1024).toFixed(0)} KB`);
});

check("SheetJs.html contains the parser", () => {
  assert.ok(sheetjs.includes("0.20.2"));
  assert.ok(sheetjs.includes("sheet_to_json"));
  assert.ok(sheetjs.length > 400 * 1024);
});

check("SheetJs.html is local and safe to inline", () => {
  assert.ok(!sheetjs.includes("cdn.sheetjs.com"));
  assert.ok(!sheetjs.includes("http://"), "raw http:// would truncate the line in Apps Script");
  assert.ok(sheetjs.includes("http:\\/\\/"));
});

check("loadSheetJsLib fetches on first use and caches the promise", () => {
  const body = part1.match(/async function loadSheetJsLib\(\)[\s\S]*?\n}/)?.[0];
  assert.ok(body, "loadSheetJsLib not found");
  assert.ok(body.includes("sheetJsLoadPromise"));
  assert.ok(body.includes("window.XLSX"));
  assert.ok(!/https?:/.test(body), "the loader must not reference a URL");
});

check("the parser source is requested from the server, not a script src", () => {
  assert.ok(part1.includes("getSheetJsSource"));
  assert.ok(part1.includes("google.script.run"));
  assert.ok(!/createElement\('script'\)[\s\S]{0,120}\.src\s*=/.test(part1));
});

check("the server serves SheetJs.html on demand", () => {
  assert.match(code, /function getSheetJsSource\(\)/);
  assert.ok(code.includes("createHtmlOutputFromFile('SheetJs')"));
  assert.ok(code.includes(".getContent()"));
});

check("CSV parsing returns before the SheetJS loader", () => {
  const body = part1.match(/async function parseUploadedTabularFile\(file\)[\s\S]*?\n}/)?.[0];
  assert.ok(body, "parseUploadedTabularFile not found");
  const csv = body.indexOf("parseCsvText");
  const xlsx = body.indexOf("loadSheetJsLib");
  assert.ok(csv > -1 && xlsx > csv, "the CSV branch must finish before loadSheetJsLib");
  const csvBranch = body.slice(0, body.indexOf("if (name.endsWith('.xlsx')"));
  assert.ok(!csvBranch.includes("XLSX"), "the CSV branch must not reference XLSX");
});

check("tools/build.mjs builds the parser as its own file", () => {
  const prelude = build.match(/const PRELUDE = `([\s\S]*?)`;/)?.[1] || "";
  assert.ok(!prelude.includes("xlsx"), "the startup prelude must not import xlsx");
  assert.ok(build.includes("buildSheetJs"));
  assert.ok(build.includes("SheetJs.html"));
});

check("the preview serves the same built source", () => {
  assert.ok(preview.includes("getSheetJsSource"));
  assert.ok(preview.includes("/sheetjs.js"));
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} SheetJS lazy-load checks passed.\n`);
process.exit(failed ? 1 : 0);
