import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const container = process.env.GOWM_DB_CONTAINER;
if (!container || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(container)) {
  throw new Error("GOWM_DB_CONTAINER is required and must be an exact safe container name");
}
const runId = `s02-${Date.now().toString(36)}`;

await runValidation("initial");
await run("docker", ["restart", container]);
await waitForDatabase();
await runValidation("recovery");

process.stdout.write(`${JSON.stringify({
  result: "STABLE_SECURITY_LOAD_RECOVERY_PASS",
  runId,
  databaseRestart: true,
  referenceRecovery: true,
  operationalRecovery: true
}, null, 2)}\n`);

async function runValidation(mode) {
  await run(process.execPath, ["--import", "tsx", "validation/scripts/stable-security-load-e2e.ts"], {
    ...process.env,
    S02_MODE: mode,
    S02_RUN_ID: runId
  });
}

async function waitForDatabase() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 500 });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("PostgreSQL did not recover within 20 seconds");
}

async function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: ["ignore", "inherit", "inherit"] });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `${command} ${args.join(" ")} failed`);
}
