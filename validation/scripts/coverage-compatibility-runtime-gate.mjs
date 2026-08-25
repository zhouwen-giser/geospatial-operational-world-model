import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = required("GOWM_V06_RUN_ID");
const container = required("GOWM_V06_POSTGRES_CONTAINER");
const schemaEvidencePath = required("GOWM_V06_C00_SCHEMA_EVIDENCE");
const recoveryEvidencePath = required("GOWM_V06_C00_RECOVERY_EVIDENCE");
if (process.env.ALLOW_GOWM_C00_GATE !== "YES") throw new Error("Set ALLOW_GOWM_C00_GATE=YES");
if (!/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/u.test(container)) throw new Error("GOWM_V06_POSTGRES_CONTAINER is invalid");
for (const path of [schemaEvidencePath, recoveryEvidencePath]) {
  if (!/^reports\/gowm-v0\.6\/[a-z0-9._-]+\.json$/u.test(path.replaceAll("\\", "/"))) throw new Error(`invalid evidence path: ${path}`);
}

const evidence = {
  schemaVersion: "1.0", phase: "C00", runId, startedAt: new Date().toISOString(), status: "RUNNING",
  commands: [], migrationMatrix: null, resultReplay: null, contractFreeze: null, predecessorLocks: null,
  networkRoutePerformance: null, errors: []
};

