import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSha256 } from "../../packages/platform/contract-runtime/src/index.js";
import { semanticSourceFingerprint } from "../../packages/platform/semantic-conformance/src/index.js";
import { admitSampleSemanticEvidence } from "./admit-semantic-evidence.js";
import { loadSampleWorldDatabase, mutateSampleWorldDatabase, resetSampleWorldDatabase } from "./database.js";
import { realizeSampleWorld } from "./model.js";
import { buildSampleHandoff } from "./handoff.js";
import { probeLiveSampleInstance } from "./readiness.js";
import {
  ensureSampleRuntimeEnvironment,
  sampleGatewayBaseUrl,
  sampleRuntimeIdentityFromValues,
  type SampleRuntimeEnvironment
} from "./runtime.js";
import { verifySampleWorld, verifyStaticPrincipal } from "./verify.js";
import { writeGowmV064RuntimeEvidence } from "../../validation/scripts/gowm-v064-runtime-evidence.js";

const CORE_SERVICES = [
  "postgres",
  "sample-bootstrap",
  "reference-catalog-provider",
  "dataset-catalog-provider",
  "world-evidence-provider",
  "spatial-provider-bridge",
  "platform-validation-provider",
  "world-capability-gateway"
];

const MUTATION_AFFECTED_PROVIDERS = [
  "world-evidence-provider",
  "spatial-provider-bridge"
];

const HEALTHY_RUNTIME_SERVICES = [
  "postgres",
  "reference-catalog-provider",
  "dataset-catalog-provider",
  "world-evidence-provider",
  "spatial-provider-bridge",
  "platform-validation-provider",
  "world-capability-gateway"
];

export async function runSampleWorldCommand(command: string): Promise<void> {
  if (command === "load-db") {
    await loadSampleWorldDatabase();
    return;
  }
  if (command === "mutate-db") {
    await mutateSampleWorldDatabase();
    return;
  }
  if (command === "reset-db") {
    await resetSampleWorldDatabase({ dryRun: process.argv.includes("--dry-run") });
    return;
  }
  const runtime = await ensureSampleRuntimeEnvironment();
  process.env.DOCKER_CONFIG = runtime.paths.dockerConfigDirectory;
  switch (command) {
    case "generate":
      await generate(runtime);
      break;
    case "up":
      materializeV063SemanticEvidence(runtime);
      await generate(runtime);
      up(runtime, true);
      await waitForGateway(runtime);
      break;
    case "wait":
      await waitForGateway(runtime);
      break;
    case "load":
      await generate(runtime);
      compose(runtime, ["run", "--rm", "sample-loader", "node", "dist/scripts/sample-world/database-cli.js", "load-db"]);
      break;
    case "verify":
      await verifySampleWorld({ runtime });
      break;
    case "mutate":
      compose(runtime, ["run", "--rm", "sample-loader", "node", "dist/scripts/sample-world/database-cli.js", "mutate-db"]);
      await verifySampleWorld({ runtime, expectedRevision: "v2" });
      break;
    case "reset":
      await reset(runtime, { dryRun: process.argv.includes("--dry-run") });
      break;
    case "down":
      down(runtime, process.argv.includes("--destroy-volumes"));
      break;
    case "status":
      await status(runtime);
      break;
    case "handoff":
      await qualifyAndBuildHandoff(runtime);
      break;
    case "upgrade-proof":
      await proveReferenceGeometryUpgrade(runtime);
      break;
    case "evidence":
      await writeReferenceComposabilityRuntimeEvidence(runtime);
      break;
    case "all":
      await all(runtime);
      break;
    default:
      throw new Error(`Unknown sample-world command: ${command}`);
  }
}

