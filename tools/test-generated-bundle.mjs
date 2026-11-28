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

  // The served bundle is one inline <script>. Apps Script's HTML pipeline reads a
  // literal `<?` as a scriptlet and a raw `http://` as a comment start, and a
  // stray `</script` closes the tag early — each of those turns the served page
  // into a blank screen that `clasp push` reports as success. tools/build.mjs
  // escapes all three, so the payload must not contain them.
  check("the compiled bundle cannot be mangled by the HTML pipeline", () => {
    const bundle = readFileSync(join(ROOT, "Bundle.html"), "utf8");
    const open = bundle.indexOf("<script>");
    const close = bundle.lastIndexOf("</script>");
    assert.ok(open !== -1 && close > open, "Bundle.html is not a single inline script");
    const payload = bundle.slice(open + "<script>".length, close);
    for (const [pattern, why] of [
      [/<\?/, "a literal `<?` (Apps Script reads it as a template scriptlet)"],
      [/(^|[^:\\])http:\/\//, "a raw `http://` (Apps Script drops the rest of the line)"],
      [/<\/script/i, "a literal `</script` (it closes the inline tag early)"]
    ]) {
      const hit = payload.match(pattern);
      assert.ok(!hit, `Bundle.html contains ${why} near: ${hit ? payload.slice(Math.max(0, hit.index - 60), hit.index + 60).replace(/\s+/g, " ") : ""}`);
    }
  });

  check("Index.html keeps its scriptlets and adds none to the served markup", () => {
    const index = readFileSync(join(ROOT, "Index.html"), "utf8");
    assert.ok(index.includes("<?!= include('Bundle') ?>"), "the bundle include must stay a template scriptlet");
    assert.ok(index.includes("<?!= serverConfigJson ?>"), "the config injection must stay a template scriptlet");
    // Everything outside a scriptlet is served as-is: a stray `<?` there would be
    // read as a scriptlet Apps Script cannot resolve.
    const withoutScriptlets = index.replace(/<\?!=?[\s\S]*?\?>/g, "");
    assert.ok(!withoutScriptlets.includes("<?"), "Index.html has a `<?` that is not a closed scriptlet");
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
