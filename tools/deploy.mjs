/**
 * Deploy pipeline with a staging gate, a production smoke test and a rollback.
 *
 *   build → clasp push -f → clasp version "deploy <sha>"
 *         → staging deployment ← that version
 *         → browser check on the staging URL (parse + #root render)
 *         → production deployment ← that version
 *         → browser check on the production URL
 *         → on a real render/parse failure: production goes back to the last
 *           good version, and that rollback is verified too
 *
 * Why: `clasp push` and `clasp version` succeed even when the served page cannot
 * parse, and the version that lands on staging is not quite the thing users get —
 * production is a different deployment with its own URL and its own authorization
 * state. So the gate runs on staging first, and the promoted version proves itself
 * on production before the deploy is called done.
 *
 * What a failed production check means (tools/release-rules.mjs decides):
 *   - parse/render failure → the version is at fault, so production rolls back.
 *   - "Authorization required" → Apps Script's per-user permission dialog. The app
 *     was never loaded, the version is not at fault, and a rollback would hide a
 *     real account problem behind a version change. The deploy stops and says who
 *     has to grant what.
 *   - cannot test (no browser, signed out) → promoted but unproven; reported.
 *
 * One-time browser sign-in (the web app is DOMAIN-only):
 *   bun run deploy:login
 *
 * Deployment ids live in deploy.config.json. The staging id is created and
 * recorded on the first run; the production id is never inferred. The same file
 * records productionVersion and lastGoodVersion, so a rollback knows where to go
 * and a fresh checkout can still roll back.
 *
 * Usage:
 *   bun tools/deploy.mjs                 # full gated deploy
 *   bun tools/deploy.mjs --verify        # smoke-test the live production URL only
 *   bun tools/deploy.mjs --rollback      # production ← lastGoodVersion
 *   bun tools/deploy.mjs --rollback --to=49
 *   bun tools/deploy.mjs --login         # open staging in a window for sign-in only
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "./build.mjs";
import {
  VERIFY,
  deploymentOn,
  nextReleaseRecord,
  releaseAction,
  rollbackTarget,
  verifyVerdict
} from "./release-rules.mjs";

const ROOT = join(import.meta.dir, "..");
const CONFIG_FILE = join(ROOT, "deploy.config.json");

const CONFIG_DEFAULTS = {
  domain: "minebea.co.th",
  productionDeploymentId: "",
  stagingDeploymentId: "",
  productionVersion: null,
  lastGoodVersion: null,
  verifyTimeoutMs: 120000
};

function readConfig() {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(`missing ${CONFIG_FILE} (needs productionDeploymentId and stagingDeploymentId)`);
  }
  const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  const config = { ...CONFIG_DEFAULTS, ...parsed };
  if (!config.productionDeploymentId) throw new Error("deploy.config.json has no productionDeploymentId");
  return config;
}

function writeConfig(config) {
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

/** Web app URL for a deployment id, in the domain form the app is served under. */
function deploymentUrl(config, id) {
  const scope = config.domain ? `/a/macros/${config.domain}` : "";
  return `https://script.google.com${scope}/s/${id}/exec`;
}