async function all(runtime: SampleRuntimeEnvironment): Promise<void> {
  await beginFreshQualification(runtime, "runtime");
  // The image, generated catalog fixture, and later admission must all consume
  // the same deterministic semantic materialization bytes.
  materializeV063SemanticEvidence(runtime);
  await generate(runtime);
  up(runtime, true);
  await waitForGateway(runtime);
  compose(runtime, ["run", "--rm", "sample-loader", "node", "dist/scripts/sample-world/database-cli.js", "load-db"]);
  await verifyAuthLifecycle(runtime);
  await verifySampleWorld({ runtime });
  compose(runtime, ["run", "--rm", "sample-loader", "node", "dist/scripts/sample-world/database-cli.js", "mutate-db"]);
  await verifySampleWorld({ runtime, expectedRevision: "v2" });
  const recoveryStages: Array<Record<string, unknown>> = [];

  recoveryStages.push(await restartAndVerifyV2(runtime, {
    stage: "gateway-restart",
    services: ["world-capability-gateway"],
    waitServices: ["world-capability-gateway"],
    acceptance: ["AC-X001", "AC-M008"]
  }));
  recoveryStages.push(await restartAndVerifyV2(runtime, {
    stage: "provider-restart",
    services: MUTATION_AFFECTED_PROVIDERS,
    waitServices: MUTATION_AFFECTED_PROVIDERS,
    acceptance: ["AC-X002", "AC-M008"]
  }));
  recoveryStages.push(await restartAndVerifyV2(runtime, {
    stage: "postgres-restart",
    services: ["postgres"],
    waitServices: HEALTHY_RUNTIME_SERVICES,
    acceptance: ["AC-X003", "AC-M008"]
  }));
  await writeFile(resolve(runtime.paths.outputDirectory, "RECOVERY_REPORT.json"), `${JSON.stringify({
    schemaVersion: "1.0",
    status: "PASS",
    expectedRevision: "v2",
    stages: recoveryStages
  }, null, 2)}\n`, "utf8");

  await reset(runtime);
  compose(runtime, ["restart", "world-capability-gateway"]);
  await waitForServicesHealthy(runtime, ["world-capability-gateway"]);
  await waitForGateway(runtime);
  await qualifyAndBuildHandoff(runtime);
  process.stdout.write("GOWM_WSGS_SAMPLE_WORLD_TASK_COMPLETE\n");
}

async function qualifyAndBuildHandoff(runtime: SampleRuntimeEnvironment): Promise<void> {
  // First bring the static attestation inputs and operation evidence digests to
  // their deterministic fixed point. Admission must never copy a digest from a
  // stale implementation report and then ask a later materialization pass to
  // validate it.
  materializeV063SemanticEvidence(runtime);
  const preparedSourceDigest = await semanticSourceFingerprint(runtime.paths.root);
  await verifySampleWorld({ runtime });
  const admittedSourceDigest = await admitSampleSemanticEvidence(runtime);
  if (admittedSourceDigest !== preparedSourceDigest) {
    throw new Error("Semantic sources changed between static evidence preparation and live admission");
  }
  materializeV063SemanticEvidence(runtime);
  const postMaterializationDigest = await semanticSourceFingerprint(runtime.paths.root);
  if (postMaterializationDigest !== admittedSourceDigest) {
    throw new Error("Semantic materialization changed the source fingerprint after live admission");
  }
  await assertPromotedAttestationsProven(runtime);
  await buildSampleHandoff(runtime);
}

async function generate(runtime: SampleRuntimeEnvironment): Promise<void> {
  const realization = await realizeSampleWorld({
    epoch: runtime.values.SAMPLE_WORLD_EPOCH!,
    seed: runtime.values.SAMPLE_WORLD_SEED!,
    outputDir: runtime.paths.generatedDirectory
  });
  process.stdout.write(`SAMPLE_WORLD_GENERATED realizationId=${realization.fixture.realizationId}\n`);
}

function up(runtime: SampleRuntimeEnvironment, build: boolean): void {
  if (build) buildImages(runtime);
  compose(runtime, ["up", "-d", "--no-build", ...CORE_SERVICES]);
}

function buildImages(runtime: SampleRuntimeEnvironment): string {
  assertQualificationBuildContextClean(runtime);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: runtime.paths.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error("Qualification candidate revision is invalid");
  execFileSync("docker", [
    "build",
    "--tag", runtime.values.GOWM_WSGS_SAMPLE_IMAGE!,
    "--label", `org.opencontainers.image.revision=${revision}`,
    "--label", "org.opencontainers.image.version=0.6.4",
    "."
  ], {
    cwd: runtime.paths.root,
    env: process.env,
    stdio: "inherit",
    maxBuffer: 64 * 1024 * 1024
  });
  compose(runtime, ["build", "postgres"]);
  return revision;
}

