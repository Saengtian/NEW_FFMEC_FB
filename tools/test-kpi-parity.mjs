/**
 * Parity checks between the Overview's inline KPI deep dive and the full modal.
 *
 * The two views are separate components, so this test pins the contract that
 * keeps them telling the same story:
 *   - App hands both views the same scoped arrays (never raw collections).
 *   - Overview forwards those arrays to the inline section unchanged.
 *   - Both components build their claims/saving sources and deep-dive view from
 *     the same props, range, cutoff and variant filter.
 *   - The full deep dive starts in the inline 90D / ALL state and receives the
 *     inline range and variant when opened.
 *
 * Run: bun tools/test-kpi-parity.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const appSource = readFileSync(join(ROOT, "Part2_App.html"), "utf8");
const overviewSource = readFileSync(join(ROOT, "Part3_ViewsA.html"), "utf8");
const moduleSource = readFileSync(join(ROOT, "Part5_Modules.html"), "utf8");

const DATA_PROPS = ["projects", "records", "gateRecords", "globalSide", "costProjects", "customerFeedback"];
const SCOPED_INPUTS = {
  projects: "scopedProjects",
  records: "scopedProductionRecords",
  gateRecords: "scopedGateRecords",
  globalSide: "globalSide",
  costProjects: "scopedCostProjects",
  customerFeedback: "scopedCustomerFeedback"
};
const INLINE_INPUTS = Object.fromEntries(DATA_PROPS.map((name) => [name, name]));

const normalize = (value) => value.replace(/\s+/g, " ").trim();

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

/** The opening tag's own source, stopping at the first self-closing slash. */
function jsxBlock(source, tag) {
  const start = source.indexOf(`<${tag}`);
  assert.notEqual(start, -1, `missing <${tag}> call site`);
  const end = source.indexOf("/>", start);
  assert.notEqual(end, -1, `missing self-closing /> for <${tag}>`);
  return source.slice(start, end + 2);
}

function prop(jsx, name) {
  const match = jsx.match(new RegExp(`\\b${name}=\\{([^}]*)\\}`));
  return match ? match[1].trim() : null;
}

const overviewCall = jsxBlock(appSource, "OverviewView");
const modalCall = jsxBlock(appSource, "KpiDeepDiveModal");
const inlineCall = jsxBlock(overviewSource, "KpiDeepDiveSection");

const modalBlock = between(
  moduleSource,
  "function KpiDeepDiveModal(",
  "const KPI_DEEP_DIVE_TABS"
);
const inlineBlock = between(
  moduleSource,
  "function KpiDeepDiveSection(",
  "// VIEW 10:"
);
const modalNorm = normalize(modalBlock);
const inlineNorm = normalize(inlineBlock);

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (error) {
    results.push({ label, ok: false, message: error.message });
  }
}
const equal = (actual, expected, message) => assert.strictEqual(actual, expected, message);
const includes = (haystack, needle, message) =>
  assert.ok(haystack.includes(needle), message || `missing: ${needle}`);

function assertProps(jsx, expected, label) {
  for (const name of DATA_PROPS) {
    equal(prop(jsx, name), expected[name], `${label} must receive ${expected[name]} for ${name}`);
  }
}

function builderArgs(block) {
  const calls = [...block.matchAll(/buildKpiDeepDiveView\(\{([\s\S]*?)\}\)/g)];
  equal(calls.length, 1, "each deep dive must call buildKpiDeepDiveView exactly once");
  return normalize(calls[0][1]);
}

check("App hands the same scoped arrays to the Overview and the full deep dive", () => {
  assertProps(overviewCall, SCOPED_INPUTS, "OverviewView");
  assertProps(modalCall, SCOPED_INPUTS, "KpiDeepDiveModal");
});

