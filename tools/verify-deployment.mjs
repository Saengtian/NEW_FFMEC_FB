/**
 * Loads a deployment URL in a real Chromium browser and fails unless the served
 * page parses and React actually mounts.
 *
 * Why a browser: Apps Script returns HTTP 200 with the splash still on screen
 * when the bundle has been mangled by its HTML pipeline (a raw `http://`, a
 * literal `<?`, `//` inside a template literal, an unescaped `</script`). A
 * fetch/curl check cannot tell that apart from a working deploy, and neither can
 * `clasp push` succeeding. Only a browser that runs the script can.
 *
 * Authentication: the web app is DOMAIN-only and executeAs USER_ACCESSING, so an
 * anonymous browser lands on Google's sign-in page. That case fails closed (exit
 * 2) instead of counting as a pass. Run once with --login: a visible window opens
 * on a dedicated profile (.preview/staging-browser, gitignored) and the sign-in
 * persists, so every later run is authenticated automatically.
 *
 * No dependencies: it drives the installed Chrome/Edge over the DevTools
 * protocol with Bun's built-in WebSocket.
 *
 * Usage:
 *   bun tools/verify-deployment.mjs <url> [--timeout=120000] [--login]
 *
 * Exit codes: 0 rendered · 1 broken (parse or render) · 2 not signed in / no browser
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DEFAULT_PROFILE = join(ROOT, ".preview/staging-browser");

const PARSE_ERROR =
  /SyntaxError|Invalid or unexpected token|Unexpected end of input|Unexpected token|Unterminated (string|template)|missing \) after argument list/i;

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);

function option(name, fallback = null) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
}

const url = argv.find((a) => /^https?:\/\//i.test(a)) || null;
const login = argv.includes("--login");
const timeoutMs = Number(option("timeout", login ? 300000 : 120000));
const profile = option("profile", DEFAULT_PROFILE);

if (!url) {
  console.error("usage: bun tools/verify-deployment.mjs <url> [--timeout=120000] [--login]");
  process.exit(2);
}

// ------------------------------------------------------------------ browser

function browserCandidates() {
  const found = [];
  if (process.env.FFM_BROWSER) found.push(process.env.FFM_BROWSER);

  if (process.platform === "win32") {
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA];
    for (const root of roots.filter(Boolean)) {
      found.push(join(root, "Google/Chrome/Application/chrome.exe"));
      found.push(join(root, "Microsoft/Edge/Application/msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    found.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
      const path = Bun.which(name);
      if (path) found.push(path);
    }
  }
  return [...new Set(found)];
}

function findBrowser() {
  const browser = browserCandidates().find((path) => existsSync(path));
  if (!browser) {
    console.error(
      "No Chrome/Edge found. Install one, or point FFM_BROWSER at the executable:\n" +
        `  FFM_BROWSER="C:/path/to/chrome.exe" bun tools/verify-deployment.mjs ${url}`
    );
    process.exit(2);
  }
  return browser;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chrome writes <port>\n<ws path> to DevToolsActivePort once it is listening. */
async function waitForDevTools(userDir, proc) {
  const file = join(userDir, "DevToolsActivePort");
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const [port] = readFileSync(file, "utf8").trim().split(/\r?\n/);
      if (port) return Number(port);
    }
    if (proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`the browser exited before it was ready (exit ${proc.exitCode}): ${stderr.trim().slice(-300)}`);
    }
    await sleep(200);
  }
  throw new Error(`the browser did not open a DevTools port within 25s (profile: ${userDir})`);
}

// --------------------------------------------------------------------- CDP

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;

  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("could not open the browser's DevTools socket"));
  });

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    for (const listener of listeners) listener(msg);
  };

  return {
    ready,
    on(fn) {
      listeners.add(fn);
    },
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`${method} timed out`));
        }, 20000);
      });
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

// Evaluated inside every frame: what the deployed page actually did.
const PROBE = `(() => {
  const root = document.getElementById('root');
  const body = document.body ? (document.body.innerText || '') : '';
  return {
    href: location.href,
    host: location.hostname,
    title: document.title,
    ready: document.readyState,
    rootChildren: root ? root.children.length : -1,
    splash: !!(root && root.querySelector('.ffm-splash')),
    startupError: body.indexOf('FFM NPI Ops Startup Error') !== -1,
    text: body.replace(/\\s+/g, ' ').trim().slice(0, 240)
  };
})()`;

// ------------------------------------------------------------ page verdicts

const AUTH_TEXT = /Sign in|Choose an account|to continue to|with your Google Account|Single sign-on/i;
const AUTH_HOST = /^(accounts\.google\.com|accounts\.youtube\.com|workspace\.google\.com)$/i;
const DENIED_TEXT = /Sorry, unable to open the file|You need access|Need permission|Request access|Authorization is required|Script function not found|The script completed but did not return anything/i;

