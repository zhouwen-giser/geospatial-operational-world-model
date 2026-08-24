import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const acceptance = JSON.parse(await readFile("reports/gowm-v0.4/final-acceptance.json", "utf8"));
const sync = JSON.parse(await readFile("reports/gowm-v0.4/sync-state.json", "utf8"));
const report = await readFile("reports/gowm-v0.4/final-stable-candidate.md", "utf8");
const version = (await readFile("VERSION", "utf8")).trim();

assert.equal(acceptance.requiredCases, acceptance.passedCases + acceptance.blockedCases + acceptance.failedCases + acceptance.notRunCases);
assert.equal(acceptance.requiredCases, 140);
assert.equal(acceptance.passedCases, 140);
assert.equal(acceptance.blockedCases, 0);
assert.equal(acceptance.failedCases, 0);
assert.equal(acceptance.notRunCases, 0);
assert.deepEqual(acceptance.blocked, []);
assert.deepEqual(acceptance.policyOverrides.flatMap(({ ids }) => ids), ["AC-C007", "AC-C008", "AC-S019", "AC-S021"]);
assert.ok(acceptance.policyOverrides.every(({ status, runtimeEvidenceClaimed }) => status === "PASS" && runtimeEvidenceClaimed === false));
assert.equal(sync.status, "COMPLETE");
assert.equal(sync.candidateVersion, version);
assert.equal(sync.milestones.groundingReady, true);
assert.equal(sync.milestones.operationalRealityReady, true);
assert.equal(sync.milestones.v02ExactExternalGatesClosed, true);
assert.equal(sync.milestones.v02ExactExternalGatesClosureBasis, "RELEASE_OWNER_POLICY_OVERRIDE");
assert.equal(sync.milestones.stableCandidate, true);
assert.ok(report.includes("`GOWM_V0_4_STABLE_CANDIDATE_COMPLETE`"));
assert.ok(!report.includes("`GOWM_V0_4_STABLE_CANDIDATE_BLOCKED`"));

process.stdout.write("STABLE_FINAL_CANDIDATE_COMPLETE cases=140 passed=140 blocked=0 failed=0 notRun=0\n");
