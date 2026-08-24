import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

import { OperationalEventRepository } from "../../packages/runtime/src/operational-event-repository.js";
import { OperationalProjectionRepository } from "../../packages/runtime/src/operational-projection-repository.js";

const sourceUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL is required");
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const names = {
  fresh: `gowm_s01_fresh_${suffix}`,
  v01: `gowm_s01_v01_${suffix}`,
  v02: `gowm_s01_v02_${suffix}`
};
const migrationFiles = (await readdir(resolve("database/migrations")))
  .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
  .sort();

try {
  await verifyBaselineLock();
  for (const name of Object.values(names)) await createDatabase(name);

  const fresh = databasePool(names.fresh);
  const v01 = databasePool(names.v01);
  const v02 = databasePool(names.v02);
  try {
    await applyThrough(fresh, 32);
    await applyThrough(fresh, 32);
    assert.equal(await migrationCount(fresh), 32);
    await runAssertions(fresh);
    await verifyFailedMigrationRollback(fresh);
    const replay = await verifyProjectionReplay(fresh);

    await applyThrough(v01, 10);
    await v01.query(
      "INSERT INTO data_scope(scope_key,operational_domain,description) VALUES ('s01-v01-preserved','TEST','v0.1 preserved row')"
    );
    await applyThrough(v01, 32);
    assert.equal((await v01.query("SELECT count(*)::integer AS count FROM data_scope WHERE scope_key='s01-v01-preserved'" )).rows[0]?.count, 1);
    assert.equal(await migrationCount(v01), 32);

    await applyThrough(v02, 16);
    await v02.query(
      "INSERT INTO data_scope(scope_key,operational_domain,description) VALUES ('s01-v02-preserved','TEST','v0.2 preserved row')"
    );
    await v02.query(
      `INSERT INTO gowm_capability.capability(
         operation_id,semantic_role,data_binding,result_semantics,description
       ) VALUES ('s01.baseline.probe','GENERIC_ANALYSIS','WORLD_INDEPENDENT','DERIVED_ANALYSIS','v0.2 preserved capability')`
    );
    await applyThrough(v02, 32);
    assert.equal((await v02.query("SELECT count(*)::integer AS count FROM data_scope WHERE scope_key='s01-v02-preserved'" )).rows[0]?.count, 1);
    assert.equal((await v02.query("SELECT count(*)::integer AS count FROM gowm_capability.capability WHERE operation_id='s01.baseline.probe'" )).rows[0]?.count, 1);
    assert.equal(await migrationCount(v02), 32);

    process.stdout.write(`${JSON.stringify({
      result: "STABLE_MIGRATION_REPLAY_PASS",
      migrationCount: 32,
      fresh: "PASS",
      v01ToV04: "PASS",
      v02ToV04: "PASS",
      checksumReplay: "PASS",
      failedMigrationRollback: "PASS",
      referenceProjectionReplay: replay.reference,
      operationalProjectionReplay: replay.operational
    }, null, 2)}\n`);
  } finally {
    await Promise.allSettled([fresh.end(), v01.end(), v02.end()]);
  }
} finally {
  for (const name of Object.values(names)) await dropDatabase(name).catch(() => undefined);
  await admin.end();
}

async function verifyBaselineLock(): Promise<void> {
  const lock = JSON.parse(await readFile("database/migration-baseline-lock.json", "utf8")) as {
    migrations: Record<string, string>;
  };
  assert.equal(Object.keys(lock.migrations).length, 14);
  for (const [name, expected] of Object.entries(lock.migrations)) {
    const actual = createHash("sha256")
      .update(await readFile(resolve("database/migrations", name)))
      .digest("hex");
    assert.equal(actual, expected, `${name} differs from the immutable v0.2 baseline`);
  }
}

async function applyThrough(pool: pg.Pool, maximumVersion: number): Promise<void> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migration(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())"
  );
  for (const file of migrationFiles.filter((name) => Number(name.slice(0, 3)) <= maximumVersion)) {
    const template = await readFile(resolve("database/migrations", file), "utf8");
    const sql = template
      .replaceAll(":ANALYSIS_SRID", "32650")
      .replaceAll(":TRACKLET_MAX_TIME_GAP_MS", "10000")
      .replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", "250")
      .replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", "80");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await pool.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migration WHERE version=$1",
      [file]
    );
    if (existing.rows[0]) {
      assert.equal(existing.rows[0].checksum, checksum, `${file} replay checksum mismatch`);
      continue;
    }
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migration(version,checksum) VALUES ($1,$2)", [file, checksum]);
  }
}

