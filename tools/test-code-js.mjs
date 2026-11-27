/**
 * Local harness for Code.js — the server, exercised without a deploy.
 *
 * Code.js is the only layer with no local coverage: the preview shims the RPC
 * boundary, so until now `saveWorkspaceState`, the SignOffLog append and the
 * chunked store were only exercised by clasp-pushing and clicking. This loads the
 * exact text clasp ships into a sandbox with a mocked `SpreadsheetApp` (in-memory
 * tabs of rows), `Session`, `LockService` and `PropertiesService`, then drives the
 * real functions:
 *
 *   1. the chunked state read/write, including a payload larger than CHUNK_SIZE,
 *      a corrupted store, revision conflicts and the history copies;
 *   2. the save permission rules, judged on the store rather than the payload —
 *      program ownership, roster ownership, and signatures that may only name
 *      the signed-in user;
 *   3. the append-only sign-off ledger — what gets a row, what does not, that
 *      the ledger is written before the store commits, and that a failed append
 *      refuses the save rather than leaving a committed signature unlogged.
 *
 * The mocks are deliberately dumb: a sheet is an array of rows, a range is a
 * window into it, and anything Apps Script would do on its own (formulas,
 * formatting, quotas) is ignored. Only behaviour of Code.js is under test.
 *
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-code-js.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const code = readFileSync(join(ROOT, "Code.js"), "utf8");

// ---------------------------------------------------------------------------
// Mock spreadsheet
// ---------------------------------------------------------------------------

function createRange(sheet, r1, c1, numRows, numCols) {
  const read = () => {
    const out = [];
    for (let r = 0; r < numRows; r += 1) {
      const row = sheet.rows[r1 - 1 + r] || [];
      const cells = [];
      for (let c = 0; c < numCols; c += 1) {
        const value = row[c1 - 1 + c];
        cells.push(value === undefined || value === null ? "" : value);
      }
      out.push(cells);
    }
    return out;
  };

  const write = (values) => {
    // One failure switch, used to prove a ledger append that throws before the
    // store commits refuses the save instead of committing an unlogged signature.
    // The one-shot switch lets a single state write fail and then lets the restore
    // path write the previous rows back.
    if (sheet.failNextSetValuesFromRow && r1 >= sheet.failNextSetValuesFromRow) {
      sheet.failNextSetValuesFromRow = 0;
      throw new Error(`simulated one-shot sheet write failure at row ${r1}`);
    }
    if (sheet.failSetValuesFromRow && r1 >= sheet.failSetValuesFromRow) {
      throw new Error(`simulated sheet write failure at row ${r1}`);
    }
    values.forEach((rowValues, ri) => {
      const target = r1 - 1 + ri;
      while (sheet.rows.length <= target) sheet.rows.push([]);
      rowValues.forEach((value, ci) => {
        sheet.rows[target][c1 - 1 + ci] = value;
      });
    });
  };

  const range = {
    getValues: read,
    getValue: () => read()[0][0],
    setValues: (values) => {
      write(values);
      return range;
    },
    setValue: (value) => {
      write([[value]]);
      return range;
    },
    setFontWeight: () => range,
    setBackground: () => range,
    setFontColor: () => range
  };
  return range;
}

function createSheet(name, id) {
  const sheet = {
    name,
    id,
    rows: [],
    frozenRows: 0,
    failSetValuesFromRow: 0,
    failNextSetValuesFromRow: 0,
    getName: () => name,
    getSheetId: () => id,
    getLastRow: () => sheet.rows.length,
    getLastColumn: () => sheet.rows.reduce((max, row) => Math.max(max, row.length), 0),
    setFrozenRows: (n) => {
      sheet.frozenRows = n;
    },
    clearContents: () => {
      sheet.rows = [];
    },
    deleteRows: (start, howMany) => {
      sheet.rows.splice(start - 1, howMany);
    },
    appendRow: (values) => {
      sheet.rows.push(values.slice());
    },
    getRange: (r1, c1, numRows = 1, numCols = 1) => createRange(sheet, r1, c1, numRows, numCols),
    getDataRange: () =>
      createRange(sheet, 1, 1, Math.max(1, sheet.rows.length), Math.max(1, sheet.getLastColumn())),
    getProtections: () => [],
    protect: () => ({
      setDescription() {
        return this;
      },
      setWarningOnly() {
        return this;
      }
    })
  };
  return sheet;
}

const store = { sheets: new Map(), properties: {}, owner: "owner@minebea.co.th" };

const spreadsheet = {
  getSheetByName: (name) => store.sheets.get(name) || null,
  insertSheet: (name) => {
    const sheet = createSheet(name, store.sheets.size + 1);
    store.sheets.set(name, sheet);
    return sheet;
  },
  getOwner: () => ({ getEmail: () => store.owner }),
  getUrl: () => "https://docs.google.com/spreadsheets/d/SHEET-ID/edit"
};

const spreadsheetApp = {
  openById: () => spreadsheet,
  getUi: () => {
    throw new Error("Spreadsheet UI is not available in tests");
  },
  ProtectionType: { SHEET: "SHEET" }
};

const session = {
  email: "owner@minebea.co.th",
  getActiveUser: () => ({ getEmail: () => session.email }),
  getEffectiveUser: () => ({ getEmail: () => "deployer@minebea.co.th" }),
  getScriptTimeZone: () => "Asia/Bangkok"
};

const lock = { busy: false };
const lockService = {
  getScriptLock: () => ({
    tryLock: () => !lock.busy,
    releaseLock: () => {}
  })
};

const propertiesService = {
  getScriptProperties: () => ({
    getProperty: (key) => (Object.prototype.hasOwnProperty.call(store.properties, key) ? store.properties[key] : null),
    setProperties: (values) => Object.assign(store.properties, values)
  })
};

const quietConsole = { log: () => {}, warn: () => {}, error: () => {} };

const htmlService = {
  content: "",
  fail: false,
  createHtmlOutputFromFile: (name) => ({
    getContent: () => {
      if (htmlService.fail) throw new Error(`missing ${name}.html`);
      return htmlService.content;
    }
  })
};

const factory = new Function(
  "SpreadsheetApp",
  "Session",
  "LockService",
  "PropertiesService",
  "Utilities",
  "DriveApp",
  "ScriptApp",
  "MimeType",
  "HtmlService",
  "console",
  `${code}
return {
  CONFIG,
  PERSISTED_SLICES,
  SIGN_OFF_LEDGER_HEADERS,
  saveWorkspaceState,
  loadWorkspaceState,
  getSignOffLedger,
  reconcileSignOffLedger,
  historySnapshots_,
  missingSignOffLedgerRows_,
  getServerInfo,
  listStateRevisions,
  loadStateRevision,
  exportRestoreSnapshot,
  getSheetJsSource,
  refreshMirrorSheets,
  ensureAllTabs_,
  parseChunkGroup_
};`
);

const api = factory(
  spreadsheetApp,
  session,
  lockService,
  propertiesService,
  { formatDate: () => "2026-11-27_0130" },
  {},
  {},
  { PLAIN_TEXT: "text/plain" },
  htmlService,
  quietConsole
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROSTER = [
  { id: "TM-01", name: "Engineer", role: "NPI Engineer", email: "engineer@minebea.co.th", products: ["X4151"] },
  { id: "TM-02", name: "Quality", role: "Quality Engineer", email: "quality@minebea.co.th", products: [] },
  { id: "TM-03", name: "Outsider", role: "Cost Owner", email: "outsider@minebea.co.th", products: ["X4026"] }
];

const PROJECT = {
  id: "PRJ-X4151",
  family: "FDB",
  model: "X4151",
  phase: "EVT",
  side: "Next",
  status: "Active",
  currentGateId: "mbo",
  buildMatrix: []
};

const LINE_KEY = "X4151|EVT|Next|ME11";

const gateRecordsWith = (approvers) => ({
  "PRJ-X4151": { [LINE_KEY]: { mbo: { approvers } } }
});

const payloadOf = (over = {}) => ({
  projects: [PROJECT],
  tasks: [{ id: "TSK-1", projectId: "PRJ-X4151", title: "Seed task", status: "To Do" }],
  gateRecords: {},
  productionRecords: [],
  masterSpecs: [],
  cpkRecords: [],
  costProjects: [],
  customerFeedback: [],
  scheduleOverrides: {},
  teamMembers: ROSTER,
  ...over
});

const reset = () => {
  store.sheets.clear();
  store.properties = {};
  store.owner = "owner@minebea.co.th";
  session.email = "owner@minebea.co.th";
  lock.busy = false;
};

const sheetOf = (name) => store.sheets.get(name);
const save = ({ payload, as = "owner@minebea.co.th", revision, summary = "test save", mirrors = false, attempt }) => {
  session.email = as;
  return api.saveWorkspaceState(JSON.stringify(payload), summary, revision, mirrors, attempt);
};
const ownerSave = (payload, revision) => save({ payload, as: "owner@minebea.co.th", revision });
const stateRows = () => sheetOf(api.CONFIG.STATE_SHEET).rows.slice(1);
const rowsFor = (key) => stateRows().filter((row) => String(row[0]) === key);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

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
const deep = (actual, expected, why) => assert.deepStrictEqual(actual, expected, why);
const refused = (fn, pattern) => assert.throws(fn, pattern);

// ---------------------------------------------------------------------------
// 1. Chunked state read/write
// ---------------------------------------------------------------------------

check("an empty sheet reports an uninitialised store, not empty data", () => {
  reset();
  const state = api.loadWorkspaceState();
  equal(state.initialized, false);
  equal(state.revision, 0);
  equal(state.data, null);
});

check("the first save writes Rev #1 and creates the managed tabs", () => {
  reset();
  const result = ownerSave(payloadOf());
  equal(result.ok, true);
  equal(result.revision, 1);
  ["_FFM_STATE_STORE", "_FFM_STATE_HISTORY", "AuditLog", "SignOffLog", "Projects", "Tasks"].forEach((tab) =>
    assert.ok(sheetOf(tab), `tab ${tab} was not created`)
  );
});

check("a save round-trips every slice it was given", () => {
  reset();
  const payload = payloadOf();
  ownerSave(payload);
  const state = api.loadWorkspaceState();
  equal(state.initialized, true);
  equal(state.revision, 1);
  deep(state.data.projects, payload.projects);
  deep(state.data.tasks, payload.tasks);
  deep(state.data.teamMembers, payload.teamMembers);
});

check("a failed state rewrite restores the previous revision instead of leaving an empty store", () => {
  reset();
  const payload = payloadOf();
  ownerSave(payload);
  const stateSheet = sheetOf(api.CONFIG.STATE_SHEET);
  const before = stateSheet.rows.map((row) => row.slice());
  stateSheet.failNextSetValuesFromRow = 1;
  refused(
    () => ownerSave(payloadOf({ tasks: [] }), 1),
    /_FFM_STATE_STORE could not be written.*previous revision was restored/
  );
  deep(stateSheet.rows, before, "the failed save left an empty or partial state store");
  const restored = api.loadWorkspaceState();
  equal(restored.revision, 1, "the failed save advanced the revision");
  deep(restored.data.tasks, payload.tasks, "the failed save changed the stored tasks");
  equal(sheetOf("AuditLog").rows.length, 2, "the failed save appended an audit row");
});

check("a slice larger than CHUNK_SIZE splits into ordered chunks and reassembles byte for byte", () => {
  reset();
  const longNote = "x".repeat(api.CONFIG.CHUNK_SIZE * 2 + 137);
  const payload = payloadOf({ productionRecords: [{ id: "PR-1", note: longNote }] });
  ownerSave(payload);

  const chunks = rowsFor("productionRecords");
  const serialised = JSON.stringify(payload.productionRecords);
  equal(chunks.length, Math.ceil(serialised.length / api.CONFIG.CHUNK_SIZE), "chunk count");
  deep(chunks.map((row) => row[1]), chunks.map((_, i) => i), "chunk indexes are 0..n-1");
  chunks.forEach((row) => equal(row[2], chunks.length, "every chunk declares the same count"));
  equal(chunks.map((row) => row[4]).join(""), serialised, "chunks concatenate to the original JSON");
  deep(api.loadWorkspaceState().data.productionRecords, payload.productionRecords);
});

check("the meta chunk records the revision, the saver and the slice manifest", () => {
  reset();
  ownerSave(payloadOf());
  const meta = JSON.parse(rowsFor("__META__")[0][4]);
  equal(meta.revision, 1);
  equal(meta.lastSavedBy, "owner@minebea.co.th");
  assert.ok(Array.isArray(meta.slices) && meta.slices.includes("projects"), "manifest lists slices");
});

check("a second save increments the revision and rewrites the store instead of appending", () => {
  reset();
  ownerSave(payloadOf());
  const rowsAfterFirst = api.loadWorkspaceState().data;
  const second = ownerSave(payloadOf({ tasks: [] }), 1);
  equal(second.revision, 2);
  const state = api.loadWorkspaceState();
  equal(state.revision, 2);
  deep(state.data.tasks, []);
  assert.ok(Array.isArray(rowsAfterFirst.tasks), "first save was readable before the second");
});

check("a store whose chunk is missing is reported as corrupted, not as empty", () => {
  reset();
  ownerSave(payloadOf());
  const sheet = sheetOf(api.CONFIG.STATE_SHEET);
  const index = sheet.rows.findIndex((row) => String(row[0]) === "tasks");
  sheet.rows.splice(index, 1);
  const state = api.loadWorkspaceState();
  equal(state.initialized, false);
  equal(state.corrupted, true);
  assert.match(state.error, /incomplete or invalid/);
});

check("a manifest naming a slice that was never written counts as corruption", () => {
  reset();
  ownerSave(payloadOf());
  const sheet = sheetOf(api.CONFIG.STATE_SHEET);
  const metaRow = sheet.rows.find((row) => String(row[0]) === "__META__");
  const meta = JSON.parse(metaRow[4]);
  meta.slices.push("cpkRecords");
  metaRow[4] = JSON.stringify(meta);
  sheet.rows = sheet.rows.filter((row) => String(row[0]) !== "cpkRecords");
  const state = api.loadWorkspaceState();
  equal(state.corrupted, true);
});

check("a stale expectedRevision is refused with the current revision, and writes nothing", () => {
  reset();
  ownerSave(payloadOf());
  ownerSave(payloadOf(), 1);
  const before = JSON.stringify(sheetOf(api.CONFIG.STATE_SHEET).rows);
  const conflict = ownerSave(payloadOf({ tasks: [] }), 1);
  equal(conflict.ok, false);
  equal(conflict.conflict, true);
  equal(conflict.revision, 2);
  equal(JSON.stringify(sheetOf(api.CONFIG.STATE_SHEET).rows), before, "store untouched");
});

check("the replaced revision is archived and reloadable from history", () => {
  reset();
  ownerSave(payloadOf());
  ownerSave(payloadOf({ tasks: [] }), 1);
  const history = api.listStateRevisions();
  equal(history.ok, true);
  equal(history.current.revision, 2);
  deep(history.revisions.map((r) => r.revision), [1], "only the replaced revision is archived");

  const loaded = api.loadStateRevision(1);
  equal(loaded.ok, true);
  equal(loaded.data.tasks.length, 1, "the archived copy still holds the old task");
});

check("history keeps at most HISTORY_LIMIT revisions", () => {
  reset();
  ownerSave(payloadOf());
  for (let revision = 1; revision <= 8; revision += 1) {
    ownerSave(payloadOf({ tasks: [{ id: `TSK-${revision}`, status: "To Do" }] }), revision);
  }
  const revisions = api.listStateRevisions().revisions;
  equal(revisions.length, api.CONFIG.HISTORY_LIMIT);
  equal(Math.max(...revisions.map((r) => r.revision)), 8);
  const gone = api.loadStateRevision(1);
  equal(gone.ok, false, "the oldest revision was dropped");
});

check("every save appends one AuditLog row attributed to the saver", () => {
  reset();
  ownerSave(payloadOf());
  ownerSave(payloadOf({ tasks: [] }), 1);
  const audit = sheetOf("AuditLog").rows;
  equal(audit.length, 3, "header + two saves");
  equal(audit[2][1], "owner@minebea.co.th");
  equal(Number(audit[2][2]), 2);
  equal(audit[2][3], "SAVE");
});

check("mirrors are only rebuilt when the caller asks for them", () => {
  reset();
  ownerSave(payloadOf());
  equal(sheetOf("Projects").rows.length, 0, "autosave path leaves mirrors alone");
  ownerSave(payloadOf(), 1);
  session.email = "owner@minebea.co.th";
  api.saveWorkspaceState(JSON.stringify(payloadOf()), "manual save", 2, true);
  equal(sheetOf("Projects").rows[0][0], "ID", "manual save writes the mirror header");
  equal(sheetOf("Projects").rows[1][2], "X4151", "and the project row");
});

// ---------------------------------------------------------------------------
// 2. Save permission rules, through the real save path
// ---------------------------------------------------------------------------

check("a save with no Google identity is refused before anything is written", () => {
  reset();
  session.email = "";
  refused(() => api.saveWorkspaceState(JSON.stringify(payloadOf()), "x", undefined, false), /could not read your Google Workspace identity/);
  equal(sheetOf(api.CONFIG.STATE_SHEET), undefined, "no store was created");
});

check("a busy script lock refuses the save instead of queueing it", () => {
  reset();
  lock.busy = true;
  refused(() => ownerSave(payloadOf()), /Another user is currently saving/);
  equal(sheetOf(api.CONFIG.STATE_SHEET), undefined);
});

check("the first seed is allowed without a roster entry: it is what establishes the roster", () => {
  reset();
  // Nothing on file yet, so even a stranger may seed; the roster comes with it.
  const result = save({ payload: payloadOf(), as: "quality@minebea.co.th" });
  equal(result.ok, true);
  equal(result.revision, 1);
});

check("an account that is not on the roster cannot change a program", () => {
  reset();
  ownerSave(payloadOf());
  refused(
    () => save({ payload: payloadOf({ projects: [{ ...PROJECT, phase: "DVT" }] }), as: "stranger@minebea.co.th", revision: 1 }),
    /not on the team roster, so it owns no program/
  );
});

check("a member may change a program their roster entry names", () => {
  reset();
  ownerSave(payloadOf());
  const result = save({ payload: payloadOf({ projects: [{ ...PROJECT, phase: "DVT" }] }), as: "engineer@minebea.co.th", revision: 1 });
  equal(result.ok, true);
  equal(api.loadWorkspaceState().data.projects[0].phase, "DVT");
});

check("a member may not change a program owned by someone else", () => {
  reset();
  ownerSave(payloadOf());
  refused(
    () => save({ payload: payloadOf({ projects: [{ ...PROJECT, phase: "DVT" }] }), as: "outsider@minebea.co.th", revision: 1 }),
    /you can only change programs you own/
  );
});

check("a rename needs permission for both the old and the new model", () => {
  reset();
  ownerSave(payloadOf());
  refused(
    () => save({ payload: payloadOf({ projects: [{ ...PROJECT, model: "X4026" }] }), as: "engineer@minebea.co.th", revision: 1 }),
    /you can only change programs you own/
  );
});

check("a save that carries the projects forward unchanged needs no program permission", () => {
  reset();
  ownerSave(payloadOf());
  const result = save({ payload: payloadOf({ tasks: [] }), as: "quality@minebea.co.th", revision: 1 });
  equal(result.ok, true, "task-only work by a non-owner is allowed");
});

check("only the spreadsheet owner may change the roster", () => {
  reset();
  ownerSave(payloadOf());
  const grown = ROSTER.concat([{ id: "TM-99", name: "New", role: "Engineer", email: "new@minebea.co.th", products: [] }]);
  refused(
    () => save({ payload: payloadOf({ teamMembers: grown }), as: "engineer@minebea.co.th", revision: 1 }),
    /the team roster is owner data/
  );
  const owners = ownerSave(payloadOf({ teamMembers: grown }), 1);
  equal(owners.ok, true, "the owner may change the roster");
});

check("deleting a program you do not own is refused like editing it", () => {
  reset();
  ownerSave(payloadOf());
  refused(
    () => save({ payload: payloadOf({ projects: [] }), as: "outsider@minebea.co.th", revision: 1 }),
    /remove PRJ-X4151/
  );
});

check("a signature may only name the signed-in user", () => {
  reset();
  // The dossier has to exist first: a gate this save creates is seeding, not a
  // signature, so only a change inside an existing dossier can be judged.
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  refused(
    () =>
      save({
        payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Quality", role: "Quality Engineer", decision: "Approved" }]) }),
        as: "engineer@minebea.co.th",
        revision: 1
      }),
    /a signature can only name the signed-in user/
  );
});

check("erasing a colleague's signature is refused like recording it", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([{ name: "Quality", decision: "Approved" }]) }));
  refused(
    () => save({ payload: payloadOf({ gateRecords: gateRecordsWith([]) }), as: "engineer@minebea.co.th", revision: 1 }),
    /erases Approved by Quality/
  );
});

check("a member signing their own decision is allowed", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  const result = save({
    payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", role: "NPI Engineer", decision: "Approved" }]) }),
    as: "engineer@minebea.co.th",
    revision: 1
  });
  equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// 3. Sign-off ledger
// ---------------------------------------------------------------------------

const ledgerRows = () => (sheetOf("SignOffLog") ? sheetOf("SignOffLog").rows : []);
const ledgerData = () => ledgerRows().slice(1);
const EXPECTED_PROP = "FFM_SIGN_OFF_LEDGER_ROWS";

check("the seed writes no ledger rows: there is no previous state to compare", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([{ name: "Quality", decision: "Approved" }]) }));
  equal(ledgerRows()[0][0], "Timestamp", "the header exists");
  equal(ledgerData().length, 0, "seeding a dossier is not somebody approving");
});

check("an older 11-column ledger header is migrated in place", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  const sheet = sheetOf("SignOffLog");
  sheet.rows[0] = sheet.rows[0].slice(0, 11);
  ownerSave(payloadOf({ tasks: [] }), 1);
  equal(sheet.rows[0][11], "SaveAttemptID");
  equal(sheet.rows[0][12], "CommittedAt");
  equal(ledgerData().length, 0, "the migration does not invent a decision");
});

check("a changed decision appends exactly one ledger row, named and attributed", () => {
  reset();
  // Seed the dossier empty: a decision recorded for the first time inside an
  // existing dossier is exactly the event the ledger exists to record.
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  const result = save({
    payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", role: "NPI Engineer", decision: "Approved", remark: "ok" }]) }),
    as: "engineer@minebea.co.th",
    revision: 1,
    summary: "sign MBO"
  });
  equal(result.signOffLedger.appended, 1);
  deep(result.warnings, []);

  const rows = ledgerData();
  equal(rows.length, 1);
  const [timestamp, revision, programId, program, line, gate, approver, role, decision, remark, email] = rows[0];
  assert.ok(timestamp, "timestamp recorded");
  equal(Number(revision), 2);
  equal(programId, "PRJ-X4151");
  equal(program, "X4151", "the model is resolved from the saved projects");
  equal(line, LINE_KEY);
  equal(gate, "G4 MBO & OK2B", "the ledger label, not the bare gate id");
  equal(approver, "Engineer");
  equal(role, "NPI Engineer", "the signer's roster role wins");
  equal(decision, "Approved");
  equal(remark, "ok");
  equal(email, "engineer@minebea.co.th");
});

check("a save that carries the dossiers forward appends nothing", () => {
  reset();
  const approvers = [{ name: "Engineer", role: "NPI Engineer", decision: "Approved" }];
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  save({ payload: payloadOf({ gateRecords: gateRecordsWith(approvers) }), as: "engineer@minebea.co.th", revision: 1 });
  equal(ledgerData().length, 1, "the first signature was recorded");
  const repeat = save({ payload: payloadOf({ gateRecords: gateRecordsWith(approvers) }), as: "engineer@minebea.co.th", revision: 2 });
  equal(repeat.signOffLedger.appended, 0);
  equal(ledgerData().length, 1, "no duplicate row for an unchanged decision");
});

check("a decision that changes again appends a new row and leaves the earlier one intact", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  save({
    payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", decision: "Approved" }]) }),
    as: "engineer@minebea.co.th",
    revision: 1
  });
  const first = ledgerData()[0].slice();
  const second = save({
    payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", decision: "Rejected", remark: "rework" }]) }),
    as: "engineer@minebea.co.th",
    revision: 2
  });
  equal(second.signOffLedger.appended, 1);
  equal(ledgerData().length, 2);
  deep(ledgerData()[0], first, "the append-only row did not change");
  equal(ledgerData()[1][8], "Rejected");
});

check("a ledger append that fails refuses the save before the store commits", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  const stateBefore = stateRows().map((row) => row.slice());
  const historyBefore = sheetOf("_FFM_STATE_HISTORY").rows.map((row) => row.slice());
  sheetOf("SignOffLog").failSetValuesFromRow = 2; // header row is fine; the append is not

  assert.throws(
    () =>
      save({
        payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", decision: "Approved" }]) }),
        as: "engineer@minebea.co.th",
        revision: 1
      }),
    /Save refused: SignOffLog could not be written/
  );

  deep(stateRows().map((row) => row.slice()), stateBefore, "the store did not move");
  deep(sheetOf("_FFM_STATE_HISTORY").rows.map((row) => row.slice()), historyBefore, "history did not move");
  equal(api.loadWorkspaceState().revision, 1);
  equal(
    api.loadWorkspaceState().data.gateRecords["PRJ-X4151"][LINE_KEY].mbo.approvers.length,
    0,
    "the signature is not in the saved gate records"
  );
  equal(ledgerData().length, 0, "no audit row was written without a committed decision");

  sheetOf("SignOffLog").failSetValuesFromRow = 0; // the outage ends
  const retry = save({
    payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", decision: "Approved" }]) }),
    as: "engineer@minebea.co.th",
    revision: 1
  });
  equal(retry.ok, true);
  equal(retry.revision, 2);
  equal(retry.signOffLedger.appended, 1);
  equal(ledgerData().length, 1, "the retry writes the decision once");
});

check("a refused signature is not a gap after five later revisions", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  sheetOf("SignOffLog").failSetValuesFromRow = 2;
  assert.throws(
    () =>
      save({
        payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", decision: "Approved" }]) }),
        as: "engineer@minebea.co.th",
        revision: 1
      }),
    /Save refused: SignOffLog could not be written/
  );
  sheetOf("SignOffLog").failSetValuesFromRow = 0;

  // Move the live state past the whole history window. There is no signature to
  // recover because the refused save never committed one.
  let revision = 1;
  for (let i = 0; i < 5; i += 1) {
    const result = ownerSave(payloadOf({ gateRecords: gateRecordsWith([]), tasks: [] }), revision);
    revision = result.revision;
  }
  equal(revision, 6);
  equal(ledgerData().length, 0);
  equal(api.loadWorkspaceState().data.gateRecords["PRJ-X4151"][LINE_KEY].mbo.approvers.length, 0);
});

check("a retry cannot duplicate a decision already in the ledger", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  // Simulate a ledger row whose state commit failed: the retry must not append
  // the same decision again. The row's revision differs from the retry's next
  // revision; the matching save attempt id is what makes it the same attempt.
  const existing = [
    "2026-11-20T00:00:00.000Z",
    1,
    "PRJ-X4151",
    "X4151",
    LINE_KEY,
    "G4 MBO & OK2B",
    "Engineer",
    "NPI Engineer",
    "Approved",
    "",
    "engineer@minebea.co.th",
    "SA-retry",
    ""
  ];
  sheetOf("SignOffLog").appendRow(existing);

  const retry = save({
    payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", decision: "Approved" }]) }),
    as: "engineer@minebea.co.th",
    revision: 1,
    attempt: "SA-retry"
  });
  equal(retry.ok, true);
  equal(retry.signOffLedger.appended, 0);
  equal(ledgerData().length, 1);
  deep(ledgerData()[0].slice(0, 11), existing.slice(0, 11), "the decision fields did not change");
  equal(ledgerData()[0][11], "SA-retry");
  assert.ok(ledgerData()[0][12], "the retry stamps the existing row committed");
});

check("a row from a failed state write is reported uncommitted, then committed by its retry", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  const stateSheet = sheetOf("_FFM_STATE_STORE");
  stateSheet.failNextSetValuesFromRow = 1;

  assert.throws(
    () =>
      save({
        payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", decision: "Approved" }]) }),
        as: "engineer@minebea.co.th",
        revision: 1,
        attempt: "SA-failed"
      }),
    /_FFM_STATE_STORE could not be written.*previous revision was restored/
  );
  equal(ledgerData().length, 1, "the decision row was written before the failed commit");
  equal(ledgerData()[0][11], "SA-failed");
  equal(ledgerData()[0][12], "", "the row has no commit marker");

  // Make the stored count look healthy too: reconciliation must still report the
  // uncommitted row instead of treating the count as a baseline.
  store.properties[EXPECTED_PROP] = "1";
  const report = api.reconcileSignOffLedger();
  equal(report.ok, true);
  equal(report.inSync, false);
  equal(report.appended, 0);
  equal(report.uncommittedCount, 1);
  equal(report.uncommitted[0].attemptId, "SA-failed");
  equal(report.rebaselined, undefined, "an uncommitted row is not silently re-baselined");
  equal(store.properties[EXPECTED_PROP], "1");
  equal(ledgerData()[0][12], "", "reconciliation did not mark the row");

  const retry = save({
    payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", decision: "Approved" }]) }),
    as: "engineer@minebea.co.th",
    revision: 1,
    attempt: "SA-failed"
  });
  equal(retry.ok, true);
  equal(retry.signOffLedger.appended, 0, "the retry reuses its uncommitted row");
  equal(retry.revision, 2);
  equal(ledgerData().length, 1);
  assert.ok(ledgerData()[0][12], "the successful state write stamps the row committed");
  const after = api.reconcileSignOffLedger();
  equal(after.ok, true);
  equal(after.inSync, true);
  equal(after.appended, 0);
});

check("a new attempt commits its own row and leaves the failed attempt's row reported", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  const stateSheet = sheetOf("_FFM_STATE_STORE");
  stateSheet.failNextSetValuesFromRow = 1;
  assert.throws(
    () =>
      save({
        payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", decision: "Approved" }]) }),
        as: "engineer@minebea.co.th",
        revision: 1,
        attempt: "SA-abandoned"
      }),
    /_FFM_STATE_STORE could not be written/
  );
  const committed = save({
    payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", decision: "Approved" }]) }),
    as: "engineer@minebea.co.th",
    revision: 1,
    attempt: "SA-fresh"
  });
  equal(committed.ok, true);
  equal(ledgerData().length, 2);
  equal(ledgerData()[0][11], "SA-abandoned");
  equal(ledgerData()[0][12], "", "the abandoned attempt stays uncommitted");
  equal(ledgerData()[1][11], "SA-fresh");
  assert.ok(ledgerData()[1][12], "the new attempt is committed");

  const report = api.reconcileSignOffLedger();
  equal(report.inSync, false);
  equal(report.appended, 0);
  equal(report.uncommittedCount, 1);
  equal(report.uncommitted[0].attemptId, "SA-abandoned");
});

check("getSignOffLedger reads the tab back as decision objects", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  save({
    payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", role: "NPI Engineer", decision: "Approved" }]) }),
    as: "engineer@minebea.co.th",
    revision: 1
  });
  const ledger = api.getSignOffLedger();
  equal(ledger.ok, true);
  equal(ledger.rows.length, 1);
  deep(Object.keys(ledger.rows[0]).sort(), [
    "approver", "decision", "gate", "line", "program", "programId", "remark", "revision", "role", "signedInEmail", "timestamp"
  ]);
  equal(ledger.rows[0].gate, "G4 MBO & OK2B");
  equal(ledger.rows[0].signedInEmail, "engineer@minebea.co.th");
  assert.ok(ledger.sheetUrl.includes("#gid="), "the reader returns a link to the tab");
});

check("getSignOffLedger refuses without an identity and skips blank rows", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  save({
    payload: payloadOf({ gateRecords: gateRecordsWith([{ name: "Engineer", decision: "Approved" }]) }),
    as: "engineer@minebea.co.th",
    revision: 1
  });
  session.email = "";
  const denied = api.getSignOffLedger();
  equal(denied.ok, false);
  assert.match(denied.error, /Sign-in required/);

  session.email = "owner@minebea.co.th";
  sheetOf("SignOffLog").appendRow(["", "", "", "", "", "", "", "", "", "", ""]);
  const ledger = api.getSignOffLedger();
  equal(ledger.ok, true);
  equal(ledger.rows.length, 1, "a blank row is not a decision");
});

check("an empty ledger reads as an empty list rather than an error", () => {
  reset();
  ownerSave(payloadOf());
  const ledger = api.getSignOffLedger();
  equal(ledger.ok, true);
  deep(ledger.rows, []);
});

// ---------------------------------------------------------------------------
// 4. Self-healing ledger: reconcile replays the archived revisions
// ---------------------------------------------------------------------------

const signEngineer = (decision, extra = {}) =>
  save({
    payload: payloadOf({
      gateRecords: gateRecordsWith([{ name: "Engineer", role: "NPI Engineer", decision, ...extra }])
    }),
    as: "engineer@minebea.co.th",
    revision: extra.revision
  });

check("a ledger that is already complete reconciles nothing", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  signEngineer("Approved", { revision: 1 });
  const before = JSON.stringify(ledgerData());
  const repair = api.reconcileSignOffLedger();
  equal(repair.ok, true);
  equal(repair.appended, 0);
  equal(repair.inSync, true);
  equal(JSON.stringify(ledgerData()), before);
});

check("a missing ledger row is repaired from the archived revisions", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  const signed = signEngineer("Approved", { revision: 1, remark: "line released" });
  equal(signed.signOffLedger.appended, 1);
  const expected = ledgerData()[0].slice();

  // Simulate a legacy post-commit append that never landed: the state has the
  // decision and the archived revision still lets the ledger be rebuilt.
  sheetOf("SignOffLog").rows = ledgerRows().slice(0, 1);
  equal(ledgerData().length, 0, "the row is missing");

  const repair = api.reconcileSignOffLedger();
  equal(repair.ok, true, `reconcile failed: ${repair.error || ""}`);
  equal(repair.appended, 1);
  deep(
    ledgerData()[0].slice(0, 11),
    expected.slice(0, 11),
    "the rebuilt decision keeps the save's timestamp and values"
  );
  assert.ok(ledgerData()[0][12], "the rebuilt row is stamped committed");

  const again = api.reconcileSignOffLedger();
  equal(again.appended, 0, "reconciling twice does not duplicate the row");
  equal(ledgerData().length, 1);
});

check("a legacy gap is still repaired after later saves have moved the store on", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  const signed = signEngineer("Approved", { revision: 1 });
  const expected = ledgerData()[0].slice();
  // Simulate the old post-commit loss, then let later saves move the store on.
  sheetOf("SignOffLog").rows = ledgerRows().slice(0, 1);
  equal(ledgerData().length, 0);

  // A later save that changes no gate: it appends nothing, so the gap survives it.
  ownerSave(payloadOf({ tasks: [] }), 2);

  const repair = api.reconcileSignOffLedger();
  equal(repair.appended, 1);
  deep(
    ledgerData()[0].slice(0, 11),
    expected.slice(0, 11),
    "the rebuilt decision keeps the save's timestamp and values"
  );
  assert.ok(ledgerData()[0][12], "the rebuilt row is stamped committed");
  equal(Number(ledgerData()[0][1]), 2, "attributed to the revision that made the decision");
});

check("seeded dossiers are never invented into the ledger", () => {
  reset();
  // The seed ships demo approvals; they were never a signature and the save path
  // deliberately logs nothing for the state that created them.
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([{ name: "Quality", role: "Quality Engineer", decision: "Approved" }]) }));
  ownerSave(payloadOf({ tasks: [] }), 1);
  ownerSave(payloadOf({ tasks: [], productionRecords: [] }), 2);
  equal(ledgerData().length, 0);

  // Force the expensive path: the counter disagrees with the tab.
  store.properties[EXPECTED_PROP] = "7";
  const repair = api.reconcileSignOffLedger();
  equal(repair.ok, true);
  equal(repair.appended, 0, "an unchanged seed is not a missing decision");
  equal(ledgerData().length, 0);
  equal(repair.rebaselined, true, "the counter is re-based so the check stays cheap");
});

check("an erased signature is not rebuilt as a decision", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  signEngineer("Approved", { revision: 1 });
  equal(ledgerData().length, 1);
  // The signer withdraws their own decision: no new decision, so no new row.
  save({ payload: payloadOf({ gateRecords: gateRecordsWith([]) }), as: "engineer@minebea.co.th", revision: 2 });
  equal(ledgerData().length, 1);

  store.properties[EXPECTED_PROP] = "4";
  const repair = api.reconcileSignOffLedger();
  equal(repair.appended, 0);
  equal(ledgerData().length, 1);
});

check("reconcile refuses without an identity, under a save lock, and on an empty store", () => {
  reset();
  session.email = "";
  const denied = api.reconcileSignOffLedger();
  equal(denied.ok, false);
  assert.match(denied.error, /Sign-in required/);

  reset();
  ownerSave(payloadOf());
  lock.busy = true;
  const locked = api.reconcileSignOffLedger();
  equal(locked.ok, false);
  equal(locked.locked, true);
  lock.busy = false;

  reset();
  const empty = api.reconcileSignOffLedger();
  equal(empty.ok, false);
  assert.match(empty.error, /has not been saved yet/);
});

check("the repaired row is only built from adjacent revisions", () => {
  reset();
  ownerSave(payloadOf({ gateRecords: gateRecordsWith([]) }));
  signEngineer("Approved", { revision: 1 });
  sheetOf("SignOffLog").rows = ledgerRows().slice(0, 1);
  ownerSave(payloadOf({ tasks: [] }), 2);

  const history = sheetOf("_FFM_STATE_HISTORY");
  // Drop revision 1 from the archive: the pair that made the decision is gone, so
  // the revision-2 snapshot must not be diffed against revision 3 instead.
  history.rows = history.rows.filter((row) => Number(row[1]) !== 1);
  store.properties[EXPECTED_PROP] = "9";

  const repair = api.reconcileSignOffLedger();
  equal(repair.appended, 0, "no decision is attributed to a revision that did not make it");
  equal(ledgerData().length, 0);
});

check("a restore snapshot refuses an empty or non-workspace payload before touching Drive", () => {
  const empty = api.exportRestoreSnapshot("", "backup.json");
  equal(empty.ok, false);
  assert.match(empty.error, /could not be read/);

  const invalid = api.exportRestoreSnapshot("{}", "backup.json");
  equal(invalid.ok, false);
  assert.match(invalid.error, /not a valid workspace payload/);
});

check("a restore snapshot without a Google identity stops instead of writing", () => {
  const saved = session.email;
  session.email = "";
  try {
    const res = api.exportRestoreSnapshot(JSON.stringify({ projects: [] }), "backup.json");
    equal(res.ok, false);
    assert.match(res.error, /identity/);
  } finally {
    session.email = saved;
  }
});

check("the SheetJS source is read from its own HTML file on demand", () => {
  htmlService.content = '<!-- built -->\n<script>\nwindow.XLSX = {};\n<\\/script>\n';
  const res = api.getSheetJsSource();
  equal(res.ok, true);
  assert.match(res.source, /window\.XLSX/);

  htmlService.fail = true;
  try {
    const failed = api.getSheetJsSource();
    equal(failed.ok, false);
    assert.match(failed.error, /could not be loaded/);
  } finally {
    htmlService.fail = false;
  }
});

// ---------------------------------------------------------------------------

let passed = 0;
for (const result of results) {
  if (result.ok) {
    passed += 1;
    console.log(`  pass  ${result.label}`);
  } else {
    console.log(`  FAIL  ${result.label}  (${result.message})`);
  }
}
console.log(`\n${passed}/${results.length} Code.js server checks passed.`);
if (passed !== results.length) process.exit(1);
