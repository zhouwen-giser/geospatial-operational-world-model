import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V05_RUN_ID;
const composeProject = process.env.GOWM_V05_COMPOSE_PROJECT;
const sourceDatabase = process.env.GOWM_N04_SOURCE_DATABASE ?? "gowm_v05_n03_20260825t0158";
if (process.env.ALLOW_GOWM_NETWORK_ACTIVATION_GATE !== "YES") throw new Error("Set ALLOW_GOWM_NETWORK_ACTIVATION_GATE=YES");
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("invalid GOWM_V05_RUN_ID");
if (!composeProject || !/^[a-z0-9][a-z0-9_-]{2,127}$/u.test(composeProject)) throw new Error("invalid GOWM_V05_COMPOSE_PROJECT");
if (!/^gowm_v05_[a-z0-9_]+$/u.test(sourceDatabase)) throw new Error("invalid GOWM_N04_SOURCE_DATABASE");

const database = `gowm_v05_${runId.replaceAll("-", "_")}`;
const role = `n04_${runId.replaceAll("-", "_")}`;
const password = createHash("sha256").update(`${composeProject}:${runId}:activation`).digest("hex");
const environment: NodeJS.ProcessEnv = { ...process.env, COMPOSE_PROJECT_NAME: composeProject,
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? "gowm_v05_local_test",
  STAS_DB_PASSWORD: process.env.STAS_DB_PASSWORD ?? "gowm_v05_stas_local_test" };
const evidence: { schemaVersion: string; runId: string; composeProject: string; sourceDatabase: string; database: string;
  startedAt: string; finishedAt?: string; status: "RUNNING" | "PASS" | "FAIL";
  commands: Array<{ command: string[]; status: "PASS" | "FAIL"; elapsedMs: number }>;
  summary: null | Record<string, unknown>; errors: string[] } = {
  schemaVersion: "1.0", runId, composeProject, sourceDatabase, database,
  startedAt: new Date().toISOString(), status: "RUNNING", commands: [], summary: null, errors: [] };

