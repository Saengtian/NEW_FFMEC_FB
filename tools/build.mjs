/**
 * Builds the two files Apps Script actually serves:
 *
 *   Bundle.html — React 18 + every view, precompiled from the Part*.html sources
 *                 (no Babel, no cdnjs)
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
const PARTS = ["Icons", "Part1_Data", "Part2_App", "Part3_ViewsA", "Part4_ViewsB", "Part5_Modules"];
const BUNDLE = join(ROOT, "Bundle.html");
const STYLES = join(ROOT, "Styles.html");
const CSS_TMP = join(ROOT, "tools/.styles.tmp.css");
const TAILWIND_CONFIG = join(ROOT, "tools/tailwind.config.cjs");
const TAILWIND_INPUT = join(ROOT, "tools/tailwind.css");

/** React/ReactDOM come from node_modules, so nothing is fetched at runtime. */
const PRELUDE = `import React from 'react';
import ReactDOM from 'react-dom';
import XLSX from 'xlsx';
const { useState, useMemo, useEffect, useRef, useCallback } = React;
window.XLSX = XLSX;
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

  // A literal </script> inside the JS would close the inline tag early.
  const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  writeFileSync(
    BUNDLE,
    `<!-- Built by tools/build.mjs from Icons.html + Part*.html. Do not edit. -->\n<script>\n${js}\n</script>\n`
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
  const [js, css] = await Promise.all([buildScript(), buildStyles()]);
  if (!quiet) {
    console.log(`Bundle.html  ${(js / 1024).toFixed(0)} KB compiled JS`);
    console.log(`Styles.html  ${(css / 1024).toFixed(0)} KB compiled CSS`);
  }
  return { js, css };
}

/** True when any source is newer than the built bundle (or a build is missing). */
export function isStale() {
  if (!existsSync(BUNDLE) || !existsSync(STYLES)) return true;
  const built = Math.min(statSync(BUNDLE).mtimeMs, statSync(STYLES).mtimeMs);
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