async function proveReferenceGeometryUpgrade(runtime: SampleRuntimeEnvironment): Promise<void> {
  const identity = sampleRuntimeIdentityFromValues(runtime.values);
  if (!identity.instanceId.startsWith("q-")) {
    throw new Error("Reference geometry upgrade proof requires a bounded q-* qualification instance");
  }
  await beginFreshQualification(runtime, "upgrade");
  materializeV063SemanticEvidence(runtime);
  await generate(runtime);
  const revision = buildImages(runtime);
  compose(runtime, ["up", "-d", "--no-build", "postgres"]);
  await waitForServicesHealthy(runtime, ["postgres"]);
  compose(runtime, [
    "run", "--rm", "--no-deps",
    "-e", "GOWM_MAXIMUM_MIGRATION_NUMBER=061",
    "sample-bootstrap"
  ]);
  compose(runtime, [
    "run", "--rm", "--no-deps", "sample-loader",
    "node", "dist/scripts/sample-world/database-cli.js", "load-db"
  ]);
  compose(runtime, [
    "run", "--rm", "--no-deps",
    "-e", `GOWM_QUALIFICATION_CANDIDATE_SHA=${revision}`,
    "sample-bootstrap", "node", "dist/validation/scripts/gowm-v064-upgrade-probe.js", "baseline"
  ]);
  compose(runtime, ["run", "--rm", "--no-deps", "sample-bootstrap"]);
  compose(runtime, [
    "run", "--rm", "--no-deps", "sample-bootstrap",
    "node", "dist/scripts/run-db-assertions.js"
  ]);
  compose(runtime, [
    "run", "--rm", "--no-deps",
    "-e", `GOWM_QUALIFICATION_CANDIDATE_SHA=${revision}`,
    "-e", "GOWM_V064_DB_ASSERTION_COUNT=45",
    "sample-bootstrap", "node", "dist/validation/scripts/gowm-v064-upgrade-probe.js", "upgraded"
  ]);
  process.stdout.write(`GOWM_V064_REFERENCE_GEOMETRY_UPGRADE_PASS candidate=${revision} migrations=61->62 assertions=45\n`);
}

async function writeReferenceComposabilityRuntimeEvidence(
  runtime: SampleRuntimeEnvironment
): Promise<void> {
  const identity = sampleRuntimeIdentityFromValues(runtime.values);
  if (!identity.instanceId.startsWith("q-")) {
    throw new Error("GOWM v0.6.4 runtime evidence requires a bounded q-* qualification instance");
  }
  const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: runtime.paths.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
  const before = await probeLiveSampleInstance(runtime, { expectedRevision: "v1" });
  compose(runtime, [
    "run", "--rm", "sample-loader",
    "node", "dist/scripts/sample-world/database-cli.js", "load-db"
  ]);
  const after = await probeLiveSampleInstance(runtime, { expectedRevision: "v1" });
  await writeGowmV064RuntimeEvidence({
    runtime,
    candidateCommit,
    idempotentStateHashBefore: before.loadedStateHash,
    idempotentStateHashAfter: after.loadedStateHash,
    freshClone: process.env.GOWM_V064_FRESH_CLONE === "YES",
    freshDatabase: process.env.GOWM_V064_FRESH_DATABASE === "YES",
    manualPatchApplied: process.env.GOWM_V064_MANUAL_PATCH_APPLIED === "YES"
  });
}

function down(runtime: SampleRuntimeEnvironment, destroyVolumes: boolean): void {
  if (!destroyVolumes) {
    compose(runtime, ["down", "--remove-orphans"]);
    process.stdout.write("SAMPLE_WORLD_DOWN_PASS volumes=PRESERVED\n");
    return;
  }
  const identity = sampleRuntimeIdentityFromValues(runtime.values);
  for (const volumeName of [identity.databaseVolumeName, identity.runtimeVolumeName]) {
    const inspection = dockerJson(["volume", "inspect", volumeName], true) as Array<{
      Name?: string;
      Labels?: Record<string, string>;
    }> | undefined;
    if (inspection?.[0] && (inspection[0].Name !== volumeName ||
        inspection[0].Labels?.["com.docker.compose.project"] !== identity.composeProjectName)) {
      throw new Error(`Refusing volume destruction because ${volumeName} ownership does not match`);
    }
  }
  compose(runtime, ["down", "--remove-orphans", "--volumes"]);
  process.stdout.write("SAMPLE_WORLD_DOWN_PASS volumes=DESTROYED\n");
}

