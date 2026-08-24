import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const version = (await readFile("VERSION", "utf8")).trim();
const packageDocument = JSON.parse(await readFile("package.json", "utf8"));
const lockDocument = JSON.parse(await readFile("package-lock.json", "utf8"));
const contractLock = JSON.parse(await readFile("contracts/gowm-v0.4/source-package-lock.json", "utf8"));
const changelog = await readFile("CHANGELOG.md", "utf8");
const status = await readFile("PROJECT_STATUS.md", "utf8");

assert.equal(packageDocument.version, version);
assert.equal(lockDocument.version, version);
assert.equal(lockDocument.packages[""].version, version);
assert.ok(changelog.includes(`## ${version} -`));
assert.equal(contractLock.softwareVersion, "0.4.0");

if (version === "0.5.0") {
  assert.equal(contractLock.softwareVersion, "0.4.0", "the frozen v0.4 contract lock must remain unchanged");
  assert.ok(status.includes("NETWORK_READY"));
  assert.ok(status.includes("ROUTING_READY"));
  assert.ok(status.includes("production-sized SLO"));
} else if (version === "0.4.0") {
  assert.ok(!status.includes("BLOCKED_EXTERNAL"), "stable 0.4.0 is forbidden while Required gates are externally blocked");
} else {
  assert.match(version, /^0\.4\.0-rc\.\d+$/u);
  assert.ok(status.includes("BLOCKED_EXTERNAL"));
  assert.ok(status.includes("stable `0.4.0` withheld"));
}

process.stdout.write(`STABLE_VERSION_GUARD_PASS version=${version} frozenV04=${contractLock.softwareVersion}\n`);
