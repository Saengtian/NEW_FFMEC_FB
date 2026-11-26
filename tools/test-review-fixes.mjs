/**
 * Regression checks for the review fixes:
 *
 *  - spec limit history is append-only (an edit that changes an existing date
 *    is rejected, not silently rewritten)
 *  - KPI scope labels share one fiscal-year window
 *  - a committed stage drag passes only the fields onReschedule consumes
 *  - only hand-attached Drive links survive onto a gate dossier (the seeded
 *    placeholders opened a 404)
 *  - a Gantt bar's colour and its click name the same line (the weakest one on a
 *    Compact Config row, which spans both sides), the tone list runs best to
 *    worst, and anything the list does not know reads as not signed off
 *  - a dragged stage is only saved when it still fits between its neighbouring
 *    stages and inside the line's FATP MIH
 *  - a team member's workload counts only the programs they own, and matches
 *    their name among multi-name approvers
 *
 * The helpers are read straight out of Part1_Data.html — the same text
 * tools/build.mjs compiles — so the tests cannot drift from a copy of a rule.
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-review-fixes.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const source = readFileSync(join(ROOT, "Part1_Data.html"), "utf8");

/** Top-level declarations the fixes are made of. Functions end at column 0. */
const DECLARATIONS = [
  /const FISCAL_YEAR_START_MONTH = \d+;/,
  /const KPI_FISCAL_YEAR = \d+;/,
  /const SPEC_LIMIT_FIELDS = \[[^\]]*\];/,
  /const SPEC_BASELINE_EFFECTIVE = '[^']+';/,
  /function fiscalYearWindow\([\s\S]*?\n}/,
  /function specLimitSnapshot\([\s\S]*?\n}/,
  /function getSpecRevisions\([\s\S]*?\n}/,
  /function specLimitsDiffer\([\s\S]*?\n}/,
  /function applySpecLimitEdit\([\s\S]*?\n}/,
  /function kpiFiscalScopeLabel\([\s\S]*?\n}/,
  /function stageDragReschedulePayload\([\s\S]*?\n}/,
  /const PLACEHOLDER_EVIDENCE_URL = [^\n]+;/,
  /function isOpenableEvidenceUrl\([\s\S]*?\n}/,
  /function purgePlaceholderEvidence\([\s\S]*?\n}/,
  /const GANTT_GATE_TONES = \[[\s\S]*?\n\];/,
  /const GANTT_GATE_UNSIGNED_TONE = [^\n]+;/,
  /function ganttGateTone\([\s\S]*?\n}/,
  /function ganttStageGateDriver\([\s\S]*?\n}/,
  /const GANTT_STAGES = \[[\s\S]*?\n\];/,
  /function parseIsoDate\([\s\S]*?\n}/,
  /function diffDaysIso\([\s\S]*?\n}/,
  /function stageMoveConflict\([\s\S]*?\n}/,
  /const NPI_GATES = \[[\s\S]*?\n\];/,
  /function computeTeamWorkload\([\s\S]*?\n}/,
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
    "return { KPI_FISCAL_YEAR, applySpecLimitEdit, kpiFiscalScopeLabel, stageDragReschedulePayload, isOpenableEvidenceUrl, purgePlaceholderEvidence, ganttStageGateDriver, ganttGateTone, GANTT_GATE_TONES, GANTT_GATE_UNSIGNED_TONE, stageMoveConflict, computeTeamWorkload };"
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

const LIMITS_V1 = { specType: 'upper', lsl: 0, nominal: 1, usl: 2, cpkTarget: 1.33 };
const LIMITS_V2 = { specType: 'upper', lsl: 0, nominal: 1, usl: 1.8, cpkTarget: 1.67 };
const REVISION_V1 = {
  id: 'SPEC-TIR-R1',
  effectiveFrom: '2026-04-01',
  ...LIMITS_V1,
  updatedAt: '2026-04-01T00:00:00.000Z',
  updatedBy: 'owner@example.com'
};
const SPEC_V1 = {
  id: 'SPEC-TIR',
  code: 'TIR',
  name: 'Bearing Runout',
  ...LIMITS_V1,
  effectiveFrom: REVISION_V1.effectiveFrom,
  revisions: [{ ...REVISION_V1 }]
};
const STAMP = '2026-06-01T00:00:00.000Z';
const ACTOR = 'editor@example.com';

