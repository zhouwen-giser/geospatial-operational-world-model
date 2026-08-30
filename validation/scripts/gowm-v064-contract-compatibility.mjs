import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baselineCommit = "17dd221330d9af540ec815a39eca96550690299a";
const expectedMigration062 = "sha256:7b8a606e3258baa2f3e68c88e81abacb289615cf960a1af20c8a9f4c2074539c";
const reportPath = resolve(root, "reports/gowm-v0.6.4/contract-compatibility-evidence.json");
const summaryPath = resolve(root, "reports/gowm-v0.6.4/contract-compatibility-report.json");
const write = process.argv.includes("--write");

assertAncestor(baselineCommit);
const baselineVersion = gitText(["show", `${baselineCommit}:VERSION`]).trim();
const targetVersion = (await readFile(resolve(root, "VERSION"), "utf8")).trim();
const rootPackage = await readJson("package.json");
const rootLock = await readJson("package-lock.json");
const consumerPackage = await readJson("packages/platform/world-gateway-contracts/package.json");
if (baselineVersion !== "0.6.3" || targetVersion !== "0.6.4" || rootPackage.version !== targetVersion ||
    rootLock.version !== targetVersion || rootLock.packages?.[""]?.version !== targetVersion) {
  throw new Error("Root candidate version does not converge on 0.6.4 from baseline 0.6.3");
}
if (consumerPackage.version !== "0.6.3") {
  throw new Error("Frozen public consumer bundle must remain @gowm/world-gateway-contracts@0.6.3");
}

const baselineMigrations = migrationPathsAt(baselineCommit, 61);
const currentMigrations = migrationPathsAt("HEAD", 61);
if (baselineMigrations.length !== 61 || canonical(baselineMigrations) !== canonical(currentMigrations)) {
  throw new Error("Frozen migration 001-061 file set differs from baseline");
}
const migrationBefore = combinedRawHash(baselineMigrations.map((path) => [path, gitBytes(["show", `${baselineCommit}:${path}`])]));
const migrationAfter = combinedRawHash(currentMigrations.map((path) => [path, currentBytes(path)]));
if (migrationBefore !== migrationAfter) throw new Error("Frozen migration 001-061 bytes changed");
const migration062Path = "database/migrations/062_reference_geometry_composability.sql";
const migration062Hash = normalizedTextHash(currentBytes(migration062Path));
if (migration062Hash !== expectedMigration062) throw new Error("Migration 062 digest differs from the authoritative source lock");
const spatialSourceLock = await readJson("contracts/manifests/providers/spatial-provider-source-lock.json");
if (spatialSourceLock.catalogFeatureReadContractMigration !== migration062Path ||
    `sha256:${spatialSourceLock.catalogFeatureReadContractMigrationSha256}` !== migration062Hash) {
  throw new Error("Spatial Provider source lock is not bound to authoritative migration 062");
}

const referenceKey = schemaSubject("contracts/gowm-v0.4/reference-key.schema.json");
const operationDefinitions = [
  {
    operationId: "reference.resolve",
    manifestPath: "contracts/manifests/providers/reference-catalog-provider.json",
    inputPath: "contracts/gowm-v0.4/reference-resolve-request.schema.json",
    outputPath: "contracts/gowm-v0.4/reference-resolve-result.schema.json"
  },
  {
    operationId: "world.get-geometry",
    manifestPath: "contracts/manifests/providers/world-evidence-provider.json",
    inputPath: "contracts/gowm-v0.4/catalog-query-request.schema.json",
    outputPath: "contracts/gowm-v0.4/world-fact-result.schema.json"
  }
];

const operations = operationDefinitions.map((definition) => operationEvidence(definition));
if (new Set(operations.map(({ operationId }) => operationId)).size !== 2) {
  throw new Error("Compatibility evidence must cover the exact two composability operations");
}
for (const operation of operations) {
  if (!operation.schemaCompatible || !operation.semanticProfile.compatible || !operation.implementationIdentityRefreshed) {
    throw new Error(`Compatibility evidence is incomplete for ${operation.operationId}`);
  }
}

const evidence = {
  schemaVersion: "1.0",
  baseline: { version: baselineVersion, source: baselineCommit },
  target: { version: targetVersion, source: "WORKTREE_CONTENT" },
  migrationLock: {
    frozenCount: 61,
    beforeHash: migrationBefore,
    afterHash: migrationAfter,
    unchanged: true,
    additiveMigration: { path: migration062Path, sha256: migration062Hash }
  },
  referenceKey,
  operations,
  wsgsAdapter: {
    changeRequired: false,
    basis: "ReferenceKey plus reference.resolve and world.get-geometry public input/output schemas are byte-semantically unchanged."
  },
  status: "PASS"
};

const summary = {
  schemaVersion: "1.0",
  baselineVersion,
  targetVersion,
  publicSchemaBreak: false,
  referenceKeySchemaHashChanged: referenceKey.beforeHash !== referenceKey.afterHash,
  operations: operations.map((operation) => ({
    operationId: operation.operationId,
    schemaCompatible: operation.schemaCompatible,
    beforeHash: canonicalHash({ input: operation.inputSchema.beforeHash, output: operation.outputSchema.beforeHash }),
    afterHash: canonicalHash({ input: operation.inputSchema.afterHash, output: operation.outputSchema.afterHash })
  })),
  status: "PASS"
};

if (summary.referenceKeySchemaHashChanged || summary.operations.some(({ beforeHash, afterHash }) => beforeHash !== afterHash)) {
  throw new Error("Public composability wire subjects changed");
}

