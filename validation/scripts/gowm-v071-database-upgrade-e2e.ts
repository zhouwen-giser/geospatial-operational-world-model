import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

import { migrate } from "../../scripts/migrate.js";
import {
  withMigratedV07Database,
  withMigratedV071Database
} from "./gowm-v07-postgres-harness.js";

type SnapshotConsistency = "PINNED" | "CONSISTENT_AT_START" | "BEST_EFFORT";

const V07_HEAD = "067_historical_trajectory_contract.sql";
const V071_HEAD = "068_effective_snapshot_consistency_downgrade.sql";
const HASH = `sha256:${"a".repeat(64)}`;
const expectedConsistency: Record<SnapshotConsistency, readonly SnapshotConsistency[]> = {
  PINNED: ["PINNED", "CONSISTENT_AT_START", "BEST_EFFORT"],
  CONSISTENT_AT_START: ["CONSISTENT_AT_START", "BEST_EFFORT"],
  BEST_EFFORT: ["BEST_EFFORT"]
};

let freshEvidence: unknown;
await withMigratedV071Database("consistency_fresh", async (databaseUrl, evidence, runId) => {
  assertMigrationHead(evidence.migrationHead, evidence.migrationCount, V071_HEAD, 68, "fresh v0.7.1");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const consistency = await assertConsistencyContract(pool, `fresh${runId}`);
    const ledger = await migrationState(pool);
    if (ledger.length !== 68 || ledger.at(-1)?.version !== V071_HEAD) {
      throw new Error("fresh v0.7.1 migration ledger is not exact through 068");
    }
    freshEvidence = {
      migrationHead: evidence.migrationHead,
      migrationCount: evidence.migrationCount,
      ledgerEntries: ledger.length,
      constraintValidated: consistency.constraintValidated,
      monotonicTriggerEnabled: consistency.monotonicTriggerEnabled,
      consistencyMatrixCases: consistency.matrixCases,
      frozenScopeCases: consistency.frozenScopeCases,
      monotonicTransitionCases: consistency.monotonicTransitionCases
    };
  } finally {
    await pool.end();
    await delay(100);
  }
});

let upgradeEvidence: unknown;
await withMigratedV07Database("v071_upgrade", async (databaseUrl, evidence, runId) => {
  assertMigrationHead(evidence.migrationHead, evidence.migrationCount, V07_HEAD, 67, "v0.7 baseline");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const before = await migrationState(pool);
    if (before.length !== 67 || before.at(-1)?.version !== V07_HEAD) {
      throw new Error("upgrade baseline ledger is not exact through 067");
    }

    const baselineQueryId = await insertQueryProbe(
      pool,
      `baseline${runId}`,
      snapshot(`baseline${runId}`, "PINNED")
    );
    const baselineDowngrade = snapshot(`baseline${runId}`, "CONSISTENT_AT_START");
    await expectScopeConstraintViolation(
      () => updateEffectiveSnapshot(pool, baselineQueryId, baselineDowngrade),
      "migration 067 must reject PINNED to CONSISTENT_AT_START"
    );
    if (await scopePreserved(pool, snapshot(`function${runId}`, "PINNED"), snapshot(`function${runId}`, "CONSISTENT_AT_START"))) {
      throw new Error("migration 067 unexpectedly allows a consistency downgrade");
    }

    await runCurrentMigration(databaseUrl);
    const after = await migrationState(pool);
    assertLedgerUpgrade(before, after);

    await updateEffectiveSnapshot(pool, baselineQueryId, baselineDowngrade);
    const upgradedBaseline = await pool.query<{ consistency: string }>(
      `SELECT effective_snapshot_manifest->>'consistency' AS consistency
       FROM gowm_capability.world_query_job
       WHERE query_id = $1`,
      [baselineQueryId]
    );
    if (upgradedBaseline.rows[0]?.consistency !== "CONSISTENT_AT_START") {
      throw new Error("migration 068 did not unlock the persisted authorized downgrade");
    }

    const consistency = await assertConsistencyContract(pool, `upgrade${runId}`);
    const structures = await requiredStructureProbe(pool);

    await runCurrentMigration(databaseUrl);
    const replayed = await migrationState(pool);
    if (JSON.stringify(replayed) !== JSON.stringify(after)) {
      throw new Error("v0.7.1 migration replay changed the 068 ledger");
    }

    upgradeEvidence = {
      migrationBase: V07_HEAD,
      migrationBaseCount: before.length,
      migrationHead: after.at(-1)?.version,
      migrationCount: after.length,
      migration068Applied: true,
      predecessorLedgerStable: true,
      checksumReplayStable: true,
      baselineRejectedDowngrade: true,
      upgradedAcceptedDowngrade: true,
      constraintValidated: consistency.constraintValidated,
      monotonicTriggerEnabled: consistency.monotonicTriggerEnabled,
      consistencyMatrixCases: consistency.matrixCases,
      frozenScopeCases: consistency.frozenScopeCases,
      monotonicTransitionCases: consistency.monotonicTransitionCases,
      requiredStructuresRetained: structures
    };
  } finally {
    await pool.end();
    await delay(100);
  }
});

