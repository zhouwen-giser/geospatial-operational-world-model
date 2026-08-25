import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const readText = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");
const readJson = (path) => JSON.parse(readText(path));
const sha256 = (path) =>
  createHash("sha256")
    .update(readFileSync(resolve(repositoryRoot, path)))
    .digest("hex");
const git = (...args) =>
  execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const migrationLock = readJson("reports/gowm-v0.6/predecessor-migration-lock.json");
const contractLock = readJson("reports/gowm-v0.6/predecessor-contract-lock.json");
const baselineLock = readJson(migrationLock.migrations001To032.enumeratedLock);
const predecessorSha = migrationLock.predecessorSha;

assert(git("merge-base", "HEAD", predecessorSha) === predecessorSha, "v0.6 is not descended from the locked v0.5 SHA");
assert(git("show", `${predecessorSha}:VERSION`).trim() === "0.5.0", "locked predecessor VERSION is not 0.5.0");

const predecessorReport = git("show", `${predecessorSha}:reports/gowm-v0.5/final-stable-candidate.md`);
assert(predecessorReport.includes("NETWORK_READY"), "NETWORK_READY predecessor marker is missing");
assert(predecessorReport.includes("ROUTING_READY"), "ROUTING_READY predecessor marker is missing");

let migrationCount = 0;
for (const [file, expected] of Object.entries(baselineLock.migrations)) {
  assert(sha256(`database/migrations/${file}`) === expected, `predecessor migration changed: ${file}`);
  migrationCount += 1;
}
for (const [file, expected] of Object.entries(migrationLock.migrations033To047)) {
  assert(sha256(`database/migrations/${file}`) === expected, `predecessor migration changed: ${file}`);
  migrationCount += 1;
}
assert(migrationCount === migrationLock.migrationCount, `expected 47 locked migrations, found ${migrationCount}`);

let contractCount = 0;
for (const [file, expected] of Object.entries(contractLock.authoritativeRepositoryFiles)) {
  assert(sha256(file) === expected, `predecessor contract changed: ${file}`);
  contractCount += 1;
}

const finalAcceptance = readJson("reports/gowm-v0.5/final-acceptance.json");
assert(finalAcceptance.decision === "PASS", "v0.5 final acceptance is not PASS");
assert(finalAcceptance.requiredCases === 154, "v0.5 Required case count changed");
assert(finalAcceptance.passedCases === 154, "v0.5 does not pass all Required cases");
assert(finalAcceptance.blockedCases === 0, "v0.5 contains a blocked Required gate");
assert(finalAcceptance.failedCases === 0, "v0.5 contains a failed Required gate");
assert(finalAcceptance.notRunCases === 0, "v0.5 contains a Required NOT_RUN gate");

console.log(
  `GOWM_V06_PREDECESSOR_READY sha=${predecessorSha} migrations=${migrationCount} contracts=${contractCount}`,
);
