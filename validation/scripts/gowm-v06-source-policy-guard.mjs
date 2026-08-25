import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const readText = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");
const sourceLock = JSON.parse(readText("reports/gowm-v0.6/source-lock.json"));
const sourcePolicy = readText("docs/supply-chain/GOWM_V0_6_SOURCE_REUSE.md");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(sourceLock.sourceArchive.sha256 === "a8b04ac9a6d6660d3042f4ba9030b0bb0b99b11a8f301a47dbfd12c8796ce116", "reference hash changed");
assert(sourceLock.sourceArchive.licenseStatus === "UNSPECIFIED", "reference license status changed");
assert(sourceLock.sourceArchive.integrationDecision === "REFERENCE_ONLY_SELECTIVE_REIMPLEMENTATION", "unsafe integration decision");
assert(sourceLock.sourceArchive.redistributionAllowed === false, "reference redistribution must remain denied");
assert(Object.keys(sourceLock.referenceReimplementationFiles).length === 22, "selective reference map must contain 22 files");

for (const requiredExclusion of [
  "services/optimizer-sidecar/**",
  "database/**",
  "contracts/**",
  "**/node_modules/**",
  "**/dist/**",
  "coverage/**",
  ".env",
]) {
  assert(sourceLock.excluded.includes(requiredExclusion), `missing exclusion: ${requiredExclusion}`);
}

for (const marker of [
  "NO_SOURCE_COPY",
  "NO_REDISTRIBUTION",
  "V0_5_NETWORK_AUTHORITY",
  "NO_SECOND_GRAPH",
  "NO_PROVIDER_TO_PROVIDER_HTTP",
]) {
  assert(sourceLock.policyMarkers.includes(marker), `missing source-lock marker: ${marker}`);
  assert(sourcePolicy.includes(marker), `missing documented policy marker: ${marker}`);
}

console.log("GOWM_V06_SOURCE_POLICY_READY referenceFiles=22 license=UNSPECIFIED redistribution=false");