// A changed limit on a date already on file must never rewrite that revision.
check("changed limits on an existing date are rejected", () => {
  const before = JSON.stringify(SPEC_V1.revisions);
  const result = api.applySpecLimitEdit(SPEC_V1, LIMITS_V2, '2026-04-01', STAMP, ACTOR);
  equal(result.rejected, true);
  deep(result.history, SPEC_V1.revisions);
  equal(JSON.stringify(SPEC_V1.revisions), before);
});

// A metadata-only save keeps the revision count and the existing entry.
check("metadata-only edit on an existing date adds no revision", () => {
  const result = api.applySpecLimitEdit(SPEC_V1, LIMITS_V1, '2026-04-01', STAMP, ACTOR);
  equal(result.rejected, false);
  equal(result.outcome, 'metadata');
  equal(result.history.length, 1);
  deep(result.history[0], REVISION_V1);
});

// A genuinely new date with different limits gets one new append-only revision.
check("new date with changed limits appends a revision", () => {
  const result = api.applySpecLimitEdit(SPEC_V1, LIMITS_V2, '2026-05-01', STAMP, ACTOR);
  equal(result.rejected, false);
  equal(result.outcome, 'revision');
  equal(result.history.length, 2);
  deep(result.history[1], {
    id: 'SPEC-TIR-R2',
    effectiveFrom: '2026-05-01',
    ...LIMITS_V2,
    updatedAt: STAMP,
    updatedBy: ACTOR
  });
  deep(SPEC_V1.revisions, [REVISION_V1]);
});

// A backdated new revision is sorted into place; the latest entry still wins.
check("backdated revision keeps latest entry last", () => {
  const result = api.applySpecLimitEdit(SPEC_V1, LIMITS_V2, '2026-02-01', STAMP, ACTOR);
  equal(result.rejected, false);
  equal(result.history.length, 2);
  equal(result.history[0].effectiveFrom, '2026-02-01');
  equal(result.history[1].effectiveFrom, '2026-04-01');
});

const SCOPE = 'All programs';
const WINDOW = `FY${api.KPI_FISCAL_YEAR} 2026-04-01 to 2027-03-31`;
check("KPI scope label without suffix", () => {
  equal(api.kpiFiscalScopeLabel(), `${SCOPE} · ${WINDOW}`);
});
check("KPI scope label with suffix", () => {
  equal(api.kpiFiscalScopeLabel('customer claims'), `${SCOPE} · ${WINDOW} · customer claims`);
});

check("stage drag payload drops unused fields", () => {
  const schedule = { prepStart: '2026-04-01', prepEnd: '2026-04-05' };
  const payload = api.stageDragReschedulePayload({
    project: 'PRJ-X4151',
    rowKeys: ['X4151'],
    schedule,
    label: 'MB14" · Case A',
    startIso: '2026-04-01',
    endIso: '2026-04-05',
    stageId: 'prep',
    deltaDays: 2
  });
  deep(payload, { project: 'PRJ-X4151', rowKeys: ['X4151'], schedule });
});

// Drive evidence: the seed used to invent folder/file ids that Google answers
// with 404, so a dossier must only offer links someone actually attached.
const REAL_DRIVE = 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567';
const SEED_FOLDER = 'https://drive.google.com/drive/folders/1FFM-PEN81-0002-P0-RHS-DR1';
const SEED_FILE = 'https://drive.google.com/file/d/10002DR1RevB/view';

check("a hand-attached Drive link stays openable", () => {
  equal(api.isOpenableEvidenceUrl(REAL_DRIVE), true);
});
check("the invented seed folder link is not offered", () => {
  equal(api.isOpenableEvidenceUrl(SEED_FOLDER), false);
});
check("the invented seed file link is not offered", () => {
  equal(api.isOpenableEvidenceUrl(SEED_FILE), false);
  // Seed ids were built from the project code, so they are letters and digits.
  equal(api.isOpenableEvidenceUrl('https://drive.google.com/file/d/1X4151G1RevB/view'), false);
});
check("a link without a web scheme is not offered", () => {
  equal(api.isOpenableEvidenceUrl('drive.google.com/drive/folders/abc'), false);
  equal(api.isOpenableEvidenceUrl(''), false);
});
check("purge drops placeholder links, keeps the real one and leaves the input alone", () => {
  const records = {
    'PRJ-X4151': {
      'ME11-RHS': {
        prep: { evidence: [{ id: 'a', url: SEED_FILE }, { id: 'b', url: SEED_FOLDER }] },
        brr: { evidence: [{ id: 'c', url: REAL_DRIVE }] },
        mbo: {}
      }
    }
  };
  const { records: cleaned, removed } = api.purgePlaceholderEvidence(records);
  const lines = cleaned['PRJ-X4151']['ME11-RHS'];
  equal(removed, 2);
  deep(lines.prep.evidence, []);
  equal(lines.brr, records['PRJ-X4151']['ME11-RHS'].brr);
  equal(lines.mbo, records['PRJ-X4151']['ME11-RHS'].mbo);
  equal(records['PRJ-X4151']['ME11-RHS'].prep.evidence.length, 2);
});