async function status(runtime: SampleRuntimeEnvironment): Promise<void> {
  compose(runtime, ["ps"]);
  const live = await probeLiveSampleInstance(runtime);
  process.stdout.write(
    `GOWM_WSGS_TEST_INSTANCE_READY fixture=${live.fixtureId} realization=${live.realizationId} ` +
    `revision=${live.revision} requiredAvailable=${live.requiredAvailable} databaseMarker=${live.databaseMarker}\n`
  );
}

async function restartAndVerifyV2(runtime: SampleRuntimeEnvironment, options: {
  stage: string;
  services: string[];
  waitServices: string[];
  acceptance: string[];
}): Promise<Record<string, unknown>> {
  compose(runtime, ["restart", ...options.services]);
  await waitForServicesHealthy(runtime, options.waitServices);
  await waitForGateway(runtime);
  await verifySampleWorld({ runtime, expectedRevision: "v2" });
  process.stdout.write(
    `SAMPLE_WORLD_V2_RECOVERY_PASS stage=${options.stage} checks=v2-current,pinned-stale acceptance=${options.acceptance.join(",")}\n`
  );
  return {
    stage: options.stage,
    status: "PASS",
    checks: ["v2-current", "pinned-snapshot-stale"],
    acceptance: options.acceptance
  };
}

async function reset(runtime: SampleRuntimeEnvironment, options: { dryRun?: boolean } = {}): Promise<void> {
  sampleRuntimeIdentityFromValues(runtime.values);
  compose(runtime, ["run", "--rm", "sample-loader", "node", "dist/scripts/sample-world/database-cli.js", "reset-db",
    ...(options.dryRun ? ["--dry-run"] : [])]);
  if (options.dryRun) return;
  compose(runtime, ["run", "--rm", "sample-loader", "node", "dist/scripts/sample-world/database-cli.js", "load-db"]);
  // Reset removes the hidden-scope result fixture as intended. Recreate it through
  // the governed hidden principal before the final visible security canary so the
  // direct-ID non-disclosure check always targets an object that really exists.
  await verifyAuthLifecycle(runtime);
  await verifySampleWorld({ runtime });
  process.stdout.write("SAMPLE_WORLD_RESET_PASS\n");
}

async function verifyAuthLifecycle(runtime: SampleRuntimeEnvironment): Promise<void> {
  recreateGateway(runtime, {
    GATEWAY_AUTH_MODE: "STATIC_SERVICE",
    GOWM_WSGS_SAMPLE_TOKEN: runtime.values.GOWM_WSGS_SAMPLE_TOKEN!,
    GATEWAY_DATA_SCOPE_CLAIM: "wsgs-demo",
    GATEWAY_DATASET_SCOPE_CLAIM: "wsgs-demo-main"
  });
  await waitForGateway(runtime);
  await verifyStaticPrincipal({ runtime, principal: "VISIBLE" });

  recreateGateway(runtime, {
    GATEWAY_AUTH_MODE: "STATIC_SERVICE",
    GOWM_WSGS_SAMPLE_TOKEN: runtime.values.GOWM_WSGS_HIDDEN_TOKEN!,
    GATEWAY_DATA_SCOPE_CLAIM: "wsgs-hidden",
    GATEWAY_DATASET_SCOPE_CLAIM: "wsgs-hidden-main"
  });
  await waitForGateway(runtime);
  await verifyStaticPrincipal({ runtime, principal: "HIDDEN" });

  recreateGateway(runtime, {
    GATEWAY_AUTH_MODE: runtime.values.GATEWAY_AUTH_MODE!,
    GOWM_WSGS_SAMPLE_TOKEN: runtime.values.GOWM_WSGS_SAMPLE_TOKEN!,
    GATEWAY_DATA_SCOPE_CLAIM: runtime.values.GATEWAY_DATA_SCOPE_CLAIM!,
    GATEWAY_DATASET_SCOPE_CLAIM: runtime.values.GATEWAY_DATASET_SCOPE_CLAIM!
  });
  await waitForGateway(runtime);
  await verifySampleWorld({ runtime, signedSmokeOnly: true });
}

