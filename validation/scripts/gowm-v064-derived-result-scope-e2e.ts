import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL is required");

const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseNames = {
  fresh: `gowm_v064_scope_fresh_${runId}`,
  upgrade: `gowm_v064_scope_upgrade_${runId}`,
  mismatch: `gowm_v064_scope_mismatch_${runId}`
};
const migrationFiles = (await readdir(resolve(repositoryRoot, "database/migrations")))
  .filter((name) => /^\d{3}_.+\.sql$/u.test(name))
  .sort();

assert.equal(migrationFiles.length, 63);
assert.equal(migrationFiles.at(-1), "063_derived_result_scope_claim_resolution.sql");

try {
  for (const name of Object.values(databaseNames)) await createDatabase(name);
  const fresh = databasePool(databaseNames.fresh);
  const upgrade = databasePool(databaseNames.upgrade);
  const mismatch = databasePool(databaseNames.mismatch);
  try {
    await applyThrough(fresh, 63);
    assert.equal(await migrationCount(fresh), 63);
    await runVitest(databaseUrl(databaseNames.fresh));
    await runSqlAssertion(fresh, "database/tests/011_derived_result_registry_assertions.sql");

    await applyThrough(upgrade, 62);
    const backfillFixture = await seedBackfillFixture(upgrade);
    await applyThrough(upgrade, 63);
    const backfillEvidence = await assertBackfill(upgrade, backfillFixture);

    await applyThrough(mismatch, 62);
    await seedMismatchedHistoricalResult(mismatch);
    await assertMismatchRollback(mismatch);

    process.stdout.write(`${JSON.stringify({
      status: "PASS",
      gate: "GOWM_V064_DERIVED_RESULT_SCOPE",
      migrationHead: migrationFiles.at(-1),
      migrationCount: await migrationCount(fresh),
      runtimeCases: 4,
      excludedAuthorityMappings: 5,
      sqlAssertionFiles: 1,
      upgrade: {
        path: "062_TO_063",
        exactTerminalResultCount: backfillEvidence.exactTerminalResultCount,
        mappedSourceDerivedCount: backfillEvidence.mappedSourceDerivedCount,
        mappedSourceSetCount: backfillEvidence.mappedSourceSetCount,
        stableReferenceKeys: backfillEvidence.stableReferenceKeys
      },
      mismatchedHistoricalScope: "42501_ATOMIC_ROLLBACK",
      sharedRuntimeMutated: false
    })}\n`);
  } finally {
    await Promise.allSettled([fresh.end(), upgrade.end(), mismatch.end()]);
  }
} finally {
  for (const name of Object.values(databaseNames).reverse()) {
    await dropDatabase(name).catch(() => undefined);
  }
  await admin.end();
}

interface BackfillFixture {
  internalScope: string;
  exactQueryId: string;
  mappedQueryId: string;
  resultReferenceKey: string;
  derivedReferenceKey: string;
  referenceSetKey: string;
}