function run(command, args, shown = [command, ...args], env = process.env) {
  const startedAt = Date.now();
  try {
    const output = execFileSync(command, args, { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
    evidence.commands.push({ command: shown, status: "PASS", elapsedMs: Date.now() - startedAt });
    return output;
  } catch (error) {
    evidence.commands.push({ command: shown, status: "FAIL", elapsedMs: Date.now() - startedAt });
    throw error;
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifyContractFreeze() {
  const lock = JSON.parse(await readFile(resolve(root, "reports/gowm-v0.6/a01-contract-lock.json"), "utf8"));
  const actual = {};
  for (const [file, expected] of Object.entries(lock.schemas)) {
    const hash = createHash("sha256").update(await readFile(resolve(root, "contracts/gowm-v0.6", file))).digest("hex");
    check(hash === expected, `public Coverage v1 schema drifted: ${file}`);
    actual[file] = hash;
  }
  const manifest = createHash("sha256").update(await readFile(resolve(root, "contracts/gowm-v0.6/manifests/providers/road-coverage-provider.json"))).digest("hex");
  const openApi = createHash("sha256").update(await readFile(resolve(root, "contracts/gowm-v0.6/openapi/road-coverage-provider-v1.yaml"))).digest("hex");
  check(manifest === lock.providerManifestSha256, "Coverage Provider manifest drifted from A01 lock");
  check(openApi === lock.openApiSha256, "Coverage OpenAPI drifted from A01 lock");
  return { schemaCount: Object.keys(actual).length, providerManifestSha256: manifest, openApiSha256: openApi, status: "PASS_EXACT_A01_BYTES" };
}

async function persist() {
  evidence.finishedAt = new Date().toISOString();
  await mkdir(resolve(root, "reports/gowm-v0.6"), { recursive: true });
  await writeFile(resolve(root, `reports/gowm-v0.6/c00-runtime-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}

let failure;
try {
  const schema = JSON.parse(await readFile(resolve(root, schemaEvidencePath), "utf8"));
  check(schema.status === "PASS" && schema.summary?.migrations === 53 && schema.summary?.assertions === 38, "C00 schema matrix is not PASS 53/38");
  check(schema.summary?.fresh?.migrationCount === 53, "fresh migration path is incomplete");
  check(schema.summary?.v04Upgrade?.upgradeMarker === "v0.4-preserved", "v0.4 upgrade marker was not preserved");
  check(schema.summary?.v05Upgrade?.upgradeMarker === "v0.5-preserved", "v0.5 upgrade marker was not preserved");
  check(Object.values(schema.summary?.checksumReplaySkips ?? {}).length === 3 && Object.values(schema.summary.checksumReplaySkips).every((value) => value === 53), "checksum replay did not skip 53/53 on all paths");
  check(schema.summary?.deliberateFailureRollback === true && schema.cleanup?.every((item) => item.status === "PASS"), "migration rollback or cleanup failed");
  evidence.migrationMatrix = { evidence: schemaEvidencePath, ...schema.summary, cleanup: "PASS" };

  const recovery = JSON.parse(await readFile(resolve(root, recoveryEvidencePath), "utf8"));
  const after = recovery.after?.checks ?? {};
  check(recovery.status === "PASS" && after.deterministicQuery && after.gatewayWorkerReplay && after.resultReadAfterRestart && after.postgresRestartPersistence, "Coverage result replay/restart evidence is incomplete");
  evidence.resultReplay = { evidence: recoveryEvidencePath, restart: recovery.restart, checks: after };

  const predecessor = run("node", ["validation/scripts/gowm-v06-predecessor-guard.mjs"]);
  const sourcePolicy = run("node", ["validation/scripts/gowm-v06-source-policy-guard.mjs"]);
  check(predecessor.includes("GOWM_V06_PREDECESSOR_READY"), "predecessor lock guard did not pass");
  check(sourcePolicy.includes("GOWM_V06_SOURCE_POLICY_READY"), "source policy guard did not pass");
  evidence.predecessorLocks = { migrationAndContract: predecessor, sourcePolicy };
  evidence.contractFreeze = await verifyContractFreeze();

  const config = execFileSync("docker", ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", container], { cwd: root, encoding: "utf8" });
  const passwordEntry = config.split(/\r?\n/u).find((line) => line.startsWith("POSTGRES_PASSWORD="));
  check(passwordEntry !== undefined, "validated PostgreSQL password was not available");
  const password = passwordEntry.slice("POSTGRES_PASSWORD=".length);
  const databaseUrl = `postgresql://gowm:${encodeURIComponent(password)}@127.0.0.1:5432/gowm_v05_r03_20260825t1040?options=-c%20role%3Dnetwork_provider`;
  const output = run("docker", ["run", "--rm", "--network", `container:${container}`, "--volume", `${root}:/workspace`, "--workdir", "/workspace",
    "--env", "DATABASE_URL", "node:22-bookworm", "node", "dist/validation/scripts/gowm-v05-routing-performance.js"],
  ["docker", "run", "--rm", "--network", `container:${container}`, "node:22-bookworm", "gowm-v05-routing-performance"], { ...process.env, DATABASE_URL: databaseUrl });
  const performance = JSON.parse(output);
  const baseline = JSON.parse(await readFile(resolve(root, "reports/gowm-v0.5/t00-acceptance.json"), "utf8")).measurements;
  const comparisons = {
    snap: performance.snapP95Ms / baseline.snapP95Ms,
    shortest: performance.shortestP95Ms / baseline.shortestP95Ms,
    matrix: performance.matrix2x2P95Ms / baseline.matrix2x2P95Ms
  };
  check(performance.result === "GOWM_V05_ROUTING_PERFORMANCE_PASS", "v0.5 Network performance gate failed");
  check(Object.values(comparisons).every((ratio) => ratio <= 2), `v0.5 Network/Route baseline regressed materially: ${JSON.stringify(comparisons)}`);
  evidence.networkRoutePerformance = { current: performance, baseline, ratioToBaseline: comparisons, interpretation: "S/M acceptance fixture; not a production SLO" };
  evidence.status = "PASS";
} catch (error) {
  failure = error;
  evidence.status = "FAIL";
  evidence.errors.push(String(error?.stderr || error?.stack || error));
} finally {
  await persist();
}

if (failure) throw failure;
process.stdout.write(`GOWM_COVERAGE_COMPATIBILITY_PASS ${runId} migrations=53 assertions=38\n`);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
