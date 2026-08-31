import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "0.7.1";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function text(path) {
  return readFile(resolve(root, path), "utf8");
}

async function json(path) {
  return JSON.parse(await text(path));
}

function requireVersion(actual, label) {
  if (actual !== EXPECTED_VERSION) {
    throw new Error(`${label} must be ${EXPECTED_VERSION}; received ${JSON.stringify(actual)}`);
  }
}

requireVersion((await text("VERSION")).trim(), "VERSION");

const rootPackage = await json("package.json");
const packageLock = await json("package-lock.json");
requireVersion(rootPackage.version, "package.json version");
requireVersion(packageLock.version, "package-lock.json version");
requireVersion(packageLock.packages?.[""]?.version, "package-lock.json root package version");

const packageTargets = [
  "packages/historical-trace-core",
  "packages/historical-trace-model",
  "packages/historical-trace-runtime",
  "services/providers/historical-trace-provider",
  "packages/platform/world-gateway-contracts"
];

for (const packagePath of packageTargets) {
  requireVersion((await json(`${packagePath}/package.json`)).version, `${packagePath}/package.json version`);
  requireVersion(packageLock.packages?.[packagePath]?.version, `package-lock.json ${packagePath} version`);
}

const bundleManifest = await json("packages/platform/world-gateway-contracts/bundle/MANIFEST.json");
const compatibilityReport = await json("packages/platform/world-gateway-contracts/bundle/compatibility/report.json");
const historicalProviderManifest = await json("contracts/manifests/providers/historical-trace-provider.json");
requireVersion(bundleManifest.packageVersion, "consumer bundle MANIFEST packageVersion");
requireVersion(compatibilityReport.packageVersion, "consumer bundle compatibility packageVersion");
requireVersion(historicalProviderManifest.provider?.providerVersion, "historical Provider manifest version");

for (const lockPath of [
  "contracts/consumers/wsgs-southbound-operation-lock-v2.json",
  "packages/platform/world-gateway-contracts/bundle/locks/wsgs-southbound-operation-lock-v2.json"
]) {
  const lock = await json(lockPath);
  requireVersion(lock.gatewayContractVersion, `${lockPath} gatewayContractVersion`);
  requireVersion(lock.consumerContractPackage?.version, `${lockPath} consumerContractPackage.version`);
}

const qualificationSchemas = [
  [
    "contracts/gowm-v0.7.1/exact-head-qualification-report.schema.json",
    "urn:gowm:v0.7.1:exact-head-qualification-report"
  ],
  [
    "contracts/gowm-v0.7.1/wsgs-historical-consumer-lock.schema.json",
    "urn:gowm:v0.7.1:wsgs-historical-consumer-lock"
  ]
];
for (const [schemaPath, expectedId] of qualificationSchemas) {
  const schema = await json(schemaPath);
  if (schema.$id !== expectedId) {
    throw new Error(`${schemaPath} qualification identity must be ${expectedId}`);
  }
}
const historicalLockSchema = await json("contracts/gowm-v0.7.1/wsgs-historical-consumer-lock.schema.json");
requireVersion(
  historicalLockSchema.properties?.consumerContractPackage?.properties?.version?.const,
  "WSGS historical qualification consumer package version"
);

if (!(await text("README.md")).includes(`Version \`${EXPECTED_VERSION}\``)) {
  throw new Error(`README.md does not identify the current version as ${EXPECTED_VERSION}`);
}
if (!(await text("CHANGELOG.md")).includes(`## ${EXPECTED_VERSION} -`)) {
  throw new Error(`CHANGELOG.md does not contain a ${EXPECTED_VERSION} release entry`);
}

process.stdout.write(`${JSON.stringify({
  marker: "GOWM_V071_VERSION_CONSISTENCY_PASS",
  version: EXPECTED_VERSION,
  packageCount: packageTargets.length,
  consumerLockCount: 2,
  qualificationSchemaCount: qualificationSchemas.length
})}\n`);