process.stdout.write(`${JSON.stringify({
  status: "PASS",
  gate: "GOWM_V071_DATABASE_067_TO_068",
  fresh: freshEvidence,
  upgrade: upgradeEvidence
})}\n`);

async function runCurrentMigration(databaseUrl: string): Promise<void> {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousStasPassword = process.env.STAS_DB_PASSWORD;
  process.env.DATABASE_URL = databaseUrl;
  process.env.STAS_DB_PASSWORD = "v071-upgrade-stas-password";
  try {
    await migrate();
  } finally {
    restoreEnvironment("DATABASE_URL", previousDatabaseUrl);
    restoreEnvironment("STAS_DB_PASSWORD", previousStasPassword);
  }
}

async function assertConsistencyContract(
  pool: pg.Pool,
  fixturePrefix: string
): Promise<{
  constraintValidated: true;
  monotonicTriggerEnabled: true;
  matrixCases: number;
  frozenScopeCases: number;
  monotonicTransitionCases: number;
}> {
  const consistencies = Object.keys(expectedConsistency) as SnapshotConsistency[];
  let matrixCases = 0;
  let monotonicTransitionCases = 0;
  for (const requestedConsistency of consistencies) {
    for (const effectiveConsistency of consistencies) {
      const allowed = await scopePreserved(
        pool,
        snapshot(`${fixturePrefix}matrix`, requestedConsistency),
        snapshot(`${fixturePrefix}matrix`, effectiveConsistency)
      );
      const expected = expectedConsistency[requestedConsistency].includes(effectiveConsistency);
      if (allowed !== expected) {
        throw new Error(
          `consistency matrix mismatch: requested=${requestedConsistency}, effective=${effectiveConsistency}`
        );
      }
      matrixCases += 1;
    }
  }

  const pinnedId = await insertQueryProbe(
    pool,
    `${fixturePrefix}pinned`,
    snapshot(`${fixturePrefix}pinned`, "PINNED")
  );
  await updateEffectiveSnapshot(
    pool,
    pinnedId,
    snapshot(`${fixturePrefix}pinned`, "CONSISTENT_AT_START")
  );
  await updateEffectiveSnapshot(
    pool,
    pinnedId,
    snapshot(`${fixturePrefix}pinned`, "BEST_EFFORT")
  );
  await expectConsistencyMonotonicViolation(
    () => updateEffectiveSnapshot(
      pool,
      pinnedId,
      snapshot(`${fixturePrefix}pinned`, "CONSISTENT_AT_START")
    ),
    "requested PINNED must not strengthen persisted BEST_EFFORT to CONSISTENT_AT_START"
  );
  monotonicTransitionCases += 1;
  await expectConsistencyMonotonicViolation(
    () => updateEffectiveSnapshot(
      pool,
      pinnedId,
      snapshot(`${fixturePrefix}pinned`, "PINNED")
    ),
    "requested PINNED must not strengthen persisted BEST_EFFORT to PINNED"
  );
  monotonicTransitionCases += 1;
  const pinnedAfterRejectedStrengthening = await pool.query<{
    consistency: string;
    revision: number;
  }>(
    `SELECT effective_snapshot_manifest->>'consistency' AS consistency,
            effective_snapshot_revision AS revision
     FROM gowm_capability.world_query_job
     WHERE query_id = $1`,
    [pinnedId]
  );
  if (
    pinnedAfterRejectedStrengthening.rows[0]?.consistency !== "BEST_EFFORT"
    || pinnedAfterRejectedStrengthening.rows[0]?.revision !== 2
  ) {
    throw new Error("rejected consistency strengthening changed the persisted Effective Snapshot");
  }

  const consistentId = await insertQueryProbe(
    pool,
    `${fixturePrefix}consistent`,
    snapshot(`${fixturePrefix}consistent`, "CONSISTENT_AT_START")
  );
  await updateEffectiveSnapshot(
    pool,
    consistentId,
    snapshot(`${fixturePrefix}consistent`, "BEST_EFFORT")
  );
  await expectConsistencyMonotonicViolation(
    () => updateEffectiveSnapshot(
      pool,
      consistentId,
      snapshot(`${fixturePrefix}consistent`, "PINNED")
    ),
    "CONSISTENT_AT_START must not strengthen to PINNED"
  );
  monotonicTransitionCases += 1;

  const bestEffortId = await insertQueryProbe(
    pool,
    `${fixturePrefix}besteffort`,
    snapshot(`${fixturePrefix}besteffort`, "BEST_EFFORT")
  );
  await expectConsistencyMonotonicViolation(
    () => updateEffectiveSnapshot(
      pool,
      bestEffortId,
      snapshot(`${fixturePrefix}besteffort`, "CONSISTENT_AT_START")
    ),
    "BEST_EFFORT must not strengthen to CONSISTENT_AT_START"
  );
  monotonicTransitionCases += 1;
  await expectConsistencyMonotonicViolation(
    () => updateEffectiveSnapshot(
      pool,
      bestEffortId,
      snapshot(`${fixturePrefix}besteffort`, "PINNED")
    ),
    "BEST_EFFORT must not strengthen to PINNED"
  );
  monotonicTransitionCases += 1;

  const frozenRequestedId = `${fixturePrefix}frozen`;
  const frozenId = await insertQueryProbe(
    pool,
    frozenRequestedId,
    snapshot(frozenRequestedId, "PINNED")
  );
  await expectScopeConstraintViolation(
    () => updateEffectiveSnapshot(
      pool,
      frozenId,
      snapshot(frozenRequestedId, "BEST_EFFORT", { mode: "BEST_EFFORT" })
    ),
    "snapshot mode must remain frozen"
  );
  await expectScopeConstraintViolation(
    () => updateEffectiveSnapshot(
      pool,
      frozenId,
      snapshot(frozenRequestedId, "BEST_EFFORT", { minimumWorldVersion: 72 })
    ),
    "minimumWorldVersion must remain frozen"
  );
  await expectScopeConstraintViolation(
    () => updateEffectiveSnapshot(
      pool,
      frozenId,
      snapshot(frozenRequestedId, "BEST_EFFORT", { dataScope: "scope-b" })
    ),
    "DATA_SCOPE membership must remain frozen"
  );
  await expectScopeConstraintViolation(
    () => updateEffectiveSnapshot(
      pool,
      frozenId,
      snapshot(`${frozenRequestedId}other`, "BEST_EFFORT")
    ),
    "querySnapshotId must remain frozen"
  );

  const constraint = await pool.query<{ convalidated: boolean; definition: string }>(
    `SELECT constraint_row.convalidated,
            pg_get_constraintdef(constraint_row.oid) AS definition
     FROM pg_constraint constraint_row
     JOIN pg_class relation ON relation.oid = constraint_row.conrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'gowm_capability'
       AND relation.relname = 'world_query_job'
       AND constraint_row.conname = 'world_query_job_effective_scope_preserved'`
  );
  const constraintRow = constraint.rows[0];
  if (!constraintRow?.convalidated || !constraintRow.definition.includes("effective_snapshot_scope_preserved")) {
    throw new Error("effective snapshot scope constraint is missing or not validated");
  }

  const trigger = await pool.query<{ tgenabled: string; definition: string }>(
    `SELECT trigger_row.tgenabled,
            pg_get_triggerdef(trigger_row.oid) AS definition
     FROM pg_trigger trigger_row
     JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'gowm_capability'
       AND relation.relname = 'world_query_job'
       AND trigger_row.tgname = 'world_query_job_effective_consistency_monotonic'
       AND NOT trigger_row.tgisinternal`
  );
  const triggerRow = trigger.rows[0];
  if (
    triggerRow?.tgenabled !== "O"
    || !triggerRow.definition.includes("enforce_effective_snapshot_consistency_monotonic")
  ) {
    throw new Error("effective snapshot consistency monotonic trigger is missing or disabled");
  }

  return {
    constraintValidated: true,
    monotonicTriggerEnabled: true,
    matrixCases,
    frozenScopeCases: 4,
    monotonicTransitionCases
  };
}