// A Gantt bar is coloured by its weakest line; the click must open that same line,
// or a Compact Config bar painted by the LHS line opens the RHS dossier.
const GATE_LINES = {
  'ME12-RHS': { brr: { status: 'Approved' }, mbo: { status: 'In Review' } },
  'ME12-LHS': { brr: { status: 'Blocked' }, mbo: { status: 'In Review' } }
};

check("a single line drives its own bar", () => {
  const gate = api.ganttStageGateDriver(GATE_LINES, ['ME12-RHS'], 'brr');
  equal(gate.lineKey, 'ME12-RHS');
  equal(gate.tone.label, 'Approved');
  equal(gate.differs, false);
});
check("the weaker side drives a Compact Config bar", () => {
  const gate = api.ganttStageGateDriver(GATE_LINES, ['ME12-RHS', 'ME12-LHS'], 'brr');
  equal(gate.tone.label, 'Blocked');
  equal(gate.lineKey, 'ME12-LHS');
  equal(gate.differs, true);
});
check("the first line drives when both sides agree", () => {
  const gate = api.ganttStageGateDriver(GATE_LINES, ['ME12-RHS', 'ME12-LHS'], 'mbo');
  equal(gate.tone.label, 'In Review');
  equal(gate.lineKey, 'ME12-RHS');
  equal(gate.differs, false);
});
check("a line with no dossier reads as unsigned and drives", () => {
  const gate = api.ganttStageGateDriver({ 'ME12-LHS': { brr: { status: 'Approved' } } }, ['ME12-RHS', 'ME12-LHS'], 'brr');
  equal(gate.tone.label, 'Not signed off');
  equal(gate.lineKey, 'ME12-RHS');
  equal(gate.differs, true);
});

// The severity comparison is indexOf on this list, so its order is the rule: a
// bar can only take the weaker line if worse sits further down.
check("gate tones run best to worst", () => {
  deep(
    api.GANTT_GATE_TONES.map((tone) => tone.status),
    ['Approved', 'Conditional', 'In Review', 'Pending', 'Blocked']
  );
  deep(
    api.GANTT_GATE_TONES.map((tone) => api.ganttGateTone(tone.status)),
    api.GANTT_GATE_TONES
  );
});

check("an unknown or missing status reads as unsigned", () => {
  equal(api.ganttGateTone('Escalated'), api.GANTT_GATE_UNSIGNED_TONE);
  equal(api.ganttGateTone(undefined), api.GANTT_GATE_UNSIGNED_TONE);
  equal(api.ganttGateTone(null), api.GANTT_GATE_UNSIGNED_TONE);
  deep(api.GANTT_GATE_UNSIGNED_TONE, api.ganttGateTone('Pending'));
  // A dossier on file but with no status is unsigned too, not approved.
  const gate = api.ganttStageGateDriver({ 'ME12-RHS': { brr: { status: 'Escalated' } } }, ['ME12-RHS'], 'brr');
  equal(gate.tone, api.GANTT_GATE_UNSIGNED_TONE);
  equal(gate.lineKey, 'ME12-RHS');
  equal(gate.differs, false);
});

check("a row with no lines reads as unsigned", () => {
  const gate = api.ganttStageGateDriver(GATE_LINES, [], 'brr');
  equal(gate.tone, api.GANTT_GATE_UNSIGNED_TONE);
  equal(gate.lineKey, null);
  equal(gate.differs, false);
});

// Stage drags must stay in sequence. Bars carry inclusive dates, so a stage starts
// at least the day after its predecessor ends and ends before its successor starts.
const PLAN = {
  prepStart: '2026-12-01',
  brrEnd: '2026-12-06',
  mboStart: '2026-12-07',
  mboEnd: '2026-12-09',
  mainStart: '2026-12-10',
  mainEnd: '2026-12-14',
  oqcStart: '2026-12-15',
  oqcEnd: '2026-12-17',
  etd: '2026-12-20',
  mih: '2026-12-24',
  pbr: '2026-12-28'
};

