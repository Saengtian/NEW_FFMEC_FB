/**
 * Imports a workspace export into the local preview.
 *
 * Two sources, one command:
 *   1. The app's own JSON export (the "Copy" button in the sidebar), for when
 *      Google Workspace blocks this desktop's browser from opening the Sheet.
 *   2. A `_FFM_STATE_STORE` CSV export, one row per 40,000-char JSON chunk.
 *
 * The CSV path rebuilds the JSON exactly the way `loadWorkspaceState()` does —
 * same chunk-count rule, same `__META__` contract. Both paths refuse an export
 * whose slices or revision do not add up. The result is written to
 * `.preview/imported-state.json`, which the preview server seeds into
 * `localStorage['ffm-npi-ops-preview-state']` once on the next page load.
 *
 * Tooling only: nothing here ships to Apps Script or into Bundle.html.
 *
 * Usage:
 *   bun tools/import-state.mjs [export] [--force] [--dry-run]
 *
 *   export     ffm-state-store.csv (default) or an FFM NPI Ops workspace .json
 *   --force    Import even if a newer revision was imported before
 *   --dry-run  Validate and report, but do not write
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { createHash } from "node:crypto";

const ROOT = join(import.meta.dir, "..");
const DEFAULT_INPUT = "ffm-state-store.csv";
const OUTPUT = join(ROOT, ".preview", "imported-state.json");
const PREVIEW_URL = "http://127.0.0.1:5183";

/** Slice shapes `hydrateFromPayload` expects; a mismatch means a bad reassembly. */
const SLICE_TYPES = {
  projects: "array",
  tasks: "array",
  gateRecords: "object",
  productionRecords: "array",
  masterSpecs: "array",
  cpkRecords: "array",
  costProjects: "array",
  customerFeedback: "array",
  scheduleOverrides: "object",
  teamMembers: "array",
};

const problems = [];
const error = (message) => problems.push({ level: "error", message });
const warn = (message) => problems.push({ level: "warn", message });

function fail(message) {
  console.error(`\nImport failed: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { file: null, force: false, dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === "--force") args.force = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("-")) fail(`unknown option ${arg} (try --help)`);
    else if (args.file !== null) fail("pass at most one export path");
    else args.file = arg;
  }
  return args;
}

function printHelp() {
  console.log(`
Import a workspace export into the local preview.

  bun tools/import-state.mjs [export] [--force] [--dry-run]

  export     ffm-state-store.csv (default) or an FFM NPI Ops workspace .json
  --force    Import even if a newer revision was imported before
  --dry-run  Validate and report, but do not write

Either source works:
  - In the deployed app: sidebar → Copy, then save the pasted JSON as a .json file.
  - In the Sheet: right-click the _FFM_STATE_STORE tab → Download → Comma-separated
    values (.csv), then drop the file in the project root.

Afterwards reload the preview tab so the app loads the imported revision.
`);
}

/**
 * RFC 4180 parser. Google's CSV export quotes any cell holding a comma, a quote
 * or a line break, and the payload chunks are dense JSON, so this has to be a
 * real parser rather than a split(","). Each row remembers its starting line
 * for useful error messages.
 */
function parseCsv(text) {
  const rows = [];
  let cells = [];
  let field = "";
  let line = 1;
  let rowLine = 1;
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    cells.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push({ line: rowLine, cells });
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted && field === "") {
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (ch === ",") {
      endField();
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
      rowLine = line;
      continue;
    }
    field += ch;
    fieldStarted = true;
  }
  if (field !== "" || cells.length) endRow();

  return rows;
}

/** The backend is the contract: read the slice list and chunk size from it. */
function readBackendContract() {
  const code = readFileSync(join(ROOT, "Code.js"), "utf8");
  const sliceBlock = code.match(/const PERSISTED_SLICES = \[([\s\S]*?)\];/);
  if (!sliceBlock) fail("Code.js no longer declares PERSISTED_SLICES — cannot validate the export");
  const slices = [...sliceBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (!slices.length) fail("PERSISTED_SLICES in Code.js is empty");
  const chunkMatch = code.match(/CHUNK_SIZE:\s*(\d+)/);
  return { slices, chunkSize: chunkMatch ? Number(chunkMatch[1]) : null };
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

function sliceSize(value) {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (kind === "array") return { records: value.length, label: "records" };
  if (kind === "object") return { records: Object.keys(value).length, label: "keys" };
  return { records: 1, label: "value" };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The app's own export: `{ app, version, exportedAt, revision, lastSavedAt,
 * lastSavedBy, data: { ...slices } }`. A bare payload (the older Backup file)
 * is accepted too, with its slices read from the top level.
 */
function readJsonExport(parsed, fileName, slices) {
  if (!isPlainObject(parsed)) fail(`${fileName}: expected a JSON object`);
  const nested = isPlainObject(parsed.data);
  const source = nested ? parsed.data : parsed;
  if (!slices.some((slice) => Object.prototype.hasOwnProperty.call(source, slice))) {
    fail(`${fileName}: holds no workspace slices (${slices.join(", ")}) — this is not an FFM NPI Ops export`);
  }

  const map = new Map();
  for (const slice of slices) {
    if (Object.prototype.hasOwnProperty.call(source, slice)) map.set(slice, source[slice]);
  }

  const revision = Number(parsed.revision);
  const usableRevision = Number.isInteger(revision) && revision >= 1;
  if (!usableRevision) {
    warn(`export has no usable revision (${JSON.stringify(parsed.revision)}) — importing as Rev #1`);
  }
  if (!nested && !parsed.exportedAt) {
    warn("export has no exportedAt stamp; it was probably edited by hand");
  }
  return {
    map,
    revision: usableRevision ? revision : 1,
    lastSavedAt: typeof parsed.lastSavedAt === "string" ? parsed.lastSavedAt : null,
    lastSavedBy: typeof parsed.lastSavedBy === "string" ? parsed.lastSavedBy : null,
    chunkRows: [],
  };
}