function snapshot(
  querySnapshotId: string,
  consistency: SnapshotConsistency,
  options: {
    mode?: "LATEST_AT_START" | "BEST_EFFORT";
    minimumWorldVersion?: number;
    dataScope?: string;
  } = {}
): Record<string, unknown> {
  return {
    querySnapshotId,
    mode: options.mode ?? "LATEST_AT_START",
    consistency,
    capturedAt: "2026-08-30T00:00:00.000Z",
    minimumWorldVersion: options.minimumWorldVersion ?? 71,
    resources: [{
      resourceKind: "DATA_SCOPE",
      resourceId: options.dataScope ?? "scope-a"
    }],
    manifestHash: HASH
  };
}

async function scopePreserved(
  pool: pg.Pool,
  requested: Record<string, unknown>,
  effective: Record<string, unknown>
): Promise<boolean> {
  const result = await pool.query<{ allowed: boolean }>(
    `SELECT gowm_capability.effective_snapshot_scope_preserved(
       $1::jsonb,
       $2::jsonb
     ) AS allowed`,
    [JSON.stringify(requested), JSON.stringify(effective)]
  );
  return result.rows[0]?.allowed === true;
}

async function insertQueryProbe(
  pool: pg.Pool,
  suffix: string,
  requested: Record<string, unknown>
): Promise<string> {
  const safeSuffix = suffix.toLowerCase().replaceAll(/[^a-z0-9]/gu, "").slice(0, 80);
  const queryId = `q${safeSuffix}`;
  const requestId = `r${safeSuffix}`;
  const publicJobId = `j${safeSuffix}`;
  const idempotencyKey = `i${safeSuffix}`;
  const gateway = await pool.query<{ job_id: string }>(
    `INSERT INTO gowm_capability.gateway_job(
       job_kind, principal_hash, request_hash, state
     ) VALUES ('WORLD_QUERY', $1, $1, 'QUEUED')
     RETURNING job_id::text`,
    [HASH]
  );
  const gatewayJobId = gateway.rows[0]?.job_id;
  if (!gatewayJobId) throw new Error("constraint probe gateway job was not created");
  const submission = {
    requestId,
    idempotencyKey,
    parameterSchemaHash: HASH,
    plan: { queryId }
  };
  const principalRef = `principal:${safeSuffix}`;
  await pool.query(
    `INSERT INTO gowm_capability.world_query_job(
       query_id, job_id, public_job_id, request_id, principal_ref, principal_hash,
       idempotency_key, request_hash, parameter_schema_hash, plan_hash, submission,
       authentication_method, authenticated_at, query_snapshot_manifest,
       effective_snapshot_manifest, effective_snapshot_revision, principal_context
     ) VALUES (
       $1, $2::uuid, $3, $4, $5, $6,
       $7, $6, $6, $6, $8::jsonb,
       'TEST_ATTESTED', '2026-08-30T00:00:00.000Z'::timestamptz, $9::jsonb,
       $9::jsonb, 0, $10::jsonb
     )`,
    [
      queryId,
      gatewayJobId,
      publicJobId,
      requestId,
      principalRef,
      HASH,
      idempotencyKey,
      JSON.stringify(submission),
      JSON.stringify(requested),
      JSON.stringify({ principalRef, authenticationMethod: "TEST_ATTESTED" })
    ]
  );
  return queryId;
}

