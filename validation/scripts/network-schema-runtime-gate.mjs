import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V05_RUN_ID;
const composeProject = process.env.GOWM_V05_COMPOSE_PROJECT;
const migrationMaximum = Number(process.env.GOWM_V05_MIGRATION_MAX ?? "999");
const assertionMaximum = Number(process.env.GOWM_V05_ASSERTION_MAX ?? "999");
if (process.env.ALLOW_GOWM_NETWORK_SCHEMA_GATE !== "YES") {
  throw new Error("Set ALLOW_GOWM_NETWORK_SCHEMA_GATE=YES to run the isolated network schema gate");
}
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) {
  throw new Error("GOWM_V05_RUN_ID must be a unique 3-32 character lowercase alphanumeric/hyphen identifier");
}
if (!composeProject || !/^[a-z0-9][a-z0-9_-]{2,127}$/u.test(composeProject)) {
  throw new Error("GOWM_V05_COMPOSE_PROJECT must identify the isolated validated database project");
}
if (!Number.isInteger(migrationMaximum) || migrationMaximum < 1 ||
    !Number.isInteger(assertionMaximum) || assertionMaximum < 1) {
  throw new Error("GOWM_V05_MIGRATION_MAX and GOWM_V05_ASSERTION_MAX must be positive integers");
}

const database = `gowm_v05_${runId.replaceAll("-", "_")}`;
const environment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: composeProject,
  POSTGRES_PASSWORD: "gowm_v05_local_test",
  STAS_DB_PASSWORD: "gowm_v05_stas_local_test"
};
const evidence = {
  schemaVersion: "1.0",
  runId,
  composeProject,
  database,
  migrationMaximum,
  assertionMaximum,
  startedAt: new Date().toISOString(),
  status: "RUNNING",
  commands: [],
  summary: null,
  errors: []
};

function run(command, args, options = {}) {
  const startedAt = Date.now();
  const evidenceCommand = options.evidenceCommand ?? [command, ...args];
  try {
    const stdout = execFileSync(command, args, {
      cwd: repositoryRoot,
      env: environment,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      input: options.input
    });
    evidence.commands.push({ command: evidenceCommand, status: "PASS", elapsedMs: Date.now() - startedAt });
    return stdout.trim();
  } catch (error) {
    evidence.commands.push({ command: evidenceCommand, status: "FAIL", elapsedMs: Date.now() - startedAt });
    evidence.errors.push(String(error.stderr || error.message || error));
    throw error;
  }
}

async function persist() {
  evidence.finishedAt = new Date().toISOString();
  const directory = resolve(repositoryRoot, "reports/gowm-v0.5");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `d01-d02-runtime-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

try {
  const containerId = run("docker", ["compose", "ps", "--quiet", "postgres"]);
  if (!containerId) throw new Error("validated database container is unavailable");
  const health = run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerId]);
  if (health !== "healthy") throw new Error(`validated database container is not healthy: ${health}`);

  run("docker", ["compose", "exec", "--no-TTY", "postgres", "createdb", "--username", "gowm", database]);
  const psqlArgs = [
    "compose", "exec", "--no-TTY", "postgres", "psql", "--username", "gowm",
    "--dbname", database, "--set", "ON_ERROR_STOP=on"
  ];
  const migrations = (await readdir(resolve(repositoryRoot, "database/migrations")))
    .filter((name) => /^\d{3}_.+\.sql$/u.test(name) && Number(name.slice(0, 3)) <= migrationMaximum)
    .sort();
  for (const file of migrations) {
    const template = await readFile(resolve(repositoryRoot, "database/migrations", file), "utf8");
    const sql = template
      .replaceAll(":ANALYSIS_SRID", "32650")
      .replaceAll(":TRACKLET_MAX_TIME_GAP_MS", "10000")
      .replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", "250")
      .replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", "80");
    run("docker", psqlArgs, { input: sql, evidenceCommand: ["migration", file] });
  }

  const assertions = (await readdir(resolve(repositoryRoot, "database/tests")))
    .filter((name) => /^\d{3}_.+_assertions\.sql$/u.test(name) && Number(name.slice(0, 3)) <= assertionMaximum)
    .sort();
  for (const file of assertions) {
    const sql = await readFile(resolve(repositoryRoot, "database/tests", file), "utf8");
    run("docker", psqlArgs, { input: sql, evidenceCommand: ["assertion", file] });
  }

  const summarySql = `SELECT jsonb_build_object(
    'migrationCount', ${migrations.length},
    'assertionCount', ${assertions.length},
    'networkTables', (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'network_%'),
    'readViews', (SELECT count(*) FROM information_schema.views WHERE table_schema='gowm_network_v1'),
    'networkProviderReadOnly', CASE WHEN ${migrationMaximum} >= 39 THEN
      (SELECT rolconfig @> ARRAY['default_transaction_read_only=on'] FROM pg_roles WHERE rolname='network_provider')
      ELSE NULL END,
    'routePlannerReadOnly', CASE WHEN ${migrationMaximum} >= 39 THEN
      (SELECT rolconfig @> ARRAY['default_transaction_read_only=on'] FROM pg_roles WHERE rolname='route_planner_provider')
      ELSE NULL END
  );`;
  const output = run("docker", [...psqlArgs, "--tuples-only", "--no-align", "--command", summarySql]);
  const summaryLine = output.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.startsWith("{"));
  if (!summaryLine) throw new Error(`network schema summary not found: ${output}`);
  evidence.summary = JSON.parse(summaryLine);
  evidence.status = "PASS";
  await persist();
  process.stdout.write(`GOWM_NETWORK_SCHEMA_RUNTIME_PASS ${runId} ${database}\n`);
} catch (error) {
  evidence.status = "FAIL";
  evidence.errors.push(String(error?.message ?? error));
  await persist();
  throw error;
}
