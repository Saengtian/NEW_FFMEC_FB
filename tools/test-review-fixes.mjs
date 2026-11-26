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
 *  - the server's sign-off ledger appends a row only for a decision this save
 *    actually changed, and never for a dossier the same save created
 *  - a team member's workload counts only the tasks assigned to them (a stored
 *    member id first, then the roster name behind free text like
 *    "Patcharapong J."), and matches their name among multi-name approvers
 *  - a program the workspace does not run is a third state: it is not a typo
 *    (no amber flag) and it is not "no assignment" (no portfolio-wide scope)
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
const serverSource = readFileSync(join(ROOT, "Code.js"), "utf8");

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
  /function addDaysIso\([\s\S]*?\n}/,
  /function diffDaysIso\([\s\S]*?\n}/,
  /function isoDateParts\([\s\S]*?\n}/,
  /function formatShortDate\([\s\S]*?\n}/,
  /function formatMonthDay\([\s\S]*?\n}/,
  /function sampleQuantile\([\s\S]*?\n}/,
  /function cpkBoxSummary\([\s\S]*?\n}/,
  /function getDefaultScheduleForRow\([\s\S]*?\n}/,
  /function stageMoveConflict\([\s\S]*?\n}/,
  /const NPI_GATES = \[[\s\S]*?\n\];/,
  /function normalizePersonName\([\s\S]*?\n}/,
  /function teamMemberForOwner\([\s\S]*?\n}/,
  /function unassignedOpenTasks\([\s\S]*?\n}/,
  /function normalizeProductKey\([\s\S]*?\n}/,
  /function distinctProductStrings\([\s\S]*?\n}/,
  /function distinctProgramValues\([\s\S]*?\n}/,
  /function programModels\([\s\S]*?\n}/,
  /function programFamilies\([\s\S]*?\n}/,
  /function productMatchesProject\([\s\S]*?\n}/,
  /function memberExternalPrograms\([\s\S]*?\n}/,
  /function unmatchedProducts\([\s\S]*?\n}/,
  /const GATE_SIGN_OFF_DUE_KEYS = \{[\s\S]*?\n\};/,
  /function gateSignOffDueIso\([\s\S]*?\n}/,
  /function lineGateSchedule\([\s\S]*?\n}/,
  /function compareSignOffsByDue\([\s\S]*?\n}/,
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
    "return { KPI_FISCAL_YEAR, applySpecLimitEdit, kpiFiscalScopeLabel, stageDragReschedulePayload, isOpenableEvidenceUrl, purgePlaceholderEvidence, ganttStageGateDriver, ganttGateTone, GANTT_GATE_TONES, GANTT_GATE_UNSIGNED_TONE, stageMoveConflict, normalizePersonName, teamMemberForOwner, unassignedOpenTasks, distinctProductStrings, programModels, programFamilies, productMatchesProject, memberExternalPrograms, unmatchedProducts, formatShortDate, formatMonthDay, sampleQuantile, cpkBoxSummary, getDefaultScheduleForRow, gateSignOffDueIso, lineGateSchedule, compareSignOffsByDue, computeTeamWorkload };"
)();

// The gate decision ledger is written in Code.js, so its row builder is read out
// of the server file the same way — the test cannot drift from a copy of a rule.
const SERVER_DECLARATIONS = [
  /const SIGN_OFF_LEDGER_HEADERS = \[[\s\S]*?\n\];/,
  /const GATE_LEDGER_LABELS = \{[\s\S]*?\n\};/,
  /function signOffLedgerRows\([\s\S]*?\n}/
];

const serverPieces = SERVER_DECLARATIONS.map((pattern) => {
  const match = serverSource.match(pattern);
  if (!match) {
    console.error(`Code.js no longer declares ${pattern} — update this test, the ledger moved.`);
    process.exit(1);
  }
  return match[0];
});

