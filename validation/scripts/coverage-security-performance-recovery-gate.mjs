import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
if (process.env.ALLOW_GOWM_COVERAGE_T00_GATE !== "YES") throw new Error("Set ALLOW_GOWM_COVERAGE_T00_GATE=YES");
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
const image = process.env.GOWM_V06_POSTGRES_IMAGE || "gowm-plus-db:18-3.6-mobilitydb-1.3-h3-4.5.0-pgrouting-4.0.1";
if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,255}$/u.test(image)) throw new Error("GOWM_V06_POSTGRES_IMAGE is invalid");
const container = `gowm-v06-${runId}-postgres`;
const password = createHash("sha256").update(`gowm-v06-t00:${runId}`).digest("hex");
const evidence = { schemaVersion: "1.0", phase: "T00", runId, image, container, startedAt: new Date().toISOString(), status: "RUNNING", commands: [], before: null, after: null, restart: null, cleanup: [], errors: [] };
let created = false;

function run(command, args, options = {}) {
  const startedAt = Date.now();
  try {
    const output = execFileSync(command, args, { cwd: root, env: options.env ?? process.env, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"], input: options.input }).trim();
    evidence.commands.push({ command: options.shown ?? [command, ...args], status: "PASS", elapsedMs: Date.now() - startedAt });
    return output;
  } catch (error) {
    evidence.commands.push({ command: options.shown ?? [command, ...args], status: "FAIL", elapsedMs: Date.now() - startedAt });
    throw error;
  }
}

function psql(sql, label) {
  return run("docker", ["exec", "--interactive", container, "psql", "--username", "gowm", "--dbname", "gowm", "--set", "ON_ERROR_STOP=on"], { input: sql, shown: [label, "gowm"] });
}

async function applyMigrations() {
  const files = (await readdir(resolve(root, "database/migrations"))).filter((name) => /^\d{3}_.+\.sql$/u.test(name)).sort();
  if (files.length !== 53 || files.at(-1)?.slice(0, 3) !== "053") throw new Error("T00 expects migrations 001-053");
  const batch = [];
  for (const file of files) {
    const source = (await readFile(resolve(root, "database/migrations", file), "utf8"))
      .replaceAll(":ANALYSIS_SRID", "32650").replaceAll(":TRACKLET_MAX_TIME_GAP_MS", "10000")
      .replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", "250").replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", "80");
    const checksum = createHash("sha256").update(source).digest("hex");
    batch.push(`\\echo APPLY_MIGRATION ${file}\n${source}\nINSERT INTO schema_migration(version,checksum) VALUES ('${file}','${checksum}');`);
  }
  psql(batch.join("\n"), "migration-batch-001-053");
}

async function waitHealthy(label) {
  const startedAt = Date.now();
  let last = "unknown";
  while (Date.now() - startedAt < 60_000) {
    try {
      last = execFileSync("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", container], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      const ready = last === "healthy" || (last === "running" && postgresReady());
      if (ready) {
        evidence.commands.push({ command: [label, container], status: "PASS", elapsedMs: Date.now() - startedAt });
        return Date.now() - startedAt;
      }
    } catch { last = "inspect-failed"; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  evidence.commands.push({ command: [label, container], status: "FAIL", elapsedMs: Date.now() - startedAt });
  throw new Error(`${container} did not become healthy: ${last}`);
}

function postgresReady() {
  try {
    const result = execFileSync("docker", ["exec", container, "sh", "-c",
      "test \"$(head -1 \"${PGDATA}/postmaster.pid\")\" = 1 && pg_isready -U gowm -d gowm >/dev/null && psql -U gowm -d gowm -Atqc \"SELECT count(*) FROM pg_available_extensions WHERE name IN ('postgis','mobilitydb','h3','h3_postgis','pgrouting')\""],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return result === "5";
  } catch { return false; }
}

function client(phase) {
  const encoded = encodeURIComponent(password);
  const base = `postgresql://gowm:${encoded}@127.0.0.1:5432/gowm`;
  const output = run("docker", ["run", "--rm", "--network", `container:${container}`, "--volume", `${root}:/workspace`, "--workdir", "/workspace",
    "--env", "GOWM_V06_RUN_ID", "--env", "GOWM_V06_T00_PHASE", "--env", "COVERAGE_PROVIDER_DATABASE_URL",
    "--env", "COVERAGE_GATEWAY_DATABASE_URL", "--env", "COVERAGE_ADMIN_DATABASE_URL", "--env", "NETWORK_PROVIDER_DATABASE_URL", "--env", "ROUTE_PROVIDER_DATABASE_URL",
    "node:22-bookworm", "node", "dist/validation/scripts/coverage-security-performance-recovery-client.js"], {
    shown: ["node-container", `coverage-t00-${phase}`, container],
    env: {
      ...process.env, GOWM_V06_RUN_ID: runId, GOWM_V06_T00_PHASE: phase,
      COVERAGE_PROVIDER_DATABASE_URL: `${base}?options=-c%20role%3Dcoverage_planner_provider`,
      COVERAGE_GATEWAY_DATABASE_URL: `${base}?options=-c%20role%3Dgowm_gateway_runtime`, COVERAGE_ADMIN_DATABASE_URL: base,
      NETWORK_PROVIDER_DATABASE_URL: `${base}?options=-c%20role%3Dnetwork_provider`,
      ROUTE_PROVIDER_DATABASE_URL: `${base}?options=-c%20role%3Droute_planner_provider`
    }
  });
  const line = output.split(/\r?\n/u).map((value) => value.trim()).find((value) => value.startsWith("{"));
  if (!line) throw new Error(`T00 ${phase} summary missing: ${output}`);
  const summary = JSON.parse(line);
  if (summary.status !== "PASS" || Object.values(summary.checks ?? {}).some((value) => value !== true)) throw new Error(`T00 ${phase} checks failed: ${line}`);
  return summary;
}

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await mkdir(resolve(root, "reports/gowm-v0.6"), { recursive: true });
  await writeFile(resolve(root, `reports/gowm-v0.6/t00-runtime-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}

let failure;
try {
  const existing = run("docker", ["ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.Names}}"], { shown: ["container-exists", container] });
  if (existing) throw new Error(`refusing to reuse T00 container ${container}`);
  run("docker", ["run", "--detach", "--name", container, "--env", "POSTGRES_DB=gowm", "--env", "POSTGRES_USER=gowm", "--env", `POSTGRES_PASSWORD=${password}`, image], {
    shown: ["create-dedicated-postgres", container, image, "POSTGRES_PASSWORD=[REDACTED]"]
  });
  created = true;
  await waitHealthy("initial-postgres-health");
  await applyMigrations();
  psql(await readFile(resolve(root, "validation/fixtures/coverage-gateway-runtime.sql"), "utf8"), "coverage-small-fixture");
  psql(await readFile(resolve(root, "validation/fixtures/coverage-t00-medium.sql"), "utf8"), "coverage-medium-fixture");
  evidence.before = client("before");
  const restartStartedAt = Date.now();
  run("docker", ["restart", container], { shown: ["restart-dedicated-postgres", container] });
  const healthyElapsedMs = await waitHealthy("restarted-postgres-health");
  evidence.restart = { status: "PASS", elapsedMs: Date.now() - restartStartedAt, healthyElapsedMs };
  evidence.after = client("after");
  evidence.status = "PASS";
} catch (error) {
  failure = error;
  evidence.status = "FAIL";
  evidence.errors.push(redact(String(error?.stderr || error?.stack || error)));
} finally {
  if (created) {
    try {
      run("docker", ["rm", "--force", container], { shown: ["remove-dedicated-postgres", container] });
      evidence.cleanup.push({ container, status: "PASS" });
    } catch (error) {
      evidence.cleanup.push({ container, status: "FAIL", error: redact(String(error)) });
      evidence.status = "FAIL";
      failure ??= error;
    }
  }
  await save();
}
if (failure) throw failure;
process.stdout.write(`GOWM_COVERAGE_T00_RUNTIME_PASS ${runId} before=${Object.keys(evidence.before.checks).length} after=${Object.keys(evidence.after.checks).length}\n`);
function redact(value) { return value.replaceAll(password, "[REDACTED]"); }
