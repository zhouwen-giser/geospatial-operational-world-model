import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
const container = process.env.GOWM_V06_POSTGRES_CONTAINER;

if (process.env.ALLOW_GOWM_COVERAGE_SCHEMA_GATE !== "YES") {
  throw new Error("Set ALLOW_GOWM_COVERAGE_SCHEMA_GATE=YES to run the isolated coverage schema gate");
}
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) {
  throw new Error("GOWM_V06_RUN_ID must be a unique 3-32 character lowercase alphanumeric/hyphen identifier");
}
if (!container || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/u.test(container)) {
  throw new Error("GOWM_V06_POSTGRES_CONTAINER must be the exact validated PostgreSQL container name");
}

const databaseSuffix = runId.replaceAll("-", "_");
const freshDatabase = `gowm_v06_fresh_${databaseSuffix}`;
const upgradeDatabase = `gowm_v06_upgrade_${databaseSuffix}`;
const databases = [freshDatabase, upgradeDatabase];
if (databases.some((database) => !/^gowm_v06_(fresh|upgrade)_[a-z0-9_]{3,32}$/u.test(database))) {
  throw new Error("derived database names escaped the isolated gowm_v06 namespace");
}

const evidence = {
  schemaVersion: "1.0",
  runId,
  container,
  databases: { fresh: freshDatabase, upgrade: upgradeDatabase },
  startedAt: new Date().toISOString(),
  status: "RUNNING",
  commands: [],
  summary: null,
  cleanup: [],
  errors: []
};
const createdDatabases = new Set();

