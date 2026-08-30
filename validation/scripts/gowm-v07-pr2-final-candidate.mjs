import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withMigratedV07Database } from "./gowm-v07-postgres-harness.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expectedMigrationHead = "067_historical_trajectory_contract.sql";
const migrationHead = await currentMigrationHead();
if (migrationHead !== expectedMigrationHead) {
  throw new Error(`unexpected PR-2 migration head: ${String(migrationHead)}`);
}

const historyGates = [
  ["task-intervals", "gowm-v07-task-interval-e2e.ts"],
  ["tracklet-finalization", "gowm-v07-tracklet-finalization-e2e.ts"],
  ["history-trajectory", "gowm-v07-history-trajectory-e2e.ts"],
  ["history-queue-worker", "gowm-v07-history-queue-worker-e2e.ts"],
  ["history-late-data", "gowm-v07-history-late-data-e2e.ts"],
  ["history-gateway", "gowm-v07-history-gateway-e2e.ts"],
  ["history-security", "gowm-v07-history-security-e2e.ts"],
  ["history-performance", "gowm-v07-history-performance.ts"]
];
const completed = [];
const prerequisite = "pr1-final-candidate";
const databaseRegression = "database-regression";
let databaseEvidence;

// The final gate still executes every child gate. They share one isolated,
// freshly migrated database so the final run does not repeat the same 67-file
// bootstrap for each child. The upgrade regression retains its own separate
// 064 -> 067 database inside the database-regression child.
await withMigratedV07Database("pr2_final", async (databaseUrl, evidence, runId) => {
  databaseEvidence = evidence;
  const sharedEnvironment = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    GOWM_V07_DATABASE_URL: databaseUrl,
    GOWM_V07_REUSE_DATABASE_URL: databaseUrl,
    GOWM_V07_COMBINED_FINAL: "1",
    GOWM_V07_RUN_ID: runId,
    RUN_GOWM_V07_DB_INTEGRATION: "1"
  };

  process.stdout.write(`GOWM_V07_PR2_GATE_START ${databaseRegression}\n`);
  await run(process.execPath, [
    "--import",
    "tsx",
    resolve(root, "validation/scripts/gowm-v07-database-regression-e2e.ts")
  ], sharedEnvironment);
  completed.push(databaseRegression);
  process.stdout.write(`GOWM_V07_PR2_GATE_PASS ${databaseRegression}\n`);

  process.stdout.write(`GOWM_V07_PR2_GATE_START ${prerequisite}\n`);
  await run(
    process.execPath,
    [resolve(root, "validation/scripts/gowm-v07-pr1-final-candidate.mjs")],
    sharedEnvironment
  );
  completed.push(prerequisite);
  process.stdout.write(`GOWM_V07_PR2_GATE_PASS ${prerequisite}\n`);

  for (const [name, script] of historyGates) {
    process.stdout.write(`GOWM_V07_PR2_GATE_START ${name}\n`);
    await run(process.execPath, [
      "--import",
      "tsx",
      resolve(root, "validation/scripts", script)
    ], sharedEnvironment);
    completed.push(name);
    process.stdout.write(`GOWM_V07_PR2_GATE_PASS ${name}\n`);
  }
});

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  gate: "GOWM_V07_PR2_FINAL_CANDIDATE",
  migrationHead,
  migrationHeadConfirmed: migrationHead === expectedMigrationHead,
  databaseEvidence,
  databaseRegressionChildGateExecuted: databaseRegression,
  historyChildGatesExecuted: historyGates.map(([name]) => name),
  prerequisiteChildGatesExecuted: [prerequisite],
  actualChildGatesExecuted: completed,
  sharedRuntimeMutated: false
})}\n`);

async function currentMigrationHead() {
  const files = (await readdir(resolve(root, "database/migrations")))
    .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
    .sort();
  return files.at(-1);
}

async function run(command, arguments_, environment = process.env) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: environment,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`PR-2 child gate failed (exit=${String(code)}, signal=${String(signal)})`));
    });
  });
}
