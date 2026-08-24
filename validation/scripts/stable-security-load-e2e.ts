import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import pg from "pg";

import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { OperationalEventRepository } from "../../packages/runtime/src/operational-event-repository.js";
import { OperationalProjectionRepository } from "../../packages/runtime/src/operational-projection-repository.js";
import { OperationalReadRepository } from "../../packages/runtime/src/operational-read-repository.js";
import {
  catalogScopeDigest,
  decodeCatalogCursor,
  encodeCatalogCursor
} from "../../services/providers/grounding-catalog-provider/src/cursor.js";
import { GroundingCatalogRepository } from "../../services/providers/grounding-catalog-provider/src/repository.js";
import { redactPublicDetails } from "../../services/gateway/world-capability-gateway/src/redaction.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const runId = process.env.S02_RUN_ID;
if (!runId || !/^[a-z0-9-]{3,80}$/u.test(runId)) throw new Error("S02_RUN_ID is required and must be safe");
const mode = process.env.S02_MODE ?? "initial";
const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });
const scopeA = `s02-a-${runId}`;
const scopeB = `s02-b-${runId}`;
const taskA = `s02-task-a-${runId}`;
const taskB = `s02-task-b-${runId}`;
const secretName = `scope-b-secret-${runId}`;
const cursorSecret = "S02StableCursorIntegritySecret_2026";

try {
  if (mode === "recovery") await verifyRecovery();
  else await initial();
} finally {
  await pool.end();
}