function recreateGateway(runtime: SampleRuntimeEnvironment, overrides: Record<string, string>): void {
  compose(runtime, ["up", "-d", "--force-recreate", "--no-deps", "world-capability-gateway"], overrides);
}

function compose(runtime: SampleRuntimeEnvironment, args: string[], overrides: Record<string, string> = {}): string {
  return execFileSync("docker", [
    "compose",
    "--env-file", runtime.paths.envPath,
    "-f", resolve(runtime.paths.root, "docker-compose.wsgs-sample.yml"),
    "--profile", "grounding-core",
    ...args
  ], {
    cwd: runtime.paths.root,
    env: { ...process.env, ...runtime.values, ...overrides },
    encoding: "utf8",
    stdio: args[0] === "ps" && !args.includes("--format") ? "inherit" : ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024
  }) as string;
}

function materializeV063SemanticEvidence(runtime: SampleRuntimeEnvironment): void {
  const script = resolve(runtime.paths.root, "scripts/materialize-capability-semantic-profiles.ts");
  const environment = {
    ...process.env,
    GOWM_REPORT_DIRECTORY: "reports/gowm-v0.6.3"
  };
  execFileSync(process.execPath, ["--import", "tsx", script, "--write"], {
    cwd: runtime.paths.root,
    env: environment,
    stdio: "inherit",
    maxBuffer: 64 * 1024 * 1024
  });
  execFileSync(process.execPath, ["--import", "tsx", script], {
    cwd: runtime.paths.root,
    env: environment,
    stdio: "inherit",
    maxBuffer: 64 * 1024 * 1024
  });
}

async function assertPromotedAttestationsProven(runtime: SampleRuntimeEnvironment): Promise<void> {
  const promoted = [
    "reference.get",
    "reference.resolve",
    "world.get-current-state",
    "world.get-geometry",
    "world.get-provenance",
    "catalog.get",
    "catalog.search",
    "spatial.find-nearby",
    "spatial.find-in-area",
    "spatial.find-intersections"
  ];
  for (const operationId of promoted) {
    const path = resolve(
      runtime.paths.root,
      `reports/gowm-v0.6.3/semantic-attestations/${operationId}@1.0.json`
    );
    const attestation = JSON.parse(await readFile(path, "utf8")) as {
      status?: string;
      evidence?: Array<{ kind?: string; symbol?: string }>;
    };
    if (attestation.status !== "PROVEN" ||
        !attestation.evidence?.some((record) => record.kind === "BLACK_BOX_TEST" && record.symbol === `${operationId}@1.0`)) {
      throw new Error(`Promoted operation lacks current real black-box admission: ${operationId}@1.0`);
    }
  }
  process.stdout.write(`SAMPLE_WORLD_PROMOTED_SEMANTICS_PROVEN operations=${promoted.length}\n`);
}

async function waitForServicesHealthy(runtime: SampleRuntimeEnvironment, services: string[]): Promise<void> {
  let last = "no service status returned";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const processes = parseComposeProcesses(compose(runtime, ["ps", "--format", "json", ...services]));
    const byService = new Map(processes.map((process) => [String(process.Service), process]));
    const pending = services.filter((service) => {
      const process = byService.get(service);
      return process?.State?.toLowerCase() !== "running" || process.Health?.toLowerCase() !== "healthy";
    });
    if (pending.length === 0) return;
    last = pending.join(",");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`Sample service health timeout: ${last}`);
}

function parseComposeProcesses(output: string): Array<{ Service?: string; State?: string; Health?: string }> {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed as { Service?: string; State?: string; Health?: string }];
  } catch {
    return trimmed.split(/\r?\n/u).filter(Boolean).map((line) =>
      JSON.parse(line) as { Service?: string; State?: string; Health?: string }
    );
  }
}

function dockerJson(args: string[], missingAllowed: boolean): unknown {
  try {
    const output = execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(output);
  } catch (error) {
    const stderr = String((error as { stderr?: string | Buffer }).stderr ?? "");
    if (missingAllowed && /No such volume:/u.test(stderr)) return undefined;
    throw error;
  }
}

