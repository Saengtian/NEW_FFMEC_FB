/**
 * Deploy pipeline with a staging gate.
 *
 *   build → clasp push -f → clasp version "deploy <sha>"
 *         → staging deployment ← that version
 *         → real browser check on the staging URL (parse + #root render)
 *         → production deployment ← that version   (only if the check passed)
 *
 * Why: `clasp push` and `clasp version` succeed even when the served page cannot
 * parse, and the production deployment is live for every planner the moment it
 * moves. The gate makes the version prove itself on a separate deployment id
 * first, in an authenticated browser, so a broken bundle never reaches
 * production. When it fails, the bad version stays on staging for debugging and
 * production keeps serving the last good one — versions are immutable, so a
 * rollback is another `clasp update-deployment <id> -V <older>`.
 *
 * One-time browser sign-in (the web app is DOMAIN-only):
 *   bun run deploy:login
 *
 * Deployment ids live in deploy.config.json. The staging id is created and
 * recorded on the first run; the production id is never inferred.
 *
 * Usage:
 *   bun tools/deploy.mjs            # full gated deploy
 *   bun tools/deploy.mjs --login    # open staging in a window for sign-in only
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "./build.mjs";

const ROOT = join(import.meta.dir, "..");
const CONFIG_FILE = join(ROOT, "deploy.config.json");

const CONFIG_DEFAULTS = {
  domain: "minebea.co.th",
  productionDeploymentId: "",
  stagingDeploymentId: "",
  verifyTimeoutMs: 120000,
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
    stderr: "inherit",
  });
  return proc.exitCode ?? 2;
}

async function main() {
  const config = readConfig();
  const loginOnly = process.argv.includes("--login");

  if (loginOnly) {
    if (!config.stagingDeploymentId) {
      console.error("No staging deployment yet — run `bun run deploy` once to create it, then sign in.");
      return 2;
    }
    return verify(deploymentUrl(config, config.stagingDeploymentId), 300000, { login: true });
  }

  if (config.productionDeploymentId === config.stagingDeploymentId) {
    console.error("deploy.config.json points staging and production at the same deployment — fix it before deploying.");
    return 1;
  }

  const sha = gitDescribe();
  const description = `deploy ${sha}`;

  console.log(`\n1/6  build`);
  await build();

  console.log(`\n2/6  clasp push -f`);
  clasp(["push", "-f"]);

  console.log(`\n3/6  clasp version "${description}"`);
  const versionOutput = clasp(["version", description]);
  const match = versionOutput.match(/version\s+(\d+)/i);
  if (!match) throw new Error(`could not read a version number from clasp output: ${versionOutput.trim().slice(-200)}`);
  const version = Number(match[1]);
  console.log(`     version ${version}`);

  console.log(`\n4/6  staging deployment ← version ${version}`);
  if (!config.stagingDeploymentId) {
    const created = clasp(["deploy", "-V", String(version), "-d", `staging: ${description}`]);
    const id = created.match(/AKfycb[\w-]{20,}/);
    if (!id) throw new Error(`could not read the new staging deployment id from clasp output: ${created.trim().slice(-300)}`);
    config.stagingDeploymentId = id[0];
    writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`     created ${id[0]} — recorded in deploy.config.json (commit it)`);
  } else {
    clasp(["update-deployment", config.stagingDeploymentId, "-V", String(version), "-d", `staging: ${description}`]);
  }
  const stagingUrl = deploymentUrl(config, config.stagingDeploymentId);

  console.log(`\n5/6  browser check on staging`);
  const code = verify(stagingUrl, config.verifyTimeoutMs);
  if (code !== 0) {
    const hint =
      code === 2
        ? `\nThe check could not run (browser missing or signed out). Sign in once, then deploy again:\n  bun run deploy:login`
        : "";
    console.error(
      `\nSTOPPED — version ${version} is on staging only; the production deployment was not touched.\n` +
        `  staging: ${stagingUrl}${hint}`
    );
    return 1;
  }

  console.log(`\n6/6  production deployment ← version ${version}`);
  clasp(["update-deployment", config.productionDeploymentId, "-V", String(version), "-d", description]);

  console.log(
    `\nPromoted version ${version} (${description}).\n` +
      `  production: ${deploymentUrl(config, config.productionDeploymentId)}\n` +
      `  staging:    ${stagingUrl}`
  );
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  console.error(`\nDeploy failed: ${err.message}`);
  process.exit(1);
}
