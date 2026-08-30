import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalSha256, validateAgainstSchema } from "../../packages/platform/contract-runtime/src/index.js";
import { loadRuntimeSampleWorld } from "./loaded.js";
import {
  assertCurrentV1Artifacts,
  probeLiveSampleInstance,
  REQUIRED_SAMPLE_OPERATIONS
} from "./readiness.js";
import {
  SAMPLE_RUNTIME_SECRET_NAMES,
  sampleContainerGatewayBaseUrl,
  sampleGatewayBaseUrl,
  sampleRuntimeIdentityFromValues,
  type SampleRuntimeEnvironment
} from "./runtime.js";

type AnyRecord = Record<string, any>;

export async function buildSampleHandoff(runtime: SampleRuntimeEnvironment): Promise<void> {
  const runtimeIdentity = sampleRuntimeIdentityFromValues(runtime.values);
  await probeLiveSampleInstance(runtime, { expectedRevision: "v1" });
  const live = await probeLiveSampleInstance(runtime, { expectedRevision: "v1" });
  const realization = await loadRuntimeSampleWorld(runtime);
  await assertCurrentV1Artifacts(runtime, realization, live);
  await assertPromotedAttestationsProven(runtime);
  const gatewayBaseUrl = sampleGatewayBaseUrl(runtime, {});
  const [catalogResponse, semanticResponse] = await Promise.all([
    fetch(`${gatewayBaseUrl}/v1/capabilities`, { signal: AbortSignal.timeout(30_000) }),
    fetch(`${gatewayBaseUrl}/v1/capability-semantics`, { signal: AbortSignal.timeout(30_000) })
  ]);
  if (!catalogResponse.ok || !semanticResponse.ok) throw new Error("Live Gateway contract discovery failed during handoff");
  const catalog = await catalogResponse.json() as AnyRecord;
  const semantics = await semanticResponse.json() as AnyRecord;
  const bundleManifest = JSON.parse(await readFile(
    resolve(runtime.paths.root, "packages/platform/world-gateway-contracts/bundle/MANIFEST.json"),
    "utf8"
  )) as AnyRecord;
  const lockPath = resolve(runtime.paths.root, "contracts/consumers/wsgs-southbound-operation-lock-v2.json");
  const lockBytes = await readFile(lockPath);
  const lock = JSON.parse(lockBytes.toString("utf8")) as AnyRecord;
  const bundledLockPath = resolve(
    runtime.paths.root,
    "packages/platform/world-gateway-contracts/bundle/locks/wsgs-southbound-operation-lock-v2.json"
  );
  const bundledLockBytes = await readFile(bundledLockPath);
  const bundledLockEntry = (bundleManifest.files as AnyRecord[] | undefined)?.find((entry) =>
    entry.path === "locks/wsgs-southbound-operation-lock-v2.json"
  );
  assertBundledLockIntegrity(lockBytes, bundledLockBytes, bundledLockEntry);
  const lockedPackage = lock.consumerContractPackage as AnyRecord | undefined;
  if (!lockedPackage || lockedPackage.name !== bundleManifest.packageName ||
      lockedPackage.version !== bundleManifest.packageVersion ||
      lockedPackage.integrity !== bundleManifest.packageIntegrity) {
    throw new Error("Consumer bundle package identity differs from the WSGS operation lock");
  }
  if (catalog.contractCatalogRevision !== bundleManifest.contractCatalogRevision ||
      catalog.contractCatalogRevision !== lock.contractCatalogRevision) {
    throw new Error("Live Gateway, consumer bundle and WSGS operation lock revisions differ");
  }
  if (semantics.contractCatalogRevision !== catalog.contractCatalogRevision ||
      semantics.bindingRevision !== catalog.bindingRevision) {
    throw new Error("Live capability and semantic projections have different registry bindings");
  }
  if (semantics.catalogHash !== bundleManifest.semanticCatalogHash ||
      semantics.catalogHash !== lock.semanticCatalogHash) {
    throw new Error("Live Gateway, consumer bundle and WSGS semantic catalog hashes differ");
  }
  const operationContracts = lockedHandoffOperationContracts(catalog, semantics, lock);

  const { handoffDirectory, stagingDirectory } = sampleHandoffPaths(runtime);
  await rm(stagingDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });
  const instanceManifest = {
    schemaVersion: "1.0",
    runtimeInstanceId: runtimeIdentity.instanceId,
    instanceId: realization.fixture.realizationId,
    fixtureId: realization.fixture.id,
    fixtureVersion: realization.fixture.version,
    gatewayBaseUrl,
    authMode: "SIGNED_DELEGATION_V1",
    tokenEnvironmentVariable: "GOWM_WSGS_SAMPLE_TOKEN",
    dataScope: "wsgs-demo",
    datasetScope: "wsgs-demo-main",
    consumerContract: {
      name: bundleManifest.packageName,
      version: bundleManifest.packageVersion,
      integrity: bundleManifest.packageIntegrity,
      bundlePath: "packages/platform/world-gateway-contracts/bundle",
      delegationPrivateKeyEnvironmentVariable: "GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH",
      delegationIssuer: runtime.values.GATEWAY_DELEGATION_ISSUER,
      delegationAudience: runtime.values.GATEWAY_DELEGATION_AUDIENCE,
      servicePrincipalRef: runtime.values.GATEWAY_RUNTIME_PRINCIPAL_REF,
      maximumDelegationTtlSeconds: Number(runtime.values.GATEWAY_DELEGATION_MAX_TTL_SECONDS)
    },
    contractCatalogRevision: catalog.contractCatalogRevision,
    semanticCatalogHash: semantics.catalogHash,
    operationLockHash: `sha256:${createHash("sha256").update(lockBytes).digest("hex")}`,
    stableOperations: operationContracts.map((operation) => `${operation.operationId}@${operation.operationVersion}`),
    referenceMapPath: "SAMPLE_REFERENCE_MAP.json",
    expectedCasesPath: "EXPECTED_CASES.json"
  };
  const instanceBinding = {
    schemaVersion: "1.0",
    runtimeInstanceId: runtimeIdentity.instanceId,
    instanceId: realization.fixture.realizationId,
    fixtureId: realization.fixture.id,
    fixtureVersion: realization.fixture.version,
    fixtureHash: realization.fixture.generatedArtifactHash,
    sourceFixtureHash: realization.fixture.sourceFixtureHash,
    realizationId: realization.fixture.realizationId,
    realizationHash: realization.fixture.realizationHash,
    realizationT0: realization.fixture.epoch,
    loadedStateHash: live.loadedStateHash,
    bindingRevision: catalog.bindingRevision,
    operationContracts,
    canaryEvidencePath: "CANARY_EVIDENCE_REPORT.json",
    consumerConnectivityReportPath: "CONSUMER_CONNECTIVITY_REPORT.json"
  };
  const instanceSchema = JSON.parse(await readFile(
    resolve(runtime.paths.root, "contracts/wsgs-sample-world/v1/sample-world-instance-manifest.schema.json"),
    "utf8"
  )) as Record<string, unknown>;
  const instanceValidation = validateAgainstSchema(instanceSchema, instanceManifest, {
    schemaName: "sample-world-instance-manifest.schema.json"
  });
  if (!instanceValidation.valid) {
    throw new Error(`Instance manifest validation failed: ${JSON.stringify(instanceValidation.issues)}`);
  }
  const bindingSchemaPath = resolve(
    runtime.paths.root,
    "contracts/wsgs-sample-world/v1/sample-world-instance-binding.schema.json"
  );
  const bindingValidation = validateAgainstSchema(
    JSON.parse(await readFile(bindingSchemaPath, "utf8")) as Record<string, unknown>,
    instanceBinding,
    { schemaName: "sample-world-instance-binding.schema.json" }
  );
  if (!bindingValidation.valid) {
    throw new Error(`Instance binding validation failed: ${JSON.stringify(bindingValidation.issues)}`);
  }
  await Promise.all([
    writeJson(resolve(stagingDirectory, "INSTANCE_MANIFEST.json"), instanceManifest),
    writeJson(resolve(stagingDirectory, "INSTANCE_BINDING.json"), instanceBinding),
    copyFile(bindingSchemaPath, resolve(stagingDirectory, "INSTANCE_BINDING.schema.json")),
    writeJson(resolve(stagingDirectory, "EXPECTED_CASES.json"), realization.expectedCases),
    writeJson(resolve(stagingDirectory, "SAMPLE_WORLD_REALIZATION.json"), realization.manifest),
    copyFile(lockPath, resolve(stagingDirectory, "CONSUMER_CONTRACT_LOCK.json")),
    copyFile(resolve(runtime.paths.outputDirectory, "SAMPLE_REFERENCE_MAP.json"), resolve(stagingDirectory, "SAMPLE_REFERENCE_MAP.json")),
    copyFile(resolve(runtime.paths.outputDirectory, "CANARY_REPORT.json"), resolve(stagingDirectory, "CANARY_REPORT.json")),
    copyFile(resolve(runtime.paths.outputDirectory, "LOAD_REPORT.json"), resolve(stagingDirectory, "LOAD_REPORT.json")),
    copyFile(
      resolve(runtime.paths.outputDirectory, "CANARY_EVIDENCE_REPORT.json"),
      resolve(stagingDirectory, "CANARY_EVIDENCE_REPORT.json")
    )
  ]);
  await writeFile(
    resolve(stagingDirectory, "README.md"),
    sampleHandoffReadme(runtime, instanceManifest, instanceBinding),
    "utf8"
  );
  await runIndependentConsumerConnectivitySmoke(runtime, stagingDirectory, instanceBinding);
  const serialized = await Promise.all((await readdir(stagingDirectory))
    .map(async (file) => [file, await readFile(resolve(stagingDirectory, file), "utf8")] as const));
  const privateKey = await readFile(runtime.paths.privateKeyPath, "utf8");
  const exactSecrets = [...new Set([
    ...SAMPLE_RUNTIME_SECRET_NAMES.map((name) => runtime.values[name]).filter((value): value is string => Boolean(value)),
    privateKey
  ])];
  const forbidden = serialized.filter(([, contents]) =>
    /postgresql:\/\/|PROVIDER_TRANSPORT|containerName|BEGIN (?:RSA )?PRIVATE KEY|GOWM_WSGS_SAMPLE_TOKEN=/u.test(contents) ||
    exactSecrets.some((secret) => contents.includes(secret))
  );
  if (forbidden.length) throw new Error(`Handoff artifact contains prohibited secret/topology material: ${forbidden.map(([file]) => file).join(",")}`);
  await rm(handoffDirectory, { recursive: true, force: true });
  await rename(stagingDirectory, handoffDirectory);
  process.stdout.write(`WSGS_TEST_HANDOFF_READY path=${handoffDirectory}\n`);
}