/**
 * The Sheet export: one row per chunk. Mirrors the backend rule exactly — the
 * chunks of a key must be numbered 0..n-1, agree on n, and join into valid JSON.
 */
function readCsvExport(text, fileName, slices, chunkSize) {
  const rows = parseCsv(text);
  if (!rows.length) fail(`${fileName} is empty`);

  // Column order comes from the header when there is one; a bare range export
  // without it falls back to the order saveWorkspaceState writes.
  const COLUMNS = ["slicekey", "chunkindex", "chunkcount", "updatedat", "payloadchunk"];
  let columns = { slicekey: 0, chunkindex: 1, chunkcount: 2, updatedat: 3, payloadchunk: 4 };
  let firstDataRow = 0;
  const header = rows[0].cells.map((c) => c.trim().toLowerCase());
  if (header[0] === "slicekey") {
    const found = {};
    COLUMNS.forEach((name) => {
      const at = header.indexOf(name);
      if (at !== -1) found[name] = at;
    });
    if (Object.keys(found).length !== COLUMNS.length) {
      fail(`${fileName}: header is missing an expected column (${COLUMNS.join(", ")}); found ${header.join(", ")}`);
    }
    columns = found;
    firstDataRow = 1;
  }

  const grouped = new Map();
  let blankRows = 0;
  let dataRows = 0;

  for (let r = firstDataRow; r < rows.length; r++) {
    const { line, cells } = rows[r];
    if (!cells.length || cells.every((c) => c.trim() === "")) {
      blankRows++;
      continue;
    }
    if (cells.length > 5) {
      error(`line ${line}: ${cells.length} columns, expected 5 — that row's payload was not quoted, so the export is damaged`);
      continue;
    }
    const key = String(cells[columns.slicekey] ?? "").trim();
    if (!key) {
      error(`line ${line}: empty SliceKey — this is not a _FFM_STATE_STORE export, or its first rows were cut off`);
      continue;
    }
    const idxRaw = String(cells[columns.chunkindex] ?? "").trim();
    const countRaw = String(cells[columns.chunkcount] ?? "").trim();
    const idx = Number(idxRaw);
    const count = Number(countRaw);
    if (idxRaw === "" || !Number.isInteger(idx) || idx < 0) {
      error(`${key}: line ${line} has chunk index "${idxRaw}", which is not a whole number`);
      continue;
    }
    if (countRaw === "" || !Number.isInteger(count) || count < 1) {
      error(`${key}: line ${line} declares chunk count "${countRaw}", which is not a positive whole number`);
      continue;
    }
    dataRows++;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      idx,
      count,
      line,
      text: String(cells[columns.payloadchunk] ?? ""),
      updatedAt: String(cells[columns.updatedat] ?? ""),
    });
  }

  if (!grouped.size) fail(`${fileName} has no chunk rows${blankRows ? ` (${blankRows} blank rows skipped)` : ""}`);

  const parsed = new Map();
  const failedKeys = new Set();
  const chunkRows = [];
  for (const [key, bucket] of grouped) {
    const chunks = bucket.slice().sort((a, b) => a.idx - b.idx);
    const declared = chunks[0].count;
    const seen = new Set();
    let broken = false;

    // One error per key is enough: the first broken rule explains the rest.
    const failKey = (message) => {
      error(message);
      failedKeys.add(key);
    };

    for (const chunk of chunks) {
      if (seen.has(chunk.idx)) {
        failKey(`${key}: chunk ${chunk.idx} appears twice (lines ${chunks.filter((c) => c.idx === chunk.idx).map((c) => c.line).join(", ")})`);
        broken = true;
        break;
      }
      seen.add(chunk.idx);
    }
    if (broken) continue;

    if (chunks.length !== declared) {
      failKey(`${key}: declares ${declared} chunk${declared === 1 ? "" : "s"} but the export holds ${chunks.length} — the export is incomplete (re-export the whole tab)`);
      continue;
    }
    if (chunks.some((c) => c.count !== declared)) {
      failKey(`${key}: chunks disagree on the total (${[...new Set(chunks.map((c) => c.count))].join(" vs ")}) — rows from two different saves are mixed`);
      continue;
    }
    if (chunks.some((c, i) => c.idx !== i)) {
      failKey(`${key}: chunks are not numbered 0..${declared - 1} (found ${chunks.map((c) => c.idx).join(", ")})`);
      continue;
    }
    if (chunkSize) {
      const short = chunks.find((c, i) => i < chunks.length - 1 && c.text.length !== chunkSize);
      if (short) {
        warn(`${key}: chunk ${short.idx} is ${short.text.length} chars, not ${chunkSize} — the cell may have been trimmed on export`);
      }
    }

    const joined = chunks.map((c) => c.text).join("");
    let value;
    try {
      value = JSON.parse(joined);
    } catch (err) {
      failKey(`${key}: chunks do not reassemble into JSON (${err.message})`);
      continue;
    }
    parsed.set(key, value);
    chunkRows.push({ key, chunks: chunks.length, bytes: Buffer.byteLength(joined, "utf8") });
  }

  // __META__ carries the revision the preview will report and save against.
  let revision = 0;
  let lastSavedAt = null;
  let lastSavedBy = null;
  const meta = parsed.get("__META__");
  if (!grouped.has("__META__")) {
    error("no __META__ rows: this is not a complete _FFM_STATE_STORE export");
  } else if (meta === undefined) {
    error("__META__ could not be read, so the revision is unknown");
  } else if (!isPlainObject(meta)) {
    error(`__META__ is not a JSON object (got ${Array.isArray(meta) ? "an array" : typeof meta})`);
  } else {
    revision = Number(meta.revision);
    if (!Number.isInteger(revision) || revision < 1) {
      error(`__META__ revision is ${JSON.stringify(meta.revision)}, not a revision number`);
    }
    lastSavedAt = typeof meta.lastSavedAt === "string" ? meta.lastSavedAt : null;
    lastSavedBy = typeof meta.lastSavedBy === "string" ? meta.lastSavedBy : null;
    if (!lastSavedAt || Number.isNaN(Date.parse(lastSavedAt))) {
      warn(`__META__ lastSavedAt is ${JSON.stringify(meta.lastSavedAt)} — the preview will show no save time`);
    }
    if (Array.isArray(meta.slices)) {
      const missing = meta.slices.filter((slice) => !grouped.has(slice));
      if (missing.length) {
        error(`__META__ lists ${missing.map((s) => `"${s}"`).join(", ")} but no chunks for it exist — the save recorded more slices than the sheet holds`);
      }
    } else {
      warn("__META__ has no slice manifest (written by an older build); slices are taken from the rows present");
    }
  }

  return {
    map: parsed,
    failedKeys,
    revision,
    lastSavedAt,
    lastSavedBy,
    chunkRows,
    dataRows,
  };
}

