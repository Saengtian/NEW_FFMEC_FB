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
 *  - AuditLog is appended on every save.
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
  AUDIT_SHEET: 'AuditLog',
  CHUNK_SIZE: 40000,
  MIRROR_REVISION_PROP: 'FFM_MIRROR_REVISION',
  MIRROR_REFRESHED_PROP: 'FFM_MIRROR_REFRESHED_AT'
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
  'scheduleOverrides'
];

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
    stateSheet.getRange(1, 1, 1, 5).setValues([['SliceKey', 'ChunkIndex', 'ChunkCount', 'UpdatedAt', 'PayloadChunk']]);
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

/**
 * Loads the complete workspace state from `_FFM_STATE_STORE`.
 * Returns { initialized: false } if the Sheet has not been seeded yet.
 */
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
    const chunks = grouped[key];
    if (!chunks || !chunks.length) return undefined;
    chunks.sort(function(a, b) { return a.idx - b.idx; });
    const declared = chunks[0].count;
    if (!declared || chunks.length !== declared ||
        chunks.some(function(c, i) { return c.count !== declared || c.idx !== i; })) {
      corrupted = true;
      return undefined;
    }
    try {
      return JSON.parse(chunks.map(function(c) { return c.text; }).join(''));
    } catch (e) {
      corrupted = true;
      return undefined;
    }
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

    // Read current revision if present
    let prevRevision = 0;
    if (stateSheet.getLastRow() >= 2) {
      const existing = stateSheet.getDataRange().getValues();
      for (let i = 1; i < existing.length; i++) {
        if (String(existing[i][0]) === '__META__') {
          try {
            const m = JSON.parse(String(existing[i][4] || '{}'));
            prevRevision = Number(m.revision) || 0;
          } catch (e) {}
          break;
        }
      }
    }

    // Reject a stale client instead of silently overwriting another user's save.
    if (expectedRevision !== undefined && expectedRevision !== null &&
        Number(expectedRevision) !== prevRevision) {
      return {
        ok: false,
        conflict: true,
        revision: prevRevision
      };
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

    // Rewrite _FFM_STATE_STORE cleanly
    stateSheet.clearContents();
    stateSheet.getRange(1, 1, 1, 5).setValues([['SliceKey', 'ChunkIndex', 'ChunkCount', 'UpdatedAt', 'PayloadChunk']]);
    if (rows.length > 0) {
      stateSheet.getRange(2, 1, rows.length, 5).setValues(rows);
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

    return {
      ok: true,
      revision: nextRevision,
      lastSavedAt: nowIso,
      lastSavedBy: actorLabel,
      userEmail: userEmail
    };
  } finally {
    lock.releaseLock();
  }
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
      return [
        r.id || '', r.date || '', r.model || '', r.phase || '', r.side || '',
        r.config || '', r.station || '', inp, fallout, salvage, fpy, fy
      ];
    });
    writeTable('ProductionRecords', ['ID', 'Date', 'Model', 'Phase', 'Side', 'Config', 'Station', 'InputQty', 'Fallout', 'Salvage', 'FPY', 'FY'], rows);
  }

  if (Array.isArray(payload.masterSpecs)) {
    const rows = payload.masterSpecs.map(function(s) {
      return [
        s.id || '', s.code || '', s.name || '', s.unit || '',
        s.lsl ?? '', s.nominal ?? '', s.usl ?? '', s.category || '', s.model || ''
      ];
    });
    writeTable('MasterSpecs', ['ID', 'ParamCode', 'Parameter', 'Unit', 'LSL', 'Nominal', 'USL', 'Category', 'Model'], rows);
  }

  if (Array.isArray(payload.cpkRecords)) {
    const rows = payload.cpkRecords.map(function(c) {
      return [
        c.id || '', c.model || '', c.phase || '', c.side || '', c.config || '',
        c.specId || '', c.mean ?? '', c.stdDev ?? '', c.sampleSize ?? '', c.date || ''
      ];
    });
    writeTable('CpkRecords', ['ID', 'Model', 'Phase', 'Side', 'Config', 'ParamCode', 'Mean', 'StdDev', 'SampleSize', 'MeasuredDate'], rows);
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
