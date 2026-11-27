/**
 * Daily state backup checks.
 *
 * The trigger itself needs Drive and a clock, so what is checked here is every
 * decision that can be wrong silently:
 *
 *   - the file name is dated in the script's time zone and sorts chronologically;
 *   - pruning drops only this job's own files, oldest first, and never the newest
 *     `keep` — a folder someone also uses by hand keeps its contents;
 *   - the file has the same shape as Sidebar → Backup, which is what makes the
 *     documented restore path work;
 *   - installing the trigger twice leaves one, because the handler is found by
 *     name rather than assumed absent;
 *   - the manifest grants the two scopes that work needs.
 *
 * The helpers are read straight out of Code.js — the text clasp ships — so the
 * tests cannot drift from a copy of a rule.
 *
 * Tooling only: tools/** is in .claspignore, so nothing here ships to Apps Script.
 *
 * Run: bun tools/test-state-backup.mjs
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = join(import.meta.dir, "..");
const code = readFileSync(join(ROOT, "Code.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(ROOT, "appsscript.json"), "utf8"));

const DECLARATIONS = [
  /const CONFIG = \{[\s\S]*?\n\};/,
  /const BACKUP_HANDLER = '[^']+';/,
  /function backupStamp_\([\s\S]*?\n}/,
  /function backupFileName_\([\s\S]*?\n}/,
  /function backupFilesToDelete_\([\s\S]*?\n}/,
  /function buildStateBackup_\([\s\S]*?\n}/,
  /function backupTriggers_\([\s\S]*?\n}/,
  /function pad2_\([\s\S]*?\n}/
];

const pieces = DECLARATIONS.map((pattern) => {
  const match = code.match(pattern);
  if (!match) {
    console.error(`Code.js no longer declares ${pattern} — update this test, the helper moved.`);
    process.exit(1);
  }
  return match[0];
});

// Apps Script provides Utilities.formatDate and Session; the harness supplies the
// same two calls for the one format this job uses.
const PRELUDE = `
  const Session = { getScriptTimeZone: () => 'Asia/Bangkok' };
  const Utilities = {
    formatDate(date, timeZone, format) {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(date).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
      if (format !== 'yyyy-MM-dd_HHmm') throw new Error('unexpected format ' + format);
      return parts.year + '-' + parts.month + '-' + parts.day + '_' + parts.hour + parts.minute;
    }
  };
`;

const api = new Function(
  `"use strict";\n${PRELUDE}\n${pieces.join("\n")}\n` +
    "return { CONFIG, BACKUP_HANDLER, backupFileName_, backupStamp_, backupFilesToDelete_, " +
    "buildStateBackup_, backupTriggers_, pad2_ };"
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

// --- the file name ----------------------------------------------------------

// 18:30 UTC is 01:30 the next morning in Bangkok: the trigger hour is the script's.
const INSTANT = new Date("2026-11-26T18:30:00Z");

check("the file is named for the day it ran, in the script's time zone", () => {
  equal(api.backupFileName_(INSTANT), "FFM_NPI_Ops_state_2026-11-27_0130.json");
});

check("an explicit time zone wins over the script's", () => {
  equal(api.backupFileName_(INSTANT, "UTC"), "FFM_NPI_Ops_state_2026-11-26_1830.json");
});

check("the day stamp is zero-padded, so names sort chronologically as text", () => {
  const early = api.backupFileName_(new Date("2026-01-05T00:05:00Z"), "UTC");
  equal(early, "FFM_NPI_Ops_state_2026-01-05_0005.json");
  assert.ok(early < api.backupFileName_(new Date("2026-01-05T00:06:00Z"), "UTC"));
  assert.ok(
    api.backupFileName_(new Date("2026-12-31T00:00:00Z"), "UTC") >
      api.backupFileName_(new Date("2026-01-01T00:00:00Z"), "UTC"),
    "December sorts after January"
  );
});

// --- pruning ----------------------------------------------------------------

const namesFor = (days) =>
  Array.from({ length: days }, (_, i) =>
    `FFM_NPI_Ops_state_2026-11-${String(i + 1).padStart(2, "0")}_0130.json`
  );

check("thirty-five daily copies keep the newest thirty", () => {
  const doomed = api.backupFilesToDelete_(namesFor(35), 30);
  equal(doomed.length, 5);
  equal(doomed[0], "FFM_NPI_Ops_state_2026-11-01_0130.json");
  equal(doomed[doomed.length - 1], "FFM_NPI_Ops_state_2026-11-05_0130.json");
});

check("pruning keeps the newest even when the folder is in any order", () => {
  const shuffled = [...namesFor(7)].reverse();
  deep(api.backupFilesToDelete_(shuffled, 7), []);
  equal(api.backupFilesToDelete_(shuffled, 2).length, 5);
});

check("a hand-downloaded backup or a stray file is never deleted", () => {
  const mixed = [
    ...namesFor(4),
    "FFM_NPI_Ops_Backup_2026-10-01.json",
    "notes.txt",
    "FFM_NPI_Ops_state_2026-01-01_0130.json.bak",
    "Someone else's folder notes"
  ];
  const doomed = api.backupFilesToDelete_(mixed, 2);
  deep(doomed, [
    "FFM_NPI_Ops_state_2026-11-01_0130.json",
    "FFM_NPI_Ops_state_2026-11-02_0130.json"
  ]);
});

check("fewer files than the limit deletes nothing", () => {
  deep(api.backupFilesToDelete_(namesFor(3), 30), []);
  deep(api.backupFilesToDelete_([], 30), []);
  deep(api.backupFilesToDelete_(null, 30), []);
});

check("a meaningless keep falls back to the configured limit, not to one", () => {
  equal(api.backupFilesToDelete_(namesFor(3), 0).length, 0);
  equal(api.backupFilesToDelete_(namesFor(3), -5).length, 0);
  equal(api.backupFilesToDelete_(namesFor(3), "thirty").length, 0);
  // A real limit still prunes. The default is 30, so 40 files leave 10 to drop.
  equal(api.backupFilesToDelete_(namesFor(31).concat(
    Array.from({ length: 9 }, (_, i) => `FFM_NPI_Ops_state_2026-12-${String(i + 1).padStart(2, "0")}_0130.json`)
  ), 0).length, 10);
});

// --- the file contents ------------------------------------------------------

const SNAPSHOT = {
  meta: { revision: 42, lastSavedAt: "2026-11-26T18:00:00.000Z", lastSavedBy: "qa@minebea.co.th" },
  data: {
    projects: [{ id: "PRJ-X4151-01", model: "X4151", note: 'quoted "text" · ünïcode' }],
    teamMembers: [{ id: "TM-12", name: "Patcharapong", email: "patcharapong@minebea.co.th" }]
  }
};

check("the file carries the same keys as the sidebar export", () => {
  const payload = api.buildStateBackup_(SNAPSHOT, "2026-11-27T01:30:00.000Z");
  deep(Object.keys(payload), [
    "app",
    "version",
    "exportedAt",
    "revision",
    "lastSavedAt",
    "lastSavedBy",
    "data"
  ]);
  equal(payload.app, "FFM NPI Ops");
  equal(payload.revision, 42);
  equal(payload.lastSavedAt, "2026-11-26T18:00:00.000Z");
  equal(payload.data.projects.length, 1);
});

check("the app's Restore accepts the file unchanged", () => {
  // handleImportWorkspaceJson: JSON.parse → parsed.data || parsed → projects array.
  const parsed = JSON.parse(JSON.stringify(api.buildStateBackup_(SNAPSHOT, "2026-11-27T01:30:00.000Z")));
  const payload = parsed.data || parsed;
  assert.ok(Array.isArray(payload.projects), "Restore would reject the file");
  equal(payload.projects[0].note, 'quoted "text" · ünïcode');
});

check("an empty or meta-less store still produces a valid, empty file", () => {
  const payload = api.buildStateBackup_({}, "2026-11-27T01:30:00.000Z");
  equal(payload.revision, 0);
  equal(payload.lastSavedAt, null);
  deep(payload.data, {});
  const fromNull = api.buildStateBackup_(null, "2026-11-27T01:30:00.000Z");
  equal(fromNull.revision, 0);
  deep(fromNull.data, {});
});

// --- the trigger ------------------------------------------------------------

const trigger = (handler, throws = false) => ({
  getHandlerFunction() {
    if (throws) throw new Error("deleted trigger");
    return handler;
  }
});

check("only triggers running the backup handler are replaced", () => {
  const existing = [
    trigger("exportStateBackup"),
    trigger("onOpen"),
    trigger("exportStateBackup"),
    trigger("refreshMirrorSheetsFromMenu_")
  ];
  equal(api.backupTriggers_(existing).length, 2);
  deep(api.backupTriggers_([]), []);
  deep(api.backupTriggers_(null), []);
});

check("a trigger that cannot report its handler does not break the install", () => {
  equal(api.backupTriggers_([trigger("exportStateBackup"), trigger("", true)]).length, 1);
});

check("the handler the trigger names is a top-level function", () => {
  equal(typeof api.BACKUP_HANDLER, "string");
  assert.ok(
    new RegExp(`^function ${api.BACKUP_HANDLER}\\(`, "m").test(code),
    `${api.BACKUP_HANDLER} is not a top-level function`
  );
  assert.ok(/ScriptApp\.newTrigger\(BACKUP_HANDLER\)/.test(code), "the trigger is not built from the handler name");
  assert.ok(/\.everyDays\(1\)/.test(code), "the trigger is not daily");
});

check("the menu hours are padded for display", () => {
  equal(api.pad2_(1), "01");
  equal(api.pad2_(30), "30");
  equal(api.pad2_(13), "13");
});

// --- the manifest -----------------------------------------------------------

check("the manifest grants Drive (app files) and trigger control", () => {
  const scopes = manifest.oauthScopes || [];
  assert.ok(scopes.includes("https://www.googleapis.com/auth/drive.file"), "no drive.file scope");
  assert.ok(scopes.includes("https://www.googleapis.com/auth/script.scriptapp"), "no script.scriptapp scope");
});

check("the scopes the app already needed are still declared", () => {
  const scopes = manifest.oauthScopes || [];
  ["spreadsheets", "userinfo.email", "script.container.ui"].forEach((scope) => {
    assert.ok(
      scopes.includes(`https://www.googleapis.com/auth/${scope}`),
      `lost the ${scope} scope`
    );
  });
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
console.log(`\n${passed}/${results.length} daily backup checks passed.`);
if (passed !== results.length) process.exit(1);
