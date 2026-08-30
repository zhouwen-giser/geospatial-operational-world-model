import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

register();
const { compareUnicodeCodePoints } = await import("../../contract-runtime/src/canonical-order.ts");

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(packageRoot, "../../..");
const defaultOutputRoot = resolve(process.argv[2] || join(packageRoot, "bundle"));
const reportRoot = resolve(repositoryRoot, process.env.GOWM_REPORT_DIRECTORY?.trim() || "reports/gowm-v0.7.1/pr-b/world-platform");

const compareCanonicalText = compareUnicodeCodePoints;
const canonical = (value) => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => compareCanonicalText(a, b)));
});
const sha256 = (value) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex")}`;
const sha512Integrity = (value) => `sha512-${createHash("sha512").update(value).digest("base64")}`;
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const authorizationBreakingChanges = [
  "SIGNED_DELEGATION_V1 dataScopes cardinality is now exactly one instead of up to 32.",
  "SIGNED_DELEGATION_V1 datasetScopes cardinality is now at most one instead of up to 32.",
  "Gateway replay and idempotency authorization identity is now bound to the SINGLE_SCOPE_V1 canonical principal context."
];
const emitJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};
const copy = async (source, destination) => {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(source));
};
const walk = async (root) => {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => compareCanonicalText(a.name, b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
};

async function copySchemas(outputRoot) {
  for (const sourceRoot of ["contracts/platform", "contracts/gowm-v0.6.2", "contracts/gowm-v0.6.3", "contracts/gowm-v0.7", "contracts/gowm-v0.7.1"]) {
    const absolute = resolve(repositoryRoot, sourceRoot);
    for (const path of await walk(absolute)) {
      const portablePath = path.replaceAll("\\", "/");
      if (!path.endsWith(".json") || portablePath.includes("/vocabularies/") || portablePath.includes("/manifests/") || portablePath.includes("/rules/")) continue;
      const prefix = basename(absolute);
      const destinationName = basename(path) === "delegation-token-claims.schema.json"
        ? "delegated-identity-claims.schema.json"
        : relative(absolute, path);
      await copy(path, join(outputRoot, "schemas", prefix, destinationName));
    }
  }
}

async function loadCatalog() {
  const registry = await json(resolve(repositoryRoot, "config/world-platform-gateway-registry.json"));
  const operations = [];
  for (const provider of registry.providers) {
    const manifest = await json(resolve(repositoryRoot, provider.manifestPath));
    operations.push(...manifest.capabilities);
  }
  return operations.sort((a, b) => compareCanonicalText(
    `${a.operationId}@${a.operationVersion}`,
    `${b.operationId}@${b.operationVersion}`
  ));
}

function operationProjection(operation) {
  const scope = operation.scopePolicy === "DATASET_SCOPE_REQUIRED" ? "dataset:read"
    : operation.scopePolicy === "DATA_SCOPE_REQUIRED" ? "data:read" : "gateway:execute";
  const dataSnapshot = operation.snapshotPolicy?.dataSnapshot;
  return {
    operationId: operation.operationId,
    operationVersion: operation.operationVersion,
    inputSchemaHash: operation.inputSchemaHash,
    outputSchemaHash: operation.outputSchemaHash,
    semanticProfileHash: sha256(operation.semanticProfile),
    maturity: operation.maturity,
    requiredPermissions: [scope],
    snapshotSupport: dataSnapshot === "REQUIRED" ? "CONSISTENT_AT_START" : dataSnapshot === "OPTIONAL" ? "BEST_EFFORT" : "NONE"
  };
}

async function fileRecords(root) {
  const records = [];
  for (const path of await walk(root)) {
    const bytes = await readFile(path);
    records.push({ path: relative(root, path).replaceAll("\\", "/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return records.sort((a, b) => compareCanonicalText(a.path, b.path));
}

export async function buildConsumerContracts(destination = defaultOutputRoot, options = {}) {
  const { writeSourceLock = false } = options;
  const outputRoot = resolve(destination);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await copySchemas(outputRoot);
  await copy(resolve(repositoryRoot, "contracts/platform/openapi/world-capability-gateway-v1.yaml"), join(outputRoot, "openapi/world-capability-gateway-v1.yaml"));
  const extension = (await readFile(resolve(repositoryRoot, "contracts/gowm-v0.6.3/openapi/world-gateway-v0.6.3-extension.yaml"), "utf8"))
    .replaceAll("../operation-availability-list.schema.json", "../schemas/gowm-v0.6.3/operation-availability-list.schema.json")
    .replaceAll("../operation-availability.schema.json", "../schemas/gowm-v0.6.3/operation-availability.schema.json")
    .replaceAll("../delegation-token-claims.schema.json", "../schemas/gowm-v0.6.3/delegated-identity-claims.schema.json")
    .replaceAll("../delegated-principal-context.schema.json", "../schemas/gowm-v0.6.3/delegated-principal-context.schema.json")
    .replaceAll("../query-snapshot-policy.schema.json", "../schemas/gowm-v0.6.3/query-snapshot-policy.schema.json")
    .replaceAll("../query-snapshot-manifest.schema.json", "../schemas/gowm-v0.6.3/query-snapshot-manifest.schema.json")
    .replaceAll("../query-snapshot-adherence.schema.json", "../schemas/gowm-v0.6.3/query-snapshot-adherence.schema.json");
  await mkdir(join(outputRoot, "openapi"), { recursive: true });
  await writeFile(join(outputRoot, "openapi/world-gateway-v0.6.3.yaml"), extension);
  await copy(resolve(repositoryRoot, "packages/platform/contract-runtime/src/generated/contracts.ts"), join(outputRoot, "types/contracts.ts"));
  for (const path of await walk(resolve(repositoryRoot, "contracts/gowm-v0.6.2/vocabularies"))) {
    await copy(path, join(outputRoot, "vocabularies", basename(path)));
  }
  for (const path of await walk(resolve(repositoryRoot, "contracts/gowm-v0.7/vocabularies"))) {
    await copy(path, join(outputRoot, "vocabularies", basename(path)));
  }

  const registryReport = await json(join(reportRoot, "world-platform-registry-build-report.json"));
  const catalog = await loadCatalog();
  const profiles = catalog.map((operation) => ({
    operationId: operation.operationId,
    operationVersion: operation.operationVersion,
    semanticProfile: operation.semanticProfile,
    semanticProfileHash: sha256(operation.semanticProfile)
  }));
  const semanticCatalogHash = sha256(profiles);
  await emitJson(join(outputRoot, "revisions/contract-catalog.json"), {
    schemaVersion: "1.0", contractCatalogRevision: registryReport.contractCatalogRevision, bindingRevision: registryReport.bindingRevision
  });
  await emitJson(join(outputRoot, "revisions/semantic-catalog.json"), {
    schemaVersion: "1.1", contractCatalogRevision: registryReport.contractCatalogRevision, semanticCatalogHash
  });
  const compatibilityReport = {
    schemaVersion: "1.0", packageVersion: "0.7.1", baselineVersion: "0.7.0", classification: "BREAKING_AUTHORIZATION_HARDENING",
    breakingChanges: authorizationBreakingChanges,
    // The v0.6.3 promotion set was already Stable in the 0.7.0 baseline.
    promotedOperations: []
  };
  if (compatibilityReport.classification.startsWith("BREAKING") && compatibilityReport.breakingChanges.length === 0) {
    throw new Error("Breaking compatibility classifications require at least one explicit breaking change");
  }
  await emitJson(join(outputRoot, "compatibility/report.json"), compatibilityReport);

  const contractHashes = {
    availabilityContractHash: sha256(await json(resolve(repositoryRoot, "contracts/gowm-v0.6.3/operation-availability-list.schema.json"))),
    snapshotContractHash: sha256(await json(resolve(repositoryRoot, "contracts/gowm-v0.7.1/query-snapshot-manifest.schema.json"))),
    delegationContractHash: sha256(await json(resolve(repositoryRoot, "contracts/gowm-v0.7.1/delegation-token-claims.schema.json")))
  };
  const preLockRecords = await fileRecords(outputRoot);
  const packageIntegrity = sha512Integrity(canonical(preLockRecords));
  const projected = catalog.filter((operation) => operation.maturity === "STABLE" || operation.maturity === "PREVIEW").map(operationProjection);
  const lock = {
    schemaVersion: "2.0", gatewayContractVersion: "0.7.1",
    consumerContractPackage: { name: "@gowm/world-gateway-contracts", version: "0.7.1", integrity: packageIntegrity },
    scopeModel: "SINGLE_SCOPE_V1",
    resourceIdEncodingRevision: "SNAPSHOT_RESOURCE_ID_V1_512",
    canonicalOrderingRevision: "UNICODE_CODE_POINT_BINARY_V1",
    contractCatalogRevision: registryReport.contractCatalogRevision, semanticCatalogHash, ...contractHashes,
    defaultOperations: projected.filter((operation) => operation.maturity === "STABLE"),
    previewOperations: projected.filter((operation) => operation.maturity === "PREVIEW")
  };
  if (writeSourceLock) {
    await emitJson(resolve(repositoryRoot, "contracts/consumers/wsgs-southbound-operation-lock-v2.json"), lock);
  }
  await emitJson(join(outputRoot, "locks/wsgs-southbound-operation-lock-v2.json"), lock);
  const files = await fileRecords(outputRoot);
  await emitJson(join(outputRoot, "MANIFEST.json"), {
    schemaVersion: "1.0", packageName: "@gowm/world-gateway-contracts", packageVersion: "0.7.1",
    contractCatalogRevision: registryReport.contractCatalogRevision, semanticCatalogHash, files, packageIntegrity
  });
  return { outputRoot, fileCount: files.length + 1, packageIntegrity, defaultOperations: lock.defaultOperations.length, previewOperations: lock.previewOperations.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await buildConsumerContracts(defaultOutputRoot, { writeSourceLock: true }))}\n`);
}
