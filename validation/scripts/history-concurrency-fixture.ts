import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

import type {
  GowmV07HistoricalTrajectoryQuery,
  GowmV07QuerySnapshotManifest,
  ProviderExecutionRequest
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  HistoricalProjectionCoordinator,
  PostgresHistoricalTrajectoryMaterializer,
  PostgresHistoricalTrajectoryOutcomeRepository,
  PostgresHistoricalTrajectoryProjectionRepository,
  PostgresTaskIntervalProjectionRepository,
  PostgresTrackletProjectionRepository,
  ProjectionFenceLostError,
  type SqlPool,
  type HistoricalTrajectoryMaterializationRequest
} from "../../packages/historical-trace-runtime/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { OperationalEventRepository } from "../../packages/runtime/src/operational-event-repository.js";
import { OperationalProjectionRepository } from "../../packages/runtime/src/operational-projection-repository.js";
import {
  ProjectionWorker,
  type ProjectionWorkerComponents
} from "../../services/projection-worker/src/worker.js";
import { createHistoricalTraceProvider } from "../../services/providers/historical-trace-provider/src/provider.js";
import {
  historicalSemanticRequestHash, HISTORICAL_TRACE_SQL
} from "../../services/providers/historical-trace-provider/src/repository.js";
import {
  withMigratedV071Database,
  type V07DatabaseEvidence
} from "./gowm-v07-postgres-harness.js";

interface FixtureIdentity {
  dataScopeKey: string;
  sourceKey: string;
  pipelineKey: string;
  datastreamKey: string;
  trackerSessionKey: string;
  targetKey: string;
  operationalTaskId: string;
  subjectReferenceKey: string;
  processingRunId: string;
  clockModelId: string;
}

interface IntervalPin {
  referenceKey: GowmV07HistoricalTrajectoryQuery["executionIntervalReferenceKey"];
  revisionId: string;
  contentHash: `sha256:${string}`;
}

interface QueueRow extends Record<string, unknown> {
  queue_id: unknown;
  state: unknown;
  generation: unknown;
  attempts: unknown;
  locked_by: unknown;
  last_error: unknown;
  trajectory_revision_id: unknown;
  outcome_id: unknown;
  captured_at: unknown;
  query_payload: unknown;
  requested_snapshot: unknown;
}

const RETAINED_RESTART_ERROR = "retained worker restart diagnostic";

export function fixtureIdentity(runId: string): FixtureIdentity {
  const suffix = runId.slice(0, 18);
  return {
    dataScopeKey: `history-queue-${suffix}`,
    sourceKey: `history-queue-source-${suffix}`,
    pipelineKey: `history-queue-pipeline-${suffix}`,
    datastreamKey: `history-queue-stream-${suffix}`,
    trackerSessionKey: `history-queue-session-${suffix}`,
    targetKey: `history-queue-target-${suffix}`,
    operationalTaskId: `history-queue-task-${suffix}`,
    subjectReferenceKey: "",
    processingRunId: randomUUID(),
    clockModelId: ""
  };
}

export async function seedFixtureFoundation(pool: pg.Pool, fixture: FixtureIdentity): Promise<void> {
  await pool.query(
    `INSERT INTO public.data_scope(scope_key,operational_domain,description)
     VALUES ($1,'TEST','v0.7 historical queue/Worker E2E scope') ON CONFLICT DO NOTHING`,
    [fixture.dataScopeKey]
  );
  await pool.query(
    `INSERT INTO public.source_registry(source_key,data_scope_key,source_type,default_analysis_space_key)
     VALUES ($1,$2,'VALIDATION','default')`,
    [fixture.sourceKey, fixture.dataScopeKey]
  );
  await pool.query(
    `INSERT INTO public.producer_pipeline(pipeline_key,source_key,pipeline_version,output_kind)
     VALUES ($1,$2,'0.7.0','CANONICAL_OBSERVATION')`,
    [fixture.pipelineKey, fixture.sourceKey]
  );
  await pool.query(
    `INSERT INTO public.datastream(datastream_key,source_key,data_scope_key,pipeline_key,schema_version)
     VALUES ($1,$2,$3,$4,'1.2')`,
    [fixture.datastreamKey, fixture.sourceKey, fixture.dataScopeKey, fixture.pipelineKey]
  );
  await pool.query(
    `INSERT INTO public.processing_run(
       processing_run_id,processor_name,processor_version,config_hash,code_digest,
       deterministic,started_at,completed_at
     ) VALUES ($1,'gowm-v07-history-queue-worker-e2e','0.7.0',$2,$3,true,clock_timestamp(),clock_timestamp())`,
    [fixture.processingRunId, sha256({ fixture: fixture.dataScopeKey }), "validation-only"]
  );
  const clock = await pool.query<{ clock_model_id: string }>(
    `INSERT INTO public.source_clock_model(
       source_key,model_version,clock_domain,residual_sigma_ms,estimation_method
     ) VALUES ($1,'history-queue-v1','DECLARED_UTC',0,'VALIDATION_FIXED_UTC')
     RETURNING clock_model_id`,
    [fixture.sourceKey]
  );
  fixture.clockModelId = requiredString(clock.rows[0]?.clock_model_id, "clock model id");
  await pool.query(
    `INSERT INTO public.world_object(id,object_type,properties,data_scope_key)
     VALUES ($1,'VEHICLE','{}'::jsonb,$2)`,
    [fixture.targetKey, fixture.dataScopeKey]
  );
  const subject = await pool.query<{ reference_key: string }>(
    `SELECT reference_key
     FROM public.world_reference_identity
     WHERE entity_kind='WORLD_OBJECT' AND internal_id=$1 AND data_scope_key=$2`,
    [fixture.targetKey, fixture.dataScopeKey]
  );
  fixture.subjectReferenceKey = requiredString(subject.rows[0]?.reference_key, "subject reference key");
}