export function assertBundledLockIntegrity(
  lockBytes: Buffer,
  bundledLockBytes: Buffer,
  bundledLockEntry: AnyRecord | undefined
): void {
  // Git may materialize text files as CRLF on Windows even though the bundle
  // manifest records the repository's canonical LF bytes. The two checked-out
  // lock copies must still be byte-identical; only the manifest comparison is
  // normalized to the repository representation.
  const canonicalLockBytes = Buffer.from(lockBytes.toString("utf8").replace(/\r\n/gu, "\n"), "utf8");
  if (!lockBytes.equals(bundledLockBytes) || !bundledLockEntry ||
      bundledLockEntry.bytes !== canonicalLockBytes.byteLength ||
      bundledLockEntry.sha256 !== createHash("sha256").update(canonicalLockBytes).digest("hex")) {
    throw new Error("Root lock, bundled lock and bundle manifest bytes differ");
  }
}

export function sampleHandoffPaths(runtime: SampleRuntimeEnvironment): {
  handoffDirectory: string;
  stagingDirectory: string;
} {
  const { instanceId } = sampleRuntimeIdentityFromValues(runtime.values);
  if (instanceId !== "shared") {
    return {
      handoffDirectory: resolve(runtime.paths.outputDirectory, "handoff"),
      stagingDirectory: resolve(runtime.paths.outputDirectory, ".handoff.staging")
    };
  }
  return {
    handoffDirectory: resolve(runtime.paths.root, "output/wsgs-sample-handoff"),
    stagingDirectory: resolve(runtime.paths.root, "output/.wsgs-sample-handoff.staging")
  };
}

