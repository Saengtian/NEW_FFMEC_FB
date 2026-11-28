/**
 * Checks for the release rules behind tools/deploy.mjs:
 *
 *  - `clasp deployments` output is read into id/version/description rows, and the
 *    HEAD deployment reads as "no version" rather than version 0
 *  - the live production version is read by deployment id, and an unknown or empty
 *    id returns null instead of guessing
 *  - a render/parse failure rolls production back; a permission dialog or an
 *    untestable page never does, because neither says anything about the version
 *  - a rollback needs a real target: --to wins, lastGoodVersion is the fallback,
 *    and a missing or malformed target is refused with the reason
 *  - the release record in deploy.config.json only changes the keys it is given
 *
 * Run: bun tools/test-release-rules.mjs
 */

import assert from "node:assert/strict";
import {
  VERIFY,
  deploymentsFrom,
  deploymentOn,
  deploymentVersionOn,
  nextReleaseRecord,
  releaseAction,
  rollbackTarget,
  verifyVerdict
} from "./release-rules.mjs";

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true });
  } catch (error) {
    results.push({ label, ok: false, message: error.message });
  }
}
const equal = (actual, expected) => assert.strictEqual(actual, expected);
const deep = (actual, expected) => assert.deepStrictEqual(actual, expected);

// The real shape of `clasp deployments` on this project.
const DEPLOYMENTS = `Found 6 deployments.
- AKfycby9n40bpM_t1OYHE2wiAMXSgpG2AZivhkcHXNDmjCg @HEAD 
- AKfycbwjPK3JuBCippJmn5z00Q7P7UeBauRapbgZfzU9f32JjalRTpgRMiTkqZAB8qYXxHvN @51 - staging: deploy 9ad4dbd
- AKfycbzuU7qusdy61gZK8mDUorc-xS0R3-DWtxiNmNH6LYS4EyURHEboOtqEI3ifsaTI2hMC @4 - AAA
- AKfycbz6y_8byEXlOxSWq6y5_azvp129b7CmlIfqhuNGA2BX-LrKTHVnmQdgHwylvx7yFE4C @49 - deploy 72da2ca
- AKfycbxzVScxIQOgQjmjxf2P3mBNMMOW2_dRubj3Lg-6fN_VgIl_QF4-NiOF44gLGfXPXdj9 @9 - BBB`;

const PROD = "AKfycbz6y_8byEXlOxSWq6y5_azvp129b7CmlIfqhuNGA2BX-LrKTHVnmQdgHwylvx7yFE4C";
const STAGE = "AKfycbwjPK3JuBCippJmn5z00Q7P7UeBauRapbgZfzU9f32JjalRTpgRMiTkqZAB8qYXxHvN";

check("clasp deployments output is read into id, version and description", () => {
  const rows = deploymentsFrom(DEPLOYMENTS);
  equal(rows.length, 5, "the 'Found 6 deployments.' header is not a row");
  equal(rows[0].id, "AKfycby9n40bpM_t1OYHE2wiAMXSgpG2AZivhkcHXNDmjCg");
  equal(rows[1].version, 51);
  assert.match(rows[1].description, /staging: deploy 9ad4dbd/);
  equal(rows[3].version, 49);
});

check("the HEAD deployment has no version, not version zero", () => {
  const head = deploymentsFrom(DEPLOYMENTS)[0];
  equal(head.version, null);
  assert.notEqual(head.version, 0);
});

check("the live version is read by deployment id", () => {
  equal(deploymentVersionOn(DEPLOYMENTS, PROD), 49);
  equal(deploymentVersionOn(DEPLOYMENTS, STAGE), 51);
  equal(deploymentOn(DEPLOYMENTS, PROD).description, "deploy 72da2ca");
});

check("an unknown or empty deployment id returns nothing", () => {
  equal(deploymentVersionOn(DEPLOYMENTS, "AKfycbnotarealdeploymentid000000000000"), null);
  equal(deploymentVersionOn(DEPLOYMENTS, ""), null);
  equal(deploymentVersionOn(DEPLOYMENTS, null), null);
  equal(deploymentOn(DEPLOYMENTS, "nope"), null);
  deep(deploymentsFrom("")[0] || null, null);
});

