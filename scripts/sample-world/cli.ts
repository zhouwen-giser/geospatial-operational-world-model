import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticSourceFingerprint } from "../../packages/platform/semantic-conformance/src/index.js";
import { admitSampleSemanticEvidence } from "./admit-semantic-evidence.js";
import { loadSampleWorldDatabase, mutateSampleWorldDatabase, resetSampleWorldDatabase } from "./database.js";
import { realizeSampleWorld } from "./model.js";
import { buildSampleHandoff } from "./handoff.js";
import { probeLiveSampleInstance } from "./readiness.js";
import { ensureSampleRuntimeEnvironment, type SampleRuntimeEnvironment } from "./runtime.js";
import { verifySampleWorld, verifyStaticPrincipal } from "./verify.js";

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
      await waitForGateway();
      break;
    case "wait":
      await waitForGateway();
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
    case "all":
      await all(runtime);
      break;
    default:
      throw new Error(`Unknown sample-world command: ${command}`);
  }
}

async function all(runtime: SampleRuntimeEnvironment): Promise<void> {
  // The image, generated catalog fixture, and later admission must all consume
  // the same deterministic semantic materialization bytes.
  materializeV063SemanticEvidence(runtime);
  await generate(runtime);
  up(runtime, true);
  await waitForGateway();
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
  await waitForGateway();
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
  const admittedSourceDigest = await admitSampleSemanticEvidence(runtime.paths.root);
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
  if (build) {
    execFileSync("docker", ["build", "--tag", "gowm-wsgs-sample:0.6.4", "."], {
      cwd: runtime.paths.root,
      env: process.env,
      stdio: "inherit",
      maxBuffer: 64 * 1024 * 1024
    });
    compose(runtime, ["build", "postgres"]);
  }
  compose(runtime, ["up", "-d", "--no-build", ...CORE_SERVICES]);
}

function down(runtime: SampleRuntimeEnvironment, destroyVolumes: boolean): void {
  if (!destroyVolumes) {
    compose(runtime, ["down", "--remove-orphans"]);
    process.stdout.write("SAMPLE_WORLD_DOWN_PASS volumes=PRESERVED\n");
    return;
  }
  if (runtime.values.COMPOSE_PROJECT_NAME !== "gowm-wsgs-sample" || runtime.values.POSTGRES_DB !== "gowm_wsgs_sample") {
    throw new Error("Refusing volume destruction because the isolated instance markers do not match");
  }
  for (const volumeName of ["gowm-wsgs-sample-db", "gowm-wsgs-sample-runtime"]) {
    const inspection = dockerJson(["volume", "inspect", volumeName], true) as Array<{
      Name?: string;
      Labels?: Record<string, string>;
    }> | undefined;
    if (inspection?.[0] && (inspection[0].Name !== volumeName ||
        inspection[0].Labels?.["com.docker.compose.project"] !== "gowm-wsgs-sample")) {
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
  await waitForGateway();
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
  if (runtime.values.COMPOSE_PROJECT_NAME !== "gowm-wsgs-sample" || runtime.values.POSTGRES_DB !== "gowm_wsgs_sample") {
    throw new Error("Refusing reset because the isolated instance markers do not match");
  }
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
  await waitForGateway();
  await verifyStaticPrincipal({ runtime, principal: "VISIBLE" });

  recreateGateway(runtime, {
    GATEWAY_AUTH_MODE: "STATIC_SERVICE",
    GOWM_WSGS_SAMPLE_TOKEN: runtime.values.GOWM_WSGS_HIDDEN_TOKEN!,
    GATEWAY_DATA_SCOPE_CLAIM: "wsgs-hidden",
    GATEWAY_DATASET_SCOPE_CLAIM: "wsgs-hidden-main"
  });
  await waitForGateway();
  await verifyStaticPrincipal({ runtime, principal: "HIDDEN" });

  recreateGateway(runtime, {
    GATEWAY_AUTH_MODE: runtime.values.GATEWAY_AUTH_MODE!,
    GOWM_WSGS_SAMPLE_TOKEN: runtime.values.GOWM_WSGS_SAMPLE_TOKEN!,
    GATEWAY_DATA_SCOPE_CLAIM: runtime.values.GATEWAY_DATA_SCOPE_CLAIM!,
    GATEWAY_DATASET_SCOPE_CLAIM: runtime.values.GATEWAY_DATASET_SCOPE_CLAIM!
  });
  await waitForGateway();
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
    env: { ...process.env, ...overrides },
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
    if (missingAllowed) return undefined;
    throw error;
  }
}

async function waitForGateway(): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:18063/health/ready", { signal: AbortSignal.timeout(2_000) });
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
  runSampleWorldCommand(process.argv[2] ?? "status").catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
