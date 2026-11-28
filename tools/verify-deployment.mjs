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
 * Frames: the deployment URL is only Apps Script's shell. It embeds the app in a
 * cross-origin sandbox frame (`userCodeAppPanel`), which embeds the served HTML in
 * a same-origin `userHtmlFrame` — so `#root` is never in the top document. The
 * shell also always ships the permission dialog's markup (a hidden
 * `#review-permissions-button`) and always names its frame
 * `?createOAuthDialog=true`, whether or not a grant is outstanding. The probe
 * therefore walks every reachable document and reads the app where it actually
 * lives; a permission block is reported only when that dialog occupies real
 * geometry and nothing rendered.
 *
 * Authorization: with `executeAs: USER_ACCESSING` every account must allow the
 * script's scopes once. While a grant really is outstanding, the app is not loaded
 * behind a visible "Review permissions" dialog. That is an account grant, not a
 * code fault, so it is reported as its own exit code and must not trigger a rollback.
 *
 * Exit codes: 0 rendered · 1 broken (parse or render) · 2 not signed in / no browser
 *             · 3 permission dialog served (authorization required)
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

// Evaluated inside every frame: what every reachable document actually did.
const PROBE = `(() => {
  const docs = [];
  const seen = new Set();
  const walk = (doc, path, depth) => {
    if (!doc || depth > 3 || seen.has(doc)) return;
    seen.add(doc);
    let root = null;
    let body = '';
    let href = '';
    let host = '';
    try {
      root = doc.getElementById('root');
      body = doc.body ? (doc.body.innerText || '') : '';
      href = doc.location ? doc.location.href : '';
      host = doc.location ? doc.location.hostname : '';
    } catch (err) {}
    // Only a dialog with real geometry is on screen: Apps Script's shell ships this
    // markup hidden on every load, authorized or not, and its frame URL always
    // says createOAuthDialog=true.
    let consent = false;
    try {
      const el = doc.getElementById('review-permissions-button') || doc.getElementById('oauth-dialog');
      if (el) {
        const rect = el.getBoundingClientRect();
        consent = rect.width > 0 && rect.height > 0;
      }
    } catch (err) {}
    docs.push({
      path: path,
      href: href,
      host: host,
      rootChildren: root ? root.children.length : -1,
      splash: !!(root && root.querySelector('.ffm-splash')),
      startupError: body.indexOf('FFM NPI Ops Startup Error') !== -1,
      consent: consent,
      text: body.replace(/\\s+/g, ' ').trim().slice(0, 240)
    });
    let frames = [];
    try {
      frames = [...doc.querySelectorAll('iframe')];
    } catch (err) {}
    frames.forEach((frame, index) => {
      let child = null;
      try {
        child = frame.contentDocument;
      } catch (err) {}
      if (child) walk(child, path + '/iframe[' + index + ']', depth + 1);
    });
  };
  walk(document, 'top', 0);
  return {
    href: location.href,
    host: location.hostname,
    title: document.title,
    docs: docs
  };
})()`;

// ------------------------------------------------------------ page verdicts

const AUTH_TEXT = /Sign in|Choose an account|to continue to|with your Google Account|Single sign-on/i;
const AUTH_HOST = /^(accounts\.google\.com|accounts\.youtube\.com|workspace\.google\.com)$/i;
const DENIED_TEXT = /Sorry, unable to open the file|You need access|Need permission|Request access|Authorization is required|Script function not found|The script completed but did not return anything/i;

const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** "top: 0 child node(s), startup splash" — one document's render state. */
const describeDoc = (doc) =>
  `${doc.path}: ${
    doc.rootChildren < 0
      ? "no #root"
      : `${doc.rootChildren} child node(s)${doc.splash ? ", startup splash" : ""}${
          doc.startupError ? ", startup error overlay" : ""
        }`
  }`;