check("a stage inside its neighbours and before MIH saves", () => {
  equal(api.stageMoveConflict(PLAN, 'prep'), null);
  equal(api.stageMoveConflict(PLAN, 'mbo'), null);
  equal(api.stageMoveConflict(PLAN, 'main'), null);
  equal(api.stageMoveConflict(PLAN, 'oqc'), null);
});
check("a stage dragged before its predecessor is refused", () => {
  const moved = { ...PLAN, mboStart: '2026-12-05', mboEnd: '2026-12-07' };
  const conflict = api.stageMoveConflict(moved, 'mbo');
  equal(conflict.kind, 'before-previous');
  equal(conflict.other.id, 'prep');
  equal(conflict.limitIso, '2026-12-06');
});
check("starting on the predecessor's last day is still too early", () => {
  const moved = { ...PLAN, mboStart: '2026-12-06', mboEnd: '2026-12-08' };
  equal(api.stageMoveConflict(moved, 'mbo').kind, 'before-previous');
});
check("a stage dragged past its successor is refused", () => {
  const moved = { ...PLAN, mainEnd: '2026-12-16' };
  const conflict = api.stageMoveConflict(moved, 'main');
  equal(conflict.kind, 'after-next');
  equal(conflict.other.id, 'oqc');
  equal(conflict.limitIso, '2026-12-15');
});
check("a stage dragged past FATP MIH is refused", () => {
  const moved = { ...PLAN, oqcStart: '2026-12-23', oqcEnd: '2026-12-25' };
  const conflict = api.stageMoveConflict(moved, 'oqc');
  equal(conflict.kind, 'after-mih');
  equal(conflict.limitIso, '2026-12-24');
});
check("finishing on the MIH day itself is allowed", () => {
  const moved = { ...PLAN, oqcStart: '2026-12-22', oqcEnd: '2026-12-24' };
  equal(api.stageMoveConflict(moved, 'oqc'), null);
});
check("an unknown stage is not checked", () => {
  equal(api.stageMoveConflict(PLAN, 'ship'), null);
});

// The team board derives workload instead of storing it, so the counts have to
// follow the member's own programs and the approver names on each dossier.
const TEAM_PROJECTS = [
  { id: 'PRJ-X4151', model: 'X4151', buildMatrix: [{}, {}] },
  { id: 'PRJ-X4026', model: 'X4026', buildMatrix: [{}] }
];
const TEAM_TASKS = [
  { projectId: 'PRJ-X4151', status: 'Open' },
  { projectId: 'PRJ-X4151', status: 'Done' },
  { projectId: 'PRJ-X4026', status: 'Blocked' }
];
const TEAM_GATES = {
  'PRJ-X4151': {
    'ME11-RHS': {
      brr: { approvers: [{ name: 'Horikawa / Saengtian', decision: 'Pending' }] },
      mbo: { approvers: [{ name: 'Horikawa / Saengtian', decision: 'Approved' }] }
    }
  },
  'PRJ-X4026': {
    'ME11-RHS': {
      brr: { approvers: [{ name: 'Panida', decision: 'Pending' }] }
    }
  }
};

check("workload counts only the member's own programs", () => {
  const load = api.computeTeamWorkload(
    { name: 'Patcharapong', products: ['x4151'] },
    TEAM_PROJECTS,
    TEAM_TASKS,
    TEAM_GATES
  );
  equal(load.lines, 2);
  equal(load.openTasks.length, 1);
  equal(load.openTasks[0].projectModel, 'X4151');
  equal(load.signOffs.length, 0);
  equal(load.load, 1);
});
check("a portfolio-wide member is measured across every program", () => {
  const load = api.computeTeamWorkload({ name: 'Nobody', products: [] }, TEAM_PROJECTS, TEAM_TASKS, TEAM_GATES);
  equal(load.lines, 3);
  equal(load.openTasks.length, 2);
  equal(load.signOffs.length, 0);
});
check("a multi-name approver owes a signature to each name on it", () => {
  const load = api.computeTeamWorkload({ name: 'saengtian', products: [] }, TEAM_PROJECTS, TEAM_TASKS, TEAM_GATES);
  equal(load.signOffs.length, 1);
  // The dossier comes back with its program and line, so the board can open it.
  equal(load.signOffs[0].projectId, 'PRJ-X4151');
  equal(load.signOffs[0].lineKey, 'ME11-RHS');
  equal(load.signOffs[0].gateCode, 'G3');
  const panida = api.computeTeamWorkload({ name: 'Panida', products: [] }, TEAM_PROJECTS, TEAM_TASKS, TEAM_GATES);
  equal(panida.signOffs.length, 1);
  equal(panida.load, 3);
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} review-fix checks passed.\n`);
process.exit(failed ? 1 : 0);