export function lockedHandoffOperationContracts(
  catalog: AnyRecord,
  semantics: AnyRecord,
  lock: AnyRecord,
  requiredOperations: readonly string[] = REQUIRED_SAMPLE_OPERATIONS
): AnyRecord[] {
  const lockedOperations = [
    ...((lock.defaultOperations as AnyRecord[] | undefined) ?? []),
    ...((lock.previewOperations as AnyRecord[] | undefined) ?? [])
  ];
  return requiredOperations.map((operationId) => {
    const descriptors = (catalog.capabilities as AnyRecord[]).filter((candidate) =>
      candidate.operationId === operationId && candidate.operationVersion === "1.0"
    );
    const descriptor = descriptors[0];
    if (descriptors.length !== 1) throw new Error(`Handoff operation is missing or duplicated: ${operationId}@1.0`);
    if (!descriptor || descriptor.maturity !== "STABLE") throw new Error(`Handoff operation is not Stable: ${operationId}@1.0`);
    const semanticCandidates = (semantics.profiles as AnyRecord[]).filter((candidate) =>
      candidate.operationId === operationId && candidate.operationVersion === "1.0"
    );
    if (semanticCandidates.length !== 1) throw new Error(`Live semantic profile is missing or duplicated: ${operationId}@1.0`);
    const semantic = semanticCandidates[0]!;
    const lockedCandidates = lockedOperations.filter((candidate) =>
      candidate.operationId === operationId && candidate.operationVersion === "1.0"
    );
    if (lockedCandidates.length !== 1) throw new Error(`WSGS lock operation is missing or duplicated: ${operationId}@1.0`);
    const locked = lockedCandidates[0]!;
    const descriptorSemanticHash = canonicalSha256(descriptor.semanticProfile);
    if (descriptor.inputSchemaHash !== locked.inputSchemaHash ||
        descriptor.outputSchemaHash !== locked.outputSchemaHash ||
        descriptor.maturity !== locked.maturity ||
        semantic.semanticProfileHash !== locked.semanticProfileHash ||
        descriptorSemanticHash !== locked.semanticProfileHash ||
        canonicalSha256(semantic.semanticProfile) !== locked.semanticProfileHash) {
      throw new Error(`Live operation/semantic contract differs from the WSGS lock: ${operationId}@1.0`);
    }
    return {
      operationId,
      operationVersion: "1.0",
      inputSchemaHash: locked.inputSchemaHash,
      outputSchemaHash: locked.outputSchemaHash,
      semanticProfileHash: locked.semanticProfileHash,
      maturity: locked.maturity
    };
  });
}