export async function seedTaskEvents(pool: pg.Pool, fixture: FixtureIdentity, interpolatedOnly = false): Promise<void> {
  const repository = new OperationalEventRepository(pool);
  const events = [
    ["EXECUTION_STARTED_OBSERVED", interpolatedOnly ? "2026-08-30T00:00:01.000Z" : "2026-08-30T00:00:00.000Z"],
    ["EXECUTION_STOPPED_OBSERVED", interpolatedOnly ? "2026-08-30T00:00:02.000Z" : "2026-08-30T00:00:10.000Z"]
  ] as const;
  for (const [eventType, eventTime] of events) {
    const eventId = `${eventType.toLowerCase()}-${fixture.operationalTaskId}`;
    await repository.insert({
      dataScopeKey: fixture.dataScopeKey,
      sourceAuthority: "history-queue-worker-e2e",
      sourceEventKey: eventId,
      sourceRevisionNo: 1,
      eventId,
      operationalTaskId: fixture.operationalTaskId,
      eventType,
      eventTime,
      actorReferenceKeys: [],
      targetReferenceKeys: [],
      payload: { taskType: "HISTORY_QUEUE_WORKER_E2E" },
      confidence: 1,
      provenance: [{
        evidenceId: `evidence-${eventId}`,
        authority: "history-queue-worker-e2e",
        evidenceType: "VALIDATION_EVENT",
        observedAt: eventTime
      }]
    }, new Date().toISOString());
  }
}

export async function seedPositions(pool: pg.Pool, fixture: FixtureIdentity): Promise<void> {
  const points = [
    { ordinal: 1, phenomenonTime: "2026-08-30T00:00:00.000Z", x: 448_000 },
    { ordinal: 2, phenomenonTime: "2026-08-30T00:00:03.000Z", x: 448_003 },
    { ordinal: 3, phenomenonTime: "2026-08-30T00:00:07.000Z", x: 448_007 },
    { ordinal: 4, phenomenonTime: "2026-08-30T00:00:10.000Z", x: 448_010 }
  ];
  for (const point of points) await insertPosition(pool, fixture, point);
  await pool.query(
    `INSERT INTO public.entity_binding(
       data_scope_key,source_key,source_local_target_id,tracker_session_key,
       world_object_id,binding_status,method,method_version,
       evidence_observation_id,confidence
     ) VALUES ($1,$2,$3,$4,$3,'CONFIRMED','GOWM_V07_HISTORY_QUEUE_WORKER_E2E','0.7.0',$5,1)`,
    [
      fixture.dataScopeKey,
      fixture.sourceKey,
      fixture.targetKey,
      fixture.trackerSessionKey,
      `history-queue-position-1-${fixture.targetKey}`
    ]
  );
}