function run(command, args, options = {}) {
  const startedAt = Date.now();
  const evidenceCommand = options.evidenceCommand ?? [command, ...args];
  try {
    const stdout = execFileSync(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
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

function runPsql(database, sql, label, extraArgs = []) {
  return run(
    "docker",
    ["exec", "--interactive", container, "psql", "--username", "gowm", "--dbname", database,
      "--set", "ON_ERROR_STOP=on", ...extraArgs],
    { input: sql, evidenceCommand: [label, database] }
  );
}

function expectPsqlFailure(database, sql, label) {
  const startedAt = Date.now();
  const result = spawnSync(
    "docker",
    ["exec", "--interactive", container, "psql", "--username", "gowm", "--dbname", database,
      "--set", "ON_ERROR_STOP=on"],
    { cwd: repositoryRoot, env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, input: sql }
  );
  if (result.error) throw result.error;
  if (result.status === 0) {
    evidence.commands.push({ command: [label, database], status: "UNEXPECTED_PASS", elapsedMs: Date.now() - startedAt });
    throw new Error(`${label} unexpectedly succeeded`);
  }
  evidence.commands.push({
    command: [label, database],
    status: "EXPECTED_FAIL",
    elapsedMs: Date.now() - startedAt,
    exitCode: result.status
  });
}

function substituteMigration(source) {
  return source
    .replaceAll(":ANALYSIS_SRID", "32650")
    .replaceAll(":TRACKLET_MAX_TIME_GAP_MS", "10000")
    .replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", "250")
    .replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", "80");
}

async function applyMigrations(database, migrations) {
  const batch = [];
  for (const file of migrations) {
    const source = await readFile(resolve(repositoryRoot, "database/migrations", file), "utf8");
    const sql = substituteMigration(source);
    const checksum = createHash("sha256").update(sql).digest("hex");
    batch.push(`\\echo APPLY_MIGRATION ${file}\n${sql}\n` +
      `INSERT INTO schema_migration(version,checksum) VALUES ('${file}','${checksum}');`);
  }
  runPsql(database, batch.join("\n"),
    `migration-batch:${migrations.at(0)}..${migrations.at(-1)}`);
}

async function runAssertions(database, assertions) {
  const batch = [];
  for (const file of assertions) {
    const sql = await readFile(resolve(repositoryRoot, "database/tests", file), "utf8");
    batch.push(`\\echo RUN_ASSERTION ${file}\n${sql}`);
  }
  runPsql(database, batch.join("\n"),
    `assertion-batch:${assertions.at(0)}..${assertions.at(-1)}`);
}

function databaseExists(database) {
  const output = run(
    "docker",
    ["exec", container, "psql", "--username", "gowm", "--dbname", "postgres", "--tuples-only", "--no-align",
      "--command", `SELECT count(*) FROM pg_database WHERE datname='${database}'`],
    { evidenceCommand: ["database-exists", database] }
  );
  return output === "1";
}

function createDatabase(database) {
  if (databaseExists(database)) {
    throw new Error(`refusing to reuse existing isolated database name: ${database}`);
  }
  run("docker", ["exec", container, "createdb", "--username", "gowm", "--owner", "gowm", database], {
    evidenceCommand: ["create-isolated-database", database]
  });
  createdDatabases.add(database);
}

function parseJsonOutput(output, label) {
  const line = output.split(/\r?\n/u).map((value) => value.trim()).find((value) => value.startsWith("{"));
  if (!line) throw new Error(`${label} JSON output not found: ${output}`);
  return JSON.parse(line);
}

async function persist() {
  evidence.finishedAt = new Date().toISOString();
  const directory = resolve(repositoryRoot, "reports/gowm-v0.6");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `d00-runtime-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

let failure;
try {
  const health = run("docker", ["inspect", "--format",
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", container]);
  if (health !== "healthy") throw new Error(`validated PostgreSQL container is not healthy: ${health}`);

  const migrations = (await readdir(resolve(repositoryRoot, "database/migrations")))
    .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
    .sort();
  const assertions = (await readdir(resolve(repositoryRoot, "database/tests")))
    .filter((name) => /^\d{3}_.+_assertions\.sql$/u.test(name))
    .sort();
  if (migrations.length !== 50 || migrations.at(-1)?.slice(0, 3) !== "050") {
    throw new Error(`expected the current v0.6 migration set 001-050, received ${migrations.length}`);
  }
  if (assertions.length !== 35 || assertions.at(-1)?.slice(0, 3) !== "035") {
    throw new Error(`expected the current v0.6 assertion set 001-035, received ${assertions.length}`);
  }

  createDatabase(freshDatabase);
  await applyMigrations(freshDatabase, migrations);
  await runAssertions(freshDatabase, assertions);

  createDatabase(upgradeDatabase);
  const predecessorMigrations = migrations.filter((name) => Number(name.slice(0, 3)) <= 47);
  const coverageMigrations = migrations.filter((name) => Number(name.slice(0, 3)) >= 48);
  await applyMigrations(upgradeDatabase, predecessorMigrations);
  runPsql(
    upgradeDatabase,
    "CREATE TABLE gowm_v06_upgrade_preservation_probe(id integer PRIMARY KEY, marker text NOT NULL); " +
      "INSERT INTO gowm_v06_upgrade_preservation_probe VALUES (1,'v0.5-preserved');",
    "create-upgrade-preservation-probe"
  );
  await applyMigrations(upgradeDatabase, coverageMigrations);
  await runAssertions(upgradeDatabase, assertions);

  for (const database of databases) {
    expectPsqlFailure(
      database,
      "BEGIN; CREATE SCHEMA coverage_failed_migration_runtime; " +
        "CREATE TABLE coverage_failed_migration_runtime.partial(id integer); " +
        "SELECT 1/0; COMMIT;",
      "deliberate-migration-failure"
    );
    const residue = runPsql(
      database,
      "SELECT count(*) FROM pg_namespace WHERE nspname='coverage_failed_migration_runtime';",
      "verify-failed-migration-rollback",
      ["--tuples-only", "--no-align"]
    );
    if (residue !== "0") throw new Error(`failed migration left residue in ${database}`);
  }

  const summarySql = (upgrade) => `SELECT jsonb_build_object(
    'migrationCount',(SELECT count(*) FROM schema_migration),
    'coverageTables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='coverage_planner'),
    'coverageFunctions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='coverage_planner'),
    'providerExecutableFunctions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='coverage_planner' AND has_function_privilege('coverage_planner_provider',p.oid,'EXECUTE')),
    'providerDirectMutation',has_table_privilege('coverage_planner_provider','coverage_planner.coverage_request','INSERT,UPDATE,DELETE'),
    'providerNetworkMutation',has_table_privilege('coverage_planner_provider','public.network_arc','INSERT,UPDATE,DELETE'),
    'upgradeMarker',${upgrade ? "(SELECT marker FROM gowm_v06_upgrade_preservation_probe WHERE id=1)" : "NULL"}
  );`;
  const freshSummary = parseJsonOutput(
    runPsql(freshDatabase, summarySql(false), "fresh-summary", ["--tuples-only", "--no-align"]),
    "fresh summary"
  );
  const upgradeSummary = parseJsonOutput(
    runPsql(upgradeDatabase, summarySql(true), "upgrade-summary", ["--tuples-only", "--no-align"]),
    "upgrade summary"
  );
  for (const [kind, summary] of [["fresh", freshSummary], ["upgrade", upgradeSummary]]) {
    if (summary.migrationCount !== 50 || summary.coverageTables !== 16 || summary.coverageFunctions !== 9 ||
        summary.providerExecutableFunctions !== 7 ||
        summary.providerDirectMutation !== false || summary.providerNetworkMutation !== false) {
      throw new Error(`${kind} database summary failed the D00 invariant set: ${JSON.stringify(summary)}`);
    }
  }
  if (upgradeSummary.upgradeMarker !== "v0.5-preserved") {
    throw new Error("upgrade database did not preserve the v0.5 marker");
  }
  evidence.summary = {
    migrations: migrations.length,
    assertions: assertions.length,
    fresh: freshSummary,
    upgrade: upgradeSummary,
    deliberateFailureRollback: true
  };
  evidence.status = "PASS";
} catch (error) {
  failure = error;
  evidence.status = "FAIL";
  evidence.errors.push(String(error?.message ?? error));
} finally {
  for (const database of [...createdDatabases].reverse()) {
    try {
      run("docker", ["exec", container, "dropdb", "--username", "gowm", "--if-exists", database], {
        evidenceCommand: ["drop-isolated-database", database]
      });
      evidence.cleanup.push({ database, status: "PASS" });
    } catch (error) {
      evidence.cleanup.push({ database, status: "FAIL", error: String(error?.message ?? error) });
      evidence.status = "FAIL";
      failure ??= error;
    }
  }
  await persist();
}

if (failure) throw failure;
process.stdout.write(`GOWM_COVERAGE_SCHEMA_RUNTIME_PASS ${runId} migrations=50 assertions=35\n`);