export function sampleHandoffReadme(
  runtime: SampleRuntimeEnvironment,
  manifest: AnyRecord,
  binding: AnyRecord
): string {
  const runtimeIdentity = sampleRuntimeIdentityFromValues(runtime.values);
  const containerBaseUrl = manifest.gatewayBaseUrl.replace("127.0.0.1", "host.docker.internal");
  const qualificationEnvironment = runtimeIdentity.instanceId === "shared"
    ? ""
    : `# Keep these non-secret qualification selectors in this PowerShell session.\n` +
      `$env:SAMPLE_WORLD_INSTANCE_ID = '${runtimeIdentity.instanceId}'\n` +
      `$env:SAMPLE_WORLD_GATEWAY_PORT = '${runtimeIdentity.gatewayPort}'\n` +
      `$env:SAMPLE_WORLD_POSTGRES_PORT = '${runtimeIdentity.postgresPort}'\n\n`;
  const qualificationReminder = runtimeIdentity.instanceId === "shared"
    ? ""
    : " This qualification handoff must always be operated with the three non-secret selector variables above; omitting them selects the shared instance instead.";
  return `# GOWM WSGS Sample World handoff

This handoff describes the running, synthetic v1 sample world for WSGS Grounding Core integration.

- Gateway Base URL from the host: \`${manifest.gatewayBaseUrl}\`
- Gateway Base URL from a WSGS container on the same host: \`${containerBaseUrl}\`
- Final authentication mode: \`${manifest.authMode}\`
- Bearer token environment variable: \`${manifest.tokenEnvironmentVariable}\`
- Delegation signing-key path environment variable: \`${manifest.consumerContract.delegationPrivateKeyEnvironmentVariable}\`
- Service principal: \`${manifest.consumerContract.servicePrincipalRef}\`
- Visible data/dataset scopes: \`${manifest.dataScope}\` / \`${manifest.datasetScope}\`
- Runtime instance: \`${manifest.runtimeInstanceId}\`
- Fixture/realization: \`${manifest.fixtureId}@${manifest.fixtureVersion}\` / \`${binding.realizationId}\`

Use only the single Gateway Base URL. Provider endpoints, container topology, database credentials, bearer values and signing-key bytes are deliberately absent. Build requests from \`CONSUMER_CONTRACT_LOCK.json\`, resolve fixture identities through \`SAMPLE_REFERENCE_MAP.json\`, and run \`EXPECTED_CASES.json\` plus \`reference.validate@1.0\` and \`result.validate@1.0\`.

## Operator lifecycle

From the repository root on the host:

\`\`\`powershell
${qualificationEnvironment}# Build, start, qualify, reset and leave the instance at v1.
npm.cmd run sample-world:all

# Read live signed availability plus the database marker, realization and revision.
npm.cmd run sample-world:status

# Guardedly clear only fixture state, reload v1 and verify it.
npm.cmd run sample-world:reset

# Stop the instance while preserving its dedicated volumes.
npm.cmd run sample-world:down
\`\`\`

For a manual start in the same PowerShell session, run \`npm.cmd run sample-world:up\`, then \`npm.cmd run sample-world:load\`, and finish with \`npm.cmd run sample-world:status\`. The handoff command refuses to publish artifacts unless the live instance is on the current realization's v1 baseline and all required operations are available.${qualificationReminder}

The instance is left at the v1 baseline after mutation/reset/restart qualification. North-gate boundary membership follows PostGIS \`ST_Covers\` semantics, so boundary points are included. Nearby results may include the center object; expected references are required members rather than an undocumented filtered set.

\`CONSUMER_CONNECTIVITY_REPORT.json\` records the independent container-side signed smoke against the WSGS container URL without recording credentials.
`;
}