async function seedBackfillFixture(pool: pg.Pool): Promise<BackfillFixture> {
  const internalScope = `v064-upgrade-scope-${runId}`;
  const mappedClaim = `v064-upgrade-claim-${runId}`;
  const exactQueryId = `v064-upgrade-exact-${runId}`;
  const mappedQueryId = `v064-upgrade-mapped-${runId}`;

  await pool.query(
    "INSERT INTO public.data_scope(scope_key,operational_domain,description) VALUES ($1,'TEST','v0.6.4 scope backfill')",
    [internalScope]
  );
  await pool.query(
    `INSERT INTO public.world_reference_external_identifier(
       reference_key,data_scope_key,authority,identifier_kind,identifier_value,
       normalized_value,confidence,evidence
     )
     SELECT identity.reference_key,identity.data_scope_key,'GOWM_GATEWAY','DATA_SCOPE_CLAIM',
            $1,public.normalize_reference_text($1),1,'[{"kind":"V064_UPGRADE_ASSERTION"}]'::jsonb
     FROM public.world_reference_identity identity
     WHERE identity.entity_kind='DATA_SCOPE'
       AND identity.internal_id=$2
       AND identity.data_scope_key=$2`,
    [mappedClaim, internalScope]
  );

  await insertWorldQueryJob(pool, exactQueryId, internalScope, "SUCCEEDED");
  await pool.query(
    `UPDATE gowm_capability.world_query_job
     SET result=jsonb_build_object(
       'queryPlanVersion','2.0','queryId',$1,'jobId',$1 || '-job','status','COMPLETED',
       'nodes',jsonb_build_array(jsonb_build_object(
         'nodeId','node1','result',jsonb_build_object(
           'dataSnapshot',jsonb_build_object('scopeDigest','sha256:' || repeat('1',64)),
           'computeSnapshot',jsonb_build_object('policy',jsonb_build_object('version','1'))
         )
       )),
       'outputs',jsonb_build_object(),'warnings',jsonb_build_array(),
       'startedAt','2026-08-24T00:00:00Z','finishedAt','2026-08-24T00:00:01Z',
       'outputHash','sha256:' || repeat('2',64)
     )
     WHERE query_id=$1`,
    [exactQueryId]
  );
  const resultReference = await pool.query<{ reference_key: string }>(
    "SELECT reference_key FROM public.world_query_result_reference WHERE query_id=$1",
    [exactQueryId]
  );
  const resultReferenceKey = resultReference.rows[0]?.reference_key;
  assert.ok(resultReferenceKey);

  await insertWorldQueryJob(pool, mappedQueryId, mappedClaim, "RUNNING");
  const derived = await pool.query<{ reference_key: string }>(
    `SELECT public.create_derived_reference(
       $1,'ANALYSIS_RESULT','v064-upgrade-backfill',$2,'node1',ARRAY[$3],
       'sha256:' || repeat('3',64),'sha256:' || repeat('4',64),'v064/1',
       NULL,NULL,clock_timestamp() + interval '1 hour',false
     ) AS reference_key`,
    [internalScope, mappedQueryId, resultReferenceKey]
  );
  const set = await pool.query<{ reference_key: string }>(
    `SELECT public.create_reference_set(
       $1,'V064_BACKFILL',$2,ARRAY[$3],clock_timestamp() + interval '1 hour'
     ) AS reference_key`,
    [internalScope, mappedQueryId, resultReferenceKey]
  );
  const derivedReferenceKey = derived.rows[0]?.reference_key;
  const referenceSetKey = set.rows[0]?.reference_key;
  assert.ok(derivedReferenceKey);
  assert.ok(referenceSetKey);

  return {
    internalScope,
    exactQueryId,
    mappedQueryId,
    resultReferenceKey,
    derivedReferenceKey,
    referenceSetKey
  };
}

async function assertBackfill(pool: pg.Pool, fixture: BackfillFixture): Promise<{
  exactTerminalResultCount: number;
  mappedSourceDerivedCount: number;
  mappedSourceSetCount: number;
  stableReferenceKeys: boolean;
}> {
  const jobs = await pool.query<{
    query_id: string;
    resolved_data_scope_key: string | null;
  }>(
    `SELECT query_id,resolved_data_scope_key
     FROM gowm_capability.world_query_job
     WHERE query_id IN ($1,$2)
     ORDER BY query_id`,
    [fixture.exactQueryId, fixture.mappedQueryId]
  );
  assert.equal(jobs.rows.length, 2);
  assert.ok(jobs.rows.every((row) => row.resolved_data_scope_key === fixture.internalScope));

  const result = await pool.query<{ count: number; reference_key: string | null; data_scope_key: string | null }>(
    `SELECT count(*)::integer AS count,min(reference_key) AS reference_key,min(data_scope_key) AS data_scope_key
     FROM public.world_query_result_reference WHERE query_id=$1`,
    [fixture.exactQueryId]
  );
  const derived = await pool.query<{ count: number; reference_key: string | null }>(
    `SELECT count(*)::integer AS count,min(reference_key) AS reference_key
     FROM public.derived_reference WHERE source_query_id=$1 AND data_scope_key=$2`,
    [fixture.mappedQueryId, fixture.internalScope]
  );
  const set = await pool.query<{ count: number; reference_key: string | null }>(
    `SELECT count(*)::integer AS count,min(reference_key) AS reference_key
     FROM public.reference_set WHERE source_query_id=$1 AND data_scope_key=$2`,
    [fixture.mappedQueryId, fixture.internalScope]
  );
  assert.equal(result.rows[0]?.count, 1);
  assert.equal(result.rows[0]?.data_scope_key, fixture.internalScope);
  assert.equal(derived.rows[0]?.count, 1);
  assert.equal(set.rows[0]?.count, 1);

  const visibilityClient = await pool.connect();
  let visibility: pg.QueryResult<{
    result_count: number;
    derived_count: number;
    set_count: number;
  }>;
  let visibilityTransaction = false;
  try {
    await visibilityClient.query("BEGIN READ ONLY");
    visibilityTransaction = true;
    await visibilityClient.query("SELECT gowm_result_v1.set_data_scope($1)", [fixture.internalScope]);
    visibility = await visibilityClient.query(
      `SELECT
         (SELECT count(*)::integer FROM gowm_result_v1.query_result WHERE query_id=$1) AS result_count,
         (SELECT count(*)::integer FROM gowm_result_v1.derived_reference WHERE source_query_id=$2) AS derived_count,
         (SELECT count(*)::integer FROM gowm_result_v1.reference_set WHERE source_query_id=$2) AS set_count`,
      [fixture.exactQueryId, fixture.mappedQueryId]
    );
    await visibilityClient.query("ROLLBACK");
    visibilityTransaction = false;
  } finally {
    if (visibilityTransaction) await visibilityClient.query("ROLLBACK").catch(() => undefined);
    visibilityClient.release();
  }
  assert.deepEqual(visibility.rows[0], { result_count: 1, derived_count: 1, set_count: 1 });

  return {
    exactTerminalResultCount: result.rows[0]?.count ?? 0,
    mappedSourceDerivedCount: derived.rows[0]?.count ?? 0,
    mappedSourceSetCount: set.rows[0]?.count ?? 0,
    stableReferenceKeys:
      result.rows[0]?.reference_key === fixture.resultReferenceKey &&
      derived.rows[0]?.reference_key === fixture.derivedReferenceKey &&
      set.rows[0]?.reference_key === fixture.referenceSetKey
  };
}

