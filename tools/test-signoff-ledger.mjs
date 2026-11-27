/**
 * Checks for the read-only gate decision ledger:
 *
 *  - the ledger is matched to the saved gate records by program + line + gate +
 *    approver, so a decision is never matched across programs or lines
 *  - a saved decision the ledger never received is reported (the failed append)
 *  - a ledger decision the saved state no longer holds is reported (reopened)
 *  - seeded decisions are not reported, because the server deliberately does not
 *    log dossiers that already existed when the decision was seeded
 *  - a decision that merely changed is history, not divergence
 *  - the CSV keeps the tab's column order and neutralizes formula injection
 *
 * The helpers are read straight out of Part1_Data.html — the same text
 * tools/build.mjs compiles — so the tests cannot drift from a copy of the rule.
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-signoff-ledger.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const source = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");

const DECLARATIONS = [
  /const NPI_GATES = \[[\s\S]*?\n\];/,
  /function csvText\([\s\S]*?\n}/,
  /const SIGN_OFF_LEDGER_DECISIONS = \[[^\]]*\];/,
  /function signOffGateLabel\([\s\S]*?\n}/,
  /function signOffLedgerKey\([\s\S]*?\n}/,
  /function signOffStateDecisions\([\s\S]*?\n}/,
  /function reconcileSignOffLedger\([\s\S]*?\n}/,
  /function signOffLedgerCsv\([\s\S]*?\n}/
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
    "return { NPI_GATES, csvText, SIGN_OFF_LEDGER_DECISIONS, signOffGateLabel, signOffLedgerKey, signOffStateDecisions, reconcileSignOffLedger, signOffLedgerCsv };"
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
const equal = (actual, expected) => assert.strictEqual(actual, expected);
const deep = (actual, expected) => assert.deepStrictEqual(actual, expected);

const PROJECTS = [{ id: "PRJ-A", model: "X4151" }];

// What the app seeded: an EM approval on MBO and a pending QA reviewer on BRR.
const SEED = {
  "PRJ-A": {
    "ME11-RHS": {
      mbo: { approvers: [{ name: "Horikawa", role: "Engineering Manager", decision: "Approved" }] },
      bbr: { approvers: [{ name: "Panida", role: "Quality Manager", decision: "Pending" }] }
    }
  }
};

// A human approved the BRR after the seed: this must reach the ledger.
const STATE = {
  "PRJ-A": {
    "ME11-RHS": {
      mbo: { approvers: [{ name: "Horikawa", role: "Engineering Manager", decision: "Approved" }] },
      bbr: { approvers: [{ name: "Panida", role: "Quality Manager", decision: "Approved", updatedAt: "Today 10:15" }] }
    }
  }
};

const row = (over = {}) => ({
  timestamp: "2026-11-27T09:00:00Z",
  revision: "5",
  programId: "PRJ-A",
  program: "X4151",
  line: "ME11-RHS",
  gate: "G2 BBR",
  approver: "Panida",
  role: "Quality Manager",
  decision: "Approved",
  remark: "",
  signedInEmail: "qa@minebea.co.th",
  ...over
});

check("gate ids map to the labels the server writes", () => {
  equal(api.signOffGateLabel("mbo"), "G4 MBO & OK2B");
  equal(api.signOffGateLabel("brr"), "G3 BRR");
  equal(api.signOffGateLabel("bbr"), "G2 BBR");
  equal(api.signOffGateLabel("not-a-gate"), "not-a-gate");
});

check("the ledger is in sync when the saved decision is in the tab", () => {
  const result = api.reconcileSignOffLedger(STATE, PROJECTS, [row()], SEED);
  equal(result.inSync, true);
  equal(result.missingFromLedger.length, 0);
  equal(result.missingFromState.length, 0);
  equal(result.stateDecisionCount, 2);
  equal(result.ledgerDecisionCount, 1);
  // Counted from the ledger, not from the state: the seeded MBO approval is in
  // the tab but never reached the ledger, so it is not a match.
  equal(result.matched, 1);
});

check("an empty ledger matches nothing, even when every decision is a seed", () => {
  const result = api.reconcileSignOffLedger(SEED, PROJECTS, [], SEED);
  equal(result.stateDecisionCount, 1);
  equal(result.ledgerDecisionCount, 0);
  equal(result.matched, 0);
  equal(result.missingFromLedger.length, 0, "a seed value was never meant to be logged");
  equal(result.inSync, true);
});

check("a saved decision the ledger never got is reported with its identity", () => {
  const result = api.reconcileSignOffLedger(STATE, PROJECTS, [], SEED);
  equal(result.inSync, false);
  equal(result.missingFromLedger.length, 1);
  const entry = result.missingFromLedger[0];
  equal(entry.programId, "PRJ-A");
  equal(entry.program, "X4151");
  equal(entry.line, "ME11-RHS");
  equal(entry.gate, "G2 BBR");
  equal(entry.approver, "Panida");
  equal(entry.decision, "Approved");
  equal(entry.at, "Today 10:15");
});

check("seeded decisions are not reported as missing from the ledger", () => {
  const result = api.reconcileSignOffLedger(STATE, PROJECTS, [row()], SEED);
  const flaggedApprovers = result.missingFromLedger.map((entry) => entry.approver);
  deep(flaggedApprovers, []);
  // Without the seed every decision is compared, so the seeded EM approval shows.
  const noSeed = api.reconcileSignOffLedger(STATE, PROJECTS, [row()]);
  equal(noSeed.missingFromLedger.length, 1);
  equal(noSeed.missingFromLedger[0].approver, "Horikawa");
});

check("a ledger decision with no decision in state is reported", () => {
  const result = api.reconcileSignOffLedger(STATE, PROJECTS, [row(), row({ line: "ME12-LHS", revision: "6" })], SEED);
  equal(result.missingFromState.length, 1);
  equal(result.missingFromState[0].line, "ME12-LHS");
  equal(result.missingFromState[0].revision, "6");
  equal(result.inSync, false, "a ledger-only decision is a disagreement in the other direction");
});

check("a reopened gate (decision back to Pending) shows as missing from state", () => {
  const reopened = {
    "PRJ-A": {
      "ME11-RHS": {
        mbo: { approvers: [{ name: "Horikawa", role: "Engineering Manager", decision: "Approved" }] },
        bbr: { approvers: [{ name: "Panida", role: "Quality Manager", decision: "Pending" }] }
      }
    }
  };
  const result = api.reconcileSignOffLedger(reopened, PROJECTS, [row()], SEED);
  equal(result.missingFromState.length, 1);
  equal(result.missingFromState[0].approver, "Panida");
});

check("a changed decision keeps history out of the divergence list", () => {
  const rejected = {
    "PRJ-A": {
      "ME11-RHS": {
        mbo: { approvers: [{ name: "Horikawa", role: "Engineering Manager", decision: "Approved" }] },
        bbr: { approvers: [{ name: "Panida", role: "Quality Manager", decision: "Rejected" }] }
      }
    }
  };
  // The tab holds the earlier approval and the later rejection.
  const history = [row({ revision: "5" }), row({ revision: "7", decision: "Rejected" })];
  const result = api.reconcileSignOffLedger(rejected, PROJECTS, history, SEED);
  equal(result.missingFromLedger.length, 0);
  equal(result.missingFromState.length, 0);
  equal(result.inSync, true);
});

check("a decision that never reached the ledger is still flagged after a change", () => {
  const rejected = {
    "PRJ-A": {
      "ME11-RHS": {
        mbo: { approvers: [{ name: "Horikawa", role: "Engineering Manager", decision: "Approved" }] },
        bbr: { approvers: [{ name: "Panida", role: "Quality Manager", decision: "Rejected" }] }
      }
    }
  };
  const result = api.reconcileSignOffLedger(rejected, PROJECTS, [row({ revision: "5" })], SEED);
  equal(result.missingFromLedger.length, 1);
  equal(result.missingFromLedger[0].decision, "Rejected");
});

check("non-decisions are ignored on both sides", () => {
  const pendingOnly = {
    "PRJ-A": {
      "ME11-RHS": {
        bbr: { approvers: [{ name: "Panida", role: "Quality Manager", decision: "Pending" }] }
      }
    }
  };
  const result = api.reconcileSignOffLedger(pendingOnly, PROJECTS, [row({ decision: "Pending" })], SEED);
  equal(result.stateDecisionCount, 0);
  equal(result.ledgerDecisionCount, 0);
  equal(result.missingFromLedger.length, 0);
  equal(result.missingFromState.length, 0);
});

check("decisions are matched per program, line, gate and approver", () => {
  const otherProgram = { ...row(), programId: "PRJ-B" };
  const result = api.reconcileSignOffLedger(STATE, PROJECTS, [otherProgram], SEED);
  equal(result.missingFromLedger.length, 1, "a row from another program must not satisfy this program's decision");
  equal(result.missingFromState.length, 1);
});

check("the CSV keeps the tab's column order", () => {
  const csv = api.signOffLedgerCsv([row({ remark: 'Hold "ME13" until OMM clears' })]);
  const lines = csv.split("\n");
  equal(lines.length, 2);
  equal(
    lines[0],
    "Timestamp,Revision,ProgramID,Program,Line,Gate,Approver,Role,Decision,Remark,SignedInEmail"
  );
  equal(
    lines[1],
    '"2026-11-27T09:00:00Z","5","PRJ-A","X4151","ME11-RHS","G2 BBR","Panida","Quality Manager","Approved","Hold ""ME13"" until OMM clears","qa@minebea.co.th"'
  );
});

check("CSV cells that look like formulas are neutralized", () => {
  const csv = api.signOffLedgerCsv([row({ remark: "=HYPERLINK(\"http://x\")" })]);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`), "formula lead-in should be quoted with a leading apostrophe");
});

check("an empty ledger exports just the header", () => {
  equal(api.signOffLedgerCsv([]).split("\n").length, 1);
  equal(api.signOffLedgerCsv(null).split("\n").length, 1);
});

for (const result of results) {
  console.log(`  ${result.ok ? "pass" : "FAIL"}  ${result.label}${result.ok ? "" : `  (${result.message})`}`);
}
const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} sign-off ledger checks passed.\n`);
process.exit(failed ? 1 : 0);