if (write) {
  await mkdir(dirname(reportPath), { recursive: true });
  await Promise.all([
    writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
    writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  ]);
} else {
  await assertCurrent(reportPath, evidence);
  await assertCurrent(summaryPath, summary);
}
process.stdout.write(`GOWM_V064_CONTRACT_COMPATIBILITY_PASS operations=${operations.length} frozenMigrations=61\n`);

function operationEvidence(definition) {
  const baselineManifest = gitJson(definition.manifestPath);
  const currentManifest = currentJson(definition.manifestPath);
  const before = oneCapability(baselineManifest, definition.operationId);
  const after = oneCapability(currentManifest, definition.operationId);
  if (before.operationVersion !== "1.0" || after.operationVersion !== "1.0" ||
      before.inputSchemaUri !== after.inputSchemaUri || before.outputSchemaUri !== after.outputSchemaUri) {
    throw new Error(`Operation identity or schema URI changed for ${definition.operationId}`);
  }
  const inputSchema = schemaSubject(definition.inputPath);
  const outputSchema = schemaSubject(definition.outputPath);
  const beforePublic = withoutDocumentation(before.semanticProfile);
  const afterPublic = withoutDocumentation(after.semanticProfile);
  const semanticBefore = canonicalHash(before.semanticProfile);
  const semanticAfter = canonicalHash(after.semanticProfile);
  const publicBefore = canonicalHash(beforePublic);
  const publicAfter = canonicalHash(afterPublic);
  if (publicBefore !== publicAfter) throw new Error(`Consumer-visible semantic profile changed for ${definition.operationId}`);
  const implementationDigestBefore = requiredDigest(baselineManifest.provider?.implementationDigest, "baseline implementation digest");
  const implementationDigestAfter = requiredDigest(currentManifest.provider?.implementationDigest, "current implementation digest");
  if (implementationDigestBefore === implementationDigestAfter) {
    throw new Error(`Provider implementation identity was not refreshed for ${definition.operationId}`);
  }
  return {
    operationId: definition.operationId,
    operationVersion: "1.0",
    manifestPath: definition.manifestPath,
    inputSchema,
    outputSchema,
    semanticProfile: {
      beforeHash: semanticBefore,
      afterHash: semanticAfter,
      publicContractBeforeHash: publicBefore,
      publicContractAfterHash: publicAfter,
      classification: semanticBefore === semanticAfter ? "UNCHANGED" : "ADDITIVE_DOCUMENTATION",
      compatible: true
    },
    implementationDigestBefore,
    implementationDigestAfter,
    implementationIdentityRefreshed: true,
    schemaCompatible: inputSchema.compatible && outputSchema.compatible
  };
}

function schemaSubject(path) {
  const beforeHash = canonicalHash(JSON.parse(gitText(["show", `${baselineCommit}:${path}`])));
  const afterHash = canonicalHash(currentJson(path));
  if (beforeHash !== afterHash) throw new Error(`Public schema changed: ${path}`);
  return { path, normalization: "CANONICAL_JSON_SORTED_KEYS_UTF8", beforeHash, afterHash, compatible: true };
}

function oneCapability(manifest, operationId) {
  const matches = (manifest.capabilities ?? []).filter((entry) => entry.operationId === operationId);
  if (matches.length !== 1) throw new Error(`Expected one ${operationId} manifest capability, received ${matches.length}`);
  return matches[0];
}

function withoutDocumentation(value) {
  if (Array.isArray(value)) return value.map(withoutDocumentation);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "notes")
    .map(([key, child]) => [key, withoutDocumentation(child)]));
}

function migrationPathsAt(revision, maximum) {
  return gitText(["ls-tree", "-r", "--name-only", revision, "--", "database/migrations"])
    .split(/\r?\n/u).filter(Boolean)
    .filter((path) => Number.parseInt(path.split("/").at(-1).slice(0, 3), 10) <= maximum)
    .sort();
}

function combinedRawHash(entries) {
  const hash = createHash("sha256");
  for (const [path, bytes] of entries) {
    hash.update(path, "utf8");
    hash.update("\0", "utf8");
    hash.update(normalizedTextBytes(bytes));
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function rawHash(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function normalizedTextHash(bytes) { return rawHash(normalizedTextBytes(bytes)); }
function normalizedTextBytes(bytes) { return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8"); }
function canonicalHash(value) { return rawHash(Buffer.from(canonical(value), "utf8")); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function currentBytes(path) { return execFileSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1]))", resolve(root, path)], { cwd: root }); }
function currentJson(path) { return JSON.parse(currentBytes(path).toString("utf8")); }
function gitBytes(args) { return execFileSync("git", args, { cwd: root, encoding: null, maxBuffer: 32 * 1024 * 1024 }); }
function gitText(args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); }
function gitJson(path) { return JSON.parse(gitText(["show", `${baselineCommit}:${path}`])); }
function requiredDigest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(value))) throw new Error(`${label} is invalid`);
  return value;
}
function assertAncestor(commit) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: root });
  if (result.status !== 0) throw new Error(`Frozen baseline is not an ancestor of HEAD: ${commit}`);
}
async function readJson(path) { return JSON.parse(await readFile(resolve(root, path), "utf8")); }
async function assertCurrent(path, expected) {
  const actual = JSON.parse(await readFile(path, "utf8"));
  if (canonical(actual) !== canonical(expected)) throw new Error(`Generated compatibility report is stale: ${path}`);
}
