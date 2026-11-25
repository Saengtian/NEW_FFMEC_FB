/**
 * Local preview server for the FFM NPI Ops Google Apps Script web app.
 *
 * Serves exactly what Apps Script would serve: it rebuilds Bundle.html and
 * Styles.html from the Part*.html sources when they change (tools/build.mjs),
 * then resolves the `<?!= include('File') ?>` tags and the serverConfigJson
 * injection the way HtmlService does. A localStorage-backed google.script.run
 * stands in for Code.js, so save/load and conflicts run locally, including a
 * one-off seed from `.preview/imported-state.json` (tools/import-state.mjs).
 *
 * Tracked source: this file ships with the repo. Everything it reads or the
 * harness writes — the imported state, screenshots, logs — stays in the
 * gitignored `.preview/` folder.
 *
 * Usage: bun tools/preview-server.mjs [port]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build, isStale } from "./build.mjs";

const ROOT = join(import.meta.dir, "..");

// Local data only: written by tools/import-state.mjs, never committed.
const DATA_DIR = join(ROOT, ".preview");
const IMPORT_FILE = join(DATA_DIR, "imported-state.json");

const HOST = "127.0.0.1";
const PORT = Number(process.argv[2] || 5183);

// localStorage-backed stand-in for Code.js, so save/load, revision conflicts
// and the sync badge all run locally. Same responses as the real backend.
const GAS_SHIM = String.raw`
(function () {
  var KEY = 'ffm-npi-ops-preview-state';
  var IMPORT_KEY = 'ffm-npi-ops-preview-import-applied';
  var EMAIL = 'local-preview@minebea.co.th';

  // A _FFM_STATE_STORE export imported by tools/import-state.mjs. Null when
  // nothing was imported, so the preview behaves exactly as before.
  var IMPORTED = __FFM_PREVIEW_IMPORT__;

  // Applied once per import, keyed by a hash of the exported CSV: reloading the
  // tab keeps whatever the preview has since edited, a newer import replaces it.
  (function applyImport() {
    if (!IMPORTED || !IMPORTED.importToken || !IMPORTED.data) return;
    try {
      if (window.localStorage.getItem(IMPORT_KEY) === IMPORTED.importToken) return;
      window.localStorage.setItem(KEY, JSON.stringify({
        revision: IMPORTED.revision,
        lastSavedAt: IMPORTED.lastSavedAt || null,
        lastSavedBy: IMPORTED.lastSavedBy || null,
        data: IMPORTED.data
      }));
      window.localStorage.setItem(IMPORT_KEY, IMPORTED.importToken);
      window.console.info('Preview workspace imported at Rev #' + IMPORTED.revision + ' from ' + IMPORTED.source);
    } catch (err) {
      // Quota or bad data: leave the stored workspace alone rather than half-imported.
      window.console.warn('Preview import skipped:', err && err.message ? err.message : err);
    }
  })();

  function readState() {
    var raw = window.localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function loadWorkspaceState() {
    var state = readState();
    if (!state) {
      return { initialized: false, userEmail: EMAIL, sheetUrl: '', revision: 0,
               lastSavedAt: null, lastSavedBy: null, data: null };
    }
    return { initialized: true, userEmail: EMAIL, sheetUrl: '', revision: state.revision,
             lastSavedAt: state.lastSavedAt, lastSavedBy: state.lastSavedBy, data: state.data };
  }

  function saveWorkspaceState(payloadJson, summary, expectedRevision) {
    var prev = readState();
    var revision = prev ? prev.revision : 0;
    // Same stale-client rule as the real save: refuse, never overwrite.
    if (expectedRevision !== undefined && expectedRevision !== null &&
        Number(expectedRevision) !== revision) {
      return { ok: false, conflict: true, revision: revision };
    }
    var next = {
      revision: revision + 1,
      lastSavedAt: new Date().toISOString(),
      lastSavedBy: EMAIL,
      data: JSON.parse(payloadJson)
    };
    window.localStorage.setItem(KEY, JSON.stringify(next));
    return { ok: true, revision: next.revision, lastSavedAt: next.lastSavedAt,
             lastSavedBy: EMAIL, userEmail: EMAIL };
  }

  function initializeDatabase(payloadJson) {
    return saveWorkspaceState(payloadJson, 'Initial database seed', undefined);
  }

  function getServerInfo() {
    return { spreadsheetId: 'LOCAL_PREVIEW', sheetUrl: '', webAppUrl: '', userEmail: EMAIL };
  }

  var methods = {
    loadWorkspaceState: loadWorkspaceState,
    saveWorkspaceState: saveWorkspaceState,
    initializeDatabase: initializeDatabase,
    getServerInfo: getServerInfo
  };

  var successHandler = null;
  var failureHandler = null;
  var run = {
    withSuccessHandler: function (fn) { successHandler = fn; return run; },
    withFailureHandler: function (fn) { failureHandler = fn; return run; }
  };

  Object.keys(methods).forEach(function (name) {
    run[name] = function () {
      var args = Array.prototype.slice.call(arguments);
      // Apps Script callbacks arrive asynchronously; keep the same ordering here.
      window.setTimeout(function () {
        try {
          var result = methods[name].apply(null, args);
          if (successHandler) successHandler(result);
        } catch (err) {
          if (failureHandler) failureHandler(err);
        }
      }, 150);
    };
  });

  window.google = window.google || {};
  window.google.script = { run: run };
})();
`;

const CONFIG_TAG = /<\?!=\s*serverConfigJson\s*\?>/g;
const INCLUDE_TAG = /<\?!=\s*include\(\s*['"]([^'"<>]+)['"]\s*\)\s*\?>/g;
const INCLUDE_START = /<\?!=\s*include\(/;
const ANY_GAS_TAG = /<\?[!=][\s\S]{0,60}/;

/** The imported workspace, or null when nothing has been imported yet. */
function readImport() {
  let raw;
  try {
    raw = readFileSync(IMPORT_FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`.preview/imported-state.json: ${err.message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.data) throw new Error("no data object");
    return parsed;
  } catch (err) {
    // A broken import must not break the preview: start from seed data instead.
    console.warn(`Ignoring .preview/imported-state.json: ${err.message}`);
    return null;
  }
}

function read(name) {
  try {
    return readFileSync(join(ROOT, name), "utf8");
  } catch (err) {
    const reason = err.code === "ENOENT"
      ? "file not found — check the include() name in Index.html"
      : err.message;
    throw new Error(`${name}: ${reason}`);
  }
}

function buildPage() {
  let html = read("Index.html");

  // Index.html has no config on disk: `null` makes the app fall back to its own
  // local-preview defaults instead of shipping a second copy of them here.
  html = html.replace(CONFIG_TAG, "null");

  // GAS evaluates include() at render time, so resolve iteratively: a part that
  // includes another part resolves the way it would in the deployed app.
  for (let depth = 0; INCLUDE_START.test(html); depth++) {
    if (depth > 8) throw new Error("include() nesting too deep — a part file probably includes itself");
    html = html.replace(INCLUDE_TAG, (_tag, file) => {
      if (!/^[A-Za-z0-9_.-]+$/.test(file)) throw new Error(`Unsafe include() name: ${file}`);
      return read(`${file}.html`);
    });
  }

  const leftover = html.match(ANY_GAS_TAG);
  if (leftover) throw new Error(`Unresolved GAS template tag: ${leftover[0].split("\n")[0]}`);

  // Inlined rather than fetched, so the seed lands before the app reads state.
  const imported = readImport();
  const importJson = imported
    ? JSON.stringify(imported).replace(/</g, "\\u003c")
    : "null";
  // A function replacement keeps `$&`-like sequences inside the JSON literal.
  const shim = GAS_SHIM.replace("__FFM_PREVIEW_IMPORT__", () => importJson);

  // Classic script in the head, so it is installed before the bundle runs.
  return html.replace("</head>", `<script>\n${shim}\n</script>\n</head>`);
}

Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname !== "/" && pathname !== "/index.html") {
      return new Response("Not found", { status: 404 });
    }
    try {
      // Same output the deployed app gets: rebuild when any source changed.
      if (isStale()) await build({ quiet: true });
      return new Response(buildPage(), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    } catch (err) {
      return new Response(`Preview build error\n\n${err.message}\n`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
  },
});

console.log(`FFM NPI Ops preview → http://${HOST}:${PORT}`);
