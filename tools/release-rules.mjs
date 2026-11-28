/**
 * The rules that decide whether a release may stay on production.
 *
 * Kept apart from tools/deploy.mjs so they can be tested without clasp, Google
 * credentials or a browser: the deploy script is the only place that talks to
 * Apps Script, and everything that could be wrong about a release decision lives
 * here as a pure function.
 *
 * The important distinction is what a failed smoke test means:
 *   - BROKEN (1)    the served page threw or never mounted. That is a fault in the
 *                   version we just promoted, so production goes back.
 *   - AUTHORIZATION (3) Apps Script stopped at its per-user permission dialog, so
 *                   the page was never given the chance to run. Rolling back would
 *                   punish a good version for an account grant; say so and stop.
 *   - UNAVAILABLE (2) no browser, signed out, or an unreachable URL. Nothing was
 *                   proven either way, so neither promote nor roll back silently.
 */

/** Exit codes tools/verify-deployment.mjs is allowed to return. */
export const VERIFY = {
  PASS: 0,
  BROKEN: 1,
  UNAVAILABLE: 2,
  AUTHORIZATION: 3
};

/** What a verifier exit code means, in one word. */
export function verifyVerdict(code) {
  const value = Number(code);
  if (value === VERIFY.PASS) return 'pass';
  if (value === VERIFY.BROKEN) return 'broken';
  if (value === VERIFY.AUTHORIZATION) return 'authorization';
  return 'unavailable';
}

/**
 * What to do with a version that is already on production: `keep` it, roll it
 * back, or leave it in place but unproven (the account-grant and cannot-test
 * cases). Only `broken` earns an automatic rollback.
 */
export function releaseAction(productionCode) {
  const verdict = verifyVerdict(productionCode);
  if (verdict === 'pass') return 'keep';
  if (verdict === 'broken') return 'rollback';
  return 'unverified';
}

/**
 * Deployment rows from `clasp deployments`, e.g.
 *   - AKfycbwjPK3JuBCippJmn5z00Q7P7UeBauRapbgZfzU9f32JjalRTpgRMiTkqZAB8qYXxHvN @51 - staging: deploy 9ad4dbd
 *   - AKfycby9n40bpM_t1OYHE2wiAMXSgpG2AZivhkcHXNDmjCg @HEAD
 * The HEAD deployment has no version number: `null`, never 0, so a caller cannot
 * mistake it for version zero and try to promote it.
 */
export function deploymentsFrom(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/(AKfyc[\w-]{20,})\s+@(\d+|HEAD)\b(?:\s*-\s*(.*))?/);
      if (!match) return null;
      return {
        id: match[1],
        version: match[2].toUpperCase() === 'HEAD' ? null : Number(match[2]),
        description: String(match[3] || '').trim()
      };
    })
    .filter(Boolean);
}

/** The version a deployment currently serves, or null when it is not listed. */
export function deploymentVersionOn(output, deploymentId) {
  const wanted = String(deploymentId || '').trim();
  if (!wanted) return null;
  const row = deploymentsFrom(output).find((entry) => entry.id === wanted);
  return row ? row.version : null;
}

/** The version a deployment row describes, for the "what is live" report. */
export function deploymentOn(output, deploymentId) {
  const wanted = String(deploymentId || '').trim();
  return deploymentsFrom(output).find((entry) => entry.id === wanted) || null;
}

/**
 * Which version a rollback should move production to: the one asked for, else the
 * last version that passed a smoke test. A rollback that would land on the
 * version already live, or that cannot name any version, is refused with the
 * reason rather than quietly doing nothing.
 */
export function rollbackTarget(input) {
  const options = input || {};
  const current = options.current === null || options.current === undefined ? null : Number(options.current);
  const rawRequested = options.requested;
  const hasRequested = rawRequested !== null && rawRequested !== undefined && rawRequested !== '';
  const requested = hasRequested ? Number(rawRequested) : null;
  const lastGood = Number(options.lastGood) || null;
  // A malformed --to is an operator mistake, not a reason to silently roll back
  // to some other version.
  if (hasRequested && (!Number.isInteger(requested) || requested <= 0)) {
    return { error: `--to must be a positive version number, got "${rawRequested}"` };
  }
  const version = requested || lastGood;

  if (!version) {
    return {
      error:
        'no version to roll back to: pass --to=<version> (see `clasp versions`), or pass --to after a deploy has recorded lastGoodVersion in deploy.config.json'
    };
  }
  if (current !== null && version === current) {
    return { error: `production is already on version ${current}` };
  }
  return { version, source: requested ? 'requested' : 'lastGoodVersion' };
}

/**
 * The release record kept in deploy.config.json. Only versions write here, so a
 * deploy that stopped before promotion leaves the previous record untouched.
 */
export function nextReleaseRecord(config, update) {
  const base = config || {};
  const change = update || {};
  const record = {
    productionVersion:
      change.productionVersion === undefined ? base.productionVersion ?? null : change.productionVersion,
    lastGoodVersion: change.lastGoodVersion === undefined ? base.lastGoodVersion ?? null : change.lastGoodVersion
  };
  return record;
}
