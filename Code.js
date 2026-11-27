/**
 * ============================================================================
 * FFM NPI Ops — Google Apps Script Backend (v2.1.0 GAS Cloud Edition)
 * ============================================================================
 * GAS Script ID : 1X2_cRlFBThwdhhUbr0Fr7yvq8zFXpgHzCmSs7CCN_Z-RPol2f-L6sQeY
 * Google Sheet  : 161ZBdYRMVg2kRvwWkF5NtkH4OGNEdKCvyJxB7aUHRuw
 * Web App URL   : https://script.google.com/a/macros/minebea.co.th/s/AKfycbz6y_8byEXlOxSWq6y5_azvp129b7CmlIfqhuNGA2BX-LrKTHVnmQdgHwylvx7yFE4C/exec
 *
 * Persistence Architecture:
 *  - Primary lossless state store: `_FFM_STATE_STORE` (auto-chunked at 40,000
 *    chars/cell to safely bypass Google Sheets' 50,000-char cell limit).
 *  - Human-readable mirror tabs (Projects, Tasks, ProductionRecords,
 *    MasterSpecs, CpkRecords, CostProjects, CustomerFeedback) are DERIVED
 *    reports: rebuilt from the store on demand (Sheet menu, or an explicit
 *    manual save), never on the debounced autosave path. The revision and
 *    timestamp of the last rebuild are kept in script properties and shown
 *    in the menu, so a stale mirror is visible rather than silent.
 *  - AuditLog is appended on every committed save.
 *  - SignOffLog is the append-only gate decision ledger: one immutable row per
 *    changed gate decision (program, line, gate, approver, decision, timestamp,
 *    signed-in email), written inside the same save lock and before the mutable
 *    store commits, so "who approved what" is answered from its own tab instead
 *    of from the mutable gateRecords JSON.
 *  - Concurrency safe via LockService.getScriptLock().
 *  - Runs as the accessing user (executeAs USER_ACCESSING), so the AuditLog can
 *    attribute every save and sign-off to the signed-in Google account. Saves
 *    without an identity fail closed rather than being attributed to nobody.
 */

const CONFIG = {
  SPREADSHEET_ID: '161ZBdYRMVg2kRvwWkF5NtkH4OGNEdKCvyJxB7aUHRuw',
  GAS_SCRIPT_ID: '1X2_cRlFBThwdhhUbr0Fr7yvq8zFXpgHzCmSs7CCN_Z-RPol2f-L6sQeY',
  WEB_APP_URL: 'https://script.google.com/a/macros/minebea.co.th/s/AKfycbz6y_8byEXlOxSWq6y5_azvp129b7CmlIfqhuNGA2BX-LrKTHVnmQdgHwylvx7yFE4C/exec',
  APP_TITLE: 'FFM NPI Ops — NMB-Minebea Thai Ltd.',
  STATE_SHEET: '_FFM_STATE_STORE',
  STATE_HISTORY_SHEET: '_FFM_STATE_HISTORY',
  AUDIT_SHEET: 'AuditLog',
  SIGN_OFF_SHEET: 'SignOffLog',
  CHUNK_SIZE: 40000,
  // How many replaced copies of the state store to keep, oldest dropped first.
  HISTORY_LIMIT: 5,
  MIRROR_REVISION_PROP: 'FFM_MIRROR_REVISION',
  MIRROR_REFRESHED_PROP: 'FFM_MIRROR_REFRESHED_AT',
  // Rows the SignOffLog should hold once every committed decision is in it.
  // New saves write the ledger before committing, so this counter mainly makes
  // the legacy-gap reconcile cheap; a mismatch is the signal to inspect history.
  SIGN_OFF_LEDGER_COUNT_PROP: 'FFM_SIGN_OFF_LEDGER_ROWS',
  // Daily state backup: one dated JSON file per run in this Drive folder, and
  // only the newest BACKUP_KEEP survive, so the folder cannot grow without limit.
  BACKUP_FOLDER_NAME: 'FFM NPI Ops State Backups',
  BACKUP_PREFIX: 'FFM_NPI_Ops_state_',
  BACKUP_KEEP: 30,
  BACKUP_HOUR: 1,
  BACKUP_MINUTE: 30,
  // Pre-restore snapshots live in the same folder but keep their own count:
  // a burst of restores must not evict the daily copies, and vice versa.
  RESTORE_SNAPSHOT_PREFIX: 'FFM_NPI_Ops_pre_restore_',
  RESTORE_SNAPSHOT_KEEP: 10
};

/** Handler name the daily trigger calls. Must stay a top-level function name. */
const BACKUP_HANDLER = 'exportStateBackup';

const SIGN_OFF_LEDGER_HEADERS = [
  'Timestamp', 'Revision', 'ProgramID', 'Program', 'Line', 'Gate',
  'Approver', 'Role', 'Decision', 'Remark', 'SignedInEmail'
];

// Gate names for the ledger only. The web app keeps its own NPI_GATES constant,
// which the server cannot read, so the same nine ids are repeated here to write a
// readable gate instead of a bare id.
const GATE_LEDGER_LABELS = {
  prep: 'G1 Preparing',
  bbr: 'G2 BBR',
  brr: 'G3 BRR',
  mbo: 'G4 MBO & OK2B',
  main: 'G5 Main Build',
  oqc: 'G6 Final Insp.',
  ship: 'G7 Shipment',
  mih: 'G8 FATP MIH',
  pbr: 'G9 PBR'
};

const PERSISTED_SLICES = [
  'projects',
  'tasks',
  'gateRecords',
  'productionRecords',
  'masterSpecs',
  'cpkRecords',
  'costProjects',
  'customerFeedback',
  'scheduleOverrides',
  'teamMembers'
];

const STATE_STORE_HEADERS = ['SliceKey', 'ChunkIndex', 'ChunkCount', 'UpdatedAt', 'PayloadChunk'];

/**
 * Web App Entry Point
 */
function doGet(e) {
  // Fail closed: without a Google identity nothing can be attributed, so the app
  // is not loaded at all. Users outside the deploying domain, or users who deny
  // the email scope on the consent screen, land here.
  const userEmail = getActiveUserEmail_();
  if (!userEmail) {
    return HtmlService.createHtmlOutput(
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + CONFIG.APP_TITLE + '</title></head>' +
      '<body style="margin:0;padding:24px;background:#0f172a;font-family:system-ui,-apple-system,Segoe UI,sans-serif;">' +
      '<div style="max-width:560px;margin:48px auto;background:#fff;color:#0f172a;border-radius:12px;padding:24px;">' +
      '<h2 style="margin:0 0 8px;font-size:16px;">Sign-in required</h2>' +
      '<p style="margin:0 0 12px;font-size:13px;line-height:1.5;">FFM NPI Ops records who saves and approves, so it needs your Google Workspace identity. ' +
      'Google did not provide an email address for this session &mdash; usually because the account is outside the Minebea domain, or because access to your email address was not granted on the permission screen.</p>' +
      '<p style="margin:0 0 12px;font-size:13px;line-height:1.5;">Sign in with your <strong>@minebea.co.th</strong> account, grant the requested permissions, then reload.</p>' +
      '<a href="' + CONFIG.WEB_APP_URL + '" style="display:inline-block;padding:8px 14px;background:#0f172a;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">Reload FFM NPI Ops</a>' +
      '</div></body></html>'
    ).setTitle(CONFIG.APP_TITLE);
  }

  const template = HtmlService.createTemplateFromFile('Index');
  template.serverConfigJson = JSON.stringify({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit',
    webAppUrl: CONFIG.WEB_APP_URL,
    userEmail: userEmail
  });
  return template
    .evaluate()
    .setTitle(CONFIG.APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * HTML Template Include Helper for modular GAS files
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Custom Spreadsheet Menu when opening the backing Google Sheet directly
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('FFM NPI Ops')
      .addItem('Open Web Application', 'openWebAppDialog_')
      .addItem('Refresh Mirror Tabs…', 'refreshMirrorSheetsFromMenu_')
      .addItem('Verify / Setup Database Tabs', 'ensureAllTabs_')
      .addItem('Protect Managed Tabs (owner)', 'protectManagedTabsFromMenu_')
      .addSubMenu(
        SpreadsheetApp.getUi()
          .createMenu('Daily State Backup')
          .addItem('Install / repair the daily trigger', 'installDailyBackupTriggerFromMenu_')
          .addItem('Back up now', 'exportStateBackupFromMenu_')
          .addItem('Backup status', 'showBackupStatusFromMenu_')
      )
      .addToUi();
  } catch (err) {
    // Ignore when triggered outside Sheet UI context
  }
}

function openWebAppDialog_() {
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui,sans-serif;padding:12px;">' +
    '<p style="margin:0 0 12px;font-size:13px;color:#334155;">Launch the FFM NPI Ops Web Application:</p>' +
    '<a href="' + CONFIG.WEB_APP_URL + '" target="_blank" ' +
    'style="display:inline-block;padding:8px 14px;background:#0f172a;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">' +
    'Open FFM NPI Ops &rarr;</a></div>'
  ).setWidth(320).setHeight(110);
  SpreadsheetApp.getUi().showModalDialog(html, 'FFM NPI Ops Web App');
}

/**
 * Email of the person using the web app, or '' when Google does not expose it
 * (users outside the script owner's domain). This deliberately does NOT fall
 * back to the effective user: that is the deployer, so the fallback would
 * attribute every user's save to the deployer in the AuditLog.
 */
function getActiveUserEmail_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

