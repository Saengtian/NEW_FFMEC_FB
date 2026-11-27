/**
 * Server-side permission checks.
 *
 * Two rules decide whether a save is allowed, both judged against the store as
 * it stands rather than against anything the client sends:
 *
 *   1. a program may only be added, rewritten or removed by someone the roster
 *      gives it to (a member's `products` / `externalProducts` in the
 *      `teamMembers` slice name the programs they own), and only the spreadsheet
 *      owner may change the roster itself;
 *   2. a signature records a person, so a gate decision this save records or
 *      erases must carry the signed-in user's own roster name.
 *
 * The helpers are read straight out of Code.js — the same text clasp ships — so
 * the tests cannot drift from a copy of a rule.
 *
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-server-permissions.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const code = readFileSync(join(ROOT, "Code.js"), "utf8");

const DECLARATIONS = [
  /const GATE_LEDGER_LABELS = \{[\s\S]*?\n\};/,
  /function identityKey_\([\s\S]*?\n}/,
  /function canonicalValue_\([\s\S]*?\n}/,
  /function rosterMemberFor_\([\s\S]*?\n}/,
  /function ownedModels_\([\s\S]*?\n}/,
  /function ownsModel_\([\s\S]*?\n}/,
  /function changedProjects_\([\s\S]*?\n}/,
  /function changedRosterEntries_\([\s\S]*?\n}/,
  /function spreadsheetOwnerEmail_\([\s\S]*?\n}/,
  /function isSpreadsheetOwner_\([\s\S]*?\n}/,
  /function describeProgramChange_\([\s\S]*?\n}/,
  /function ownedModelNames_\([\s\S]*?\n}/,
  /function authorizeWorkspaceSave_\([\s\S]*?\n}/,
  /function signOffSignatureEdits_\([\s\S]*?\n}/,
  /function foreignSignOffEdits_\([\s\S]*?\n}/,
  /function signOffLedgerRows\([\s\S]*?\n}/
];

const pieces = DECLARATIONS.map((pattern) => {
  const match = code.match(pattern);
  if (!match) {
    console.error(`Code.js no longer declares ${pattern} — update this test, the helper moved.`);
    process.exit(1);
  }
  return match[0];
});

const api = new Function(
  `"use strict";\n${pieces.join("\n")}\n` +
    "return { identityKey_, canonicalValue_, rosterMemberFor_, ownsModel_, changedProjects_, " +
    "changedRosterEntries_, isSpreadsheetOwner_, authorizeWorkspaceSave_, signOffSignatureEdits_, " +
    "foreignSignOffEdits_, signOffLedgerRows };"
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
const equal = (actual, expected, why) => assert.strictEqual(actual, expected, why);
const deep = (actual, expected) => assert.deepStrictEqual(actual, expected);

// The roster is the permission source: email to identify, products to own, role
// to describe the signer. Horikawa and Panida own no program on purpose — that is
// the quality team, which signs across every program but changes none of them.
const ROSTER = [
  { id: "TM-01", name: "Horikawa", role: "Engineering Manager", email: "horikawa@minebea.co.th", products: [] },
  { id: "TM-12", name: "Patcharapong", role: "NPI Engineer", email: "patcharapong@minebea.co.th", products: ["X4151", "X4026"] },
  { id: "TM-07", name: "Chanoknan", role: "NPI Engineer", email: "chanoknan@minebea.co.th", products: ["X4152"] },
  { id: "TM-14", name: "Panida", role: "Quality Manager", email: "panida@minebea.co.th", products: [] }
];

const PROJECTS = [
  { id: "PRJ-X4151-01", model: "X4151", phase: "EVT", owner: "Patcharapong J." },
  { id: "PRJ-X4152-01", model: "X4152", phase: "EVT", owner: "Chanoknan" }
];

const store = (over = {}) => ({
  projects: PROJECTS,
  teamMembers: ROSTER,
  gateRecords: {},
  ...over
});

const withProject = (id, patch) =>
  PROJECTS.map((project) => (project.id === id ? { ...project, ...patch } : project));

const PAT = "patcharapong@minebea.co.th";
const PAN = "panida@minebea.co.th";
const OWNER = "owner@minebea.co.th";

// --- programs ---------------------------------------------------------------

check("the roster owner of a program may rewrite it", () => {
  const result = api.authorizeWorkspaceSave_(
    store(),
    { projects: withProject("PRJ-X4151-01", { phase: "DVT" }), teamMembers: ROSTER },
    PAT,
    false
  );
  equal(result.ok, true, result.error);
  equal(result.actorName, "Patcharapong");
  equal(result.actorRole, "NPI Engineer");
});

check("another model's program is refused, named the way the roster names it", () => {
  const result = api.authorizeWorkspaceSave_(
    store(),
    { projects: withProject("PRJ-X4152-01", { phase: "DVT" }), teamMembers: ROSTER },
    PAT,
    false
  );
  equal(result.ok, false);
  assert.match(result.error, /PRJ-X4152-01/);
  assert.match(result.error, /X4152/);
  assert.match(result.error, /X4151/);
});

check("the spreadsheet owner may change any program", () => {
  const result = api.authorizeWorkspaceSave_(
    store(),
    { projects: withProject("PRJ-X4152-01", { phase: "MP" }), teamMembers: ROSTER },
    OWNER,
    true
  );
  equal(result.ok, true, result.error);
  equal(result.isOwner, true);
});

check("an account that is not on the roster owns nothing and is told how to fix it", () => {
  const result = api.authorizeWorkspaceSave_(
    store(),
    { projects: withProject("PRJ-X4151-01", { phase: "DVT" }), teamMembers: ROSTER },
    "stranger@minebea.co.th",
    false
  );
  equal(result.ok, false);
  assert.match(result.error, /not on the team roster/);
  assert.match(result.error, /Team & Workload/);
});

check("a new program needs the roster to own its model", () => {
  const created = [...PROJECTS, { id: "PRJ-X9999-01", model: "X9999", phase: "EVT" }];
  const patch = api.authorizeWorkspaceSave_(store(), { projects: created, teamMembers: ROSTER }, PAT, false);
  equal(patch.ok, false);
  assert.match(patch.error, /add PRJ-X9999-01/);
});

check("removing someone else's program is refused", () => {
  const result = api.authorizeWorkspaceSave_(
    store(),
    { projects: PROJECTS.filter((project) => project.id !== "PRJ-X4152-01"), teamMembers: ROSTER },
    PAT,
    false
  );
  equal(result.ok, false);
  assert.match(result.error, /remove PRJ-X4152-01/);
});

check("renaming a program to a model the roster does not own is refused", () => {
  const result = api.authorizeWorkspaceSave_(
    store(),
    { projects: withProject("PRJ-X4151-01", { model: "X9999" }), teamMembers: ROSTER },
    PAT,
    false
  );
  equal(result.ok, false, "owning the old model is not owning the new one");
});

check("a save that carries programs forward unchanged needs no program permission", () => {
  const result = api.authorizeWorkspaceSave_(
    store(),
    { projects: PROJECTS.map((project) => ({ ...project })), teamMembers: ROSTER, tasks: [{ id: "T-1" }] },
    PAN,
    false
  );
  equal(result.ok, true, result.error);
});

check("an omitted projects slice is a removal of every program, not an empty diff", () => {
  const result = api.authorizeWorkspaceSave_(store(), { teamMembers: ROSTER }, PAN, false);
  equal(result.ok, false);
  assert.match(result.error, /remove PRJ-X4151-01/);
});

check("product ownership ignores case and padding", () => {
  const padded = [{ ...ROSTER[1], products: [" x4151 "] }];
  const result = api.authorizeWorkspaceSave_(
    store({ teamMembers: padded }),
    { projects: withProject("PRJ-X4151-01", { phase: "DVT" }), teamMembers: padded },
    PAT,
    false
  );
  equal(result.ok, true, result.error);
});

check("the first seed is allowed: the roster it would be judged by does not exist yet", () => {
  const result = api.authorizeWorkspaceSave_(null, { projects: PROJECTS, teamMembers: ROSTER }, PAT, false);
  equal(result.ok, true, result.error);
});

// --- the roster itself ------------------------------------------------------

check("a non-owner cannot grant themselves a program", () => {
  const escalated = ROSTER.map((member) =>
    member.email === PAN ? { ...member, products: ["X4151", "X4152"] } : member
  );
  const result = api.authorizeWorkspaceSave_(
    store(),
    { projects: PROJECTS, teamMembers: escalated },
    PAN,
    false
  );
  equal(result.ok, false);
  assert.match(result.error, /team roster is owner data/);
  assert.match(result.error, /Panida/);
});

check("a non-owner cannot change anyone's role or email", () => {
  const promoted = ROSTER.map((member) =>
    member.email === PAN ? { ...member, role: "Engineering Manager" } : member
  );
  equal(api.authorizeWorkspaceSave_(store(), { projects: PROJECTS, teamMembers: promoted }, PAN, false).ok, false);
});

check("the spreadsheet owner may change the roster", () => {
  const rosterChanged = [
    ...ROSTER,
    { id: "TM-15", name: "New Person", role: "NPI Engineer", email: "new@minebea.co.th", products: ["X4151"] }
  ];
  const result = api.authorizeWorkspaceSave_(store(), { projects: PROJECTS, teamMembers: rosterChanged }, OWNER, true);
  equal(result.ok, true, result.error);
});

check("a roster carried forward with different key order is not a change", () => {
  const reordered = ROSTER.map((member) => ({
    products: member.products,
    role: member.role,
    email: member.email,
    name: member.name,
    id: member.id
  }));
  const result = api.authorizeWorkspaceSave_(store(), { projects: PROJECTS, teamMembers: reordered }, PAN, false);
  equal(result.ok, true, result.error);
});

// --- signatures -------------------------------------------------------------

const gates = (approvers) => ({ "PRJ-X4151-01": { "ME11-RHS": { mbo: { approvers } } } });
const EM = { name: "Horikawa", role: "Engineering Manager", decision: "Pending", remark: "" };
const PE = { name: "Patcharapong", role: "Program Engineer", decision: "Pending", remark: "" };

check("a decision under someone else's name is refused", () => {
  const edits = api.foreignSignOffEdits_(
    gates([{ ...EM, decision: "Pending" }]),
    gates([{ ...EM, decision: "Approved" }]),
    "Patcharapong"
  );
  equal(edits.length, 1);
  equal(edits[0].approver, "Horikawa");
  equal(edits[0].decision, "Approved");
});

check("the signed-in user may record their own decision, whatever the case", () => {
  const edits = api.foreignSignOffEdits_(
    gates([{ ...PE, decision: "Pending" }]),
    gates([{ ...PE, name: "patcharapong", decision: "Rejected" }]),
    "Patcharapong"
  );
  deep(edits, []);
});

check("signing with your own Workspace email is your signature", () => {
  // The sign-off modal records the Google email as the approver name, so the
  // rule has to read the email as the same person as the roster entry.
  const edits = api.foreignSignOffEdits_(
    gates([{ ...PE, decision: "Pending" }]),
    gates([{ ...PE, name: PAT, decision: "Approved" }]),
    "Patcharapong",
    PAT
  );
  deep(edits, []);
});

check("a colleague's email is still someone else", () => {
  const edits = api.foreignSignOffEdits_(
    gates([{ ...EM, decision: "Pending" }]),
    gates([{ ...EM, name: "horikawa@minebea.co.th", decision: "Approved" }]),
    "Patcharapong",
    PAT
  );
  equal(edits.length, 1);
});

check("erasing a colleague's decision is refused like writing one", () => {
  const edits = api.foreignSignOffEdits_(
    gates([{ ...PE, decision: "Approved" }, { ...EM, decision: "Approved" }]),
    gates([{ ...PE, decision: "Approved" }]),
    "Patcharapong"
  );
  equal(edits.length, 1);
  equal(edits[0].kind, "removal");
  equal(edits[0].approver, "Horikawa");
});

check("signatures carried forward unchanged are history, not a violation", () => {
  const edits = api.foreignSignOffEdits_(
    gates([{ ...EM, decision: "Approved" }, { ...PE, decision: "Pending" }]),
    gates([{ ...EM, decision: "Approved" }, { ...PE, decision: "Approved" }]),
    "Patcharapong"
  );
  deep(edits, []);
});

check("an account with no roster name can sign nothing", () => {
  const edits = api.foreignSignOffEdits_(
    gates([{ ...PE, decision: "Pending" }]),
    gates([{ ...PE, decision: "Approved" }]),
    ""
  );
  equal(edits.length, 1);
});

check("a dossier this save created is not a signature", () => {
  deep(api.signOffSignatureEdits_({}, gates([{ ...PE, decision: "Approved" }])), []);
  deep(api.signOffSignatureEdits_(null, gates([{ ...PE, decision: "Approved" }])), []);
});

check("the ledger row carries the signer's roster role, not the slot's", () => {
  const rows = api.signOffLedgerRows(
    gates([{ ...PE, decision: "Pending" }]),
    gates([{ ...PE, decision: "Approved" }]),
    [{ id: "PRJ-X4151-01", model: "X4151" }],
    {
      timestamp: "2026-11-27T09:00:00.000Z",
      revision: 8,
      userEmail: PAT,
      actorRole: "NPI Engineer"
    }
  );
  equal(rows.length, 1);
  equal(rows[0][7], "NPI Engineer");
  equal(rows[0][8], "Approved");
});

check("a removal writes no ledger row of its own", () => {
  const rows = api.signOffLedgerRows(
    gates([{ ...PE, decision: "Approved" }, { ...EM, decision: "Approved" }]),
    gates([{ ...PE, decision: "Approved" }]),
    [{ id: "PRJ-X4151-01", model: "X4151" }],
    { timestamp: "2026-11-27T09:00:00.000Z", revision: 8, userEmail: PAT }
  );
  deep(rows, []);
});

// --- the save path ----------------------------------------------------------

const saveBody = code.slice(
  code.indexOf("function saveWorkspaceState"),
  code.indexOf("function signOffLedgerRows")
);

check("the save path decides permissions before it writes anything", () => {
  const decideAt = saveBody.indexOf("authorizeWorkspaceSave_");
  const writeAt = saveBody.indexOf("stateSheet.clearContents()");
  assert.ok(decideAt !== -1, "saveWorkspaceState no longer calls authorizeWorkspaceSave_");
  assert.ok(writeAt !== -1, "the state write moved");
  assert.ok(decideAt < writeAt, "permissions are checked after the state is written");
});

check("permissions are judged on the stored roster, not the incoming payload", () => {
  const callAt = saveBody.indexOf("authorizeWorkspaceSave_(");
  const endAt = saveBody.indexOf("isSpreadsheetOwner_(ss, userEmail)");
  assert.ok(callAt !== -1 && endAt > callAt, "the permission call moved");
  const decisionArgs = saveBody.slice(callAt, endAt);
  assert.match(decisionArgs, /projects: previousSlice_\(previousRows, 'projects'\)/);
  assert.match(decisionArgs, /teamMembers: previousSlice_\(previousRows, 'teamMembers'\)/);
  assert.ok(
    !/payload\.(projects|teamMembers)/.test(decisionArgs),
    "the permission check trusts the payload's own slices"
  );
});

check("a refused save throws before the ledger is built", () => {
  const refusalAt = saveBody.indexOf("Save refused:");
  const ledgerAt = saveBody.indexOf("signOffRows = signOffLedgerRows(");
  assert.ok(refusalAt !== -1 && ledgerAt !== -1);
  assert.ok(refusalAt < ledgerAt, "the signature guard runs after ledger rows are built");
});

let passed = 0;
for (const result of results) {
  if (result.ok) {
    passed += 1;
    console.log(`  pass  ${result.label}`);
  } else {
    console.log(`  FAIL  ${result.label}  (${result.message})`);
  }
}
console.log(`\n${passed}/${results.length} server permission checks passed.`);
if (passed !== results.length) process.exit(1);
