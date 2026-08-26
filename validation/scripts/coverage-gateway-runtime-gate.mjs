import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeSourceFingerprint } from "./runtime-source-fingerprint.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeModules = await realpath(resolve(root, "node_modules"));
const runId = process.env.GOWM_V06_RUN_ID;
const container = process.env.GOWM_V06_POSTGRES_CONTAINER;
const password = process.env.GOWM_V06_POSTGRES_PASSWORD;
if (process.env.ALLOW_GOWM_COVERAGE_GATEWAY_GATE !== "YES") throw new Error("Set ALLOW_GOWM_COVERAGE_GATEWAY_GATE=YES");
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
if (!container || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/u.test(container)) throw new Error("GOWM_V06_POSTGRES_CONTAINER is invalid");
if (!password || password.length < 16) throw new Error("GOWM_V06_POSTGRES_PASSWORD must be provided");
const database = `gowm_v06_g00_${runId.replaceAll("-", "_")}`;
if (!/^gowm_v06_g00_[a-z0-9_]{3,32}$/u.test(database)) throw new Error("isolated G00 database name is invalid");
const evidence = { schemaVersion: "1.0", phase: "G00", runId, container, database, startedAt: new Date().toISOString(), status: "RUNNING", commands: [], summary: null, cleanup: [], errors: [] };
evidence.sourceBefore = await runtimeSourceFingerprint(root);
let created = false;

function run(command, args, options = {}) {
  const startedAt = Date.now();
  try {
    const output = execFileSync(command, args, { cwd: root, env: options.env ?? process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"], input: options.input }).trim();
    evidence.commands.push({ command: options.shown ?? [command, ...args], status: "PASS", elapsedMs: Date.now() - startedAt });
    return output;
  } catch (error) {
    evidence.commands.push({ command: options.shown ?? [command, ...args], status: "FAIL", elapsedMs: Date.now() - startedAt });
    throw error;
  }
}
function psql(sql, label, target = database, extra = []) {
  return run("docker", ["exec", "--interactive", container, "psql", "--username", "gowm", "--dbname", target, "--set", "ON_ERROR_STOP=on", ...extra], { input: sql, shown: [label, target] });
}
async function migrationBatch() {
  const files = (await readdir(resolve(root, "database/migrations"))).filter((name) => /^\d{3}_.+\.sql$/u.test(name)).sort();
  if (files.length !== 58 || files.at(-1)?.slice(0, 3) !== "058") throw new Error("G00 expects migrations 001-058");
  const parts = [];
  for (const file of files) {
    const template = await readFile(resolve(root, "database/migrations", file), "utf8");
    const sql = template.replaceAll(":ANALYSIS_SRID", "32650").replaceAll(":TRACKLET_MAX_TIME_GAP_MS", "10000").replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", "250").replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", "80");
    const checksum = createHash("sha256").update(sql).digest("hex");
    parts.push(`\\echo APPLY_MIGRATION ${file}\n${sql}\nINSERT INTO schema_migration(version,checksum) VALUES ('${file}','${checksum}');`);
  }
  psql(parts.join("\n"), "migration-batch-001-058");
}
async function save() {
  evidence.sourceAfter = await runtimeSourceFingerprint(root);
  if (evidence.sourceAfter.digest !== evidence.sourceBefore.digest) {
    evidence.status = "FAIL"; evidence.errors.push("Source changed during real gate");
    failure ??= new Error("Source changed during real gate");
  }
  evidence.finishedAt = new Date().toISOString();
  await mkdir(resolve(root, "reports/gowm-v0.6.1"), { recursive: true });
  await writeFile(resolve(root, `reports/gowm-v0.6.1/g00-runtime-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}

let failure;
try {
  const health = run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", container]);
  if (health !== "healthy") throw new Error(`PostgreSQL container is not healthy: ${health}`);
  const existing = run("docker", ["exec", container, "psql", "--username", "gowm", "--dbname", "postgres", "--tuples-only", "--no-align", "--command", `SELECT count(*) FROM pg_database WHERE datname='${database}'`], { shown: ["database-exists", database] });
  if (existing !== "0") throw new Error(`refusing to reuse existing database ${database}`);
  run("docker", ["exec", container, "createdb", "--username", "gowm", "--owner", "gowm", database], { shown: ["create-isolated-database", database] });
  created = true;
  await migrationBatch();
  psql(await readFile(resolve(root, "validation/fixtures/coverage-gateway-runtime.sql"), "utf8"), "coverage-gateway-fixture");
  const encoded = encodeURIComponent(password);
  const base = `postgresql://gowm:${encoded}@127.0.0.1:5432/${database}`;
  const output = run("docker", ["run", "--rm", "--network", `container:${container}`, "--volume", `${root}:/workspace`, "--volume", `${nodeModules}:/workspace/node_modules:ro`, "--workdir", "/workspace",
    "--env", "GOWM_V06_RUN_ID", "--env", "COVERAGE_PROVIDER_DATABASE_URL", "--env", "COVERAGE_GATEWAY_DATABASE_URL", "--env", "COVERAGE_ADMIN_DATABASE_URL", "--env", "PLATFORM_VALIDATION_DATABASE_URL", "--env", "CATALOG_PROVIDER_DATABASE_URL",
    "node:22-bookworm", "node", "dist/validation/scripts/coverage-gateway-runtime-client.js"], {
    shown: ["node-container", "coverage-gateway-runtime-client", database],
    env: {
      ...process.env,
      GOWM_V06_RUN_ID: runId,
      COVERAGE_PROVIDER_DATABASE_URL: `${base}?options=-c%20role%3Dcoverage_planner_provider`,
      COVERAGE_GATEWAY_DATABASE_URL: `${base}?options=-c%20role%3Dgowm_gateway_runtime`,
      COVERAGE_ADMIN_DATABASE_URL: base,
      PLATFORM_VALIDATION_DATABASE_URL: `${base}?options=-c%20role%3Dplatform_validation_provider`,
      CATALOG_PROVIDER_DATABASE_URL: `${base}?options=-c%20role%3Dgowm_catalog_reader`
    }
  });
  const line = output.split(/\r?\n/u).map((value) => value.trim()).find((value) => value.startsWith("{"));
  if (!line) throw new Error(`G00 client summary missing: ${output}`);
  evidence.summary = JSON.parse(line);
  if (evidence.summary.status !== "PASS" || Object.values(evidence.summary.checks ?? {}).some((value) => value !== true)) throw new Error(`G00 checks did not all pass: ${line}`);
  evidence.status = "PASS";
} catch (error) {
  failure = error;
  evidence.status = "FAIL";
  evidence.errors.push(redact(String(error?.stderr || error?.stack || error)));
} finally {
  if (created) {
    try {
      run("docker", ["exec", container, "dropdb", "--username", "gowm", "--if-exists", database], { shown: ["drop-isolated-database", database] });
      evidence.cleanup.push({ database, status: "PASS" });
    } catch (error) {
      evidence.cleanup.push({ database, status: "FAIL", error: redact(String(error)) });
      evidence.status = "FAIL";
      failure ??= error;
    }
  }
  await save();
}
if (failure) throw failure;
process.stdout.write(`GOWM_COVERAGE_GATEWAY_RUNTIME_PASS ${runId} checks=${Object.keys(evidence.summary.checks).length}\n`);
function redact(value) { return value.replaceAll(password, "[REDACTED]"); }