async function runAssertions(pool: pg.Pool): Promise<void> {
  const files = (await readdir(resolve("database/tests")))
    .filter((name) => /^\d{3}_.+_assertions\.sql$/u.test(name))
    .sort();
  assert.equal(files.length, 21);
  for (const file of files) {
    const source = await readFile(resolve("database/tests", file), "utf8");
    const sql = source.split(/\r?\n/u).filter((line) => !line.trimStart().startsWith("\\")).join("\n");
    await pool.query(sql);
  }
}

async function verifyFailedMigrationRollback(pool: pg.Pool): Promise<void> {
  await assert.rejects(pool.query(
    "BEGIN; CREATE TABLE s01_partial_schema_probe(id integer); SELECT * FROM s01_missing_relation; COMMIT;"
  ));
  const result = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass('public.s01_partial_schema_probe')::text AS relation"
  );
  assert.equal(result.rows[0]?.relation, null);
}

async function verifyProjectionReplay(pool: pg.Pool): Promise<{ reference: string; operational: string }> {
  const scope = `s01-replay-${suffix}`;
  const eventId = `s01-event-${suffix}`;
  const taskId = `s01-task-${suffix}`;
  const observedAt = new Date(Date.now() - 30_000).toISOString();
  await pool.query(
    "INSERT INTO data_scope(scope_key,operational_domain,description) VALUES ($1,'TEST','S01 replay fixture')",
    [scope]
  );
  const events = new OperationalEventRepository(pool);
  const projections = new OperationalProjectionRepository(pool);
  await events.insert({
    dataScopeKey: scope,
    sourceAuthority: "s01-replay",
    sourceEventKey: eventId,
    sourceRevisionNo: 1,
    eventId,
    operationalTaskId: taskId,
    eventType: "EXECUTION_STOPPED_OBSERVED",
    eventTime: observedAt,
    actorReferenceKeys: [],
    targetReferenceKeys: [],
    payload: { taskType: "S01_REPLAY" },
    confidence: 1,
    provenance: [{ evidenceId: `s01-evidence-${suffix}`, authority: "s01", evidenceType: "MIGRATION_REPLAY", observedAt }]
  });
  await projections.projectPending(100);
  const operational = await projections.rebuild(scope);
  assert.equal(operational.currentHash, operational.replayHash);

  await pool.query("SELECT rebuild_reference_search_projection($1)", [scope]);
  const before = await pool.query<{ checksum: string }>(
    "SELECT reference_search_projection_checksum($1) AS checksum",
    [scope]
  );
  await pool.query("SELECT rebuild_reference_search_projection_audited($1,'s01-stable-replay-v1')", [scope]);
  const after = await pool.query<{ checksum: string }>(
    "SELECT reference_search_projection_checksum($1) AS checksum",
    [scope]
  );
  assert.equal(before.rows[0]?.checksum, after.rows[0]?.checksum);
  const audit = await pool.query<{ outcome: string }>(
    "SELECT outcome FROM grounding_replay_audit WHERE data_scope_key=$1 ORDER BY created_at DESC LIMIT 1",
    [scope]
  );
  assert.equal(audit.rows[0]?.outcome, "MATCH");
  return { reference: "MATCH", operational: "MATCH" };
}

async function migrationCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM schema_migration");
  return result.rows[0]?.count ?? 0;
}

function databasePool(name: string): pg.Pool {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return new pg.Pool({ connectionString: url.toString(), max: 2 });
}

async function createDatabase(name: string): Promise<void> {
  assert.match(name, /^[a-z0-9_]+$/u);
  await admin.query(`CREATE DATABASE ${name}`);
}

async function dropDatabase(name: string): Promise<void> {
  assert.match(name, /^[a-z0-9_]+$/u);
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [name]);
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
}