function run(command: string, args: string[], evidenceArgs: string[] = args): string {
  const startedAt = Date.now();
  try {
    const output = execFileSync(command, args, { cwd: repositoryRoot, env: environment, encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    evidence.commands.push({ command: [command, ...evidenceArgs], status: "PASS", elapsedMs: Date.now() - startedAt });
    return output.trim();
  } catch (error) {
    evidence.commands.push({ command: [command, ...evidenceArgs], status: "FAIL", elapsedMs: Date.now() - startedAt });
    throw error;
  }
}

async function persist(): Promise<void> {
  evidence.finishedAt = new Date().toISOString();
  const directory = resolve(repositoryRoot, "reports/gowm-v0.5");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `n04-runtime-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

let roleCreated = false;
try {
  const containerId = run("docker", ["compose", "ps", "--quiet", "postgres"]);
  if (!containerId) throw new Error("validated database container is unavailable");
  if (run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerId]) !== "healthy") throw new Error("database is not healthy");
  run("docker", ["compose", "exec", "--no-TTY", "postgres", "createdb", "--username", "gowm", "--template", sourceDatabase, database]);
  const psql = ["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", database, "--set", "ON_ERROR_STOP=on", "--command"];
  const migration = await readFile(resolve(repositoryRoot, "database/migrations/043_network_atomic_activation_management.sql"), "utf8");
  run("docker", [...psql, migration], [...psql, "<migration 043_network_atomic_activation_management.sql>"]);
  const seed = `DO $seed$ DECLARE d uuid; dv uuid; l uuid; lv uuid; f7 uuid; f8 uuid; BEGIN
    SELECT dataset_id,dataset_version_id INTO STRICT d,dv FROM spatial_dataset_version WHERE version='1' AND dataset_kind='NETWORK' ORDER BY created_at LIMIT 1;
    INSERT INTO spatial_layer(dataset_id,data_scope_key,dataset_scope_key,layer_key,name)
      SELECT d,data_scope_key,dataset_scope_key,'n04-road-centerline','N04 Road Centerline' FROM spatial_dataset WHERE dataset_id=d RETURNING layer_id INTO l;
    INSERT INTO spatial_layer_version(layer_id,dataset_id,dataset_version_id,version,layer_type,geometry_type,schema_version,crs,content_hash,published_at)
      VALUES(l,d,dv,'1','VECTOR_FEATURE','LineString','1.0','EPSG:4326','sha256:'||repeat('9',64),clock_timestamp()) RETURNING layer_version_id INTO lv;
    INSERT INTO spatial_feature_identity(reference_key,layer_id,data_scope_key,dataset_scope_key,feature_key,feature_type)
      SELECT 'wrf_'||repeat('7',32),l,data_scope_key,dataset_scope_key,'n04-road-7','ROAD' FROM spatial_dataset WHERE dataset_id=d RETURNING feature_id INTO f7;
    INSERT INTO spatial_feature_identity(reference_key,layer_id,data_scope_key,dataset_scope_key,feature_key,feature_type)
      SELECT 'wrf_'||repeat('8',32),l,data_scope_key,dataset_scope_key,'n04-road-8','ROAD' FROM spatial_dataset WHERE dataset_id=d RETURNING feature_id INTO f8;
    INSERT INTO spatial_feature_version(feature_id,layer_id,layer_version_id,version,geometry,properties,content_hash,published_at) VALUES
      (f7,l,lv,'1',ST_GeomFromText('LINESTRING (0 0,0.001 0)',4326),'{}','sha256:'||repeat('7',64),clock_timestamp()),
      (f8,l,lv,'1',ST_GeomFromText('LINESTRING (0.001 0,0.002 0)',4326),'{}','sha256:'||repeat('8',64),clock_timestamp());
  END $seed$;`;
  run("docker", [...psql, seed], [...psql, "<N04 Catalog source fixture>"]);
  const roleSql = `CREATE ROLE ${role} LOGIN PASSWORD '${password}'; GRANT network_builder TO ${role}`;
  run("docker", [...psql, roleSql], [...psql, `CREATE ROLE ${role} LOGIN PASSWORD '<redacted-ephemeral-password>'; GRANT network_builder TO ${role}`]);
  roleCreated = true;
  const networkMap = JSON.parse(run("docker", ["inspect", "--format", "{{json .NetworkSettings.Networks}}", containerId])) as Record<string, unknown>;
  const networkName = Object.keys(networkMap)[0];
  if (!networkName) throw new Error("database network is unavailable");
  environment.GOWM_N04_RUN_ID = runId; environment.GOWM_N04_DATABASE = database;
  environment.GOWM_N04_DATABASE_HOST = "postgres"; environment.GOWM_N04_DATABASE_ROLE = role;
  environment.GOWM_N04_DATABASE_PASSWORD = password;
  const output = run("docker", ["run", "--rm", "--network", networkName, "--volume", `${repositoryRoot}:/workspace:ro`, "--workdir", "/workspace",
    "--env", "GOWM_N04_RUN_ID", "--env", "GOWM_N04_DATABASE", "--env", "GOWM_N04_DATABASE_HOST", "--env", "GOWM_N04_DATABASE_ROLE", "--env", "GOWM_N04_DATABASE_PASSWORD",
    "node:22-bookworm", "node", "dist/validation/scripts/network-activation-runtime-client.js"]);
  const summaryLine = output.split(/\r?\n/u).find((line) => line.startsWith("N04_CLIENT_SUMMARY "));
  if (!summaryLine) throw new Error(`N04 client summary unavailable: ${output}`);
  evidence.summary = JSON.parse(summaryLine.slice("N04_CLIENT_SUMMARY ".length)) as Record<string, unknown>;
  run("docker", ["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", "postgres", "--set", "ON_ERROR_STOP=on", "--command", `DROP ROLE ${role}`]);
  roleCreated = false; evidence.status = "PASS"; await persist();
  process.stdout.write(`GOWM_NETWORK_ACTIVATION_RUNTIME_PASS ${runId} ${database}\n`);
} catch (error) {
  evidence.status = "FAIL"; evidence.errors.push(String(error instanceof Error ? error.stack ?? error.message : error)); await persist(); throw error;
} finally {
  if (roleCreated) try { run("docker", ["compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm", "--dbname", "postgres", "--set", "ON_ERROR_STOP=on", "--command", `DROP ROLE IF EXISTS ${role}`]); } catch { /* retain primary result */ }
}