/** Email the script actually executes as (normally the deployer), for diagnostics. */
function getExecutorEmail_() {
  try {
    return Session.getEffectiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

/**
 * Neutralizes spreadsheet formula injection: a text cell whose trimmed value
 * starts with =, +, -, @, tab or CR would otherwise be evaluated as a formula
 * when written with setValues/appendRow. Non-string values pass through so
 * numbers stay numeric.
 */
function safeSheetText_(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value.trim()) ? "'" + value : value;
}

function safeSheetRow_(row) {
  return row.map(function(cell) { return safeSheetText_(cell); });
}

function getSpreadsheet_() {
  try {
    return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  } catch (err) {
    // Under USER_ACCESSING each user opens the Sheet with their own permissions.
    throw new Error(
      'FFM NPI Ops cannot open its Google Sheet as ' + (getActiveUserEmail_() || 'this account') +
      '. Ask the owner to share the FFM NPI Ops spreadsheet with your account as an Editor, then reload. (' +
      (err && err.message ? err.message : err) + ')'
    );
  }
}

function getOrCreateSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

function ensureAllTabs_() {
  const ss = getSpreadsheet_();
  const stateSheet = getOrCreateSheet_(ss, CONFIG.STATE_SHEET);
  if (stateSheet.getLastRow() === 0) {
    stateSheet.getRange(1, 1, 1, STATE_STORE_HEADERS.length).setValues([STATE_STORE_HEADERS]);
    stateSheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
    stateSheet.setFrozenRows(1);
  }
  const auditSheet = getOrCreateSheet_(ss, CONFIG.AUDIT_SHEET);
  if (auditSheet.getLastRow() === 0) {
    auditSheet.getRange(1, 1, 1, 6).setValues([['Timestamp', 'UserEmail', 'Revision', 'Action', 'Summary', 'Executor']]);
    auditSheet.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
    auditSheet.setFrozenRows(1);
  } else if (String(auditSheet.getRange(1, 6).getValue() || '') !== 'Executor') {
    // Migrate an older 5-column AuditLog in place; existing rows keep their values.
    auditSheet.getRange(1, 6).setValue('Executor').setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
  }
  const ledgerSheet = getOrCreateSheet_(ss, CONFIG.SIGN_OFF_SHEET);
  if (ledgerSheet.getLastRow() === 0) {
    ledgerSheet.getRange(1, 1, 1, SIGN_OFF_LEDGER_HEADERS.length).setValues([SIGN_OFF_LEDGER_HEADERS]);
    ledgerSheet.getRange(1, 1, 1, SIGN_OFF_LEDGER_HEADERS.length).setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
    ledgerSheet.setFrozenRows(1);
  }
  const historySheet = getOrCreateSheet_(ss, CONFIG.STATE_HISTORY_SHEET);
  if (historySheet.getLastRow() === 0) {
    historySheet.getRange(1, 1, 1, 7).setValues([['SliceKey', 'Revision', 'ChunkIndex', 'ChunkCount', 'SavedAt', 'PayloadChunk', 'SavedBy']]);
    historySheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
    historySheet.setFrozenRows(1);
  }
  ['Projects', 'Tasks', 'ProductionRecords', 'MasterSpecs', 'CpkRecords', 'CostProjects', 'CustomerFeedback'].forEach(function(tab) {
    getOrCreateSheet_(ss, tab);
  });
  protectManagedTabs_(ss);
  return { ok: true };
}

/**
 * Marks the app-owned tabs so a human editing them in the Sheet UI gets a warning.
 *
 * A blocking protection is deliberately not used: the web app now runs as the
 * signed-in user (executeAs USER_ACCESSING), so a protection that excludes users
 * would also block the app's own writes. Warning-only keeps the app working while
 * making hand-editing of the store and audit trail an explicit act.
 */
function protectManagedTabs_(ss, force) {
  protectManagedTab_(ss, CONFIG.STATE_SHEET,
    'FFM NPI Ops — authoritative state store. Do not edit by hand; the web app rewrites this tab on every save.', force);
  protectManagedTab_(ss, CONFIG.AUDIT_SHEET,
    'FFM NPI Ops — append-only audit trail. Do not edit by hand.', force);
  protectManagedTab_(ss, CONFIG.SIGN_OFF_SHEET,
    'FFM NPI Ops — append-only gate sign-off ledger. Do not edit by hand.', force);
}

function protectManagedTab_(ss, tabName, description, force) {
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return;

  const existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  if (existing.length > 0) {
    existing.forEach(function(protection) {
      try {
        if (!protection.getDescription()) protection.setDescription(description);
        if (!protection.isWarningOnly()) protection.setWarningOnly(true);
      } catch (e) {
        // Only the protection's owner can relax it; leave it alone otherwise.
      }
    });
    return;
  }

  // Creating a protection as a non-owner would restrict every other user, so only
  // the file owner sets one up — and always as a warning, never a hard block.
  let ownerEmail = '';
  try {
    ownerEmail = (ss.getOwner() && ss.getOwner().getEmail()) || '';
  } catch (e) {}
  if (!force && (!ownerEmail || ownerEmail.toLowerCase() !== getActiveUserEmail_().toLowerCase())) return;
  try {
    sheet.protect().setDescription(description).setWarningOnly(true);
  } catch (e) {}
}

function protectManagedTabsFromMenu_() {
  const ui = SpreadsheetApp.getUi();
  try {
    const ss = getSpreadsheet_();
    protectManagedTabs_(ss, true);
    ui.alert('Protect Managed Tabs',
      'AuditLog and ' + CONFIG.STATE_SHEET + ' now warn before manual edits.\n\n' +
      'A blocking protection is not applied: the web app writes these tabs as the signed-in user, ' +
      'so excluding users would also block the app itself.', ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Protect Managed Tabs', 'Failed: ' + (err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

/**
 * Read-only view of the gate decision ledger (`SignOffLog`).
 *
 * A save appends the ledger before the state store commits, so a committed
 * signature always has its audit row. This returns the tab as plain objects so
 * the app can show it and reconcile it against the saved gate records, including
 * gaps left by older revisions or a hand edit. It never writes: no locks, no
 * sheet creation, no repairs.
 */
function getSignOffLedger() {
  const userEmail = getActiveUserEmail_();
  if (!userEmail) {
    return { ok: false, error: 'Sign-in required: the ledger is only readable by the accessing domain account.' };
  }

  let ss;
  let sheet;
  try {
    ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    sheet = ss.getSheetByName(CONFIG.SIGN_OFF_SHEET);
  } catch (err) {
    return { ok: false, error: 'SignOffLog could not be opened: ' + errorMessage_(err) };
  }

  const readAt = new Date().toISOString();
  const sheetUrl = ss.getUrl() + (sheet ? '#gid=' + sheet.getSheetId() : '');
  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: true, rows: [], sheetUrl: sheetUrl, readAt: readAt, userEmail: userEmail };
  }

  return { ok: true, rows: readSignOffLedgerRows_(ss), sheetUrl: sheetUrl, readAt: readAt, userEmail: userEmail };
}

/** The ledger tab as plain objects. Read-only: never creates the tab or a lock. */
function readSignOffLedgerRows_(ss) {
  const sheet = ss.getSheetByName(CONFIG.SIGN_OFF_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, SIGN_OFF_LEDGER_HEADERS.length)
    .getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const cell = function(index) {
      const value = row[index];
      if (value instanceof Date) return value.toISOString();
      return String(value === null || value === undefined ? '' : value);
    };
    // A cleared or trailing blank row is not a decision.
    if (!cell(0).trim() && !cell(6).trim()) continue;
    rows.push({
      timestamp: cell(0),
      revision: cell(1),
      programId: cell(2),
      program: cell(3),
      line: cell(4),
      gate: cell(5),
      approver: cell(6),
      role: cell(7),
      decision: cell(8),
      remark: cell(9),
      signedInEmail: cell(10)
    });
  }
  return rows;
}

/** Rows the ledger holds, header excluded. */
function ledgerRowCount_(ss) {
  const sheet = ss.getSheetByName(CONFIG.SIGN_OFF_SHEET);
  return sheet && sheet.getLastRow() > 1 ? sheet.getLastRow() - 1 : 0;
}

function readLedgerExpectation_() {
  try {
    return Number(PropertiesService.getScriptProperties().getProperty(CONFIG.SIGN_OFF_LEDGER_COUNT_PROP)) || 0;
  } catch (err) {
    return 0;
  }
}

function markLedgerExpectation_(count) {
  try {
    const value = String(Math.max(0, Number(count) || 0));
    const patch = {};
    patch[CONFIG.SIGN_OFF_LEDGER_COUNT_PROP] = value;
    PropertiesService.getScriptProperties().setProperties(patch);
  } catch (err) {
    // Losing the counter only costs a cheaper reconcile path, never the ledger.
  }
}

/**
 * Returns basic server & user metadata
 */
function getServerInfo() {
  return {
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit',
    webAppUrl: CONFIG.WEB_APP_URL,
    userEmail: getActiveUserEmail_()
  };
}

// ---------------------------------------------------------------------------
// Daily state backup
//
// `_FFM_STATE_HISTORY` keeps five replaced revisions inside the sheet: enough to
// undo a bad save, useless against a deleted sheet, a broken chunk, or a mistake
// nobody noticed for a month. This is the outer ring. A time-driven trigger
// writes the whole store to a dated JSON file in Drive and prunes the oldest, so
// the folder holds a rolling month of daily copies and nothing else.
//
// The file has the same shape as Sidebar → Backup, so restoring one is:
// open the Drive folder, download the file, Sidebar → Restore. See docs/SOP.md §9.
// ---------------------------------------------------------------------------

/** `2026-11-27_0130` in the script's time zone: names sort chronologically. */
function backupStamp_(date, timeZone) {
  return Utilities.formatDate(date, timeZone || Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
}

function backupFileName_(date, timeZone) {
  return CONFIG.BACKUP_PREFIX + backupStamp_(date, timeZone) + '.json';
}

/**
 * The backup file names to drop, oldest first, keeping the newest `keep`.
 * Anything this job did not create is left alone — a hand-downloaded JSON backup,
 * a notes file, or a folder someone else is using.
 */
function backupFilesToDelete_(fileNames, keep, prefix) {
  // A keep of zero or nonsense is not "delete everything": fall back to the
  // configured limit rather than leaving the folder with one lonely file.
  const asked = Number(keep);
  const limit = asked > 0 ? Math.floor(asked) : CONFIG.BACKUP_KEEP;
  const wanted = prefix || CONFIG.BACKUP_PREFIX;
  const mine = (fileNames || [])
    .map(function(name) { return String(name || ''); })
    .filter(function(name) {
      return name.indexOf(wanted) === 0 && /\.json$/.test(name);
    })
    .sort();
  return mine.slice(0, Math.max(0, mine.length - limit));
}

/**
 * The file the trigger writes. Same keys as the sidebar's export, so Restore
 * accepts it unchanged; `revision` says which state it holds.
 */
function buildStateBackup_(snapshot, exportedAt) {
  const meta = (snapshot && snapshot.meta) || {};
  return {
    app: 'FFM NPI Ops',
    version: 'v2.1.0-GAS',
    exportedAt: exportedAt || new Date().toISOString(),
    revision: Number(meta.revision) || 0,
    lastSavedAt: meta.lastSavedAt || null,
    lastSavedBy: meta.lastSavedBy || null,
    data: (snapshot && snapshot.data) || {}
  };
}

/** The backup triggers already installed, so installing twice leaves exactly one. */
function backupTriggers_(triggers) {
  return (triggers || []).filter(function(trigger) {
    try {
      return trigger.getHandlerFunction() === BACKUP_HANDLER;
    } catch (err) {
      return false;
    }
  });
}

function backupFolder_() {
  const folders = DriveApp.getFoldersByName(CONFIG.BACKUP_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(CONFIG.BACKUP_FOLDER_NAME);
}

/** Trashes files with `prefix` beyond the newest `keep`. Returns how many went. */
function pruneSnapshotFiles_(folder, prefix, keep) {
  const byName = {};
  const iterator = folder.getFiles();
  while (iterator.hasNext()) {
    const file = iterator.next();
    const name = String(file.getName() || '');
    if (name && !byName[name]) byName[name] = file;
  }
  const doomed = backupFilesToDelete_(Object.keys(byName), keep, prefix);
  doomed.forEach(function(name) {
    try {
      byName[name].setTrashed(true);
    } catch (err) {
      // One stubborn file must not lose the batch it is part of: the next run
      // tries again, and the folder simply holds one extra copy meanwhile.
      console.error('Could not prune backup ' + name + ': ' + errorMessage_(err));
    }
  });
  return doomed.length;
}

/** Trashes every daily backup beyond the newest CONFIG.BACKUP_KEEP. */
function pruneStateBackups_(folder) {
  return pruneSnapshotFiles_(folder, CONFIG.BACKUP_PREFIX, CONFIG.BACKUP_KEEP);
}

/** Reads the store without the sidebar's consent to be signed in: the trigger runs as the owner. */
function stateSnapshot_() {
  const state = loadWorkspaceState();
  if (!state || state.initialized !== true) {
    return {
      ok: false,
      error: (state && state.error) || 'The state store has not been seeded yet, so there is nothing to back up.'
    };
  }
  return {
    ok: true,
    meta: {
      revision: state.revision,
      lastSavedAt: state.lastSavedAt,
      lastSavedBy: state.lastSavedBy
    },
    data: state.data
  };
}

/**
 * Writes today's backup file and prunes the oldest. This is the trigger handler
 * and the "Back up now" menu action; it never throws, so a failed run is reported
 * instead of leaving a silent gap in the folder.
 */
function exportStateBackup() {
  try {
    const snapshot = stateSnapshot_();
    if (!snapshot.ok) {
      // A trigger's return value is discarded, so an unseeded or unreadable store
      // has to reach the execution log to be noticed at all.
      console.error('Daily state backup skipped: ' + snapshot.error);
      return { ok: false, error: snapshot.error };
    }

    const now = new Date();
    const payload = buildStateBackup_(snapshot, now.toISOString());
    const json = JSON.stringify(payload, null, 2);
    const folder = backupFolder_();
    const fileName = backupFileName_(now);
    const file = folder.createFile(fileName, json, MimeType.PLAIN_TEXT);

    const deleted = pruneStateBackups_(folder);
    return {
      ok: true,
      fileId: file.getId(),
      fileName: fileName,
      folderName: folder.getName(),
      folderUrl: folder.getUrl(),
      bytes: json.length,
      revision: payload.revision,
      deleted: deleted,
      kept: CONFIG.BACKUP_KEEP
    };
  } catch (err) {
    console.error('Daily state backup failed: ' + errorMessage_(err));
    return { ok: false, error: errorMessage_(err) };
  }
}

/** `2026-11-27_193045`: seconds keep two restores in one minute from sharing a name. */
function restoreSnapshotStamp_(date, timeZone) {
  return Utilities.formatDate(date, timeZone || Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmmss');
}

function restoreSnapshotFileName_(date, timeZone) {
  return CONFIG.RESTORE_SNAPSHOT_PREFIX + restoreSnapshotStamp_(date, timeZone) + '.json';
}

/**
 * Writes the workspace the user is about to replace into the Drive backup folder.
 * The Restore dialog calls this before it hydrates anything, and only applies the
 * backup when this returns ok: a failed snapshot stops the restore.
 */
function exportRestoreSnapshot(payloadJson, sourceName) {
  try {
    const userEmail = getActiveUserEmail_();
    if (!userEmail) {
      return {
        ok: false,
        error:
          'Restore stopped: FFM NPI Ops could not read your Google Workspace identity, so no Drive snapshot ' +
          'could be written. Sign in again and retry.'
      };
    }
    const text = String(payloadJson || '');
    if (!text) {
      return { ok: false, error: 'Restore stopped: the current workspace could not be read for its Drive snapshot.' };
    }
    if (text.length > 4 * 1024 * 1024) {
      return { ok: false, error: 'Restore stopped: the current workspace is too large for a Drive snapshot (over 4 MB).' };
    }
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) {
      return { ok: false, error: 'Restore stopped: the current workspace is not a valid workspace payload.' };
    }

    const now = new Date();
    const payload = buildStateBackup_(
      { meta: { revision: 0, lastSavedAt: now.toISOString(), lastSavedBy: userEmail }, data: data },
      now.toISOString()
    );
    payload.reason = 'Before restoring ' + String(sourceName || 'a JSON backup').slice(0, 120);
    const json = JSON.stringify(payload, null, 2);
    const folder = backupFolder_();
    const fileName = restoreSnapshotFileName_(now);
    const file = folder.createFile(fileName, json, MimeType.PLAIN_TEXT);
    const deleted = pruneSnapshotFiles_(folder, CONFIG.RESTORE_SNAPSHOT_PREFIX, CONFIG.RESTORE_SNAPSHOT_KEEP);
    return {
      ok: true,
      fileId: file.getId(),
      fileName: fileName,
      folderName: folder.getName(),
      folderUrl: folder.getUrl(),
      bytes: json.length,
      deleted: deleted,
      kept: CONFIG.RESTORE_SNAPSHOT_KEEP
    };
  } catch (err) {
    console.error('Restore snapshot failed: ' + errorMessage_(err));
    return {
      ok: false,
      error: 'Restore stopped: the Drive snapshot failed (' + errorMessage_(err) + '). Nothing was changed.'
    };
  }
}

/**
 * Returns the SheetJS source to the browser on the first Excel import. Keeping
 * the library in its own HTML file means Index.html does not download or parse
 * the ~486 KB parser at startup; CSV imports never call this.
 */
function getSheetJsSource() {
  try {
    return { ok: true, source: HtmlService.createHtmlOutputFromFile('SheetJs').getContent() };
  } catch (err) {
    console.error('SheetJS source unavailable: ' + errorMessage_(err));
    return {
      ok: false,
      error: 'Excel parser could not be loaded. Upload a .csv file instead.'
    };
  }
}

/** Installs (or repairs) the daily trigger. Idempotent: a second call replaces the first. */
function installDailyBackupTrigger() {
  try {
    const existing = backupTriggers_(ScriptApp.getProjectTriggers());
    existing.forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
    ScriptApp.newTrigger(BACKUP_HANDLER)
      .timeBased()
      .everyDays(1)
      .atHour(CONFIG.BACKUP_HOUR)
      .nearMinute(CONFIG.BACKUP_MINUTE)
      .create();
    return {
      ok: true,
      replaced: existing.length,
      hour: CONFIG.BACKUP_HOUR,
      minute: CONFIG.BACKUP_MINUTE,
      timeZone: Session.getScriptTimeZone(),
      folderName: CONFIG.BACKUP_FOLDER_NAME,
      keep: CONFIG.BACKUP_KEEP
    };
  } catch (err) {
    return { ok: false, error: errorMessage_(err) };
  }
}

function pad2_(value) {
  return (Number(value) < 10 ? '0' : '') + Number(value);
}

function installDailyBackupTriggerFromMenu_() {
  const ui = SpreadsheetApp.getUi();
  const result = installDailyBackupTrigger();
  if (!result.ok) {
    ui.alert('Daily State Backup', 'Could not install the trigger: ' + result.error, ui.ButtonSet.OK);
    return;
  }
  ui.alert(
    'Daily State Backup',
    'Backs up every day at ' + pad2_(result.hour) + ':' + pad2_(result.minute) +
      ' (' + result.timeZone + ')' +
      (result.replaced ? ', replacing ' + result.replaced + ' earlier trigger(s)' : '') + '.\n\n' +
      'Files go to the Drive folder "' + result.folderName + '"; the newest ' + result.keep +
      ' are kept and older ones are moved to the trash.',
    ui.ButtonSet.OK
  );
}

function exportStateBackupFromMenu_() {
  const ui = SpreadsheetApp.getUi();
  const result = exportStateBackup();
  if (!result.ok) {
    ui.alert('Daily State Backup', 'Backup failed: ' + result.error, ui.ButtonSet.OK);
    return;
  }
  ui.alert(
    'Daily State Backup',
    'Wrote ' + result.fileName + ' (Rev #' + result.revision + ', ' +
      Math.max(1, Math.round(result.bytes / 1024)) + ' KB)' +
      (result.deleted ? ' and pruned ' + result.deleted + ' old cop' + (result.deleted === 1 ? 'y' : 'ies') : '') +
      '.\n\nTo restore one: open the folder, download the file, then Sidebar → Restore in the app.',
    ui.ButtonSet.OK
  );
}

function showBackupStatusFromMenu_() {
  const ui = SpreadsheetApp.getUi();
  try {
    const triggers = backupTriggers_(ScriptApp.getProjectTriggers());
    const folders = DriveApp.getFoldersByName(CONFIG.BACKUP_FOLDER_NAME);
    let lines = [
      triggers.length
        ? 'Daily trigger installed (' + triggers.length + ').'
        : 'No daily trigger yet — use "Install / repair the daily trigger".',
      'Keeps the newest ' + CONFIG.BACKUP_KEEP + ' backups.'
    ];
    if (folders.hasNext()) {
      const folder = folders.next();
      const names = [];
      const iterator = folder.getFiles();
      while (iterator.hasNext()) {
        const name = String(iterator.next().getName() || '');
        if (name.indexOf(CONFIG.BACKUP_PREFIX) === 0 && /\.json$/.test(name)) names.push(name);
      }
      // Folder iteration order is not a promise; the names carry the date, so the
      // newest five are the last five once sorted.
      const newest = names.sort().slice(-5).reverse();
      lines.push('');
      lines.push('Folder: ' + folder.getUrl());
      lines.push(newest.length ? 'Newest files:\n' + newest.join('\n') : 'No backup files yet.');
    } else {
      lines.push('');
      lines.push('Folder "' + CONFIG.BACKUP_FOLDER_NAME + '" does not exist yet — the first backup creates it.');
    }
    ui.alert('Daily State Backup', lines.join('\n'), ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Daily State Backup', 'Status failed: ' + errorMessage_(err), ui.ButtonSet.OK);
  }
}

/**
 * Loads the complete workspace state from `_FFM_STATE_STORE`.
 * Returns { initialized: false } if the Sheet has not been seeded yet.
 */
/**
 * Reassembles one slice from its stored chunks.
 *
 * `missing` distinguishes "this slice was never stored" from "the stored chunks
 * are incomplete or invalid": only the latter means the copy must not be used.
 */
function parseChunkGroup_(chunks) {
  if (!chunks || !chunks.length) return { ok: false, missing: true };
  chunks.sort(function(a, b) { return a.idx - b.idx; });
  const declared = chunks[0].count;
  if (!declared || chunks.length !== declared ||
      chunks.some(function(c, i) { return c.count !== declared || c.idx !== i; })) {
    return { ok: false, missing: false };
  }
  try {
    return { ok: true, value: JSON.parse(chunks.map(function(c) { return c.text; }).join('')) };
  } catch (e) {
    return { ok: false, missing: false };
  }
}

function loadWorkspaceState() {
  const ss = getSpreadsheet_();
  const stateSheet = ss.getSheetByName(CONFIG.STATE_SHEET);
  const userEmail = getActiveUserEmail_();
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + CONFIG.SPREADSHEET_ID + '/edit';

  if (!stateSheet || stateSheet.getLastRow() < 2) {
    return {
      initialized: false,
      userEmail: userEmail,
      sheetUrl: sheetUrl,
      revision: 0,
      lastSavedAt: null,
      lastSavedBy: null,
      data: null
    };
  }

  const values = stateSheet.getDataRange().getValues();
  const grouped = {};
  let corrupted = false;
  for (let i = 1; i < values.length; i++) {
    const key = String(values[i][0] || '').trim();
    if (!key) continue;
    const chunkIdx = Number(values[i][1]) || 0;
    const chunkCount = Number(values[i][2]) || 0;
    const payloadChunk = String(values[i][4] || '');
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ idx: chunkIdx, count: chunkCount, text: payloadChunk });
  }

  if (!grouped['__META__']) {
    return {
      initialized: false,
      userEmail: userEmail,
      sheetUrl: sheetUrl,
      revision: 0,
      lastSavedAt: null,
      lastSavedBy: null,
      data: null
    };
  }

  const parseKey = function(key) {
    const result = parseChunkGroup_(grouped[key]);
    if (!result.ok && !result.missing) corrupted = true;
    return result.ok ? result.value : undefined;
  };

  const meta = parseKey('__META__') || {};
  // Newer saves carry a slice manifest; older saves are tolerated as-is.
  if (Array.isArray(meta.slices)) {
    meta.slices.forEach(function(slice) {
      if (!grouped[slice]) {
        corrupted = true;
      }
    });
  }
  const data = {};
  PERSISTED_SLICES.forEach(function(slice) {
    const parsed = parseKey(slice);
    if (parsed !== undefined) {
      data[slice] = parsed;
    }
  });

  if (corrupted) {
    return {
      initialized: false,
      corrupted: true,
      error: 'Stored workspace data is incomplete or invalid. Sync paused to protect existing data.',
      userEmail: userEmail,
      sheetUrl: sheetUrl,
      revision: 0,
      lastSavedAt: null,
      lastSavedBy: null,
      data: null
    };
  }

  return {
    initialized: true,
    userEmail: userEmail,
    sheetUrl: sheetUrl,
    revision: Number(meta.revision) || 1,
    lastSavedAt: meta.lastSavedAt || null,
    lastSavedBy: meta.lastSavedBy || null,
    data: data
  };
}

/**
 * Seeds the Google Sheet for the first time (or forces re-seed).
 * Seeding is an explicit one-off, so the reporting tabs are built once here.
 */
function initializeDatabase(payloadJson) {
  return saveWorkspaceState(payloadJson, 'Initial database seed from FFM NPI Ops', undefined, true);
}

// ---------------------------------------------------------------------------
// Server-side permissions
//
// A save carries the whole workspace, so "may this person change that program?"
// can only be answered by comparing the payload with the store as it stands.
// Two rules are enforced here, before a single row is written:
//
//   1. a program may only be added, rewritten or removed by someone the roster
//      gives it to — a member's `products` / `externalProducts` name the
//      programs they own, and a program is identified by its model;
//   2. a signature is personal: a gate decision this save records or erases must
//      carry the signed-in user's own roster name, never a colleague's.
//
// The roster is the persisted `teamMembers` slice: it already holds each
// member's email, role and owned products, so it decides the rules and is
// protected by them. Only the spreadsheet owner may change it — otherwise rule 1
// could be undone in a single save by granting yourself every product.
// ---------------------------------------------------------------------------

/** Comparison key for a person or a product: no case, no padding. */
function identityKey_(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/** Stable JSON, so two copies with the same content compare equal whatever their key order. */
function canonicalValue_(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalValue_).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(function(key) {
    return JSON.stringify(key) + ':' + canonicalValue_(value[key]);
  }).join(',') + '}';
}

/** The roster entry whose email is this person, or null when they are not on it. */
function rosterMemberFor_(members, email) {
  const key = identityKey_(email);
  if (!key) return null;
  const list = Array.isArray(members) ? members : [];
  for (let i = 0; i < list.length; i++) {
    if (identityKey_(list[i] && list[i].email) === key) return list[i];
  }
  return null;
}

/** The program models a roster member owns, as a lookup. */
function ownedModels_(member) {
  const owned = {};
  if (!member) return owned;
  [member.products, member.externalProducts].forEach(function(list) {
    (Array.isArray(list) ? list : []).forEach(function(product) {
      const key = identityKey_(product);
      if (key) owned[key] = true;
    });
  });
  return owned;
}

function ownsModel_(member, model) {
  const key = identityKey_(model);
  return !!key && ownedModels_(member)[key] === true;
}

/**
 * Programs a save adds, rewrites or removes, with the model(s) each change needs
 * permission for. A program carried forward unchanged is not a change. An
 * omitted `projects` slice removes every program, so it is judged as a removal of
 * each one rather than as "no changes".
 */
function changedProjects_(previousProjects, nextProjects) {
  const before = {};
  const after = {};
  (Array.isArray(previousProjects) ? previousProjects : []).forEach(function(project) {
    if (project && project.id) before[String(project.id)] = project;
  });
  (Array.isArray(nextProjects) ? nextProjects : []).forEach(function(project) {
    if (project && project.id) after[String(project.id)] = project;
  });

  const changes = [];
  Object.keys(after).forEach(function(id) {
    const next = after[id];
    const previous = before[id];
    if (!previous) {
      changes.push({ id: id, kind: 'create', models: [next.model] });
      return;
    }
    if (canonicalValue_(previous) !== canonicalValue_(next)) {
      // Renaming the model is two claims: the old program and the new one.
      changes.push({ id: id, kind: 'update', models: [previous.model, next.model] });
    }
  });
  Object.keys(before).forEach(function(id) {
    if (after[id]) return;
    changes.push({ id: id, kind: 'delete', models: [before[id].model] });
  });
  return changes;
}

/** Roster entries a save adds, rewrites or removes. */
function changedRosterEntries_(previousMembers, nextMembers) {
  const before = {};
  const after = {};
  (Array.isArray(previousMembers) ? previousMembers : []).forEach(function(member, index) {
    before[String((member && member.id) || '#' + index)] = member;
  });
  (Array.isArray(nextMembers) ? nextMembers : []).forEach(function(member, index) {
    after[String((member && member.id) || '#' + index)] = member;
  });

  const changes = [];
  Object.keys(after).forEach(function(id) {
    const label = String((after[id] && after[id].name) || id);
    if (!before[id]) changes.push({ id: id, kind: 'create', label: label });
    else if (canonicalValue_(before[id]) !== canonicalValue_(after[id])) {
      changes.push({ id: id, kind: 'update', label: label });
    }
  });
  Object.keys(before).forEach(function(id) {
    if (after[id]) return;
    changes.push({ id: id, kind: 'delete', label: String((before[id] && before[id].name) || id) });
  });
  return changes;
}

/** Email of the spreadsheet owner, or '' when the file cannot say (shared drive, no access). */
function spreadsheetOwnerEmail_(ss) {
  try {
    const owner = ss.getOwner();
    return owner ? String(owner.getEmail() || '') : '';
  } catch (err) {
    return '';
  }
}

/** The file's owner: the only account that may change the roster or work outside its own programs. */
function isSpreadsheetOwner_(ss, email) {
  const owner = identityKey_(spreadsheetOwnerEmail_(ss));
  return !!owner && owner === identityKey_(email);
}

/** One program change, named the way the person reading the refusal knows it. */
function describeProgramChange_(change) {
  const verb = change.kind === 'create' ? 'add ' : change.kind === 'delete' ? 'remove ' : 'change ';
  const seen = {};
  const models = [];
  (change.models || []).forEach(function(model) {
    const key = identityKey_(model);
    if (!key || seen[key]) return;
    seen[key] = true;
    models.push(String(model).trim());
  });
  const model = models.length ? models.join(' → ') : 'a program with no model';
  return verb + change.id + ' (' + model + ')';
}

/** The program models a member owns, spelled as the roster spells them. */
function ownedModelNames_(member) {
  const seen = {};
  const names = [];
  if (!member) return names;
  [member.products, member.externalProducts].forEach(function(list) {
    (Array.isArray(list) ? list : []).forEach(function(product) {
      const key = identityKey_(product);
      if (!key || seen[key]) return;
      seen[key] = true;
      names.push(String(product).trim());
    });
  });
  return names;
}

/**
 * Whether `actorEmail` may save `payload` over `previous`.
 * Returns { ok: true, isOwner, actorName, actorRole } or { ok: false, error }.
 * `previous` is `{ projects, teamMembers, gateRecords }` from the store, or null
 * when nothing has been saved yet.
 */
function authorizeWorkspaceSave_(previous, payload, actorEmail, isOwner) {
  const member = rosterMemberFor_(previous && previous.teamMembers, actorEmail);
  const allowed = {
    ok: true,
    isOwner: !!isOwner,
    actorName: String((member && member.name) || ''),
    actorRole: String((member && member.role) || '')
  };

  // Nothing on file yet: this is the first seed, which establishes the roster it
  // would otherwise have to be judged by.
  if (!previous) return allowed;

  // The file's owner can repair any program or roster entry, and needs no roster
  // entry of their own to do it.
  if (isOwner) return allowed;

  const rosterChanges = changedRosterEntries_(previous.teamMembers, payload && payload.teamMembers);
  if (rosterChanges.length > 0) {
    return {
      ok: false,
      error: 'the team roster is owner data, and this save changes ' + rosterChanges.length +
        ' roster entr' + (rosterChanges.length === 1 ? 'y' : 'ies') + ' (' +
        rosterChanges.slice(0, 3).map(function(change) { return change.label; }).join(', ') +
        '). Only the spreadsheet owner can change who is on the roster, their role, their email or the programs they own.'
    };
  }

  const changes = changedProjects_(previous.projects, payload && payload.projects);
  if (changes.length === 0) return allowed;

  if (!member) {
    return {
      ok: false,
      error: 'your account (' + actorEmail + ') is not on the team roster, so it owns no program. ' +
        'Ask the spreadsheet owner to add you in Team & Workload with the programs you own, then reload.'
    };
  }

  const refused = changes.filter(function(change) {
    return !(change.models || []).every(function(model) { return ownsModel_(member, model); });
  });
  if (refused.length === 0) return allowed;

  const owned = ownedModelNames_(member);
  return {
    ok: false,
    error: 'you can only change programs you own: ' + refused.slice(0, 3).map(describeProgramChange_).join(', ') +
      (refused.length > 3 ? ' and ' + (refused.length - 3) + ' more' : '') + '. ' +
      'The roster has ' + (String(member.name || '').trim() || actorEmail) + ' responsible for ' +
      (owned.length ? owned.join(', ') : 'no program') + '.'
  };
}

/**
 * Every signature this save records or erases, one entry per approver whose
 * decision moved. A dossier this save created, or a gate it did not have before,
 * produces nothing: seeding a dossier is not somebody approving. Likewise a
 * decision carried forward unchanged is not a new signature.
 */
function signOffSignatureEdits_(previousGateRecords, nextGateRecords) {
  if (!previousGateRecords || !nextGateRecords) return [];
  const DECISIONS = { Approved: true, Conditional: true, Rejected: true };
  const edits = [];

  Object.keys(nextGateRecords).forEach(function(projectId) {
    const nextLines = nextGateRecords[projectId] || {};
    const previousLines = previousGateRecords[projectId] || {};
    Object.keys(nextLines).forEach(function(lineKey) {
      const nextGates = nextLines[lineKey] || {};
      const previousGates = previousLines[lineKey] || {};
      Object.keys(nextGates).forEach(function(gateId) {
        const dossier = nextGates[gateId];
        const before = previousGates[gateId];
        if (!dossier || typeof dossier !== 'object' || !before || typeof before !== 'object') return;

        // Approvers are matched by name: the name is what the signature carries.
        const beforeDecisions = {};
        (Array.isArray(before.approvers) ? before.approvers : []).forEach(function(approver) {
          beforeDecisions[identityKey_(approver && approver.name)] = String((approver && approver.decision) || '');
        });

        const stillThere = {};
        (Array.isArray(dossier.approvers) ? dossier.approvers : []).forEach(function(approver) {
          if (!approver) return;
          const nameKey = identityKey_(approver.name);
          stillThere[nameKey] = true;
          const decision = String(approver.decision || '');
          if (!DECISIONS[decision]) return;
          if (beforeDecisions[nameKey] === decision) return;
          edits.push({
            kind: 'decision',
            projectId: projectId,
            line: lineKey,
            gateId: gateId,
            approver: String(approver.name || ''),
            role: String(approver.role || ''),
            decision: decision,
            remark: String(approver.remark || '')
          });
        });

        // Erasing a colleague's decision is not a way around the rule above: a
        // signature that disappears is still that person's signature.
        (Array.isArray(before.approvers) ? before.approvers : []).forEach(function(approver) {
          if (!approver) return;
          const nameKey = identityKey_(approver.name);
          const decision = String(approver.decision || '');
          if (!DECISIONS[decision] || stillThere[nameKey]) return;
          edits.push({
            kind: 'removal',
            projectId: projectId,
            line: lineKey,
            gateId: gateId,
            approver: String(approver.name || ''),
            role: String(approver.role || ''),
            decision: decision,
            remark: ''
          });
        });
      });
    });
  });
  return edits;
}

/**
 * Signature edits that are not the actor's to make. A signature row names the
 * person who signed it, so it may only carry the signed-in user's own identity.
 * The app signs with the Workspace email (the modal states that), while older
 * rows and the roster use the member's name, so both are the actor's own; an
 * account with neither can record or erase nothing.
 */
function foreignSignOffEdits_(previousGateRecords, nextGateRecords, actorName, actorEmail) {
  const own = {};
  [actorName, actorEmail].forEach(function(value) {
    const key = identityKey_(value);
    if (key) own[key] = true;
  });
  return signOffSignatureEdits_(previousGateRecords, nextGateRecords).filter(function(edit) {
    const signer = identityKey_(edit.approver);
    return !signer || own[signer] !== true;
  });
}

/**
 * Persists all workspace slices to `_FFM_STATE_STORE`, the single authoritative
 * copy of the workspace. Mirror tabs are derived reports and are only rebuilt
 * when `refreshMirrors` is true (explicit manual save or seed), which keeps the
 * debounced autosave cheap.
 */
function saveWorkspaceState(payloadJson, summary, expectedRevision, refreshMirrors) {
  // Reject unauthenticated saves server-side: the web app runs as the accessing
  // user, and a save with no identity could not be attributed or defended.
  const userEmail = getActiveUserEmail_();
  if (!userEmail) {
    throw new Error(
      'Save refused: FFM NPI Ops could not read your Google Workspace identity. ' +
      'Sign in with your Minebea account, grant the requested permissions, and reload.'
    );
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw new Error('Another user is currently saving to the Google Sheet. Please retry in a few seconds.');
  }

  try {
    ensureAllTabs_();
    const ss = getSpreadsheet_();
    const stateSheet = getOrCreateSheet_(ss, CONFIG.STATE_SHEET);
    const payload = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
    const nowIso = new Date().toISOString();
    const actorLabel = userEmail;
    const executorEmail = getExecutorEmail_();

    // Read current revision, keeping the rows so the copy being replaced can
    // be archived before the store is rewritten.
    let prevRevision = 0;
    let previousRows = [];
    if (stateSheet.getLastRow() >= 2) {
      const existing = stateSheet.getDataRange().getValues();
      previousRows = existing.slice(1).filter(function(row) {
        return String(row[0] || '').trim();
      });
      for (let i = 0; i < previousRows.length; i++) {
        if (String(previousRows[i][0]) === '__META__') {
          try {
            const m = JSON.parse(String(previousRows[i][4] || '{}'));
            prevRevision = Number(m.revision) || 0;
          } catch (e) {}
          break;
        }
      }
    }

    // The gate decisions already on file, so the ledger records only what this
    // save actually changed — a save that carries dossiers forward writes nothing.
    const previousGateRecords = previousRows.length > 0
      ? previousSlice_(previousRows, 'gateRecords')
      : null;

    // Reject a stale client instead of silently overwriting another user's save.
    if (expectedRevision !== undefined && expectedRevision !== null &&
        Number(expectedRevision) !== prevRevision) {
      return {
        ok: false,
        conflict: true,
        revision: prevRevision
      };
    }

    // Permissions are judged on the store as it stands, never on the payload:
    // otherwise a save could grant itself the roster entry it needs to pass.
    const permissions = authorizeWorkspaceSave_(
      previousRows.length > 0
        ? {
            projects: previousSlice_(previousRows, 'projects'),
            teamMembers: previousSlice_(previousRows, 'teamMembers'),
            gateRecords: previousGateRecords
          }
        : null,
      payload,
      userEmail,
      isSpreadsheetOwner_(ss, userEmail)
    );
    if (!permissions.ok) {
      throw new Error('Save refused: ' + permissions.error);
    }

    const foreignSignatures = foreignSignOffEdits_(
      previousGateRecords,
      payload.gateRecords,
      permissions.actorName,
      userEmail
    );
    if (foreignSignatures.length > 0) {
      const first = foreignSignatures[0];
      const where = (GATE_LEDGER_LABELS[first.gateId] || first.gateId) +
        ' on ' + first.projectId + ' · ' + first.line;
      throw new Error(
        'Save refused: a signature can only name the signed-in user. This save ' +
        (first.kind === 'removal' ? 'erases ' : 'records ') + first.decision +
        ' by ' + (String(first.approver || '').trim() || 'an unnamed approver') + ' at ' + where +
        (foreignSignatures.length > 1 ? ' (and ' + (foreignSignatures.length - 1) + ' other signature)' : '') +
        '. ' + (permissions.actorName
          ? 'You are on the roster as ' + permissions.actorName + ' (' + userEmail +
            '), so only your own decisions can be saved.'
          : 'Your account is not on the team roster, so it has no name to sign with.')
      );
    }

    const nextRevision = prevRevision + 1;
    const metaObj = {
      revision: nextRevision,
      lastSavedAt: nowIso,
      lastSavedBy: actorLabel,
      appVersion: 'v2.1.0-GAS',
      slices: PERSISTED_SLICES.filter(function(slice) { return payload[slice] !== undefined; })
    };

    const rows = [];
    const appendChunked = function(key, obj) {
      const str = JSON.stringify(obj === undefined ? null : obj);
      const totalChunks = Math.max(1, Math.ceil(str.length / CONFIG.CHUNK_SIZE));
      for (let c = 0; c < totalChunks; c++) {
        const part = str.substring(c * CONFIG.CHUNK_SIZE, (c + 1) * CONFIG.CHUNK_SIZE);
        rows.push([key, c, totalChunks, nowIso, part]);
      }
    };

    appendChunked('__META__', metaObj);
    PERSISTED_SLICES.forEach(function(slice) {
      if (payload[slice] !== undefined) {
        appendChunked(slice, payload[slice]);
      }
    });

    // Build the ledger rows before the store is touched: building them is pure,
    // so a malformed dossier fails the save while nothing has committed. The
    // append follows before the store commit (see below).
    let signOffRows = [];
    if (previousGateRecords && payload.gateRecords && typeof payload.gateRecords === 'object') {
      signOffRows = signOffLedgerRows(previousGateRecords, payload.gateRecords, payload.projects, {
        timestamp: nowIso,
        revision: nextRevision,
        userEmail: userEmail,
        actorRole: permissions.actorRole
      });
    }

    // The ledger is the audit trail, so write it before the mutable store. If
    // this append fails the save is refused while the old state is still intact:
    // a signature can never be committed without its immutable ledger row. The
    // append checks ledger identity, so retrying a save after a later failure
    // cannot duplicate a decision. Keep any legacy count gap across this save so
    // a later reconcile can still see it.
    const ledgerBefore = ledgerRowCount_(ss);
    const ledgerGap = Math.max(0, readLedgerExpectation_() - ledgerBefore);
    let ledgerAppended = 0;
    if (signOffRows.length > 0) {
      try {
        ledgerAppended = appendSignOffLedgerOnce_(ss, signOffRows);
      } catch (err) {
        throw new Error(
          'Save refused: SignOffLog could not be written (' + errorMessage_(err) + '). ' +
          'No workspace change was saved.'
        );
      }
    }

    // Keep the copy being replaced: every save is undoable from the history tab.
    if (prevRevision > 0 && previousRows.length > 0) {
      archiveStateRevision_(ss, prevRevision, previousRows);
    }

    // Write the header and rows in one setValues call, then put the pre-save
    // rows back if that write fails. Without the restore, a failure after
    // clearContents leaves the authoritative store empty or partial.
    const writeStateRows = function(dataRows) {
      const values = [STATE_STORE_HEADERS].concat(dataRows);
      stateSheet.clearContents();
      stateSheet.getRange(1, 1, values.length, STATE_STORE_HEADERS.length).setValues(values);
    };
    try {
      writeStateRows(rows);
    } catch (err) {
      try {
        writeStateRows(previousRows);
      } catch (restoreErr) {
        throw new Error(
          'Save refused: _FFM_STATE_STORE could not be written (' + errorMessage_(err) + '). ' +
          'The previous revision could not be restored automatically (' + errorMessage_(restoreErr) + '). ' +
          (prevRevision > 0 ? 'Revision #' + prevRevision + ' is preserved in ' + CONFIG.STATE_HISTORY_SHEET + '.' : '')
        );
      }
      throw new Error(
        'Save refused: _FFM_STATE_STORE could not be written (' + errorMessage_(err) + '). ' +
        (prevRevision > 0
          ? 'The previous revision was restored; no workspace change was saved.'
          : 'No workspace state had been committed yet; the store was reset.')
      );
    }

    // Mirror tabs are derived reports: rebuild them only on an explicit save.
    if (refreshMirrors) {
      syncMirrorSheets_(ss, payload);
      markMirrorsRefreshed_(nextRevision, nowIso);
    }

    // Append AuditLog entry
    const auditSheet = getOrCreateSheet_(ss, CONFIG.AUDIT_SHEET);
    auditSheet.appendRow([
      nowIso,
      actorLabel,
      nextRevision,
      'SAVE',
      safeSheetText_(summary || 'Workspace sync'),
      executorEmail
    ]);

    // The ledger row is already in place. Update the count only after the store
    // commits; carrying the pre-existing gap forward keeps a legacy repair visible
    // instead of hiding it behind this successful save.
    markLedgerExpectation_(ledgerBefore + ledgerAppended + ledgerGap);

    return {
      ok: true,
      revision: nextRevision,
      lastSavedAt: nowIso,
      lastSavedBy: actorLabel,
      userEmail: userEmail,
      signOffLedger: { appended: ledgerAppended, error: '' },
      warnings: []
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Rows for the gate decisions this save changed. Only a change of decision is a
 * new event: an unchanged dossier produces nothing, so replaying or retrying a
 * save cannot duplicate history. A gate that did not exist before is skipped too
 * — creating a program seeds sample decisions, which is not somebody approving.
 * With no previous store (the very first seed) there is nothing to compare and
 * nothing is written. Approval and rejection are recorded with the signed-in
 * email of the person who saved, and with the approver named on the dossier.
 */
function signOffLedgerRows(previousGateRecords, nextGateRecords, projects, meta) {
  if (!previousGateRecords || !nextGateRecords) return [];
  const models = {};
  (projects || []).forEach(function(project) {
    if (project && project.id) models[project.id] = String(project.model || '');
  });

  // One row per decision, never per erasure: a removed signature has no decision
  // of its own to record, and the ledger is append-only.
  return signOffSignatureEdits_(previousGateRecords, nextGateRecords)
    .filter(function(edit) { return edit.kind === 'decision'; })
    .map(function(edit) {
      return [
        meta.timestamp,
        meta.revision,
        edit.projectId,
        models[edit.projectId] || '',
        edit.line,
        GATE_LEDGER_LABELS[edit.gateId] || edit.gateId,
        edit.approver,
        // The signer's roster role when the save path resolved one: the roster is
        // the authority on who signed, not the slot the client filled in.
        String(meta.actorRole || edit.role || ''),
        edit.decision,
        edit.remark,
        meta.userEmail
      ];
    });
}

/** One slice of the store already on file, or null when it was never written. */
function previousSlice_(rows, key) {
  const chunks = [];
  (rows || []).forEach(function(row) {
    if (String(row[0] || '') !== key) return;
    chunks.push({ idx: Number(row[1]) || 0, count: Number(row[2]) || 0, text: String(row[4] || '') });
  });
  const parsed = parseChunkGroup_(chunks);
  return parsed.ok ? parsed.value : null;
}

/** Appends ledger rows; never rewrites the tab, never touches earlier rows. */
function appendSignOffLedger_(ss, rows) {
  if (!rows || rows.length === 0) return 0;
  const sheet = getOrCreateSheet_(ss, CONFIG.SIGN_OFF_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SIGN_OFF_LEDGER_HEADERS.length).setValues([SIGN_OFF_LEDGER_HEADERS]);
    sheet.getRange(1, 1, 1, SIGN_OFF_LEDGER_HEADERS.length).setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  sheet
    .getRange(sheet.getLastRow() + 1, 1, rows.length, SIGN_OFF_LEDGER_HEADERS.length)
    .setValues(rows.map(safeSheetRow_));
  return rows.length;
}

/**
 * Appends only the rows the tab does not already hold. A decision's identity is
 * the revision plus the program, line, gate, approver and decision, so a retry
 * after a save wrote the ledger but failed to commit the store cannot duplicate
 * the audit row. The caller decides whether an append failure should fail the
 * save; the save path writes this before the mutable store.
 */
function appendSignOffLedgerOnce_(ss, rows) {
  if (!rows || rows.length === 0) return 0;
  const known = {};
  readSignOffLedgerRows_(ss).forEach(function(row) {
    known[ledgerRowKey_(row.revision, row.programId, row.line, row.gate, row.approver, row.decision)] = true;
  });
  const fresh = [];
  rows.forEach(function(row) {
    const key = ledgerRowKey_(row[1], row[2], row[4], row[5], row[6], row[8]);
    if (known[key]) return;
    known[key] = true;
    fresh.push(row);
  });
  return appendSignOffLedger_(ss, fresh);
}

/**
 * Ledger identity of one decision: the revision that recorded it plus the four
 * things the row names. Two epochs of the same approver on the same gate are two
 * rows, so the revision is part of the key; without it a re-approval would look
 * like a duplicate of the earlier one.
 */
function ledgerRowKey_(revision, programId, line, gate, approver, decision) {
  return [
    String(Number(revision) || 0),
    String(programId || '').trim(),
    String(line || '').trim(),
    String(gate || '').trim(),
    identityKey_(approver),
    String(decision || '').trim()
  ].join('\u0000');
}

/**
 * Every archived revision as a snapshot, oldest first, parsed like the live store.
 * A snapshot whose chunks do not reassemble is dropped rather than guessed at.
 */
function historySnapshots_(rows) {
  const byRevision = new Map();
  (rows || []).forEach(function(row) {
    const revision = Number(row[1]) || 0;
    const key = String(row[0] || '').trim();
    if (!revision || !key) return;
    let snapshot = byRevision.get(revision);
    if (!snapshot) {
      snapshot = { revision: revision, savedAt: '', savedBy: '', chunks: {} };
      byRevision.set(revision, snapshot);
    }
    if (!snapshot.chunks[key]) snapshot.chunks[key] = [];
    snapshot.chunks[key].push({
      idx: Number(row[2]) || 0,
      count: Number(row[3]) || 0,
      text: String(row[5] || '')
    });
    if (!snapshot.savedAt && row[4]) snapshot.savedAt = String(row[4]);
    if (!snapshot.savedBy && row[6]) snapshot.savedBy = String(row[6]);
  });

  const snapshots = [];
  byRevision.forEach(function(snapshot) {
    const data = {};
    let corrupted = false;
    PERSISTED_SLICES.forEach(function(slice) {
      const parsed = parseChunkGroup_(snapshot.chunks[slice]);
      if (parsed.ok) data[slice] = parsed.value;
      else if (!parsed.missing) corrupted = true;
    });
    if (corrupted) return;
    const meta = parseChunkGroup_(snapshot.chunks['__META__']);
    const metaValue = meta.ok && meta.value ? meta.value : {};
    snapshots.push({
      revision: snapshot.revision,
      savedAt: String(metaValue.lastSavedAt || snapshot.savedAt || ''),
      savedBy: String(metaValue.lastSavedBy || snapshot.savedBy || ''),
      data: data
    });
  });
  return snapshots.sort(function(a, b) {
    return a.revision - b.revision;
  });
}

/**
 * Decisions a consecutive pair of snapshots recorded that the ledger does not
 * hold. The rows are built exactly as the save would have built them — same
 * timestamp, revision, gate label, role and signed-in email — so a repaired row
 * is indistinguishable from one the failed append would have written.
 *
 * Only decisions are repaired: an erased signature has no decision to record, and
 * the ledger is append-only.
 */
function missingSignOffLedgerRows_(snapshots, ledgerRows) {
  const known = {};
  (ledgerRows || []).forEach(function(row) {
    if (row && row.decision) {
      known[ledgerRowKey_(row.revision, row.programId, row.line, row.gate, row.approver, row.decision)] = true;
    }
  });

  const out = [];
  const seen = {};
  for (let i = 1; i < (snapshots || []).length; i += 1) {
    const previous = snapshots[i - 1];
    const next = snapshots[i];
    // Only adjacent revisions are a save. A gap means the history no longer holds
    // the state that save replaced, and diffing across it would attribute one
    // save's decisions to another revision.
    if (next.revision !== previous.revision + 1) continue;

    const models = {};
    (next.data.projects || []).forEach(function(project) {
      if (project && project.id) models[project.id] = String(project.model || '');
    });
    // The save recorded the signer's roster role and the saver's email; both are
    // derived here from the same roster the save read.
    const actor = rosterMemberFor_(next.data.teamMembers, next.savedBy);

    signOffSignatureEdits_(previous.data.gateRecords, next.data.gateRecords)
      .filter(function(edit) {
        return edit.kind === 'decision';
      })
      .forEach(function(edit) {
        const gate = GATE_LEDGER_LABELS[edit.gateId] || edit.gateId;
        const key = ledgerRowKey_(next.revision, edit.projectId, edit.line, gate, edit.approver, edit.decision);
        if (known[key] || seen[key]) return;
        seen[key] = true;
        out.push([
          next.savedAt || new Date().toISOString(),
          next.revision,
          edit.projectId,
          models[edit.projectId] || '',
          edit.line,
          gate,
          edit.approver,
          String((actor && actor.role) || edit.role || ''),
          edit.decision,
          edit.remark,
          String(next.savedBy || '')
        ]);
      });
  }
  return out;
}

/**
 * Self-healing SignOffLog for legacy gaps.
 *
 * New saves write the ledger before the store commits, so a failed append refuses
 * the save rather than leaving a committed signature without an audit row. This
 * repair still covers rows lost by an older post-commit save or removed by a hand
 * edit — on the next load, under the same lock a save takes, by replaying the
 * archived revisions against the tab and appending only the decisions missing.
 *
 * The cheap check comes first: script properties remember how many rows the tab
 * should hold, so a healthy store returns after two small reads and never touches
 * the history. Only a count mismatch pays for the replay.
 */
function reconcileSignOffLedger() {
  const userEmail = getActiveUserEmail_();
  if (!userEmail) {
    return { ok: false, appended: 0, error: 'Sign-in required: the ledger is only readable by the accessing domain account.' };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return { ok: false, appended: 0, locked: true, error: 'Another user is currently saving to the Google Sheet. Please retry in a few seconds.' };
  }

  try {
    const ss = getSpreadsheet_();
    const state = loadWorkspaceState();
    if (!state.initialized) {
      return {
        ok: false,
        appended: 0,
        corrupted: Boolean(state.corrupted),
        error: state.error || 'The workspace store has not been saved yet, so there is no ledger to reconcile.'
      };
    }

    const actual = ledgerRowCount_(ss);
    const expected = readLedgerExpectation_();
    if (actual === expected) {
      return { ok: true, appended: 0, revision: state.revision, inSync: true };
    }

    const historySheet = ss.getSheetByName(CONFIG.STATE_HISTORY_SHEET);
    const snapshots = historySheet && historySheet.getLastRow() >= 2
      ? historySnapshots_(historySheet.getRange(2, 1, historySheet.getLastRow() - 1, 7).getValues())
          .filter(function(snapshot) { return snapshot.revision < state.revision; })
      : [];

    // Nothing to replay against: the tab disagrees with the counter, but the state
    // that would say what is missing is gone. Report it instead of inventing rows.
    if (snapshots.length === 0) {
      return {
        ok: true,
        appended: 0,
        revision: state.revision,
        inSync: false,
        reason: 'No archived revision to compare against, so the ledger was left as it is.'
      };
    }

    snapshots.push({
      revision: state.revision,
      savedAt: String(state.lastSavedAt || ''),
      savedBy: String(state.lastSavedBy || ''),
      data: state.data
    });

    const rows = missingSignOffLedgerRows_(snapshots, readSignOffLedgerRows_(ss));
    if (rows.length === 0) {
      // The gap was not a missing decision (a hand-added row, or an append that
      // was written and then cleared). Re-baseline so the check stays cheap.
      markLedgerExpectation_(actual);
      return { ok: true, appended: 0, revision: state.revision, inSync: true, rebaselined: true };
    }

    const appended = appendSignOffLedgerOnce_(ss, rows);
    markLedgerExpectation_(actual + appended);

    try {
      getOrCreateSheet_(ss, CONFIG.AUDIT_SHEET).appendRow([
        new Date().toISOString(),
        userEmail,
        state.revision,
        'SIGN_OFF_LEDGER_RECONCILED',
        safeSheetText_(appended + ' gate decision(s) restored to SignOffLog from the archived revisions'),
        getExecutorEmail_()
      ]);
    } catch (err) {
      console.error('AuditLog could not record the ledger reconciliation: ' + errorMessage_(err));
    }

    return { ok: true, appended: appended, revision: state.revision, inSync: true };
  } catch (err) {
    return { ok: false, appended: 0, error: errorMessage_(err) };
  } finally {
    lock.releaseLock();
  }
}

function errorMessage_(err) {
  if (err && err.message) return String(err.message);
  return String(err || 'unknown error');
}

/**
 * Copies the state rows that are about to be overwritten into
 * `_FFM_STATE_HISTORY`, so a save can be undone. Only the newest
 * CONFIG.HISTORY_LIMIT revisions are kept.
 */
function archiveStateRevision_(ss, revision, rows) {
  const sheet = getOrCreateSheet_(ss, CONFIG.STATE_HISTORY_SHEET);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 7).setValues([['SliceKey', 'Revision', 'ChunkIndex', 'ChunkCount', 'SavedAt', 'PayloadChunk', 'SavedBy']]);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#0f172a').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }

  let savedBy = '';
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === '__META__' && Number(rows[i][1]) === 0) {
      try {
        savedBy = String(JSON.parse(String(rows[i][4] || '{}')).lastSavedBy || '');
      } catch (e) {}
      break;
    }
  }

  const out = rows.map(function(row) {
    return [
      String(row[0] || ''), revision, Number(row[1]) || 0, Number(row[2]) || 0,
      String(row[3] || ''), String(row[4] || ''), savedBy
    ];
  });
  if (out.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, out.length, 7).setValues(out);
  pruneStateHistory_(sheet, CONFIG.HISTORY_LIMIT);
}

/**
 * Revision keys to delete when more than `keep` are stored. Snapshots are
 * archived oldest first, so only the oldest block(s) are ever dropped.
 */
function historyRevisionsToDrop_(order, keep) {
  const list = Array.isArray(order) ? order : [];
  const excess = list.length - Math.max(1, Number(keep) || 1);
  return excess > 0 ? list.slice(0, excess) : [];
}

function pruneStateHistory_(sheet, keep) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const revisions = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const order = [];
  revisions.forEach(function(cell) {
    const key = String(cell[0] || '');
    if (key && order.indexOf(key) === -1) order.push(key);
  });
  const drop = historyRevisionsToDrop_(order, keep);
  if (drop.length === 0) return;
  // History is append-only and oldest-first, so the dropped rows are a prefix.
  let count = 0;
  while (count < revisions.length && drop.indexOf(String(revisions[count][0] || '')) !== -1) {
    count += 1;
  }
  if (count > 0) sheet.deleteRows(2, count);
}

/**
 * Revision list for the History panel: the live revision plus the archived ones,
 * newest first. Reads only the small metadata columns, never the payloads.
 */
function listStateRevisions() {
  const current = loadWorkspaceState();
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.STATE_HISTORY_SHEET);
  const revisions = [];
  if (sheet && sheet.getLastRow() >= 2) {
    const count = sheet.getLastRow() - 1;
    const keys = sheet.getRange(2, 2, count, 1).getValues();
    const times = sheet.getRange(2, 5, count, 1).getValues();
    const bys = sheet.getRange(2, 7, count, 1).getValues();
    for (let i = 0; i < count; i++) {
      const revision = Number(keys[i][0]) || 0;
      if (!revision || revisions.some(function(r) { return r.revision === revision; })) continue;
      revisions.push({
        revision: revision,
        lastSavedAt: times[i][0] ? String(times[i][0]) : null,
        lastSavedBy: bys[i][0] ? String(bys[i][0]) : null
      });
    }
  }
  return {
    ok: true,
    limit: CONFIG.HISTORY_LIMIT,
    current: current.initialized
      ? { revision: current.revision, lastSavedAt: current.lastSavedAt, lastSavedBy: current.lastSavedBy }
      : null,
    revisions: revisions.sort(function(a, b) { return b.revision - a.revision; })
  };
}

