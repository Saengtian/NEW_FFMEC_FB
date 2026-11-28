/**
 * Explains what an Apps Script web app deployment actually serves.
 *
 * The verifier answers "did it render"; when the answer is no, this says why: the
 * top-level page is Apps Script's own shell, and the app lives inside a sandbox
 * iframe (`userCodeAppPanel`) that is usually served from another origin. So this
 * walks every frame and target, and reports for each one:
 *
 *   - the URL and whether it is reachable from the page
 *   - how many bytes of HTML it holds, and whether that HTML contains #root
 *   - its visible text, so a sign-in or "unable to open the file" page is obvious
 *   - any uncaught exception or console error, with its frame
 *
 * Read-only: it never clicks, types or navigates beyond the URL it is given.
 *
 * Usage:
 *   bun tools/diagnose-deployment.mjs <url> [--timeout=45000] [--profile=<dir>]
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const url = argv.find((a) => /^https?:\/\//i.test(a)) || null;
const option = (name, fallback) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
};
const timeoutMs = Number(option("timeout", 45000));
const profile = option("profile", join(ROOT, ".preview/staging-browser"));

if (!url) {
  console.error("usage: bun tools/diagnose-deployment.mjs <url> [--timeout=45000] [--profile=<dir>]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const found = [];
  if (process.env.FFM_BROWSER) found.push(process.env.FFM_BROWSER);
  if (process.platform === "win32") {
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      found.push(join(root, "Google/Chrome/Application/chrome.exe"));
      found.push(join(root, "Microsoft/Edge/Application/msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    found.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  } else {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "microsoft-edge"]) {
      const path = Bun.which(name);
      if (path) found.push(path);
    }
  }
  const browser = found.find((path) => existsSync(path));
  if (!browser) {
    console.error("No Chrome/Edge found. Set FFM_BROWSER to the executable.");
    process.exit(2);
  }
  return browser;
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("could not open the DevTools socket"));
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
    on: (fn) => listeners.add(fn),
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

const PROBE = `(() => {
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  const frames = [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src') || '(no src)');
  return {
    href: location.href,
    host: location.hostname,
    title: document.title,
    ready: document.readyState,
    htmlBytes: html.length,
    hasRoot: /id=["']root["']/.test(html),
    rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
    iframes: frames,
    scripts: [...document.querySelectorAll('script')].map((s) => ({
      type: s.type || 'text/javascript',
      bytes: (s.textContent || '').length,
      src: s.getAttribute('src') || ''
    })),
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    bodyBytes: document.body ? document.body.outerHTML.length : -1,
    bodyHead: document.body ? document.body.outerHTML.slice(0, 500) : '',
    bodyText: document.body ? String(document.body.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400) : '',
    consentMarkers: {
      reviewButton: !!document.querySelector('#review-permissions-button'),
      reviewText: /review permissions|authorization required|grant access/i.test(String(document.body ? document.body.textContent : '')),
      oauthUrl: /createOAuthDialog=true/i.test(location.href)
    },
    tail: html.slice(-300),
    // Same-origin child documents: the served app lives in userHtmlFrame, one
    // level down from the sandbox frame, so the shell alone says nothing.
    nested: (() => {
      const out = [];
      const walk = (doc, path, depth) => {
        if (!doc || depth > 3) return;
        let root = null;
        let text = '';
        try {
          root = doc.getElementById('root');
          text = doc.body ? (doc.body.innerText || '') : '';
        } catch (err) {}
        out.push({
          path,
          bytes: doc.documentElement ? doc.documentElement.outerHTML.length : -1,
          rootChildren: root ? root.children.length : -1,
          hasSplash: !!root && !!root.querySelector('.ffm-splash'),
          text: text.replace(/\\s+/g, ' ').trim().slice(0, 200)
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
      return out;
    })(),
    hasSplash: html.indexOf('ffm-splash') !== -1,
    hasGasConfig: html.indexOf('__FFM_GAS_CONFIG__') !== -1,
    hasBabel: html.indexOf('text/babel') !== -1,
    reactType: typeof window.React,
    configKeys: window.__FFM_GAS_CONFIG__ ? Object.keys(window.__FFM_GAS_CONFIG__) : null
  };
})()`;

async function main() {
  const browser = findBrowser();
  mkdirSync(profile, { recursive: true });
  rmSync(join(profile, "DevToolsActivePort"), { force: true });

  const proc = Bun.spawn({
    cmd: [
      browser,
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-component-update",
      "--window-size=1280,960",
      "--headless=new",
      "--disable-gpu",
      "--mute-audio",
      "about:blank",
    ],
    stdout: "ignore",
    stderr: "pipe",
  });

  let cdp;
  const events = [];
  try {
    const portFile = join(profile, "DevToolsActivePort");
    let port = null;
    const portDeadline = Date.now() + 25000;
    while (Date.now() < portDeadline) {
      if (existsSync(portFile)) {
        port = Number(readFileSync(portFile, "utf8").trim().split(/\r?\n/)[0]);
        if (port) break;
      }
      await sleep(200);
    }
    if (!port) throw new Error("the browser did not open a DevTools port");

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    cdp = connectCdp(version.webSocketDebuggerUrl);
    await cdp.ready;

    const origins = new Map();
    cdp.on((msg) => {
      const sid = msg.sessionId || "page";
      const where = origins.get(sid) || sid;
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails || {};
        const text = d.exception?.description || d.text || "unknown error";
        events.push(`[${where}] EXCEPTION ${text.split("\n").slice(0, 4).join(" ⏎ ")}`);
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
        events.push(`[${where}] console.error ${String(text).slice(0, 200)}`);
      } else if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
        events.push(`[${where}] log.error ${String(msg.params.entry.text).slice(0, 200)}`);
      } else if (msg.method === "Network.loadingFailed") {
        const p = msg.params || {};
        if (!p.errorText || /blocked|cancel/i.test(p.errorText)) {
          events.push(`[${where}] request failed ${p.errorText} ${p.blockedReason || ""}`.trim());
        }
      } else if (msg.method === "Network.responseReceived") {
        const r = msg.params?.response || {};
        if (r.status >= 400) events.push(`[${where}] HTTP ${r.status} ${String(r.url).slice(0, 120)}`);
      }
    });

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    for (const method of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) {
      await cdp.send(method, {}, sessionId);
    }
    origins.set(sessionId, "top");

    await cdp.send("Page.navigate", { url }, sessionId);
    await sleep(timeoutMs);

    const targets = await cdp.send("Target.getTargets");
    const rows = [];
    const sessions = [{ sessionId, label: "top" }];
    for (const t of targets.targetInfos) {
      if (t.type !== "iframe" && t.type !== "page" && t.type !== "other") continue;
      if (t.targetId === targetId) continue;
      try {
        const attached = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        for (const method of ["Runtime.enable", "Log.enable"]) {
          await cdp.send(method, {}, attached.sessionId).catch(() => {});
        }
        origins.set(attached.sessionId, t.url.slice(0, 60) || t.type);
        sessions.push({ sessionId: attached.sessionId, label: t.url });
      } catch (err) {
        rows.push({ label: `${t.type} ${t.url}`, note: `could not attach: ${err.message}` });
      }
    }

    for (const s of sessions) {
      const probe = await cdp
        .send("Runtime.evaluate", { expression: PROBE, returnByValue: true }, s.sessionId)
        .catch((err) => ({ error: err.message }));
      rows.push({ label: s.label, value: probe?.result?.value, error: probe?.error });
    }

    const tree = await cdp.send("Page.getFrameTree", {}, sessionId).catch(() => null);
    const flatten = (node, depth = 0, out = []) => {
      if (!node) return out;
      out.push({ depth, url: node.frame.url, security: node.frame.securityOrigin });
      (node.childFrames || []).forEach((child) => flatten(child, depth + 1, out));
      return out;
    };
    const frames = flatten(tree?.frameTree);

    console.log(`Diagnosing ${url}`);
    console.log(`  browser ${version.Browser}`);
    console.log(`\nFrame tree (${frames.length} frame(s)):`);
    frames.forEach((f) => console.log(`  ${"  ".repeat(f.depth)}${f.url || "(empty)"}  [origin ${f.security || "none"}]`));

    console.log(`\nFrames inspected (${rows.length}):`);
    for (const row of rows) {
      console.log(`\n  ── ${row.label}`);
      if (row.note) {
        console.log(`     ${row.note}`);
        continue;
      }
      if (row.error) {
        console.log(`     probe failed: ${row.error}`);
        continue;
      }
      const v = row.value;
      if (!v) {
        console.log("     no value returned (frame gone or cross-origin and unattached)");
        continue;
      }
      console.log(`     url        ${v.href.slice(0, 120)}`);
      console.log(`     html       ${v.htmlBytes} bytes · #root ${v.hasRoot ? "present" : "MISSING"} · children ${v.rootChildren}`);
      console.log(`     title      ${JSON.stringify(v.title).slice(0, 80)}`);
      console.log(`     scripts    ${v.scripts.length ? v.scripts.map((s) => `${s.type}:${s.bytes}b${s.src ? ` src=${s.src.slice(0, 40)}` : ""}`).join(", ") : "none"}`);
      if (v.iframes.length) console.log(`     iframes    ${v.iframes.map((s) => s.slice(0, 80)).join(", ")}`);
      console.log(`     body       ${v.bodyBytes} bytes · splash ${v.hasSplash} · gas config ${v.hasGasConfig} · text/babel ${v.hasBabel} · React ${v.reactType} · config ${v.configKeys ? v.configKeys.join(",") : "none"}`);
      if (v.bodyHead) console.log(`     body head  ${v.bodyHead.replace(/\s+/g, " ").slice(0, 300)}`);
      if (v.tail) console.log(`     html tail  ${v.tail.replace(/\s+/g, " ").slice(0, 300)}`);
      if (v.bodyText) console.log(`     body text  ${v.bodyText.slice(0, 300)}`);
      if (v.nested && v.nested.length > 1) {
        for (const nested of v.nested.filter((n) => n.path !== "top")) {
          console.log(
            `     in ${nested.path.padEnd(18)} ${nested.bytes} bytes · #root ${nested.rootChildren} child node(s)${
              nested.hasSplash ? " · startup splash" : ""
            }`
          );
          if (nested.text) console.log(`       text     ${nested.text.slice(0, 200)}`);
        }
      }
      const m = v.consentMarkers || {};
      if (m.reviewButton || m.reviewText || m.oauthUrl) {
        console.log(`     consent    review button ${m.reviewButton} · wording ${m.reviewText} · createOAuthDialog ${m.oauthUrl}`);
      }
      if (v.text) console.log(`     text       ${v.text.slice(0, 160)}`);
    }

    console.log(`\nEvents (${events.length}):`);
    if (!events.length) console.log("  none");
    [...new Set(events)].slice(0, 25).forEach((line) => console.log(`  ${line}`));
    return 0;
  } finally {
    cdp?.close();
    try {
      proc.kill();
    } catch {}
  }
}

process.exit(await main());