function run(cmd, args, { quiet = false } = {}) {
  const proc = Bun.spawnSync({ cmd: [cmd, ...args], cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = proc.stdout.toString();
  const err = proc.stderr.toString();
  if (!quiet) process.stdout.write(out);
  if (proc.exitCode !== 0) {
    process.stderr.write(err);
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${proc.exitCode})`);
  }
  return { out, err };
}

const clasp = (args) => run("clasp", args).out;

function gitDescribe() {
  try {
    return run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function verify(url, timeoutMs, { login = false } = {}) {
  const args = ["tools/verify-deployment.mjs", url, `--timeout=${timeoutMs}`];
  if (login) args.push("--login");
  const proc = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit"
  });
  return proc.exitCode ?? VERIFY.UNAVAILABLE;
}

const option = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

/** What production serves right now, according to clasp. */
function liveProduction(config) {
  const row = deploymentOn(clasp(["deployments"]), config.productionDeploymentId);
  return row ? row.version : null;
}

function reportProduction(config, note) {
  const live = liveProduction(config);
  console.log(
    `\n${note}\n` +
      `  production: ${deploymentUrl(config, config.productionDeploymentId)}\n` +
      `  live version: ${live === null ? "unknown" : live} · recorded good: ${
        config.lastGoodVersion === null ? "none yet" : config.lastGoodVersion
      }`
  );
}

async function main() {
  const config = readConfig();
  const loginOnly = process.argv.includes("--login");
  const verifyOnly = process.argv.includes("--verify");
  const rollbackOnly = process.argv.includes("--rollback");
  const productionUrl = deploymentUrl(config, config.productionDeploymentId);

  if (loginOnly) {
    if (!config.stagingDeploymentId) {
      console.error("No staging deployment yet — run `bun run deploy` once to create it, then sign in.");
      return 2;
    }
    return verify(deploymentUrl(config, config.stagingDeploymentId), 300000, { login: true });
  }

  if (verifyOnly) {
    console.log(`Smoke test: production ${productionUrl}`);
    const code = verify(productionUrl, config.verifyTimeoutMs);
    console.log(`\nVerdict: ${verifyVerdict(code)} (exit ${code}). Production was not changed.`);
    return code;
  }

  if (rollbackOnly) {
    const current = liveProduction(config);
    const target = rollbackTarget({
      requested: option("to"),
      lastGood: config.lastGoodVersion,
      current
    });
    if (target.error) {
      console.error(`Rollback refused: ${target.error}`);
      return 1;
    }
    console.log(`\nRolling production back to version ${target.version} (from ${current ?? "unknown"}, ${target.source})`);
    clasp([
      "update-deployment",
      config.productionDeploymentId,
      "-V",
      String(target.version),
      "-d",
      `rollback to ${target.version}`
    ]);
    Object.assign(config, nextReleaseRecord(config, { productionVersion: target.version }));
    writeConfig(config);

    console.log(`\nSmoke test after rollback`);
    const code = verify(productionUrl, config.verifyTimeoutMs);
    const verdict = verifyVerdict(code);
    reportProduction(
      config,
      verdict === "pass"
        ? `Rolled back to version ${target.version}, and that version renders.`
        : `Rolled back to version ${target.version}, but the check came back "${verdict}" — ` +
            (verdict === "authorization"
              ? "an account grant is still outstanding; the rollback itself is not the problem."
              : "inspect the production URL before trying anything else.")
    );
    return verdict === "pass" ? 0 : code;
  }

  if (config.productionDeploymentId === config.stagingDeploymentId) {
    console.error("deploy.config.json points staging and production at the same deployment — fix it before deploying.");
    return 1;
  }

  const sha = gitDescribe();
  const description = `deploy ${sha}`;
  const currentVersion = liveProduction(config);
  const previousVersion = config.lastGoodVersion || currentVersion;

  console.log(`\n1/7  build`);
  await build();

  console.log(`\n2/7  clasp push -f`);
  clasp(["push", "-f"]);

  console.log(`\n3/7  clasp version "${description}"`);
  const versionOutput = clasp(["version", description]);
  const match = versionOutput.match(/version\s+(\d+)/i);
  if (!match) throw new Error(`could not read a version number from clasp output: ${versionOutput.trim().slice(-200)}`);
  const version = Number(match[1]);
  console.log(`     version ${version}`);

  console.log(`\n4/7  staging deployment ← version ${version}`);
  if (!config.stagingDeploymentId) {
    const created = clasp(["deploy", "-V", String(version), "-d", `staging: ${description}`]);
    const id = created.match(/AKfycb[\w-]{20,}/);
    if (!id) throw new Error(`could not read the new staging deployment id from clasp output: ${created.trim().slice(-300)}`);
    config.stagingDeploymentId = id[0];
    writeConfig(config);
    console.log(`     created ${id[0]} — recorded in deploy.config.json (commit it)`);
  } else {
    clasp(["update-deployment", config.stagingDeploymentId, "-V", String(version), "-d", `staging: ${description}`]);
  }
  const stagingUrl = deploymentUrl(config, config.stagingDeploymentId);

  console.log(`\n5/7  browser check on staging`);
  const stagingCode = verify(stagingUrl, config.verifyTimeoutMs);
  if (stagingCode !== VERIFY.PASS) {
    const hint =
      stagingCode === VERIFY.UNAVAILABLE
        ? `\nThe check could not run (browser missing or signed out). Sign in once, then deploy again:\n  bun run deploy:login`
        : stagingCode === VERIFY.AUTHORIZATION
          ? `\nThe staging URL is waiting on a permission grant, not on this version. Open it, press\n  Review permissions → Allow, then deploy again:\n  ${stagingUrl}`
          : "";
    console.error(
      `\nSTOPPED — version ${version} is on staging only; the production deployment was not touched.\n` +
        `  staging: ${stagingUrl}${hint}`
    );
    return 1;
  }

  console.log(`\n6/7  production deployment ← version ${version} (was ${currentVersion ?? "unknown"})`);
  clasp(["update-deployment", config.productionDeploymentId, "-V", String(version), "-d", description]);

  console.log(`\n7/7  browser check on production`);
  const productionCode = verify(productionUrl, config.verifyTimeoutMs);
  const verdict = verifyVerdict(productionCode);
  const action = releaseAction(productionCode);

  if (action === "keep") {
    Object.assign(
      config,
      nextReleaseRecord(config, { productionVersion: version, lastGoodVersion: version })
    );
    writeConfig(config);
    console.log(
      `\nPromoted version ${version} (${description}) and it renders on production.\n` +
        `  production: ${productionUrl}\n` +
        `  staging:    ${stagingUrl}`
    );
    return 0;
  }

  if (action === "rollback") {
    console.error(
      `\nPRODUCTION CHECK FAILED (${verdict}) — version ${version} does not render. Rolling back.`
    );
    const target = rollbackTarget({ lastGood: previousVersion, current: version });
    if (target.error) {
      console.error(
        `Rollback could not run: ${target.error}\n` +
          `Production is still serving the broken version ${version}. Fix it by hand:\n` +
          `  clasp deployments\n  clasp update-deployment ${config.productionDeploymentId} -V <version> -d "rollback"`
      );
      return 1;
    }
    console.log(`  production ← version ${target.version}`);
    clasp([
      "update-deployment",
      config.productionDeploymentId,
      "-V",
      String(target.version),
      "-d",
      `rollback: ${description} failed the production check`
    ]);
    Object.assign(config, nextReleaseRecord(config, { productionVersion: target.version }));
    writeConfig(config);

    console.log(`\nBrowser check after rollback`);
    const afterCode = verify(productionUrl, config.verifyTimeoutMs);
    const afterVerdict = verifyVerdict(afterCode);
    reportProduction(
      config,
      afterVerdict === "pass"
        ? `Rolled back to version ${target.version}, which renders. Version ${version} stays on staging for debugging.`
        : `Rolled back to version ${target.version}, but the check came back "${afterVerdict}". ` +
            `Version ${version} stays on staging; investigate production before the next deploy.`
    );
    return 1;
  }

  // Promoted, but the page could not be proven either way. Never roll back here:
  // an account grant or a missing browser says nothing about the version.
  Object.assign(config, nextReleaseRecord(config, { productionVersion: version }));
  writeConfig(config);
  const why =
    verdict === "authorization"
      ? "Apps Script is showing its per-user permission dialog, so the app was not loaded for the check.\n" +
        "  That is an account grant: open the production URL, press Review permissions → Allow, then run\n" +
        `  \`bun run deploy:verify\`. Version ${version} is live but unproven.\n` +
        `  ${productionUrl}`
      : `The check could not run (${verdict}), so version ${version} is live but unproven.\n` +
        "  Sign the check profile in (`bun run deploy:login`), then run `bun run deploy:verify`.";
  reportProduction(config, `PROMOTED BUT UNVERIFIED — ${why}`);
  return productionCode === VERIFY.AUTHORIZATION ? VERIFY.AUTHORIZATION : VERIFY.UNAVAILABLE;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(`\nDeploy failed: ${err.message}`);
  process.exit(1);
}