async function beginFreshQualification(
  runtime: SampleRuntimeEnvironment,
  purpose: "upgrade" | "runtime"
): Promise<void> {
  const identity = sampleRuntimeIdentityFromValues(runtime.values);
  if (identity.instanceId === "shared") return;
  if (!identity.instanceId.startsWith("q-")) {
    throw new Error("Fresh qualification requires a bounded q-* instance identity");
  }
  const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: runtime.paths.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
  if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) {
    throw new Error("Qualification source commit is invalid");
  }
  const remotes = execFileSync("git", ["remote"], {
    cwd: runtime.paths.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).split(/\r?\n/u).filter(Boolean);
  if (remotes.length !== 0) {
    throw new Error("Fresh-clone qualification requires a detached local clone with no configured remotes");
  }
  assertQualificationBuildContextClean(runtime);
  const containerIds = execFileSync("docker", [
    "ps", "-aq", "--filter", `label=com.docker.compose.project=${identity.composeProjectName}`
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
    .split(/\r?\n/u).filter(Boolean);
  const volumeNames = execFileSync("docker", ["volume", "ls", "--format", "{{.Name}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).split(/\r?\n/u).filter(Boolean);
  const networkNames = execFileSync("docker", ["network", "ls", "--format", "{{.Name}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).split(/\r?\n/u).filter(Boolean);
  const expectedVolumes = [identity.databaseVolumeName, identity.runtimeVolumeName];
  const expectedNetworks = ["sample-debug", "sample-edge", "sample-internal"]
    .map((name) => `${identity.composeProjectName}_${name}`);
  const presentVolumes = expectedVolumes.filter((name) => volumeNames.includes(name));
  const presentNetworks = expectedNetworks.filter((name) => networkNames.includes(name));
  if (containerIds.length > 0 || presentVolumes.length > 0 || presentNetworks.length > 0) {
    throw new Error("Qualification resources already exist; refusing to represent a reused database as fresh");
  }
  await Promise.all([
    "UPGRADE_062_BASELINE.json",
    "UPGRADE_062_REPORT.json",
    "V064_RUNTIME_EVIDENCE.json",
    "QUALIFICATION_PREFLIGHT.json"
  ].map((name) => rm(resolve(runtime.paths.outputDirectory, name), { force: true })));
  const generatedAt = new Date().toISOString();
  const preflightCore = {
    schemaVersion: "1.0",
    targetVersion: "0.6.4",
    purpose,
    candidateCommit,
    runtimeInstanceId: identity.instanceId,
    qualificationRunId: randomUUID(),
    generatedAt,
    git: { remoteCount: 0, sourceContextClean: true },
    observedAbsent: {
      composeProjectContainers: 0,
      databaseVolumeAbsent: true,
      runtimeVolumeAbsent: true,
      composeNetworkCount: expectedNetworks.length,
      composeNetworksAbsent: true
    },
    resourceIdentityHash: `sha256:${createHash("sha256").update(JSON.stringify({
      composeProjectName: identity.composeProjectName,
      volumes: expectedVolumes,
      networks: expectedNetworks
    })).digest("hex")}`,
    status: "PASS"
  };
  const preflight = {
    ...preflightCore,
    evidenceHash: canonicalSha256(preflightCore)
  };
  await writeFile(
    resolve(runtime.paths.outputDirectory, "QUALIFICATION_PREFLIGHT.json"),
    `${JSON.stringify(preflight, null, 2)}\n`,
    "utf8"
  );
}

function assertQualificationBuildContextClean(runtime: SampleRuntimeEnvironment): void {
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: runtime.paths.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  const forbidden = status.split(/\r?\n/u).filter(Boolean)
    .map((line) => line.slice(3).replaceAll("\\", "/"))
    .filter((path) => !path.startsWith("reports/gowm-v0.6.3/"));
  if (forbidden.length > 0) {
    throw new Error(`Refusing to label a dirty image build context: ${forbidden.join(",")}`);
  }
}

async function waitForGateway(runtime: SampleRuntimeEnvironment): Promise<void> {
  let last: unknown;
  const baseUrl = sampleGatewayBaseUrl(runtime, {});
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      last = await response.text();
    } catch (error) {
      last = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`Gateway readiness timeout: ${String(last)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await runSampleWorldCommand(process.argv[2] ?? "status");
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