/**
 * One archived revision, reassembled exactly like the live store. Read-only:
 * restoring is a normal save of this payload, so it becomes a new revision and
 * the state it replaces stays in history.
 */
function loadStateRevision(revision) {
  const target = Number(revision);
  if (!target) return { ok: false, error: 'No revision number was supplied.' };
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.STATE_HISTORY_SHEET);
  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: false, error: 'No archived revisions yet.' };
  }

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  const grouped = {};
  let savedAt = null;
  let savedBy = null;
  values.forEach(function(row) {
    if (Number(row[1]) !== target) return;
    const key = String(row[0] || '').trim();
    if (!key) return;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ idx: Number(row[2]) || 0, count: Number(row[3]) || 0, text: String(row[5] || '') });
    if (!savedAt && row[4]) savedAt = String(row[4]);
    if (!savedBy && row[6]) savedBy = String(row[6]);
  });

  const data = {};
  let corrupted = false;
  PERSISTED_SLICES.forEach(function(slice) {
    const result = parseChunkGroup_(grouped[slice]);
    if (result.ok) data[slice] = result.value;
    else if (!result.missing) corrupted = true;
  });

  if (Object.keys(data).length === 0) {
    return { ok: false, error: 'Revision ' + target + ' is no longer in the history.' };
  }
  if (corrupted) {
    return { ok: false, error: 'Revision ' + target + ' is stored incompletely and was not loaded.' };
  }
  return { ok: true, revision: target, lastSavedAt: savedAt, lastSavedBy: savedBy, data: data };
}

