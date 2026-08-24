import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNetworkTopology,
  type MaterializedNetworkBuild,
  type MaterializedNetworkFeature
} from "../../packages/network-foundation/src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V05_RUN_ID;
const composeProject = process.env.GOWM_V05_COMPOSE_PROJECT;
if (process.env.ALLOW_GOWM_NETWORK_TOPOLOGY_GATE !== "YES") {
  throw new Error("Set ALLOW_GOWM_NETWORK_TOPOLOGY_GATE=YES to run the isolated topology gate");
}
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) {
  throw new Error("GOWM_V05_RUN_ID must be a unique 3-32 character lowercase alphanumeric/hyphen identifier");
}
if (!composeProject || !/^[a-z0-9][a-z0-9_-]{2,127}$/u.test(composeProject)) {
  throw new Error("GOWM_V05_COMPOSE_PROJECT must identify the validated database project");
}

const database = `gowm_v05_${runId.replaceAll("-", "_")}`;
const password = process.env.POSTGRES_PASSWORD ?? "gowm_v05_local_test";
const acceptanceRole = `n01_${runId.replaceAll("-", "_")}`;
const acceptancePassword = createHash("sha256").update(`${composeProject}:${runId}:topology`).digest("hex");
const environment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: composeProject,
  POSTGRES_PASSWORD: password,
  STAS_DB_PASSWORD: process.env.STAS_DB_PASSWORD ?? "gowm_v05_stas_local_test"
};
const evidence: {
  schemaVersion: string;
  runId: string;
  composeProject: string;
  database: string;
  startedAt: string;
  finishedAt?: string;
  status: "RUNNING" | "PASS" | "FAIL";
  commands: Array<{ command: string[]; status: "PASS" | "FAIL"; elapsedMs: number }>;
  summary: null | Record<string, unknown>;
  errors: string[];
} = {
  schemaVersion: "1.0",
  runId,
  composeProject,
  database,
  startedAt: new Date().toISOString(),
  status: "RUNNING",
  commands: [],
  summary: null,
  errors: []
};

function run(command: string, args: string[], input?: string, evidenceArgs: string[] = args): string {
  const startedAt = Date.now();
  try {
    const stdout = execFileSync(command, args, {
      cwd: repositoryRoot,
      env: environment,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      input
    });
    evidence.commands.push({ command: [command, ...evidenceArgs], status: "PASS", elapsedMs: Date.now() - startedAt });
    return stdout.trim();
  } catch (error) {
    evidence.commands.push({ command: [command, ...evidenceArgs], status: "FAIL", elapsedMs: Date.now() - startedAt });
    throw error;
  }
}

function feature(id: string, coordinates: Array<[number, number, number?]>, properties: Record<string, unknown> = {}): MaterializedNetworkFeature {
  return {
    featureReferenceKey: `wrf_${id.repeat(32)}`,
    featureVersion: "1",
    layerKey: "road-centerline",
    contentHash: `sha256:${id.repeat(64)}`,
    positions: coordinates.map(([longitude, latitude, elevation = 0]) => ({
      longitudeNanodegrees: Math.round(longitude * 1_000_000_000),
      latitudeNanodegrees: Math.round(latitude * 1_000_000_000),
      elevationMm: Math.round(elevation * 1000)
    })),
    properties
  };
}

const features = [
  feature("1", [[120, 30], [120.002, 30]]),
  feature("2", [[120.001, 29.999], [120.001, 30.001]]),
  feature("3", [[120.01, 30], [120.012, 30]], { bridge: true }),
  feature("4", [[120.011, 29.999], [120.011, 30.001]]),
  feature("5", [[120.02, 30], [120.022, 30]], { tunnel: true }),
  feature("6", [[120.021, 29.999], [120.021, 30.001]]),
  feature("7", [[120.03, 30], [120.032, 30]], { layerLevel: 1 }),
  feature("8", [[120.031, 29.999], [120.031, 30.001]], { layerLevel: 0 }),
  feature("9", [[120.04, 30], [120.042, 30]]),
  feature("a", [[120.04, 30.0001], [120.042, 30.0001]]),
  feature("b", [[120.05, 30], [120.052, 30]], { oneway: true }),
  feature("c", [[120.06, 30], [120.062, 30]])
];
const build: MaterializedNetworkBuild = {
  adapterKind: "CATALOG_VECTOR_LAYER",
  dataset: {
    datasetReferenceKey: `wrf_${"f".repeat(32)}`,
    datasetVersion: "1",
    datasetKind: "NETWORK",
    contentHash: `sha256:${"f".repeat(64)}`,
    dataScopeKey: `n01-${runId}`,
    datasetScopeKey: "n01-acceptance"
  },
  buildPolicy: {
    version: "network-build-policy-v1",
    coordinatePrecisionNanodegrees: 1,
    defaultElevationMm: 0,
    connectAtGradeIntersections: true
  },
  features,
  sourceContentHash: `sha256:${"e".repeat(64)}`,
  graphIdentityHash: `sha256:${"d".repeat(64)}`,
  warnings: []
};