async function initial(): Promise<void> {
  await createScope(scopeA);
  await createScope(scopeB);
  const events = new OperationalEventRepository(pool);
  const projections = new OperationalProjectionRepository(pool);
  const base = Date.now() - 120_000;

  for (let index = 0; index < 60; index += 1) {
    await events.insert(event(scopeA, taskA, `timeline-${index}`, index + 1, "EXECUTION_PROGRESS_OBSERVED", new Date(base + index * 1_000).toISOString()));
  }
  await events.insert(event(scopeA, taskA, "control-current", 61, "CONTROL_REJECTED_OBSERVED", new Date(base + 70_000).toISOString()));
  await events.insert(event(scopeB, taskB, "scope-b-event", 1, "EXECUTION_STOPPED_OBSERVED", new Date(base + 50_000).toISOString()));

  const projectionStarted = performance.now();
  await projections.projectPending(100);
  const initialProjectionMs = performance.now() - projectionStarted;
  const snapshotA = await projections.get(scopeA, taskA);
  const snapshotB = await projections.get(scopeB, taskB);
  assert.ok(snapshotA && snapshotB);

  await pool.query(
    `INSERT INTO world_reference_name(
       reference_key,data_scope_key,name_kind,language_tag,name_text,normalized_text,source_ref,confidence
     ) VALUES ($1,$2,'ALIAS','und',$3,normalize_reference_text($3),'s02-security',1)`,
    [snapshotB.referenceKey.id, scopeB, secretName]
  );
  await pool.query("SELECT rebuild_reference_search_projection($1)", [scopeA]);
  await pool.query("SELECT rebuild_reference_search_projection($1)", [scopeB]);

  const catalog = new GroundingCatalogRepository({ pool, cursorSecret });
  const input = {
    schemaVersion: "1.0",
    mentions: [{ mentionId: "secret", surfaceText: secretName, expectedKinds: ["OPERATIONAL_TASK"] }],
    context: { anchorReferenceKeys: [] },
    limitPerMention: 10
  };
  const hidden = await catalog.execute("reference.resolve", input, { dataScopeKey: scopeA }, 5_000);
  const visible = await catalog.execute("reference.resolve", input, { dataScopeKey: scopeB }, 5_000);
  const hiddenResolution = (hidden.output as any).resolutions[0];
  const visibleResolution = (visible.output as any).resolutions[0];
  assert.ok(hiddenResolution.candidates.every((candidate: any) => candidate.candidate.referenceKey.id !== snapshotB.referenceKey.id));
  assert.equal(visibleResolution.status, "RESOLVED_EXACT");
  assert.equal(visibleResolution.candidates.length, 1);

  const reads = new OperationalReadRepository(pool);
  const hiddenTasks = await reads.find(scopeA, { referenceKey: snapshotB.referenceKey });
  const hiddenEvents = await reads.timeline(scopeA, snapshotB.referenceKey);
  assert.equal(hiddenTasks.result.tasks.length, 0);
  assert.equal(hiddenEvents.result.events.length, 0);

  const cursor = encodeCatalogCursor({
    v: 1,
    operationId: "reference.search",
    scopeDigest: catalogScopeDigest(scopeA),
    snapshotVersion: "1",
    after: snapshotA.referenceKey.id
  }, cursorSecret);
  assert.throws(() => decodeCatalogCursor(`${cursor}x`, {
    operationId: "reference.search",
    scopeDigest: catalogScopeDigest(scopeA),
    snapshotVersion: "1"
  }, cursorSecret), { code: "INVALID_REQUEST" });

  const sensitive = JSON.stringify(redactPublicDetails({
    token: "s02-super-secret-token",
    geometry: { coordinates: [116.4, 39.9] },
    name: secretName,
    issues: [{ path: "/input/name", keyword: "enum" }]
  }));
  assert.ok(!sensitive.includes("s02-super-secret-token"));
  assert.ok(!sensitive.includes(secretName));
  assert.ok(!sensitive.includes("116.4"));

  const planClient = await pool.connect();
  let planText: string;
  try {
    await planClient.query("BEGIN");
    await planClient.query("SET LOCAL enable_seqscan=off");
    const plan = await planClient.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
       SELECT reference_key FROM reference_search_projection
       WHERE data_scope_key=$1 AND normalized_text=$2
       ORDER BY match_priority,reference_key LIMIT 10`,
      [scopeB, secretName]
    );
    planText = JSON.stringify(plan.rows[0]?.["QUERY PLAN"]);
    await planClient.query("ROLLBACK");
  } finally {
    planClient.release();
  }
  assert.ok(planText.includes("reference_search_projection_scope_exact_idx"), planText);

  const timelineLatencies: number[] = [];
  for (let index = 0; index < 60; index += 1) {
    const started = performance.now();
    const timeline = await reads.timeline(scopeA, snapshotA.referenceKey, { limit: 100 });
    timelineLatencies.push(performance.now() - started);
    assert.ok(timeline.result.events.length >= 60);
  }
  const timelineP95Ms = percentile(timelineLatencies, 0.95);
  assert.ok(timelineP95Ms < 250, `timeline p95 ${timelineP95Ms}ms exceeds the 250ms local target`);

  const duplicate = event(scopeA, taskA, "concurrent-duplicate", 62, "EXECUTION_PROGRESS_OBSERVED", new Date(base + 80_000).toISOString());
  const duplicateResults = await Promise.all(Array.from({ length: 8 }, () => events.insert(duplicate)));
  assert.equal(duplicateResults.filter((value) => value.status !== "duplicate").length, 1);
  assert.equal(duplicateResults.filter((value) => value.status === "duplicate").length, 7);

  const beforeLate = await projections.get(scopeA, taskA);
  assert.equal(beforeLate?.controlState, "REJECTED_OBSERVED");
  await events.insert(event(scopeA, taskA, "late-control", 63, "CONTROL_ACCEPTED_OBSERVED", new Date(base + 10_000).toISOString()));
  const restartedProjector = new OperationalProjectionRepository(pool);
  const restartStarted = performance.now();
  const projected = await restartedProjector.projectPending(100);
  const projectionLagMs = performance.now() - restartStarted;
  const afterLate = await restartedProjector.get(scopeA, taskA);
  assert.equal(afterLate?.controlState, "REJECTED_OBSERVED");
  const secondRestart = new OperationalProjectionRepository(pool);
  assert.equal(await secondRestart.projectPending(100), 0);
  assert.ok(projected >= 1);
  assert.ok(projectionLagMs < 2_000, `projection lag ${projectionLagMs}ms exceeds the 2s local target`);

  process.stdout.write(`${JSON.stringify({
    result: "STABLE_SECURITY_LOAD_INITIAL_PASS",
    runId,
    crossScopeNames: "PASS_NO_FOREIGN_REFERENCE",
    crossScopeEvents: "PASS",
    cursorIntegrity: "PASS",
    logRedaction: "PASS",
    referenceSearchPlan: "reference_search_projection_scope_exact_idx",
    timelineP95Ms: round(timelineP95Ms),
    timelineSamples: timelineLatencies.length,
    initialProjectionMs: round(initialProjectionMs),
    projectionLagMs: round(projectionLagMs),
    concurrentIdempotency: { accepted: 1, duplicates: 7 },
    lateEventNonRegression: "PASS",
    projectorRestart: "PASS",
    recoveryFixtureHash: sha256({ scopeA, scopeB, taskA, taskB, secretName })
  }, null, 2)}\n`);
}

async function verifyRecovery(): Promise<void> {
  const reads = new OperationalReadRepository(pool);
  const result = await pool.query<{ reference_key: string }>(
    "SELECT reference_key FROM operational_task WHERE data_scope_key=$1 AND operational_task_id=$2",
    [scopeA, taskA]
  );
  const referenceKey = result.rows[0]?.reference_key;
  assert.ok(referenceKey);
  const recovered = await reads.find(scopeA, {
    referenceKey: { namespace: "gowm", kind: "OPERATIONAL_TASK", id: referenceKey, version: "1" }
  });
  assert.equal(recovered.result.tasks[0]?.operationalTaskId, taskA);

  const catalog = new GroundingCatalogRepository({ pool, cursorSecret });
  const resolved = await catalog.execute("reference.resolve", {
    schemaVersion: "1.0",
    mentions: [{ mentionId: "secret", surfaceText: secretName, expectedKinds: ["OPERATIONAL_TASK"] }],
    context: { anchorReferenceKeys: [] },
    limitPerMention: 10
  }, { dataScopeKey: scopeB }, 5_000);
  assert.equal((resolved.output as any).resolutions[0].status, "RESOLVED_EXACT");

  process.stdout.write(`${JSON.stringify({
    result: "STABLE_DB_RESTART_RECOVERY_PASS",
    runId,
    referenceReadRecovered: true,
    operationalReadRecovered: true
  }, null, 2)}\n`);
}

async function createScope(scope: string): Promise<void> {
  await pool.query(
    "INSERT INTO data_scope(scope_key,operational_domain,description) VALUES ($1,'TEST',$2)",
    [scope, `S02 isolated scope ${scope}`]
  );
  const identity = await pool.query<{ reference_key: string }>(
    `SELECT reference_key FROM world_reference_identity
     WHERE entity_kind='DATA_SCOPE' AND internal_id=$1 AND data_scope_key=$1`,
    [scope]
  );
  const referenceKey = identity.rows[0]?.reference_key;
  assert.ok(referenceKey);
  await pool.query(
    `INSERT INTO world_reference_descriptor_version(
       reference_key,data_scope_key,reference_type,display_name,content_hash
     ) VALUES ($1,$2,'DATA_SCOPE',$3,$4)`,
    [referenceKey, scope, `S02 scope ${scope}`, sha256({ referenceKey, scope })]
  );
}

function event(
  scope: string,
  task: string,
  key: string,
  revision: number,
  eventType: "EXECUTION_PROGRESS_OBSERVED" | "CONTROL_REJECTED_OBSERVED" | "CONTROL_ACCEPTED_OBSERVED" | "EXECUTION_STOPPED_OBSERVED",
  eventTime: string
) {
  return {
    dataScopeKey: scope,
    sourceAuthority: "s02-stability",
    sourceEventKey: `${runId}-${key}`,
    sourceRevisionNo: revision,
    eventId: `${runId}-${key}`,
    operationalTaskId: task,
    eventType,
    eventTime,
    actorReferenceKeys: [],
    targetReferenceKeys: [],
    payload: { taskType: "S02_STABILITY" },
    confidence: 1,
    provenance: [{
      evidenceId: `${runId}-evidence-${key}`,
      authority: "s02",
      evidenceType: "STABILITY_TEST",
      observedAt: eventTime
    }]
  };
}

function percentile(values: number[], quantile: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * quantile) - 1)] ?? 0;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
