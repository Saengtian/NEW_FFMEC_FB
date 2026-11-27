/**
 * Builds the three files Apps Script actually serves:
 *
 *   Bundle.html — React 18 + every view, precompiled from the Part*.html sources
 *                 (no Babel, no cdnjs, no SheetJS)
 *   SheetJs.html — SheetJS alone, served on demand by Code.js.getSheetJsSource()
 *   Styles.html — Tailwind compiled from the classes those sources use
 *                 (no Play CDN, no runtime class scanning)
 *
 * Sources stay human-readable in Icons.html / Part*.html; only this script reads
 * them. Run:  bun tools/build.mjs
 */

import { readFileSync, writeFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";

const ROOT = join(import.meta.dir, "..");
const PARTS = ["Icons", "Part1_Data", "Part2_App", "Part3_ViewsA", "Part4_ViewsB", "Part5_Modules", "Part6_Reports"];
const BUNDLE = join(ROOT, "Bundle.html");
const SHEETJS = join(ROOT, "SheetJs.html");
const STYLES = join(ROOT, "Styles.html");
const CSS_TMP = join(ROOT, "tools/.styles.tmp.css");
const TAILWIND_CONFIG = join(ROOT, "tools/tailwind.config.cjs");
const TAILWIND_INPUT = join(ROOT, "tools/tailwind.css");

/** React/ReactDOM come from node_modules, so nothing is fetched at runtime. */
const PRELUDE = `import React from 'react';
import ReactDOM from 'react-dom';
const { useState, useMemo, useEffect, useRef, useCallback } = React;
`;

/** Mounting used to be a second <script type="text/babel"> at the end of Index. */
const EPILOGUE = `
const rootEl = document.getElementById('root');
if (ReactDOM.createRoot) {
  ReactDOM.createRoot(rootEl).render(<App />);
} else {
  ReactDOM.render(<App />, rootEl);
}
`;

/**
 * Apps Script's HTML pipeline strips from a raw `http://` to the end of that
 * line; on SheetJS's long minified lines that silently deleted ~49 KB and left
 * an unterminated string (startup SyntaxError). `\/` is a no-op escape inside JS
 * strings/regexes/templates, so runtime values stay intact. For the same reason
 * it reads `<?` as the start of a template scriptlet, so SheetJS's literal
 * "<?xml" declaration needs its delimiter broken — `\?` is likewise the same
 * character to the running JS. A literal </script> would close the inline tag
 * early, so that is escaped too.
 */
function escapeForHtml(js) {
  return js
    .replace(/<\/script/gi, "<\\/script")
    .replaceAll("http://", "http:\\/\\/")
    .replaceAll("<?", "<\\?");
}

function scriptBody(name) {
  const html = readFileSync(join(ROOT, `${name}.html`), "utf8");
  const match = html.match(/<script[^>]*>([\s\S]*)<\/script>/);
  if (!match) throw new Error(`${name}.html has no <script> block to compile`);
  return match[1];
}

async function buildScript() {
  const code =
    PRELUDE +
    PARTS.map((name) => `\n// ===== ${name} =====\n${scriptBody(name)}`).join("\n") +
    EPILOGUE;

  const result = await esbuild.build({
    stdin: { contents: code, resolveDir: ROOT, sourcefile: "app.jsx", loader: "jsx" },
    bundle: true,
    write: false,
    format: "iife",
    target: ["es2019"],
    jsx: "transform",
    minify: true,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });

  const js = escapeForHtml(result.outputFiles[0].text);
  writeFileSync(
    BUNDLE,
    `<!-- Built by tools/build.mjs from Icons.html + Part*.html. Do not edit. -->\n<script>\n${js}\n</script>\n`
  );
  return js.length;
}

/**
 * SheetJS is ~486 KB minified and only an Excel import needs it. Building it separately
 * keeps it out of Index.html's startup path; Code.js reads this file on demand
 * and loadSheetJsLib() injects the source once, on the first .xlsx/.xls import.
 */
async function buildSheetJs() {
  const result = await esbuild.build({
    stdin: {
      contents: "import XLSX from 'xlsx';\nwindow.XLSX = XLSX;\n",
      resolveDir: ROOT,
      sourcefile: "sheetjs-entry.js",
    },
    bundle: true,
    write: false,
    format: "iife",
    target: ["es2019"],
    minify: true,
    legalComments: "none",
    logLevel: "silent",
  });
  const js = escapeForHtml(result.outputFiles[0].text);
  writeFileSync(
    SHEETJS,
    `<!-- Built by tools/build.mjs from the pinned xlsx dependency. Loaded on demand. Do not edit. -->\n<script>\n${js}\n</script>\n`
  );
  return js.length;
}

async function buildStyles() {
  const proc = Bun.spawn(
    [
      process.execPath,
      join(ROOT, "node_modules/tailwindcss/lib/cli.js"),
      "-c", TAILWIND_CONFIG,
      "-i", TAILWIND_INPUT,
      "-o", CSS_TMP,
      "--minify",
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" }
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tailwind failed (exit ${exitCode}):\n${err}`);
  }

  const css = readFileSync(CSS_TMP, "utf8").trim();
  unlinkSync(CSS_TMP);
  writeFileSync(
    STYLES,
    `<!-- Built by tools/build.mjs from tools/tailwind.css. Do not edit. -->\n<style>\n${css}\n</style>\n`
  );
  return css.length;
}

export async function build({ quiet = false } = {}) {
  const [js, sheetjs, css] = await Promise.all([buildScript(), buildSheetJs(), buildStyles()]);
  if (!quiet) {
    console.log(`Bundle.html   ${(js / 1024).toFixed(0)} KB compiled JS`);
    console.log(`SheetJs.html  ${(sheetjs / 1024).toFixed(0)} KB on-demand JS`);
    console.log(`Styles.html   ${(css / 1024).toFixed(0)} KB compiled CSS`);
  }
  return { js, sheetjs, css };
}

/** True when any source is newer than the built files (or a build is missing). */
export function isStale() {
  if (!existsSync(BUNDLE) || !existsSync(SHEETJS) || !existsSync(STYLES)) return true;
  const built = Math.min(
    statSync(BUNDLE).mtimeMs,
    statSync(SHEETJS).mtimeMs,
    statSync(STYLES).mtimeMs
  );
  const sources = [
    "Index.html",
    "Icons.html",
    ...PARTS.map((p) => `${p}.html`),
    "tools/build.mjs",
    "tools/tailwind.css",
    "tools/tailwind.config.cjs",
  ];
  return sources.some((file) => statSync(join(ROOT, file)).mtimeMs > built);
}

if (import.meta.main) {
  await build();
}