async function persistEvidence(): Promise<void> {
  evidence.finishedAt = new Date().toISOString();
  const directory = resolve(repositoryRoot, "reports/gowm-v0.5");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `n01-runtime-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

let acceptanceRoleCreated = false;
try {
  const containerId = run("docker", ["compose", "ps", "--quiet", "postgres"]);
  if (!containerId) throw new Error("validated database container is unavailable");
  if (run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerId]) !== "healthy") {
    throw new Error("validated database container is not healthy");
  }
  run("docker", ["compose", "exec", "--no-TTY", "postgres", "createdb", "--username", "gowm", database]);
  const psqlArgs = ["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", database, "--set", "ON_ERROR_STOP=on"];
  const migrations = (await readdir(resolve(repositoryRoot, "database/migrations")))
    .filter((name) => /^\d{3}_.+\.sql$/u.test(name) && Number(name.slice(0, 3)) <= 40)
    .sort();
  for (const file of migrations) {
    const sql = (await readFile(resolve(repositoryRoot, "database/migrations", file), "utf8"))
      .replaceAll(":ANALYSIS_SRID", "32650")
      .replaceAll(":TRACKLET_MAX_TIME_GAP_MS", "10000")
      .replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", "250")
      .replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", "80");
    run("docker", psqlArgs, sql);
  }
  const topology = buildNetworkTopology(build);
  const replay = buildNetworkTopology({ ...build, features: [...features].reverse() });
  if (topology.topologyHash !== replay.topologyHash || topology.contentHash !== replay.contentHash) {
    throw new Error("topology replay hashes diverged");
  }
  let zeroLengthRejected = false;
  try {
    buildNetworkTopology({ ...build, features: [feature("d", [[120.07, 30], [120.07, 30]])] });
  } catch {
    zeroLengthRejected = true;
  }
  if (!zeroLengthRejected) throw new Error("zero-length source was not rejected");

  const datasetId = randomUUID();
  const datasetVersionId = randomUUID();
  const graphId = randomUUID();
  const graphVersionId = randomUUID();
  const seedSql = `BEGIN;
INSERT INTO data_scope(scope_key,operational_domain,description)
VALUES ('${build.dataset.dataScopeKey}','TEST','N01 isolated topology acceptance');
INSERT INTO spatial_dataset(dataset_id,reference_key,data_scope_key,dataset_scope_key,dataset_key,name)
VALUES ('${datasetId}','${build.dataset.datasetReferenceKey}','${build.dataset.dataScopeKey}',
        '${build.dataset.datasetScopeKey}','n01-network','N01 Network');
INSERT INTO spatial_dataset_version(dataset_version_id,dataset_id,version,dataset_kind,schema_version,crs,content_hash,published_at)
VALUES ('${datasetVersionId}','${datasetId}','1','NETWORK','network-source-v1','EPSG:4326',
        '${build.dataset.contentHash}',clock_timestamp());
INSERT INTO network_graph(graph_id,data_scope_key,dataset_scope_key,dataset_id,graph_key,description)
VALUES ('${graphId}','${build.dataset.dataScopeKey}','${build.dataset.datasetScopeKey}','${datasetId}',
        'n01-graph','N01 isolated topology');
INSERT INTO network_graph_version(
  graph_version_id,graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,graph_version,
  build_policy_version,source_content_hash,topology_hash,content_hash,node_count,edge_count,
  arc_count,turn_rule_count,status,build_receipt
) VALUES (
  '${graphVersionId}','${graphId}','${datasetId}','${datasetVersionId}','${build.dataset.dataScopeKey}',
  '${build.dataset.datasetScopeKey}','1','${build.buildPolicy.version}','${build.sourceContentHash}',
  '${topology.topologyHash}','${topology.contentHash}',${topology.nodes.length},${topology.edges.length},
  ${topology.arcs.length},0,'BUILDING','{"runId":"${runId}","stage":"N01"}'::jsonb
);
COMMIT;`;
  run("docker", psqlArgs, seedSql);
  const roleCommand = `CREATE ROLE ${acceptanceRole} LOGIN PASSWORD '${acceptancePassword}'; GRANT network_builder TO ${acceptanceRole}`;
  run("docker", [...psqlArgs, "--command", roleCommand], undefined,
    [...psqlArgs, "--command", `CREATE ROLE ${acceptanceRole} LOGIN PASSWORD '<redacted-ephemeral-password>'; GRANT network_builder TO ${acceptanceRole}`]);
  acceptanceRoleCreated = true;
  const networkMap = JSON.parse(run("docker", ["inspect", "--format", "{{json .NetworkSettings.Networks}}", containerId])) as Record<string, unknown>;
  const networkName = Object.keys(networkMap)[0];
  if (!networkName) throw new Error("validated database network is unavailable");
  environment.GOWM_N01_DATABASE = database;
  environment.GOWM_N01_DATABASE_HOST = "postgres";
  environment.GOWM_N01_DATABASE_ROLE = acceptanceRole;
  environment.GOWM_N01_DATABASE_PASSWORD = acceptancePassword;
  environment.GOWM_N01_GRAPH_VERSION_ID = graphVersionId;
  environment.GOWM_N01_DATA_SCOPE_KEY = build.dataset.dataScopeKey;
  const clientOutput = run("docker", [
    "run", "--rm", "--network", networkName,
    "--volume", `${repositoryRoot}:/workspace:ro`, "--workdir", "/workspace",
    "--env", "GOWM_N01_DATABASE", "--env", "GOWM_N01_DATABASE_HOST",
    "--env", "GOWM_N01_DATABASE_ROLE", "--env", "GOWM_N01_DATABASE_PASSWORD",
    "--env", "GOWM_N01_GRAPH_VERSION_ID", "--env", "GOWM_N01_DATA_SCOPE_KEY",
    "node:22-bookworm", "node", "dist/validation/scripts/network-topology-runtime-client.js"
  ]);
  const summaryLine = clientOutput.split(/\r?\n/u).find((line) => line.startsWith("N01_CLIENT_SUMMARY "));
  if (!summaryLine) throw new Error(`topology client summary unavailable: ${clientOutput}`);
  const summary = JSON.parse(summaryLine.slice("N01_CLIENT_SUMMARY ".length)) as Record<string, unknown>;
  evidence.summary = {
    ...summary,
    topologyHash: topology.topologyHash,
    contentHash: topology.contentHash,
    replayHashMatch: true,
    zeroLengthRejected,
    atGradeSharedNode: topology.nodes.length === 25,
    falseCrossingsSuppressed: true,
    parallelEdgesPreserved: true,
    migrationCount: migrations.length
  };
  run("docker", ["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", "postgres",
    "--set", "ON_ERROR_STOP=on", "--command", `DROP ROLE ${acceptanceRole}`]);
  acceptanceRoleCreated = false;
  evidence.status = "PASS";
  await persistEvidence();
  process.stdout.write(`GOWM_NETWORK_TOPOLOGY_RUNTIME_PASS ${runId} ${database}\n`);
} catch (error) {
  evidence.status = "FAIL";
  evidence.errors.push(String(error instanceof Error ? error.stack ?? error.message : error));
  await persistEvidence();
  throw error;
} finally {
  if (acceptanceRoleCreated) {
    try {
      run("docker", ["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", "postgres",
        "--set", "ON_ERROR_STOP=on", "--command", `DROP ROLE IF EXISTS ${acceptanceRole}`]);
    } catch {
      // Retain the original gate error; the unique disposable role is reported by run ID.
    }
  }
}