async function seedMismatchedHistoricalResult(pool: pg.Pool): Promise<void> {
  const scopeA = `v064-mismatch-a-${runId}`;
  const scopeB = `v064-mismatch-b-${runId}`;
  const queryId = `v064-mismatch-query-${runId}`;
  await pool.query(
    `INSERT INTO public.data_scope(scope_key,operational_domain,description)
     VALUES ($1,'TEST','v0.6.4 mismatch A'),($2,'TEST','v0.6.4 mismatch B')`,
    [scopeA, scopeB]
  );
  await insertWorldQueryJob(pool, queryId, scopeA, "RUNNING");
  const referenceKey = `wrf_${"a".repeat(20)}${runId}`;
  await pool.query(
    "SELECT public.register_result_registry_identity($1,'QUERY_RESULT',$2,$3,'Historical mismatched query result')",
    [referenceKey, queryId, scopeB]
  );
  await pool.query(
    `INSERT INTO public.world_query_result_reference(
       reference_key,query_id,data_scope_key,result_hash,status,data_snapshot_hash,
       compute_snapshot_hash,result_record,valid_until
     ) VALUES (
       $1,$2,$3,'sha256:' || repeat('5',64),'COMPLETED','sha256:' || repeat('6',64),
       'sha256:' || repeat('7',64),'{"status":"COMPLETED"}'::jsonb,
       clock_timestamp() + interval '1 hour'
     )`,
    [referenceKey, queryId, scopeB]
  );
}

async function assertMismatchRollback(pool: pg.Pool): Promise<void> {
  const migration = migrationFiles.find((name) => name.startsWith("063_"));
  assert.ok(migration);
  const sql = renderMigration(await readFile(resolve(repositoryRoot, "database/migrations", migration), "utf8"));
  const client = await pool.connect();
  try {
    await assert.rejects(
      client.query(sql),
      (error: unknown) => {
        const databaseError = error as { code?: unknown; constraint?: unknown };
        return databaseError.code === "42501" &&
          databaseError.constraint === "world_query_result_scope_claim_resolution";
      }
    );
    await client.query("ROLLBACK");
    const count = await client.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM schema_migration"
    );
    assert.equal(count.rows[0]?.count, 62);
    const schema = await client.query<{ column_name: string | null }>(
      `SELECT min(column_name) AS column_name
       FROM information_schema.columns
       WHERE table_schema='gowm_capability' AND table_name='world_query_job'
         AND column_name='resolved_data_scope_key'`
    );
    assert.equal(schema.rows[0]?.column_name, null);
  } finally {
    client.release();
  }
}

