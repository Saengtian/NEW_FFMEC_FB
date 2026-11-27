/**
 * Generated-bundle freshness check.
 *
 * Bundle.html, SheetJs.html and Styles.html are build products (`bun run build`)
 * and the only generated files Apps Script actually runs, so a commit that edits
 * Part*.html, Icons.html or Index.html without rebuilding would ship an artifact
 * that does not match the source in the same commit.
 *
 * The check rebuilds and compares byte for byte. When they differ the checked-in
 * copy is put back, so the tests report a stale bundle instead of silently
 * regenerating it and hiding the problem.
 *
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-generated-bundle.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const OUTPUTS = ["Bundle.html", "SheetJs.html", "Styles.html"];

const committed = new Map(OUTPUTS.map((name) => [name, readFileSync(join(ROOT, name))]));
const build = spawnSync(process.execPath, ["tools/build.mjs"], { cwd: ROOT, encoding: "utf8" });

// Whatever happened, leave the working tree with the bundle it started with.
const restore = () => {
  for (const [name, bytes] of committed) {
    const path = join(ROOT, name);
    if (!readFileSync(path).equals(bytes)) writeFileSync(path, bytes);
  }
};

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (err) {
    results.push({ label, ok: false, message: err.message });
  }
}

try {
  check("tools/build.mjs exits cleanly", () => {
    assert.equal(
      build.status,
      0,
      `build failed (exit ${build.status}): ${(build.stderr || build.stdout || "").trim().slice(-400)}`
    );
  });

  check(`${OUTPUTS.join(" and ")} match a fresh build`, () => {
    assert.equal(build.status, 0, "build failed, so the comparison is meaningless");
    const stale = OUTPUTS.map((name) => {
      const before = committed.get(name);
      const fresh = readFileSync(join(ROOT, name));
      return before.equals(fresh) ? null : `${name} (${before.length} → ${fresh.length} bytes)`;
    }).filter(Boolean);
    if (stale.length > 0) {
      throw new Error(
        `stale generated file(s): ${stale.join(", ")} — run \`bun run build\` and commit them`
      );
    }
  });
} finally {
  restore();
}

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} generated-bundle checks passed.\n`);
process.exit(failed ? 1 : 0);