export async function insertPosition(
  pool: pg.Pool,
  fixture: FixtureIdentity,
  point: { ordinal: number; phenomenonTime: string; x: number }
): Promise<void> {
  const observationId = `history-queue-position-${point.ordinal}-${fixture.targetKey}`;
  const measurementId = randomUUID();
  const timeSolutionId = randomUUID();
  const receivedAt = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.world_observation(
         observation_id,observer_type,observer_id,subject_type,subject_id,
         observation_type,geometry,value,confidence,observed_at,received_at,source,
         correlation_id,metadata,data_scope_key,source_record_key,source_revision_no,
         origin_kind,source_local_target_id,tracker_session_id,datastream_key,
         producer_pipeline_key,upstream_received_time,raw_reference,payload_hash,
         entity_binding_status
       ) VALUES (
         $1,'VALIDATION_SENSOR',$2,'VEHICLE',$3,'position',
         ST_SetSRID(ST_MakePoint(116.4,39.9),4326),'{}',1,$4,$5,$2,
         $6,'{}',$7,$1,1,'SIMULATION',$3,$8,$9,$10,$5,$11,$12,'DECLARED'
       )`,
      [
        observationId,
        fixture.sourceKey,
        fixture.targetKey,
        point.phenomenonTime,
        receivedAt,
        fixture.operationalTaskId,
        fixture.dataScopeKey,
        fixture.trackerSessionKey,
        fixture.datastreamKey,
        fixture.pipelineKey,
        `inline://history-queue-worker/${point.ordinal}`,
        sha256({ observationId, point })
      ]
    );
    await client.query(
      `INSERT INTO public.world_observation_head(source_key,source_record_key,current_observation_id)
       VALUES ($1,$2,$2)`,
      [fixture.sourceKey, observationId]
    );
    await client.query(
      `INSERT INTO public.observation_time_solution(
         time_solution_id,observation_id,clock_model_id,processing_run_id,
         phenomenon_time_estimate,phenomenon_time_window,uncertainty_seconds,solution_method
       ) VALUES (
         $1,$2,$3,$4,$5,
         span($5::timestamptz,$5::timestamptz+interval '1 millisecond',true,false),
         0,'VALIDATION_FIXED_UTC'
       )`,
      [timeSolutionId, observationId, fixture.clockModelId, fixture.processingRunId, point.phenomenonTime]
    );
    await client.query(
      `INSERT INTO public.measurement(
         measurement_id,observation_id,time_solution_id,processing_run_id,
         measurement_key,measurement_stage,observed_property,result_kind,
         source_geometry,measurement_model,measurement_model_version,
         algorithm_confidence,quality_score,continuity_token,manual_cut_before,
         command_fingerprint
       ) VALUES (
         $1,$2,$3,$4,'position','NORMALIZED','position','POSITION',
         ST_SetSRID(ST_MakePoint(116.4,39.9),4326),
         'GOWM_V07_HISTORY_QUEUE_WORKER_E2E','0.7.0',1,1,$5,false,$6
       )`,
      [
        measurementId,
        observationId,
        timeSolutionId,
        fixture.processingRunId,
        `${fixture.trackerSessionKey}:continuous`,
        sha256({ observationId, measurementId, point })
      ]
    );
    await client.query(
      `INSERT INTO public.position_measurement(
         measurement_id,analysis_space_key,source_position,position,
         accuracy_radius_m,accuracy_model,accuracy_confidence
       ) VALUES (
         $1,'default',ST_SetSRID(ST_MakePoint(116.4,39.9),4326),
         ST_SetSRID(ST_MakePoint($2,4417000),32650),1,'HARD_RADIUS',0.95
       )`,
      [measurementId, point.x]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function seedCompleteWatermark(pool: pg.Pool, fixture: FixtureIdentity): Promise<void> {
  await pool.query(
    `INSERT INTO public.pipeline_watermark_revision(
       datastream_key,producer_pipeline_key,processing_run_id,clock_model_id,
       time_basis,closed_through_event_time,allowed_lateness,last_received_time,
       completeness_state
     ) VALUES ($1,$2,$3,$4,'CLOCK_MODEL','2026-08-30T00:01:00Z',
               interval '0',clock_timestamp(),'COMPLETE')`,
    [fixture.datastreamKey, fixture.pipelineKey, fixture.processingRunId, fixture.clockModelId]
  );
}

export async function projectFixture(
  adminPool: pg.Pool,
  workerPool: pg.Pool,
  fixture: FixtureIdentity,
  runId: string
): Promise<void> {
  const workerPrivileges = await adminPool.query<{
    worker_select: boolean;
    service_select: boolean;
  }>(`
    SELECT
      has_table_privilege('gowm_history_worker',
        'gowm_history.tracklet_finalization_head','SELECT') AS worker_select,
      has_table_privilege('gowm_history_worker_service',
        'gowm_history.tracklet_finalization_head','SELECT') AS service_select
  `);
  assert.deepEqual(workerPrivileges.rows[0], {
    worker_select: true,
    service_select: true
  }, `dedicated history worker privilege inheritance is incomplete: ${JSON.stringify(workerPrivileges.rows[0])}`);
  const operationalProjected = await new OperationalProjectionRepository(adminPool).projectPending(100);
  assert(operationalProjected > 0, "operational task projection did not run");
  const coordinator = new HistoricalProjectionCoordinator({
    intervals: new PostgresTaskIntervalProjectionRepository(workerPool),
    tracklets: new PostgresTrackletProjectionRepository(workerPool)
  });
  await new Promise((resolve)=>setTimeout(resolve,1100));
  const result = await coordinator.tick({
    workerId: `history-fixture-${runId}`,
    batchSize: 100,
    leaseSeconds: 60,
    retryDelayMs: 0
  });
  const failureDiagnostics = result.historicalProjectionFailures === 0
    ? []
    : (await adminPool.query<{ stage: string; last_error: string }>(`
        SELECT 'task_interval' AS stage,last_error
        FROM gowm_history.task_interval_projection_queue
        WHERE last_error IS NOT NULL
        UNION ALL
        SELECT 'tracklet' AS stage,last_error
        FROM gowm_history.tracklet_projection_queue
        WHERE last_error IS NOT NULL
        UNION ALL
        SELECT 'finalization' AS stage,last_error
        FROM gowm_history.tracklet_finalization_queue
        WHERE last_error IS NOT NULL
      `)).rows;
  assert.equal(result.historicalProjectionFailures, 0, JSON.stringify({ result, failureDiagnostics }));
  assert.equal(result.taskIntervalsProjected, 1, JSON.stringify(result));
  assert.equal(result.trackletsRebuilt, 1, JSON.stringify(result));
  assert.equal(result.trackletsFinalized, 1, JSON.stringify(result));
}

export async function loadIntervalPin(pool: pg.Pool, fixture: FixtureIdentity): Promise<IntervalPin> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT interval.reference_key,revision.interval_revision_id,
            revision.revision_no,revision.content_hash
     FROM gowm_history.task_execution_interval interval
     JOIN gowm_history.task_execution_interval_head head USING (interval_id)
     JOIN gowm_history.task_execution_interval_revision revision
       ON revision.interval_revision_id=head.current_revision_id
     WHERE interval.data_scope_key=$1
       AND interval.operational_task_id=$2
       AND interval.execution_no=1`,
    [fixture.dataScopeKey, fixture.operationalTaskId]
  );
  const row = result.rows[0];
  assert(row, "projected execution interval is missing");
  return {
    referenceKey: {
      namespace: "gowm",
      kind: "TASK_EXECUTION_INTERVAL",
      id: requiredString(row.reference_key, "interval reference key"),
      version: String(integer(row.revision_no, "interval revision"))
    },
    revisionId: requiredString(row.interval_revision_id, "interval revision id"),
    contentHash: digest(row.content_hash, "interval content hash")
  };
}

export function historicalQuery(
  fixture: FixtureIdentity,
  intervalReferenceKey: GowmV07HistoricalTrajectoryQuery["executionIntervalReferenceKey"]
): GowmV07HistoricalTrajectoryQuery {
  return {
    subjectReferenceKey: {
      namespace: "gowm",
      kind: "WORLD_OBJECT",
      id: fixture.subjectReferenceKey,
      version: "1"
    },
    executionIntervalReferenceKey: structuredClone(intervalReferenceKey),
    phaseScope: "EXECUTION_ENVELOPE",
    sourceSelection: {
      mode: "EXPLICIT_SOURCE",
      sourceKey: fixture.sourceKey,
      trackerSessionKey: fixture.trackerSessionKey
    },
    sourceSelectionProfileReferenceKey: {
      namespace: "gowm.history",
      kind: "HISTORY_METHOD_PROFILE",
      id: "trajectory-single-authoritative-v1",
      version: "1.0"
    },
    analysisSpaceReferenceKey: {
      namespace: "gowm",
      kind: "ANALYSIS_SPACE",
      id: "default",
      version: "1"
    },
    maximumInlinePoints: 100
  };
}

export function snapshotManifest(querySnapshotId: string, capturedAt: string): GowmV07QuerySnapshotManifest {
  const manifest = {
    querySnapshotId,
    mode: "LATEST_AT_START" as const,
    consistency: "CONSISTENT_AT_START" as const,
    capturedAt,
    resources: []
  };
  return { ...manifest, manifestHash: sha256(manifest) };
}

async function databaseNow(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ captured_at: Date | string }>(
    "SELECT clock_timestamp() AS captured_at"
  );
  return iso(result.rows[0]?.captured_at);
}

function requiredQueueRow(value: QueueRow | undefined): QueueRow {
  if (!value) throw new Error("historical projection queue row is missing");
  return value;
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function integer(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(result)) throw new Error(`${field} must be an integer`);
  return result;
}

function digest(value: unknown, field: string): `sha256:${string}` {
  const result = requiredString(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error(`${field} must be SHA-256`);
  return result as `sha256:${string}`;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid timestamp: ${String(value)}`);
  return date.toISOString();
}