async function main() {
  const browser = findBrowser();
  mkdirSync(profile, { recursive: true });
  // A stale file from a killed run would point at a port nobody is listening on.
  // Windows reports EBUSY while the previous browser is still letting go of the
  // profile — the staging and production checks run back to back on this profile.
  const stalePort = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      rmSync(stalePort, { force: true });
      break;
    } catch {
      await sleep(200);
    }
  }

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
        const summary = text.split("\n").slice(0, 3).join("\n");
        const location = d.url
          ? ` (${d.url}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1})`
          : "";
        exceptions.push(`${summary}${location}`);
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

    // Apps Script runs the app in a sandbox iframe on another origin, which Chrome
    // keeps as a separate target. Auto-attach does not reliably reach it, and from
    // the page session alone a blank page and a working app look identical — so
    // every new frame target is attached and probed explicitly.
    const attachedTargets = new Set([targetId]);
    const attachChildFrames = async () => {
      const targets = await cdp.send("Target.getTargets").catch(() => null);
      if (!targets) return;
      for (const target of targets.targetInfos) {
        if (attachedTargets.has(target.targetId)) continue;
        if (target.type !== "iframe" && target.type !== "other") continue;
        attachedTargets.add(target.targetId);
        try {
          const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
          sessions.add(attached.sessionId);
          for (const method of ["Runtime.enable", "Log.enable", "Page.enable"]) {
            cdp.send(method, {}, attached.sessionId).catch(() => {});
          }
        } catch {
          // A frame that vanishes mid-attach is simply not probed.
        }
      }
    };
    await attachChildFrames();

    const deadline = Date.now() + timeoutMs;
    let rendered = null;
    let mainState = null;
    let signedOut = false;
    let denied = null;
    let consentState = null;
    let lastNote = 0;
    let sweep = 0;
    let lastDocs = [];

    while (Date.now() < deadline) {
      if (sweep++ % 4 === 0) await attachChildFrames();
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
      // Every reachable document, flattened: the shell, the sandbox frame, and the
      // same-origin userHtmlFrame that holds the served app.
      const docs = [];
      for (const state of all) for (const doc of state.docs || []) docs.push(doc);
      if (docs.length) lastDocs = docs;

      // The app may run one document down from the shell, so a document that
      // rendered settles the check before anything else in the same sweep.
      const appDoc = docs.find((d) => d.rootChildren > 0 && !d.splash && !d.startupError);
      if (appDoc) {
        rendered = appDoc;
        break;
      }

      // The permission dialog is terminal, but only when it is actually on screen
      // and the app is not: the shell ships that markup hidden either way.
      consentState = docs.find((d) => d.consent) || consentState;
      if (consentState) break;

      const signedOutNow =
        docs.some((d) => AUTH_HOST.test(d.host || "")) ||
        (main && AUTH_TEXT.test(main.text || "") && !docs.some((d) => d.rootChildren > 0));
      if (signedOutNow) {
        signedOut = true;
        // In login mode the visible window is waiting for the user, so keep
        // polling instead of closing it the moment Google's sign-in page loads.
        if (!login) break;
      } else {
        signedOut = false;
      }
      denied = docs.find((d) => DENIED_TEXT.test(d.text || "")) || denied;
      if (denied) break;

      // A bundle that cannot parse will never mount, so stop waiting for it.
      if (exceptions.some((text) => PARSE_ERROR.test(text))) break;
      const crash = docs.find((d) => d.startupError);
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
      `Deployment check: ${url}`,
      `  browser     ${version.Browser || "Chromium"} (${login ? "window" : "headless"}, profile ${profile.replace(ROOT, ".")})`,
      `  page        ${mainState ? JSON.stringify(mainState.title || "").slice(0, 80) : "not loaded"}`,
      `  #root       ${
        rendered
          ? `rendered — ${rendered.rootChildren} child node(s) in ${rendered.path}, splash replaced`
          : lastDocs.length
            ? lastDocs.map(describeDoc).join(" · ")
            : "never inspected"
      }`,
      `  frames      ${sessions.size + 1} inspected (page + attached frames), ${lastDocs.length} document(s) probed`,
      consentState ? "  consent     a visible permission dialog is holding the app frame" : null,
      `  console     ${consoleErrors.length} error(s)`,
      `  elapsed     ${fmt(elapsed)}`,
    ].filter(Boolean);

    if (parseFailures.length) {
      report.push("", "Uncaught parse/script error(s):");
      for (const text of [...new Set(parseFailures)].slice(0, 3)) report.push(`  ${text.replace(/\n/g, "\n  ")}`);
    } else if (exceptions.length) {
      report.push("", `Other uncaught error(s) (not fatal to parse/render): ${exceptions.length}`);
    }
    if (consoleErrors.length) {
      for (const text of [...new Set(consoleErrors)].slice(0, 3)) report.push(`  console: ${text}`);
    }
    const visibleText = (rendered || lastDocs[0])?.text;
    if (visibleText) report.push("", `Visible text: ${visibleText.slice(0, 160)}`);

    console.log(report.join("\n"));

    if (consentState) {
      console.log(
        "\nBLOCKED (authorization) — Apps Script served its permission dialog inside the sandbox frame, " +
          "so the app was never loaded and this version was not tested.\n" +
          "  This is a per-user account grant, not a code fault: with executeAs USER_ACCESSING every\n" +
          "  account must allow the script's scopes once before the app is served to it.\n" +
          "  Fix: open the URL below in a signed-in browser, press Review permissions → Allow, then re-run.\n" +
          `    ${url}\n` +
          "  Or sign the dedicated check profile in first:\n" +
          `    bun tools/verify-deployment.mjs ${url} --login`
      );
      return 3;
    }
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
      // Wait for the browser to release the profile before the next check opens it.
      await Promise.race([proc.exited, sleep(5000)]);
    } catch {}
  }
}

process.exit(await main());