async function updateEffectiveSnapshot(
  pool: pg.Pool,
  queryId: string,
  effective: Record<string, unknown>
): Promise<void> {
  const updated = await pool.query(
    `UPDATE gowm_capability.world_query_job
     SET effective_snapshot_manifest = $2::jsonb,
         effective_snapshot_revision = effective_snapshot_revision + 1,
         effective_snapshot_updated_at = clock_timestamp(),
         updated_at = clock_timestamp()
     WHERE query_id = $1`,
    [queryId, JSON.stringify(effective)]
  );
  if (updated.rowCount !== 1) throw new Error(`constraint probe query is missing: ${queryId}`);
}

async function expectScopeConstraintViolation(
  action: () => Promise<void>,
  label: string
): Promise<void> {
  await expectConstraintViolation(
    action,
    label,
    "world_query_job_effective_scope_preserved"
  );
}

async function expectConsistencyMonotonicViolation(
  action: () => Promise<void>,
  label: string
): Promise<void> {
  await expectConstraintViolation(
    action,
    label,
    "world_query_job_effective_consistency_monotonic"
  );
}

async function expectConstraintViolation(
  action: () => Promise<void>,
  label: string,
  expectedConstraint: string
): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch (error) {
    const postgres = error as { code?: string; constraint?: string };
    if (
      postgres.code !== "23514" ||
      postgres.constraint !== expectedConstraint
    ) {
      throw error;
    }
    rejected = true;
  }
  if (!rejected) throw new Error(`${label}: update unexpectedly succeeded`);
}