/** Checks every persisted slice the preview will hydrate and returns that map. */
function collectSlices(map, failedKeys, slices) {
  const data = {};
  for (const slice of slices) {
    if (!map.has(slice)) {
      // A key that failed validation is already explained; do not also call it absent.
      if (!failedKeys.has(slice)) {
        warn(`slice "${slice}" is absent from the export — the preview keeps its built-in seed data for it`);
      }
      continue;
    }
    const value = map.get(slice);
    const expected = SLICE_TYPES[slice];
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (expected && actual !== expected) {
      warn(`slice "${slice}" is ${actual}, but the app hydrates it as ${expected}`);
    }
    data[slice] = value;
  }
  for (const key of map.keys()) {
    if (key !== "__META__" && !slices.includes(key)) warn(`key "${key}" is not a persisted slice — ignored`);
  }
  return data;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = resolve(ROOT, args.file || DEFAULT_INPUT);
  if (!existsSync(inputPath)) {
    fail(`${basename(inputPath)} not found at ${inputPath}\n  Pass the export path, or drop ffm-state-store.csv / a workspace .json in the project root.`);
  }

  const raw = readFileSync(inputPath, "utf8");
  if (raw.startsWith("PK\u0003\u0004")) {
    fail("that file is an .xlsx workbook, not CSV.\n  Re-export the tab with File → Download → Comma-separated values (.csv), or use the app's Copy button.");
  }
  const text = raw.replace(/^\uFEFF/, "");
  const { slices, chunkSize } = readBackendContract();

  const fileName = basename(inputPath);
  const isJson = text.trimStart().startsWith("{");
  let exportRead;
  if (isJson) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      fail(`${fileName} is not valid JSON (${err.message})`);
    }
    exportRead = readJsonExport(parsed, fileName, slices);
    exportRead.failedKeys = new Set();
  } else {
    exportRead = readCsvExport(text, fileName, slices, chunkSize);
  }

  const { map, failedKeys, revision, lastSavedAt, lastSavedBy } = exportRead;
  const data = collectSlices(map, failedKeys, slices);

  // Guard against silently rolling the preview back to an older export.
  if (existsSync(OUTPUT) && !args.force) {
    try {
      const previous = JSON.parse(readFileSync(OUTPUT, "utf8"));
      if (previous && Number(previous.revision) > revision) {
        error(`.preview/imported-state.json already holds Rev #${previous.revision}, newer than this export's Rev #${revision}. Export the current state, or pass --force to import anyway.`);
      }
    } catch {
      warn("the previous .preview/imported-state.json is unreadable and will be replaced");
    }
  }

  const errors = problems.filter((p) => p.level === "error");
  const warnings = problems.filter((p) => p.level === "warn");

  console.log(`\nFFM NPI Ops — workspace import ${args.dryRun ? "(dry run)" : ""}\n`);
  console.log(
    `  source     ${fileName} (${formatBytes(statSync(inputPath).size)}, ${isJson ? "app JSON export" : `${exportRead.dataRows} chunk rows`})`
  );
  console.log(`  revision   Rev #${revision} · ${lastSavedAt || "no save time"} · ${lastSavedBy || "no author"}`);

  const sliceLines = slices
    .filter((slice) => map.has(slice))
    .map((slice) => {
      const shape = sliceSize(map.get(slice));
      const chunk = exportRead.chunkRows.find((c) => c.key === slice);
      return {
        slice,
        records: shape.records,
        chunks: chunk ? chunk.chunks : null,
        bytes: chunk ? chunk.bytes : Buffer.byteLength(JSON.stringify(map.get(slice)), "utf8"),
      };
    })
    .sort((a, b) => a.slice.localeCompare(b.slice));

  if (sliceLines.length) {
    const showChunks = !isJson;
    if (showChunks) {
      const split = exportRead.chunkRows.filter((c) => c.chunks > 1).length;
      console.log(`  chunks     ${exportRead.chunkRows.reduce((sum, c) => sum + c.chunks, 0)} rows reassembled (${split} split)`);
    }
    console.log("");
    console.log(
      `  ${"slice".padEnd(22)}${"records".padStart(9)}${showChunks ? "chunks".padStart(8) : ""}${"size".padStart(10)}`
    );
    for (const entry of sliceLines) {
      console.log(
        `  ${entry.slice.padEnd(22)}${String(entry.records).padStart(9)}${showChunks ? String(entry.chunks).padStart(8) : ""}${formatBytes(entry.bytes).padStart(10)}`
      );
    }
  }

  if (warnings.length) {
    console.log("");
    warnings.forEach((p) => console.log(`  warning  ${p.message}`));
  }
  if (errors.length) {
    console.log("");
    errors.forEach((p) => console.log(`  error    ${p.message}`));
    console.log(`\nNothing was written: ${errors.length} error${errors.length === 1 ? "" : "s"} in the export.\n`);
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(`\nValid — ${Object.keys(data).length} slices, ${formatBytes(Buffer.byteLength(JSON.stringify(data)))} of data. Not written (--dry-run).\n`);
    return;
  }

  const payload = {
    importToken: createHash("sha256").update(text).digest("hex").slice(0, 16),
    source: fileName,
    revision,
    lastSavedAt,
    lastSavedBy,
    importedAt: new Date().toISOString(),
    data,
  };
  mkdirSync(join(ROOT, ".preview"), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(payload) + "\n");

  console.log(`\n  written    .preview/imported-state.json (Rev #${revision}, ${formatBytes(Buffer.byteLength(JSON.stringify(payload)))})`);
  console.log(`  next       bun run preview → ${PREVIEW_URL}, then reload the preview tab.\n`);
  console.log(`             The import seeds localStorage['ffm-npi-ops-preview-state'] once;`);
  console.log(`             preview edits after that are kept until the next import.\n`);
}

main();