async function assertPromotedAttestationsProven(runtime: SampleRuntimeEnvironment): Promise<void> {
  for (const operationId of REQUIRED_SAMPLE_OPERATIONS.slice(0, 10)) {
    const attestation = JSON.parse(await readFile(resolve(
      runtime.paths.root,
      `reports/gowm-v0.6.3/semantic-attestations/${operationId}@1.0.json`
    ), "utf8")) as AnyRecord;
    if (attestation.status !== "PROVEN" ||
        !(attestation.evidence as AnyRecord[] | undefined)?.some((record) =>
          record.kind === "BLACK_BOX_TEST" && record.symbol === `${operationId}@1.0`
        )) {
      throw new Error(`Handoff refuses an unproven promoted operation: ${operationId}@1.0`);
    }
  }
}

async function runIndependentConsumerConnectivitySmoke(
  runtime: SampleRuntimeEnvironment,
  handoffDirectory: string,
  binding: AnyRecord
): Promise<void> {
  const containerBaseUrl = sampleContainerGatewayBaseUrl(runtime);
  const output = execFileSync("docker", [
    "run",
    "--rm",
    "--pull", "never",
    "-e", "GOWM_GATEWAY_BASE_URL",
    "-e", "GOWM_WSGS_SAMPLE_TOKEN",
    "-e", "GATEWAY_DELEGATION_ISSUER",
    "-e", "GATEWAY_RUNTIME_PRINCIPAL_REF",
    "-e", "GATEWAY_DELEGATION_AUDIENCE",
    "-e", "GATEWAY_DATA_SCOPE_CLAIM",
    "-e", "GATEWAY_DATASET_SCOPE_CLAIM",
    "-e", "GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH",
    "-e", "SAMPLE_WORLD_OUTPUT_DIRECTORY",
    "-v", `${handoffDirectory}:/handoff:ro`,
    "-v", `${runtime.paths.privateKeyPath}:/run/secrets/delegation-private.pem:ro`,
    runtime.values.GOWM_WSGS_SAMPLE_IMAGE!,
    "node",
    "dist/scripts/sample-world/consumer-smoke.js"
  ], {
    cwd: runtime.paths.root,
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      DOCKER_CONFIG: runtime.paths.dockerConfigDirectory,
      GOWM_GATEWAY_BASE_URL: containerBaseUrl,
      GOWM_WSGS_SAMPLE_TOKEN: runtime.values.GOWM_WSGS_SAMPLE_TOKEN,
      GATEWAY_DELEGATION_ISSUER: runtime.values.GATEWAY_DELEGATION_ISSUER,
      GATEWAY_RUNTIME_PRINCIPAL_REF: runtime.values.GATEWAY_RUNTIME_PRINCIPAL_REF,
      GATEWAY_DELEGATION_AUDIENCE: runtime.values.GATEWAY_DELEGATION_AUDIENCE,
      GATEWAY_DATA_SCOPE_CLAIM: runtime.values.GATEWAY_DATA_SCOPE_CLAIM,
      GATEWAY_DATASET_SCOPE_CLAIM: runtime.values.GATEWAY_DATASET_SCOPE_CLAIM,
      GOWM_WSGS_DELEGATION_PRIVATE_KEY_PATH: "/run/secrets/delegation-private.pem",
      SAMPLE_WORLD_OUTPUT_DIRECTORY: "/handoff"
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024
  });
  if (!output.includes("INDEPENDENT_CONSUMER_CONTAINER_CONNECTIVITY_PASS auth=SIGNED_DELEGATION_V1 operation=reference.get@1.0")) {
    throw new Error("Independent consumer container connectivity smoke returned no PASS marker");
  }
  const manifest = JSON.parse(await readFile(resolve(handoffDirectory, "INSTANCE_MANIFEST.json"), "utf8")) as AnyRecord;
  const report = {
    schemaVersion: "1.0",
    status: "PASS",
    realizationId: binding.realizationId,
    loadedStateHash: binding.loadedStateHash,
    contractCatalogRevision: manifest.contractCatalogRevision,
    semanticCatalogHash: manifest.semanticCatalogHash,
    gatewayBaseUrlHash: `sha256:${createHash("sha256").update(containerBaseUrl).digest("hex")}`,
    authMode: "SIGNED_DELEGATION_V1",
    operation: "reference.get@1.0",
    evidenceSource: "INDEPENDENT_CONTAINER"
  };
  await Promise.all([
    writeJson(resolve(runtime.paths.outputDirectory, "CONSUMER_CONNECTIVITY_REPORT.json"), report),
    writeJson(resolve(handoffDirectory, "CONSUMER_CONNECTIVITY_REPORT.json"), report)
  ]);
  process.stdout.write("INDEPENDENT_CONSUMER_CONTAINER_CONNECTIVITY_PASS auth=SIGNED_DELEGATION_V1 operation=reference.get@1.0\n");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