async function requiredStructureProbe(pool: pg.Pool): Promise<true> {
  const probes = await pool.query<{
    effective_snapshots: number;
    task_intervals: number;
    tracklet_finalizations: number;
    historical_trajectories: number;
  }>(`SELECT
    (SELECT count(*)::integer FROM information_schema.columns
      WHERE table_schema='gowm_capability' AND table_name='world_query_job'
        AND column_name='effective_snapshot_manifest') AS effective_snapshots,
    (SELECT count(*)::integer FROM information_schema.tables
      WHERE table_schema='gowm_history' AND table_name='task_execution_interval_revision') AS task_intervals,
    (SELECT count(*)::integer FROM information_schema.tables
      WHERE table_schema='gowm_history' AND table_name='tracklet_finalization_revision') AS tracklet_finalizations,
    (SELECT count(*)::integer FROM information_schema.tables
      WHERE table_schema='gowm_history' AND table_name='historical_trajectory_revision') AS historical_trajectories`);
  const probe = probes.rows[0];
  if (!probe || probe.effective_snapshots !== 1 || probe.task_intervals !== 1
    || probe.tracklet_finalizations !== 1 || probe.historical_trajectories !== 1) {
    throw new Error("v0.7.1 upgrade lost required durable runtime structures");
  }
  return true;
}

function assertLedgerUpgrade(
  before: Array<{ version: string; checksum: string }>,
  after: Array<{ version: string; checksum: string }>
): void {
  if (after.length !== 68 || after.at(-1)?.version !== V071_HEAD) {
    throw new Error("067 to 068 upgrade did not produce the exact v0.7.1 migration ledger");
  }
  if (JSON.stringify(after.slice(0, before.length)) !== JSON.stringify(before)) {
    throw new Error("migration 068 changed the frozen 001-067 ledger");
  }
  if (!/^[0-9a-f]{64}$/u.test(after.at(-1)?.checksum ?? "")) {
    throw new Error("migration 068 checksum is missing or malformed");
  }
}

function assertMigrationHead(
  actualHead: string,
  actualCount: number,
  expectedHead: string,
  expectedCount: number,
  label: string
): void {
  if (actualHead !== expectedHead || actualCount !== expectedCount) {
    throw new Error(
      `${label} must be ${expectedCount} migrations through ${expectedHead}; ` +
      `received ${actualCount} through ${actualHead}`
    );
  }
}

async function migrationState(pool: pg.Pool): Promise<Array<{ version: string; checksum: string }>> {
  const result = await pool.query<{ version: string; checksum: string }>(
    "SELECT version, checksum FROM public.schema_migration ORDER BY version"
  );
  return result.rows;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
