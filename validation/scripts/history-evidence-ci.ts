import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import pg from "pg";

// A separate current-feature gate: never widen the frozen 067 -> 069 baseline.
const source = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!source) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL is required");
const adminUrl = new URL(source);
adminUrl.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
const run = promisify(execFile);
const migrationFiles = (await readdir(new URL("../../database/migrations/", import.meta.url)))
  .filter((name) => /^\d{3}_.+\.sql$/u.test(name)).sort();
const head = migrationFiles.at(-1);
if (!head) throw new Error("No formal migration head found");
const currentHeadNumber = Number(head.slice(0, 3));
try {
  for (const baseline of [0, 69]) {
    const database = `gowm_history_repair_ci_${baseline}_${randomUUID().replaceAll("-", "")}`;
    assert.match(database, /^gowm_history_repair_ci_(0|69)_[a-f0-9]{32}$/);
    const target = new URL(source);
    target.pathname = `/${database}`;
    let created = false;
    let pool: pg.Pool | undefined;
    const env = { ...process.env, DATABASE_URL: target.toString(), ANALYSIS_SRID: "32648",
      STAS_DB_PASSWORD: "history-evidence-ci-disposable-stas" };
    const migrate = async (maximum: number) => {
      const options = { maximumMigrationNumber: maximum };
      await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
        `import {migrate} from './scripts/migrate.ts'; await migrate(${JSON.stringify(options)});`],
      { env, maxBuffer: 4 * 1024 * 1024 });
    };
    try {
      await admin.query(`CREATE DATABASE "${database}"`);
      created = true;
      pool = new pg.Pool({ connectionString: target.toString(), max: 1 });
      const ledger = async () => (await pool!.query<{version: string; checksum: string}>(
        "SELECT version,checksum FROM schema_migration ORDER BY version")).rows;
      let predecessor: Awaited<ReturnType<typeof ledger>> = [];
      if (baseline) { await migrate(baseline); predecessor = await ledger(); assert.equal(predecessor.length, baseline); }
      await migrate(currentHeadNumber);
      const current = await ledger();
      assert.equal(current.length, migrationFiles.length);
      assert.equal(current.at(-1)?.version, head);
      assert.deepEqual(current.slice(0, baseline), predecessor);
      await migrate(currentHeadNumber);
      assert.deepEqual(await ledger(), current, "replay must not alter migration checksums");
      const result = await run(process.execPath, ["--import", "tsx", "validation/scripts/history-evidence-repair-e2e.ts"],
        { env, maxBuffer: 4 * 1024 * 1024 });
      process.stdout.write(result.stdout);
      for (const script of ["reset-watermark-e2e.ts",...(baseline===0?["history-slicer-performance.ts"]:[])]) {
        const checked=await run(process.execPath,["--import","tsx",`validation/scripts/${script}`],{env,maxBuffer:4*1024*1024});
        process.stdout.write(checked.stdout);
      }
      process.stdout.write(`${JSON.stringify({status: "PASS", gate: "HISTORY_EVIDENCE_CURRENT_DATABASE",
        baseline, migrationCount: current.length, migrationHead: head, predecessorStable: true, replayStable: true})}\n`);
    } finally {
      await pool?.end();
      // Only the successfully created, exact random database above is removed.
      if (created) await admin.query(`DROP DATABASE "${database}"`);
    }
  }
} finally { await admin.end(); }