const serverApi = new Function(
  `"use strict";\n${serverPieces.join("\n")}\n` + "return { SIGN_OFF_LEDGER_HEADERS, signOffLedgerRows };"
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
// follow the person a task is assigned to and the approver names on each dossier.
const TEAM_PROJECTS = [
  {
    id: 'PRJ-X4151',
    model: 'X4151',
    familyGroup: 'MB14"',
    mihDate: '2026-12-24',
    buildMatrix: [
      { config: 'ME11', side: 'RHS', fatpMih: '2026-12-24' },
      { config: 'ME11', side: 'LHS', fatpMih: '2026-12-24' }
    ]
  },
  {
    id: 'PRJ-X4026',
    model: 'X4026',
    familyGroup: 'MB14"',
    mihDate: '2027-01-20',
    buildMatrix: [{ config: 'ME11', side: 'RHS', fatpMih: '2027-01-20' }]
  }
];
const TEAM_MEMBERS = [
  { id: 'TM-12', name: 'Patcharapong', role: 'NPI Engineer', products: ['X4151'] },
  { id: 'TM-04', name: 'Touchakorn', role: 'Program Leader', products: ['X4151'] },
  { id: 'TM-01', name: 'Horikawa', role: 'Engineering Manager', products: [] }
];
const TEAM_TASKS = [
  // Seeded rows carry no member id: only the free text names the owner.
  { id: 'T-1', projectId: 'PRJ-X4151', status: 'Open', owner: 'Patcharapong J.' },
  { id: 'T-2', projectId: 'PRJ-X4151', status: 'Done', owner: 'Patcharapong J.' },
  // Same program, someone else's task.
  { id: 'T-3', projectId: 'PRJ-X4151', status: 'Open', owner: 'Touchakorn T.' },
  // A stored id wins over the text an earlier edit left behind.
  { id: 'T-4', projectId: 'PRJ-X4026', status: 'Blocked', ownerId: 'TM-12', owner: 'Supachai M.' },
  // Nobody on the roster owns this, so it pads no one's workload.
  { id: 'T-5', projectId: 'PRJ-X4151', status: 'Open', owner: 'Kanya R.' }
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

check("workload counts only the tasks assigned to the member", () => {
  const load = api.computeTeamWorkload(TEAM_MEMBERS[0], TEAM_PROJECTS, TEAM_TASKS, TEAM_GATES, TEAM_MEMBERS);
  equal(load.lines, 2);
  // T-1 by roster name, T-4 by member id; T-3 sits on the same program but is
  // someone else's, and T-5 belongs to a name the roster does not know.
  equal(load.openTasks.map((task) => task.id).join(','), 'T-1,T-4');
  equal(load.openTasks[0].projectModel, 'X4151');
  equal(load.signOffs.length, 0);
  equal(load.load, 2);
});
check("a seeded 'Name I.' owner resolves to the roster", () => {
  equal(api.teamMemberForOwner('', 'Patcharapong J.', TEAM_MEMBERS)?.id, 'TM-12');
  equal(api.teamMemberForOwner('', 'Touchakorn T.', TEAM_MEMBERS)?.id, 'TM-04');
  // Off-roster names stay unowned instead of being guessed onto someone.
  equal(api.teamMemberForOwner('', 'kanya r.', TEAM_MEMBERS), null);
  equal(api.teamMemberForOwner('', 'NMB Eng', TEAM_MEMBERS), null);
});
check('open tasks with no roster owner are collected as unassigned', () => {
  deep(api.unassignedOpenTasks(TEAM_TASKS, TEAM_MEMBERS).map((task) => task.id), ['T-5']);
  // A stored id that names a current member owns the task whatever the text says.
  deep(
    api.unassignedOpenTasks(
      [{ id: 'T-4', status: 'Blocked', ownerId: 'TM-12', owner: 'Supachai M.' }],
      TEAM_MEMBERS
    ),
    []
  );
  // Finished work is never unassigned work.
  deep(api.unassignedOpenTasks([{ id: 'T-2', status: 'Done', owner: 'Kanya R.' }], TEAM_MEMBERS), []);
  // A removed member's id leaves the task claimable again.
  deep(
    api
      .unassignedOpenTasks(
        [{ id: 'T-9', status: 'Open', ownerId: 'TM-GONE', owner: 'Kanya R.' }],
        TEAM_MEMBERS
      )
      .map((task) => task.id),
    ['T-9']
  );
});

check("a stored member id wins over stale free text", () => {
  equal(api.teamMemberForOwner('TM-12', 'Supachai M.', TEAM_MEMBERS)?.id, 'TM-12');
});
check('plan dates read as zero-padded mm/dd', () => {
  equal(api.formatMonthDay('2026-12-04'), '12/04');
  equal(api.formatMonthDay('2027-01-05'), '01/05');
  equal(api.formatMonthDay(' 2026-12-05 '), '12/05');
  equal(api.formatMonthDay('2026-12-05T08:00:00Z'), '12/05');
  // Bad input must not be dressed up as a date: the parser fills gaps for
  // scheduling, so the formatter has to reject what it invented.
  equal(api.formatMonthDay(''), '—');
  equal(api.formatMonthDay(null), '—');
  equal(api.formatMonthDay('not-a-date'), '—');
  equal(api.formatMonthDay('2026-12'), '—');
  equal(api.formatMonthDay('2026-13-40'), '—');
  equal(api.formatMonthDay('2025-02-29'), '—');
});
check('both date formatters reject what the parser had to invent', () => {
  equal(api.formatShortDate('2026-12-05'), 'Dec 5');
  equal(api.formatShortDate('not-a-date'), '—');
  equal(api.formatShortDate('2026-13-40'), '—');
  equal(api.formatShortDate(''), '—');
});

check('a raw box plot uses sample quartiles and 1.5 IQR whiskers', () => {
  const box = api.cpkBoxSummary({ mean: 5, stdDev: 2.5, rawValues: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  equal(box.basis, 'raw');
  equal(box.q1, 3);
  equal(box.median, 5);
  equal(box.q3, 7);
  // 1.5 × IQR fences sit at -3 and 13, so every sample stays a whisker end.
  equal(box.low, 1);
  equal(box.high, 9);
});

check('a summary-only reading falls back to mean ± σ with ±3σ whiskers', () => {
  const box = api.cpkBoxSummary({ mean: 10, stdDev: 2 });
  equal(box.basis, 'normal');
  equal(box.low, 4);
  equal(box.q1, 8);
  equal(box.median, 10);
  equal(box.q3, 12);
  equal(box.high, 16);
});

check('quantiles interpolate between neighbours and survive one sample', () => {
  equal(api.sampleQuantile([1, 2, 3, 4], 0.5), 2.5);
  equal(api.sampleQuantile([5], 0.9), 5);
  assert.ok(Number.isNaN(api.sampleQuantile([], 0.5)));
});

check("an owed gate is due on its own milestone in the line plan", () => {
  const project = TEAM_PROJECTS[0];
  const schedule = api.getDefaultScheduleForRow(project, project.buildMatrix[0]);
  equal(api.gateSignOffDueIso('brr', schedule), schedule.brrEnd);
  equal(api.gateSignOffDueIso('mbo', schedule), schedule.mboEnd);
  equal(api.gateSignOffDueIso('main', schedule), schedule.mainEnd);
  equal(api.gateSignOffDueIso('oqc', schedule), schedule.oqcEnd);
  equal(api.gateSignOffDueIso('ship', schedule), schedule.etd);
  equal(api.gateSignOffDueIso('mih', schedule), schedule.mih);
  equal(api.gateSignOffDueIso('not-a-gate', schedule), null);
});
check('the gate sequence runs forward from prep to PBR and ends past MIH', () => {
  const project = TEAM_PROJECTS[0];
  const schedule = api.getDefaultScheduleForRow(project, project.buildMatrix[0]);
  const order = ['prep', 'bbr', 'brr', 'mbo', 'main', 'oqc', 'ship', 'mih', 'pbr'];
  const dates = order.map((gateId) => api.gateSignOffDueIso(gateId, schedule));
  dates.forEach((date, idx) => {
    assert.ok(date, `${order[idx]} has no due date`);
    if (idx > 0) assert.ok(dates[idx - 1] <= date, `${order[idx - 1]} falls after ${order[idx]}`);
  });
  equal(dates[order.indexOf('mih')], schedule.mih);
});
check('a signature carries its deadline and the override moves it', () => {
  const member = { id: 'TM-99', name: 'Saengtian', products: [] };
  const load = api.computeTeamWorkload(member, TEAM_PROJECTS, TEAM_TASKS, TEAM_GATES, TEAM_MEMBERS, {});
  const plan = api.getDefaultScheduleForRow(TEAM_PROJECTS[0], TEAM_PROJECTS[0].buildMatrix[0]);
  equal(load.signOffs.length, 1);
  equal(load.signOffs[0].dueIso, plan.brrEnd);
  // A dragged line schedule is the plan its signatures are judged against.
  const moved = api.computeTeamWorkload(member, TEAM_PROJECTS, TEAM_TASKS, TEAM_GATES, TEAM_MEMBERS, {
    'PRJ-X4151::ME11-RHS': { ...plan, brrEnd: '2027-02-01' }
  });
  equal(moved.signOffs[0].dueIso, '2027-02-01');
});
check('a gate with no plan date sorts after the dated ones', () => {
  const sorted = [
    { dueIso: null, projectModel: 'X9', lineKey: 'ME1-RHS', gateCode: 'G9' },
    { dueIso: '2026-12-05', projectModel: 'X1', lineKey: 'ME1-RHS', gateCode: 'G4' },
    { dueIso: '2026-11-01', projectModel: 'X1', lineKey: 'ME2-RHS', gateCode: 'G3' }
  ].sort(api.compareSignOffsByDue);
  equal(sorted.map((item) => item.dueIso).join(','), '2026-11-01,2026-12-05,');
});
check('the product picker offers only models and families that exist', () => {
  equal(api.programModels(TEAM_PROJECTS).join(','), 'X4026,X4151');
  equal(api.programFamilies(TEAM_PROJECTS).join(','), 'MB14"');
  equal(api.programModels([]).length, 0);
  equal(api.programFamilies([]).length, 0);
});
check('a product list is trimmed and deduplicated by spelling', () => {
  deep(api.distinctProductStrings([' X4151 ', 'x4151', '', null, 'X4026']), ['X4151', 'X4026']);
  deep(api.distinctProductStrings([]), []);
});

check('the match rule takes a product as stored', () => {
  assert.ok(api.productMatchesProject(' mb14" ', TEAM_PROJECTS[0]));
  assert.ok(api.productMatchesProject('X4026', TEAM_PROJECTS[1]));
  assert.ok(!api.productMatchesProject('X4115', TEAM_PROJECTS[1]));
  assert.ok(!api.productMatchesProject('  ', TEAM_PROJECTS[1]));
});

check('the typo list is judged by the rule workload scopes by', () => {
  // A model, a padded family, a program that is not in this scope, a typo and a
  // program name from elsewhere: only the last three are unmatched.
  deep(api.unmatchedProducts(['X4151', ' mb14" ', 'X4152', 'X4115', 'desktop'], TEAM_PROJECTS), [
    'X4152',
    'X4115',
    'desktop'
  ]);
});

check('a family assignment covers every program in that family', () => {
  const load = api.computeTeamWorkload(
    { id: 'TM-99', name: 'Family Owner', products: ['MB14"'] },
    TEAM_PROJECTS,
    TEAM_TASKS,
    TEAM_GATES,
    TEAM_MEMBERS,
    {}
  );
  // X4151 has two lines and X4026 one; both belong to MB14".
  equal(load.lines, 3);
  equal(api.unmatchedProducts(['MB14"'], TEAM_PROJECTS).length, 0);
});
check('a model assignment still covers only its own program', () => {
  const load = api.computeTeamWorkload(
    { id: 'TM-98', name: 'Model Owner', products: ['X4026'] },
    TEAM_PROJECTS,
    TEAM_TASKS,
    TEAM_GATES,
    TEAM_MEMBERS,
    {}
  );
  equal(load.lines, 1);
});
check('a product that matches no program is flagged', () => {
  equal(api.unmatchedProducts(['x4151', 'X4115', 'X4115', 'MB99"'], TEAM_PROJECTS).join(','), 'X4115,MB99"');
  equal(api.unmatchedProducts(['X4026'], TEAM_PROJECTS).length, 0);
  // Padding and casing are not a different program.
  equal(api.unmatchedProducts([' X4151 ', 'x4151'], TEAM_PROJECTS).length, 0);
});
check('a padded product scopes workload exactly like a clean one', () => {
  const load = api.computeTeamWorkload(
    { id: 'TM-12', name: 'Patcharapong', products: [' x4151 '] },
    TEAM_PROJECTS,
    TEAM_TASKS,
    TEAM_GATES,
    TEAM_MEMBERS,
    {}
  );
  equal(load.lines, 2);
});
check('a product typo zeroes the lines it was meant to cover', () => {
  const typo = api.computeTeamWorkload(
    { id: 'TM-12', name: 'Patcharapong', products: ['X4115'] },
    TEAM_PROJECTS,
    TEAM_TASKS,
    TEAM_GATES,
    TEAM_MEMBERS
  );
  equal(typo.lines, 0);
  // ...and the flag is what makes that zero visible instead of silent.
  equal(api.unmatchedProducts(['X4115'], TEAM_PROJECTS).join(','), 'X4115');
});
check('a program outside this workspace covers nothing and is not portfolio-wide', () => {
  const load = api.computeTeamWorkload(
    { id: 'TM-05', name: 'Umarporn', products: [], externalProducts: ['Desktop'] },
    TEAM_PROJECTS,
    TEAM_TASKS,
    TEAM_GATES,
    TEAM_MEMBERS,
    {}
  );
  equal(load.portfolioWide, false);
  equal(load.lines, 0);
  equal(load.signOffs.length, 0);
  equal(load.load, 0);
  deep(load.externalPrograms, ['Desktop']);
});

check('nothing on file is still the only portfolio-wide state', () => {
  const blank = api.computeTeamWorkload(
    { id: 'TM-01', name: 'Horikawa', products: [] },
    TEAM_PROJECTS,
    TEAM_TASKS,
    TEAM_GATES,
    TEAM_MEMBERS,
    {}
  );
  equal(blank.portfolioWide, true);
  equal(blank.lines, 3);
  // A live model next to an outside program scopes to the model alone.
  const mixed = api.computeTeamWorkload(
    { id: 'TM-98', name: 'Mixed', products: ['X4026'], externalProducts: ['X3439'] },
    TEAM_PROJECTS,
    TEAM_TASKS,
    TEAM_GATES,
    TEAM_MEMBERS,
    {}
  );
  equal(mixed.portfolioWide, false);
  equal(mixed.lines, 1);
});

check('outside programs are kept apart from product typos', () => {
  deep(api.memberExternalPrograms({ externalProducts: [' X3439 ', 'x3439', ''] }), ['X3439']);
  const member = { products: [], externalProducts: ['X3439'] };
  // The typo flag only ever looks at products, so an outside program cannot raise it.
  equal(api.unmatchedProducts(member.products, TEAM_PROJECTS).length, 0);
  equal(api.unmatchedProducts(['X3439'], TEAM_PROJECTS).join(','), 'X3439');
  deep(api.memberExternalPrograms({}), []);
});

check("a member with no program of their own owns no one else's tasks", () => {
  const load = api.computeTeamWorkload(TEAM_MEMBERS[2], TEAM_PROJECTS, TEAM_TASKS, TEAM_GATES, TEAM_MEMBERS);
  equal(load.lines, 3);
  equal(load.openTasks.length, 0);
  // The portfolio-wide signature still counts: Horikawa owes the pending BRR.
  equal(load.signOffs.length, 1);
  equal(load.load, load.signOffs.length);
});
check("a multi-name approver owes a signature to each name on it", () => {
  const load = api.computeTeamWorkload(
    { id: 'TM-02', name: 'saengtian', products: [] },
    TEAM_PROJECTS,
    TEAM_TASKS,
    TEAM_GATES,
    TEAM_MEMBERS
  );
  equal(load.signOffs.length, 1);
  // The dossier comes back with its program and line, so the board can open it.
  equal(load.signOffs[0].projectId, 'PRJ-X4151');
  equal(load.signOffs[0].lineKey, 'ME11-RHS');
  equal(load.signOffs[0].gateCode, 'G3');
  const panida = api.computeTeamWorkload(
    { id: 'TM-14', name: 'Panida', products: [] },
    TEAM_PROJECTS,
    TEAM_TASKS,
    TEAM_GATES,
    TEAM_MEMBERS
  );
  equal(panida.signOffs.length, 1);
  equal(panida.load, 1);
});

// --- sign-off ledger (Code.js) ---

const LEDGER_PROJECTS = [{ id: 'PRJ-X4151', model: 'X4151' }];
const ledgerRecords = (decision) => ({
  'PRJ-X4151': {
    'ME11-RHS': {
      mbo: {
        approvers: [
          { name: 'Horikawa', role: 'Engineering Manager', decision, remark: 'Verified against the MBO checklist' }
        ]
      }
    }
  }
});
const LEDGER_META = {
  timestamp: '2026-11-26T10:00:00.000Z',
  revision: 7,
  userEmail: 'auditor@minebea.co.th'
};

check('a changed decision appends one immutable row naming the signer', () => {
  const rows = serverApi.signOffLedgerRows(
    ledgerRecords('Pending'),
    ledgerRecords('Approved'),
    LEDGER_PROJECTS,
    LEDGER_META
  );
  equal(rows.length, 1);
  equal(
    rows[0].join('|'),
    '2026-11-26T10:00:00.000Z|7|PRJ-X4151|X4151|ME11-RHS|G4 MBO & OK2B|Horikawa|Engineering Manager|Approved|Verified against the MBO checklist|auditor@minebea.co.th'
  );
  equal(rows[0].length, serverApi.SIGN_OFF_LEDGER_HEADERS.length);
});
check('an unchanged save appends nothing', () => {
  equal(
    serverApi.signOffLedgerRows(ledgerRecords('Approved'), ledgerRecords('Approved'), LEDGER_PROJECTS, LEDGER_META).length,
    0
  );
});
check('a gate this save created is not somebody approving', () => {
  equal(serverApi.signOffLedgerRows({}, ledgerRecords('Approved'), LEDGER_PROJECTS, LEDGER_META).length, 0);
});
check('the first seed has no ledger to write', () => {
  equal(serverApi.signOffLedgerRows(null, ledgerRecords('Approved'), LEDGER_PROJECTS, LEDGER_META).length, 0);
});
check('a rejection is a decision too', () => {
  const rows = serverApi.signOffLedgerRows(
    ledgerRecords('Approved'),
    ledgerRecords('Rejected'),
    LEDGER_PROJECTS,
    LEDGER_META
  );
  equal(rows.length, 1);
  equal(rows[0][8], 'Rejected');
});
check('the ledger header names the program, gate, approver and signer', () => {
  ['Timestamp', 'Program', 'Line', 'Gate', 'Approver', 'Decision', 'SignedInEmail'].forEach((column) => {
    assert.ok(serverApi.SIGN_OFF_LEDGER_HEADERS.indexOf(column) !== -1, `missing ${column}`);
  });
});

for (const r of results) {
  console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.label}${r.ok ? "" : `  (${r.message})`}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} review-fix checks passed.\n`);
process.exit(failed ? 1 : 0);
