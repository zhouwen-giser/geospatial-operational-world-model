import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const acceptance = JSON.parse(await readFile("reports/gowm-v0.4/final-acceptance.json", "utf8"));
const sync = JSON.parse(await readFile("reports/gowm-v0.4/sync-state.json", "utf8"));
const report = await readFile("reports/gowm-v0.4/final-stable-candidate.md", "utf8");
const version = (await readFile("VERSION", "utf8")).trim();

assert.equal(acceptance.requiredCases, acceptance.passedCases + acceptance.blockedCases + acceptance.failedCases + acceptance.notRunCases);
assert.equal(acceptance.requiredCases, 140);
assert.equal(acceptance.passedCases, 136);
assert.equal(acceptance.blockedCases, 4);
assert.equal(acceptance.failedCases, 0);
assert.equal(acceptance.notRunCases, 0);
assert.deepEqual(acceptance.blocked.map(({ id }) => id), ["AC-C007", "AC-C008", "AC-S019", "AC-S021"]);
assert.equal(sync.status, "BLOCKED_EXTERNAL");
assert.equal(sync.candidateVersion, version);
assert.equal(sync.milestones.groundingReady, true);
assert.equal(sync.milestones.operationalRealityReady, true);
assert.equal(sync.milestones.stableCandidate, false);
assert.ok(report.includes("`GOWM_V0_4_STABLE_CANDIDATE_BLOCKED`"));
assert.ok(!report.includes("`GOWM_V0_4_STABLE_CANDIDATE_COMPLETE`"));

process.stdout.write("STABLE_FINAL_CANDIDATE_BLOCKED cases=140 passed=136 blocked=4 failed=0 notRun=0\n");