check("Overview forwards its scoped arrays to the inline deep dive unchanged", () => {
  assertProps(inlineCall, INLINE_INPUTS, "KpiDeepDiveSection");
  const signature = between(
    overviewSource,
    "function OverviewView({",
    "}) {"
  );
  for (const name of DATA_PROPS) {
    assert.match(signature, new RegExp(`\\b${name}\\b`), `OverviewView no longer accepts ${name}`);
  }
});

check("both deep dives derive claims and cost saving from the same props", () => {
  const sourceCall = normalize(
    "kpiDeepDiveSources({ projects, gateRecords, globalSide, customerFeedback, costProjects })"
  );
  includes(modalNorm, sourceCall, "the modal must build sources from the modal's scoped props");
  includes(inlineNorm, sourceCall, "the inline section must build sources from the same scoped props");
});

check("both deep dives build the view from exactly the same inputs", () => {
  const modalArgs = builderArgs(modalBlock);
  const inlineArgs = builderArgs(inlineBlock);
  equal(modalArgs, inlineArgs, "inline and modal buildKpiDeepDiveView inputs have drifted");
  for (const required of [
    "rangeDays: range.days",
    "rangeLabel: range.label",
    "cutoffIso",
    "variantFilter"
  ]) {
    includes(modalArgs, required, `the shared view inputs lost ${required}`);
  }
});

check("both deep dives start from the same range and variant state", () => {
  includes(inlineNorm, "const [rangeId, setRangeId] = useState('90D');");
  includes(inlineNorm, "const [variantFilter, setVariantFilter] = useState('ALL');");
  includes(modalNorm, "initialVariant = 'ALL'");
  includes(modalNorm, "initialRange = '90D'");
  includes(modalNorm, "useState(initialVariant || 'ALL')");
  includes(
    modalNorm,
    "option.id === initialRange) ? initialRange : '90D'",
    "the modal must keep a valid startup range from the inline handoff"
  );
});

check("the full deep dive keeps the inline range and variant", () => {
  includes(
    inlineNorm,
    "onClick={() => openDeepDive()}",
    "Full deep dive must hand off the active KPI, variant and range"
  );
  includes(
    normalize(appSource),
    "onOpenKpiDrilldown={(key, variant, range, print) => setKpiDrilldown({ key, variant: variant || 'ALL', range: range || '90D', print: Boolean(print) })",
    "App's KPI handoff must preserve the inline range and variant"
  );
  equal(prop(modalCall, "initialVariant"), "kpiDrilldown.variant");
  equal(prop(modalCall, "initialRange"), "kpiDrilldown.range");
});

check("the inline deep dive can export and print the same view", () => {
  includes(inlineNorm, "downloadKpiDeepDiveCsv(meta, view, range)", "the inline CSV must use the shared downloader");
  includes(inlineNorm, "const openDeepDive = (print = false) => {", "both actions must share one handoff");
  includes(inlineNorm, "onOpenDeepDive(kpiKey, activeVariant, range.id, print)", "the shared handoff must carry the current KPI, variant and range");
  includes(inlineNorm, "onClick={() => openDeepDive()}", "Full deep dive must use the shared handoff");
  includes(inlineNorm, "onClick={() => openDeepDive(true)}", "Print must use the shared handoff and request printing");
  includes(inlineNorm, "<Download", "the inline header must expose CSV");
  includes(inlineNorm, "<Printer", "the inline header must expose Print");
  includes(modalNorm, "downloadKpiDeepDiveCsv(meta, view, range)", "the modal CSV must use the same downloader");
  equal(prop(modalCall, "printOnOpen"), "kpiDrilldown.print");
  includes(normalize(appSource), "print: Boolean(print)", "App must carry the inline print request into the modal");
});

check("both deep dives render the same headline and view data", () => {
  for (const field of ["view.headline.text", "view.scopeLabel", "view.trend", "view.variant", "view.pareto"]) {
    includes(modalNorm, field, `the modal no longer renders ${field}`);
    includes(inlineNorm, field, `the inline section no longer renders ${field}`);
  }
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} KPI deep-dive parity checks passed.\n`);
process.exit(failed ? 1 : 0);