const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function main() {
  const browser = findBrowser();
  mkdirSync(profile, { recursive: true });
  // A stale file from a killed run would point at a port nobody is listening on.
  rmSync(join(profile, "DevToolsActivePort"), { force: true });

  const args = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-background-networking",
    "--window-size=1280,960",
    login ? "--start-maximized" : "--headless=new",
  ];
  if (!login) args.push("--disable-gpu", "--mute-audio");

  const proc = Bun.spawn({
    cmd: [browser, ...args, "about:blank"],
    stdout: "ignore",
    stderr: "pipe",
  });

  const started = Date.now();
  let cdp;
  const exceptions = [];
  const consoleErrors = [];
  const sessions = new Set();
  let pageSession = null;

  try {
    const port = await waitForDevTools(profile, proc);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    cdp = connectCdp(version.webSocketDebuggerUrl);
    await cdp.ready;

    cdp.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails || {};
        const text = d.exception?.description || d.text || "unknown error";
        exceptions.push(text.split("\n").slice(0, 3).join("\n"));
      } else if (msg.method === "Log.entryAdded") {
        const entry = msg.params?.entry || {};
        if (entry.level === "error") consoleErrors.push(String(entry.text).slice(0, 200));
      } else if (msg.method === "Target.attachedToTarget") {
        const { sessionId } = msg.params;
        sessions.add(sessionId);
        for (const method of ["Runtime.enable", "Log.enable", "Page.enable"]) {
          cdp.send(method, {}, sessionId).catch(() => {});
        }
      }
    });

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    ({ sessionId: pageSession } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));

    for (const method of ["Page.enable", "Runtime.enable", "Log.enable"]) {
      await cdp.send(method, {}, pageSession);
    }
    // Same-origin frames are covered by the page session; this catches the
    // out-of-process iframe Apps Script can wrap the app in.
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSession).catch(() => {});

    await cdp.send("Page.navigate", { url }, pageSession);

    const deadline = Date.now() + timeoutMs;
    let rendered = null;
    let mainState = null;
    let signedOut = false;
    let denied = null;
    let lastNote = 0;

    while (Date.now() < deadline) {
      const states = [];
      const targets = [pageSession, ...sessions];
      for (const sessionId of targets) {
        const probe = await cdp
          .send("Runtime.evaluate", { expression: PROBE, returnByValue: true }, sessionId)
          .catch(() => null);
        const value = probe?.result?.value;
        if (value) states.push({ ...value, sessionId });
      }

      const main = states.find((s) => s.sessionId === pageSession) || states[0] || null;
      if (main) mainState = main;
      const all = states.length ? states : main ? [main] : [];

      if (all.some((s) => AUTH_HOST.test(s.host || "")) || (main && AUTH_TEXT.test(main.text || "") && !main.rootChildren)) {
        signedOut = true;
        break;
      }
      denied = all.find((s) => DENIED_TEXT.test(s.text || "")) || denied;
      if (denied) break;

      const ok = all.find((s) => s.rootChildren > 0 && !s.splash && !s.startupError);
      if (ok) {
        rendered = ok;
        break;
      }
      // A bundle that cannot parse will never mount, so stop waiting for it.
      if (exceptions.some((text) => PARSE_ERROR.test(text))) break;
      const crash = all.find((s) => s.startupError);
      if (crash) {
        rendered = null;
        break;
      }

      if (login && Date.now() - lastNote > 15000) {
        lastNote = Date.now();
        console.log("  … waiting for sign-in: complete it in the window that just opened");
      }
      await sleep(500);
    }

    const elapsed = Date.now() - started;
    const parseFailures = exceptions.filter((text) => PARSE_ERROR.test(text));

    const report = [
      `Staging check: ${url}`,
      `  browser     ${version.Browser || "Chromium"} (${login ? "window" : "headless"}, profile ${profile.replace(ROOT, ".")})`,
      `  page        ${mainState ? JSON.stringify(mainState.title || "").slice(0, 80) : "not loaded"}`,
      `  #root       ${
        rendered
          ? `rendered — ${rendered.rootChildren} child node(s), splash replaced`
          : mainState
            ? `${
                mainState.rootChildren < 0
                  ? "no #root element"
                  : `${mainState.rootChildren} child node(s)${mainState.splash ? ", still the startup splash" : ""}${mainState.startupError ? ", startup error overlay" : ""}`
              }`
            : "never inspected"
      }`,
      `  console     ${consoleErrors.length} error(s)`,
      `  elapsed     ${fmt(elapsed)}`,
    ];

    if (parseFailures.length) {
      report.push("", "Uncaught parse/script error(s):");
      for (const text of [...new Set(parseFailures)].slice(0, 3)) report.push(`  ${text.replace(/\n/g, "\n  ")}`);
    } else if (exceptions.length) {
      report.push("", `Other uncaught error(s) (not fatal to parse/render): ${exceptions.length}`);
    }
    if (consoleErrors.length) {
      for (const text of [...new Set(consoleErrors)].slice(0, 3)) report.push(`  console: ${text}`);
    }
    if (mainState?.text) report.push("", `Visible text: ${mainState.text.slice(0, 160)}`);

    console.log(report.join("\n"));

    if (signedOut) {
      console.log(
        "\nFAIL (not authenticated) — the browser is signed out, so this page could not be tested.\n" +
          "Sign in once on the dedicated profile, then run the check again:\n" +
          `  bun tools/verify-deployment.mjs ${url} --login`
      );
      return 2;
    }
    if (denied) {
      console.log(`\nFAIL (blocked page) — Apps Script answered with: ${denied.text.slice(0, 160)}`);
      return 1;
    }
    if (parseFailures.length) {
      console.log("\nFAIL (parse) — the served page threw a script error, so the bundle did not parse.");
      return 1;
    }
    if (!rendered) {
      console.log(
        "\nFAIL (render) — #root never replaced the startup splash, so the app did not mount" +
          `${mainState?.startupError ? " (the page showed its startup error card)" : ""}.`
      );
      return 1;
    }
    console.log("\nPASS — the served page parses and #root rendered.");
    return 0;
  } catch (err) {
    console.error(`\nFAIL (infrastructure) — ${err.message}`);
    return 2;
  } finally {
    cdp?.close();
    try {
      proc.kill();
    } catch {}
  }
}

process.exit(await main());