/**
 * Rebuilds the human-readable mirror tabs from the authoritative
 * `_FFM_STATE_STORE` payload, never from a client payload. Takes the same
 * script lock as a save, so it is safe to run while others are editing.
 *
 * An unreadable store is reported like `loadWorkspaceState` reports it
 * (`corrupted`, `error`), so callers can share one message helper.
 */
function refreshMirrorSheets() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw new Error('Another user is currently saving to the Google Sheet. Please retry in a few seconds.');
  }
  try {
    // syncMirrorSheets_ creates the tabs it writes, so ensureAllTabs_ is not needed here.
    const state = loadWorkspaceState();
    if (!state.initialized) {
      return { ok: false, corrupted: Boolean(state.corrupted), error: state.error || null };
    }
    syncMirrorSheets_(getSpreadsheet_(), state.data);
    const refreshedAt = new Date().toISOString();
    markMirrorsRefreshed_(state.revision, refreshedAt);
    return { ok: true, revision: state.revision, refreshedAt: refreshedAt };
  } finally {
    lock.releaseLock();
  }
}

/** Freshness stamp written by markMirrorsRefreshed_ and read by the menu. */
function readMirrorStatus_() {
  const props = PropertiesService.getScriptProperties();
  return {
    revision: Number(props.getProperty(CONFIG.MIRROR_REVISION_PROP)) || 0,
    refreshedAt: props.getProperty(CONFIG.MIRROR_REFRESHED_PROP) || null
  };
}