check("verifier exit codes map to one verdict each", () => {
  equal(verifyVerdict(VERIFY.PASS), "pass");
  equal(verifyVerdict(VERIFY.BROKEN), "broken");
  equal(verifyVerdict(VERIFY.AUTHORIZATION), "authorization");
  equal(verifyVerdict(VERIFY.UNAVAILABLE), "unavailable");
  equal(verifyVerdict(99), "unavailable", "an unexpected code cannot read as success");
  equal(verifyVerdict(undefined), "unavailable");
});

check("only a real render failure rolls production back", () => {
  equal(releaseAction(VERIFY.PASS), "keep");
  equal(releaseAction(VERIFY.BROKEN), "rollback");
  equal(releaseAction(VERIFY.AUTHORIZATION), "unverified", "a permission dialog is not the version's fault");
  equal(releaseAction(VERIFY.UNAVAILABLE), "unverified", "a check that could not run proves nothing");
  equal(releaseAction(99), "unverified");
});

check("a rollback goes to the version asked for", () => {
  deep(rollbackTarget({ requested: "46", lastGood: 49, current: 52 }), {
    version: 46,
    source: "requested"
  });
});

check("without --to a rollback uses the last good version", () => {
  deep(rollbackTarget({ requested: null, lastGood: 49, current: 52 }), {
    version: 49,
    source: "lastGoodVersion"
  });
});

check("a rollback with no target, or onto the live version, is refused", () => {
  assert.match(rollbackTarget({ current: 52 }).error, /--to/);
  assert.match(rollbackTarget({ lastGood: null, current: 52 }).error, /clasp versions/);
  assert.match(rollbackTarget({ requested: "52", current: 52 }).error, /already on version 52/);
  assert.match(rollbackTarget({ lastGood: 52, current: 52 }).error, /already on version 52/);
});

check("a malformed --to is refused instead of falling back to another version", () => {
  assert.match(rollbackTarget({ requested: "abc", lastGood: 49, current: 52 }).error, /positive version/);
  assert.match(rollbackTarget({ requested: "-3", lastGood: 49, current: 52 }).error, /positive version/);
  assert.match(rollbackTarget({ requested: "0", lastGood: 49, current: 52 }).error, /positive version/);
});

check("a rollback with an unknown live version still works", () => {
  deep(rollbackTarget({ requested: null, lastGood: 49, current: null }), {
    version: 49,
    source: "lastGoodVersion"
  });
});

check("the release record only changes the keys it is given", () => {
  const config = {
    domain: "minebea.co.th",
    productionDeploymentId: PROD,
    productionVersion: 49,
    lastGoodVersion: 48
  };
  deep(nextReleaseRecord(config, { productionVersion: 52, lastGoodVersion: 52 }), {
    productionVersion: 52,
    lastGoodVersion: 52
  });
  deep(nextReleaseRecord(config, { productionVersion: 49 }), {
    productionVersion: 49,
    lastGoodVersion: 48
  });
  deep(nextReleaseRecord({}, {}), { productionVersion: null, lastGoodVersion: null });
  // The record is a fragment: the caller merges it into the config it already has,
  // so ids and timeouts survive a deploy.
  const merged = { ...config, ...nextReleaseRecord(config, { productionVersion: 52 }) };
  equal(merged.productionDeploymentId, PROD);
  equal(merged.lastGoodVersion, 48, "a promote does not claim an unverified version is good");
});

const passed = results.filter((entry) => entry.ok).length;
results.forEach((entry) => {
  if (entry.ok) {
    console.log(`  pass  ${entry.label}`);
  } else {
    console.log(`  FAIL  ${entry.label}  (${entry.message})`);
  }
});
console.log("");
console.log(`${passed}/${results.length} release-rule checks passed.`);
if (passed !== results.length) process.exit(1);
