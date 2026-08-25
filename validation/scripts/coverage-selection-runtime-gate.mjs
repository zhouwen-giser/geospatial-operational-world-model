import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
const container = process.env.GOWM_V06_POSTGRES_CONTAINER;
const password = process.env.GOWM_V06_POSTGRES_PASSWORD;
if (process.env.ALLOW_GOWM_COVERAGE_SELECTION_GATE !== "YES") {
  throw new Error("Set ALLOW_GOWM_COVERAGE_SELECTION_GATE=YES to run the isolated B00 gate");
}
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
if (!container || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/u.test(container)) throw new Error("GOWM_V06_POSTGRES_CONTAINER is invalid");
if (!password || password.length < 16) throw new Error("GOWM_V06_POSTGRES_PASSWORD must be provided without recording it in evidence");
const database = `gowm_v06_b00_${runId.replaceAll("-", "_")}`;
if (!/^gowm_v06_b00_[a-z0-9_]{3,32}$/u.test(database)) throw new Error("isolated database name escaped the B00 namespace");

const evidence = {
  schemaVersion: "1.0",
  runId,
  container,
  database,
  startedAt: new Date().toISOString(),
  status: "RUNNING",
  commands: [],
  summary: null,
  cleanup: [],
  errors: []
};
let created = false;

function run(command, args, options = {}) {
  const startedAt = Date.now();
  try {
    const output = execFileSync(command, args, {
      cwd: repositoryRoot,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      input: options.input
    }).trim();
    evidence.commands.push({ command: options.evidenceCommand ?? [command, ...args], status: "PASS", elapsedMs: Date.now() - startedAt });
    return output;
  } catch (error) {
    evidence.commands.push({ command: options.evidenceCommand ?? [command, ...args], status: "FAIL", elapsedMs: Date.now() - startedAt });
    evidence.errors.push(redact(String(error.stderr || error.message || error)));
    throw error;
  }
}

function psql(sql, label, targetDatabase = database, extraArgs = []) {
  return run("docker", ["exec", "--interactive", container, "psql", "--username", "gowm", "--dbname", targetDatabase,
    "--set", "ON_ERROR_STOP=on", ...extraArgs], { input: sql, evidenceCommand: [label, targetDatabase] });
}

async function migrationBatch() {
  const files = (await readdir(resolve(repositoryRoot, "database/migrations")))
    .filter((name) => /^\d{3}_.+\.sql$/u.test(name)).sort();
  if (files.length !== 50 || files.at(-1)?.slice(0, 3) !== "050") throw new Error("B00 expects migrations 001-050");
  const parts = [];
  for (const file of files) {
    const template = await readFile(resolve(repositoryRoot, "database/migrations", file), "utf8");
    const sql = template.replaceAll(":ANALYSIS_SRID", "32650")
      .replaceAll(":TRACKLET_MAX_TIME_GAP_MS", "10000")
      .replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", "250")
      .replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", "80");
    const checksum = createHash("sha256").update(sql).digest("hex");
    parts.push(`\\echo APPLY_MIGRATION ${file}\n${sql}\nINSERT INTO schema_migration(version,checksum) VALUES ('${file}','${checksum}');`);
  }
  psql(parts.join("\n"), "migration-batch-001-050");
}

async function persist() {
  evidence.finishedAt = new Date().toISOString();
  const directory = resolve(repositoryRoot, "reports/gowm-v0.6");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `b00-runtime-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

let failure;
try {
  const health = run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", container]);
  if (health !== "healthy") throw new Error(`PostgreSQL container is not healthy: ${health}`);
  const existing = run("docker", ["exec", container, "psql", "--username", "gowm", "--dbname", "postgres", "--tuples-only", "--no-align",
    "--command", `SELECT count(*) FROM pg_database WHERE datname='${database}'`], { evidenceCommand: ["database-exists", database] });
  if (existing !== "0") throw new Error(`refusing to reuse existing database ${database}`);
  run("docker", ["exec", container, "createdb", "--username", "gowm", "--owner", "gowm", database], { evidenceCommand: ["create-isolated-database", database] });
  created = true;
  await migrationBatch();
  const fixture = await readFile(resolve(repositoryRoot, "validation/fixtures/coverage-selection-runtime.sql"), "utf8");
  psql(fixture, "coverage-selection-fixture");

  const encodedPassword = encodeURIComponent(password);
  const databaseUrl = `postgresql://gowm:${encodedPassword}@127.0.0.1:5432/${database}?options=-c%20role%3Dcoverage_planner_provider`;
  const output = run("docker", ["run", "--rm", "--network", `container:${container}`,
    "--volume", `${repositoryRoot}:/workspace`, "--workdir", "/workspace",
    "--env", "DATABASE_URL", "node:22-bookworm",
    "node", "dist/validation/scripts/coverage-selection-runtime-client.js"], {
    evidenceCommand: ["node-container", "coverage-selection-runtime-client", database],
    env: { ...process.env, DATABASE_URL: databaseUrl }
  });
  const line = output.split(/\r?\n/u).map((value) => value.trim()).find((value) => value.startsWith("{"));
  if (!line) throw new Error(`B00 client summary missing: ${output}`);
  evidence.summary = JSON.parse(line);
  if (evidence.summary.status !== "PASS" || Object.values(evidence.summary.checks ?? {}).some((value) => value !== true)) {
    throw new Error(`B00 client did not pass all checks: ${line}`);
  }
  evidence.status = "PASS";
} catch (error) {
  failure = new Error(redact(String(error?.message ?? error)));
  evidence.status = "FAIL";
  evidence.errors.push(redact(String(error?.message ?? error)));
} finally {
  if (created) {
    try {
      run("docker", ["exec", container, "dropdb", "--username", "gowm", "--if-exists", database], { evidenceCommand: ["drop-isolated-database", database] });
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
process.stdout.write(`GOWM_COVERAGE_SELECTION_RUNTIME_PASS ${runId} checks=${Object.keys(evidence.summary.checks).length}\n`);

function redact(value) {
  return password ? value.replaceAll(password, "[REDACTED]") : value;
}