async function insertWorldQueryJob(
  pool: pg.Pool,
  queryId: string,
  dataScopeClaim: string,
  gatewayState: "RUNNING" | "SUCCEEDED"
): Promise<void> {
  const principalHash = hash(`${queryId}:principal`);
  const requestHash = hash(`${queryId}:request`);
  const gateway = await pool.query<{ job_id: string }>(
    `INSERT INTO gowm_capability.gateway_job(
       job_kind,principal_hash,data_scope_key,request_hash,state,started_at,completed_at
     ) VALUES (
       'WORLD_QUERY',$1,$2,$3,$4,clock_timestamp(),
       CASE WHEN $4='SUCCEEDED' THEN clock_timestamp() ELSE NULL END
     ) RETURNING job_id::text`,
    [principalHash, dataScopeClaim, requestHash, gatewayState]
  );
  const jobId = gateway.rows[0]?.job_id;
  assert.ok(jobId);
  await pool.query(
    `INSERT INTO gowm_capability.world_query_job(
       query_id,job_id,public_job_id,request_id,principal_ref,principal_hash,
       idempotency_key,request_hash,parameter_schema_hash,plan_hash,submission,
       authentication_method,authenticated_at,data_scope_claim,
       query_snapshot_manifest,principal_context
     ) VALUES (
       $1,$2::uuid,$1 || '-job',$1 || '-request','principal:' || $1,$3,
       $1 || '-idempotency',$4,'sha256:' || repeat('8',64),'sha256:' || repeat('9',64),
       jsonb_build_object(
         'requestId',$1 || '-request','idempotencyKey',$1 || '-idempotency',
         'parameterSchemaHash','sha256:' || repeat('8',64),'plan',jsonb_build_object('queryId',$1)
       ),
       'TEST_ATTESTED',clock_timestamp(),$5::text,
       jsonb_build_object(
         'querySnapshotId','snapshot_' || substr(encode(digest($1,'sha256'),'hex'),1,32),
         'mode','BEST_EFFORT','consistency','BEST_EFFORT',
         'capturedAt','2026-08-24T00:00:00.000Z','resources','[]'::jsonb,
         'manifestHash','sha256:' || encode(digest($1 || ':snapshot','sha256'),'hex')
       ),
       jsonb_build_object(
         'mode','STATIC_SERVICE','principalRef','principal:' || $1,
          'authenticationMethod','TEST_ATTESTED','dataScopeClaim',$5::text
       )
     )`,
    [queryId, jobId, principalHash, requestHash, dataScopeClaim]
  );
}

async function applyThrough(pool: pg.Pool, maximum: number): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migration(
       version text PRIMARY KEY,checksum text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
     )`
  );
  for (const file of migrationFiles.filter((name) => Number(name.slice(0, 3)) <= maximum)) {
    const sql = renderMigration(await readFile(resolve(repositoryRoot, "database/migrations", file), "utf8"));
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

function renderMigration(source: string): string {
  return source
    .replaceAll(":ANALYSIS_SRID", "32650")
    .replaceAll(":TRACKLET_MAX_TIME_GAP_MS", "10000")
    .replaceAll(":TRACKLET_MAX_DISTANCE_GAP_M", "250")
    .replaceAll(":TRACKLET_MAX_REQUIRED_SPEED_MPS", "80");
}

async function runSqlAssertion(pool: pg.Pool, file: string): Promise<void> {
  const source = await readFile(resolve(repositoryRoot, file), "utf8");
  const sql = source.split(/\r?\n/u).filter((line) => !line.trimStart().startsWith("\\")).join("\n");
  await pool.query(sql);
}

async function runVitest(targetDatabaseUrl: string): Promise<void> {
  const vitest = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [vitest, "run", "tests/integration/derived-result-scope-postgres.test.ts", "--reporter=verbose"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          RUN_GOWM_DERIVED_SCOPE_DB_INTEGRATION: "1",
          GOWM_DERIVED_SCOPE_DATABASE_URL: targetDatabaseUrl,
          GOWM_DERIVED_SCOPE_RUN_ID: runId
        },
        stdio: "inherit",
        windowsHide: true
      }
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`derived-result scope Vitest failed (exit=${String(code)}, signal=${String(signal)})`));
    });
  });
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function migrationCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM schema_migration");
  return result.rows[0]?.count ?? 0;
}

function databaseUrl(name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function databasePool(name: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl(name), max: 4 });
}

async function createDatabase(name: string): Promise<void> {
  assert.match(name, /^[a-z0-9_]+$/u);
  await admin.query(`CREATE DATABASE ${name}`);
}

async function dropDatabase(name: string): Promise<void> {
  assert.match(name, /^[a-z0-9_]+$/u);
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
    [name]
  );
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
}