/** Honest wording: an unreadable store is not the same as an empty one. */
function describeUninitializedStore_(state) {
  if (state && state.corrupted) {
    return 'The workspace store could not be read: ' +
      (state.error || 'its stored chunks are incomplete or invalid') +
      '\n\nNothing was rebuilt. Restore the store before refreshing the reporting tabs.';
  }
  return 'The workspace store is empty: no workspace has been saved to the Sheet yet, so there is nothing to rebuild.';
}

function refreshMirrorSheetsFromMenu_() {
  const ui = SpreadsheetApp.getUi();
  try {
    const state = loadWorkspaceState();
    if (!state.initialized) {
      ui.alert('Mirror Tabs', describeUninitializedStore_(state), ui.ButtonSet.OK);
      return;
    }

    const status = readMirrorStatus_();
    const freshness = status.refreshedAt && status.revision
      ? 'Reporting tabs were last rebuilt from Rev #' + status.revision + ' at ' + status.refreshedAt + '.'
      : 'The reporting tabs have never been rebuilt from the store.';
    const prompt = freshness + '\nThe store is at Rev #' + state.revision + '.\n\nRebuild the reporting tabs now?';

    if (ui.alert('Mirror Tabs', prompt, ui.ButtonSet.YES_NO) !== ui.Button.YES) {
      return;
    }

    const res = refreshMirrorSheets();
    // !ok here means the store stopped being readable between prompt and rebuild.
    ui.alert('Mirror Tabs', res.ok
      ? 'Reporting tabs rebuilt from stored state (Rev #' + res.revision + ') at ' + res.refreshedAt + '.'
      : describeUninitializedStore_(res), ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Mirror Tabs', 'Refresh failed: ' + (err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

function markMirrorsRefreshed_(revision, refreshedAt) {
  try {
    PropertiesService.getScriptProperties().setProperties({
      [CONFIG.MIRROR_REVISION_PROP]: String(revision),
      [CONFIG.MIRROR_REFRESHED_PROP]: String(refreshedAt)
    });
  } catch (e) {}
}

/**
 * Writes clean, filterable tabular snapshots to human-readable tabs
 */
function syncMirrorSheets_(ss, payload) {
  const writeTable = function(tabName, headers, dataRows) {
    const sh = getOrCreateSheet_(ss, tabName);
    sh.clearContents();
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1e293b').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    if (dataRows.length > 0) {
      sh.getRange(2, 1, dataRows.length, headers.length).setValues(dataRows.map(safeSheetRow_));
    }
  };

  if (Array.isArray(payload.projects)) {
    const rows = payload.projects.map(function(p) {
      return [
        p.id || '', p.family || '', p.model || '', p.phase || '', p.side || '',
        p.status || '', p.currentGateId || '', p.leader || '',
        p.pm || '', p.owner || '', (p.buildMatrix || []).length
      ];
    });
    writeTable('Projects', ['ID', 'Family', 'Model', 'Phase', 'Side', 'Status', 'CurrentGate', 'Leader', 'Manager', 'PE', 'ConfigLines'], rows);
  }

  if (Array.isArray(payload.tasks)) {
    const rows = payload.tasks.map(function(t) {
      return [
        t.id || '', t.projectId || '', t.gateId || '', t.processStep || '', t.category || '',
        t.title || '', t.owner || '', t.priority || '', t.status || '', t.dueDate || ''
      ];
    });
    writeTable('Tasks', ['ID', 'ProjectID', 'GateID', 'ProcessStep', 'Category', 'Title', 'Owner', 'Priority', 'Status', 'DueDate'], rows);
  }

  if (Array.isArray(payload.productionRecords)) {
    const rows = payload.productionRecords.map(function(r) {
      const defects = Array.isArray(r.defectItems) ? r.defectItems : [];
      const fallout = defects.length
        ? defects.reduce(function(s, d) { return s + (Number(d.falloutQty) || 0); }, 0)
        : (Number(r.fallout) || 0);
      const salvage = defects.length
        ? defects.reduce(function(s, d) {
            const f = Math.max(0, Number(d.falloutQty) || 0);
            return s + Math.min(f, Math.max(0, Number(d.salvageQty) || 0));
          }, 0)
        : Math.min(fallout, Number(r.salvage) || 0);
      const inp = Number(r.input) || 0;
      const fpy = inp > 0 ? (((inp - fallout) / inp) * 100).toFixed(2) + '%' : '';
      const fy = inp > 0 ? (((inp - fallout + salvage) / inp) * 100).toFixed(2) + '%' : '';
      // Planned and downtime hours are mirror-only columns: without them the tab
      // cannot be downloaded and re-imported, because UPH and efficiency divide
      // by the planned time and the import refuses a row that has none.
      const planned = Number(r.plannedTimeHr) || 0;
      const downtimeMin = (Array.isArray(r.downtimeEvents) ? r.downtimeEvents : []).reduce(
        function(s, e) { return s + Math.max(0, Number(e && e.durationMin) || 0); },
        0
      );
      const downtimeHr = (downtimeMin / 60).toFixed(2);
      return [
        r.id || '', r.date || '', r.model || '', r.phase || '', r.side || '',
        r.config || '', r.station || '', inp, planned, fallout, salvage, downtimeHr, fpy, fy
      ];
    });
    writeTable(
      'ProductionRecords',
      ['ID', 'Date', 'Model', 'Phase', 'Side', 'Config', 'Station', 'InputQty', 'PlannedHr', 'Fallout', 'Salvage', 'DowntimeHr', 'FPY', 'FY'],
      rows
    );
  }

  if (Array.isArray(payload.masterSpecs)) {
    const rows = payload.masterSpecs.map(function(s) {
      const revisions = Array.isArray(s.revisions) ? s.revisions : [];
      return [
        s.id || '', s.code || '', s.name || '', s.unit || '',
        s.lsl ?? '', s.nominal ?? '', s.usl ?? '', s.category || '', s.model || '',
        s.effectiveFrom || '', revisions.length || 1
      ];
    });
    writeTable('MasterSpecs', ['ID', 'ParamCode', 'Parameter', 'Unit', 'LSL', 'Nominal', 'USL', 'Category', 'Model', 'LimitsEffectiveFrom', 'LimitRevisions'], rows);
  }

  if (Array.isArray(payload.cpkRecords)) {
    const rows = payload.cpkRecords.map(function(c) {
      return [
        c.id || '', c.model || '', c.phase || '', c.side || '', c.config || '',
        c.specId || '', c.mean ?? '', c.stdDev ?? '', c.sampleSize ?? '', c.date || '',
        c.lsl ?? '', c.usl ?? '', c.cpkTarget ?? '', c.specRevisionId || ''
      ];
    });
    writeTable('CpkRecords', ['ID', 'Model', 'Phase', 'Side', 'Config', 'ParamCode', 'Mean', 'StdDev', 'SampleSize', 'MeasuredDate', 'LSL', 'USL', 'CpkTarget', 'SpecRevision'], rows);
  }

  if (Array.isArray(payload.costProjects)) {
    const rows = payload.costProjects.map(function(c) {
      return [
        c.id || '', c.title || '', c.category || '', c.model || '',
        c.feasibility || '', c.stage || '', c.hcReduction ?? 0,
        c.annualMaterialSavingThb ?? 0, c.quotedCostThb ?? 0, c.owner || ''
      ];
    });
    writeTable('CostProjects', ['ID', 'Title', 'Category', 'Model', 'Feasibility', 'Stage', 'HCReduction', 'AnnualMatSavingTHB', 'QuotedCostTHB', 'Owner'], rows);
  }

  if (Array.isArray(payload.customerFeedback)) {
    const rows = payload.customerFeedback.map(function(f) {
      return [
        f.id || '', f.facaNo || '', f.feedbackDate || '', f.location || '',
        f.model || '', f.phase || '', f.issueCategory || '', f.issueItem || '',
        f.ngQty ?? 0, f.nmbStatus || '', f.customerStatus || '', f.owner || ''
      ];
    });
    writeTable('CustomerFeedback', ['ID', 'FACA#', 'Date', 'Location', 'Model', 'Phase', 'Category', 'IssueItem', 'NGQty', 'NMBStatus', 'CustomerStatus', 'Owner'], rows);
  }
}
