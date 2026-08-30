import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { reconstructTaskExecutionIntervals } from "../../packages/historical-trace-core/src/index.js";
import {
  HistoricalProjectionCoordinator,
  PostgresMobilityDbTrajectorySlicer,
  PostgresTaskIntervalProjectionRepository,
  PostgresTrackletProjectionRepository
} from "../../packages/historical-trace-runtime/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import {
  withMigratedV07Database,
  type V07DatabaseEvidence
} from "./gowm-v07-postgres-harness.js";

type JsonRecord = Record<string, unknown>;

const SAMPLE = {
  positions: 10_000,
  trajectorySamples: 5_000,
  taskEvents: 1_000,
  dirtyKeysRequested: 100,
  dirtyKeysSeeded: 101,
  dirtyKeyKinds: ["TASK", "TRACKLET"],
  previewLimit: 100
} as const;

// These are bounded validation timeouts for a developer workstation. They are
// deliberately generous and are not production latency/SLO claims.
const MAX_MS = {
  positionFixture: 180_000,
  trackletRebuild: 120_000,
  trajectorySlice: 30_000,
  intervalReconstruction: 120_000,
  boundedWorkerTick: 180_000,
  boundedTrackletClaim: 30_000,
  total: 480_000
} as const;

await withMigratedV07Database("history_performance", async (databaseUrl, versions, runId) => {
  await runPerformanceSample(databaseUrl, versions, runId);
});

async function runPerformanceSample(
  databaseUrl: string,
  versions: V07DatabaseEvidence,
  runId: string
): Promise<void> {
  const started = performance.now();
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    connectionTimeoutMillis: 5_000,
    query_timeout: MAX_MS.boundedWorkerTick
  });
  const suffix = runId.slice(0, 18);
  const scope = `history-perf-${suffix}`;
  const source = `history-perf-source-${suffix}`;
  const pipeline = `history-perf-pipeline-${suffix}`;
  const stream = `history-perf-stream-${suffix}`;
  const target = `history-perf-target-${suffix}`;
  const session = `history-perf-session-${suffix}`;
  const processingRunId = randomUUID();
  const intervalTask = `history-perf-interval-${suffix}`;
  try {
    const clockModelId = await seedFoundation(
      pool, { scope, source, pipeline, stream, processingRunId }
    );

    const positionFixtureMs = await timed(async () => {
      await seedPositionFixture(pool, {
        scope, source, pipeline, stream, target, session, processingRunId, clockModelId
      });
    });
    within(positionFixtureMs, MAX_MS.positionFixture, "10k position fixture and Dirty Queue coalescing");
    const activeTrackletQueue = await scalar(pool,
      `SELECT count(*) FROM gowm_history.tracklet_projection_queue
       WHERE data_scope_key=$1 AND source_key=$2 AND source_local_target_id=$3
         AND tracker_session_key=$4 AND state IN ('QUEUED','RUNNING','FAILED')`,
      [scope, source, target, session]
    );
    const totalTrackletQueue = await scalar(pool,
      `SELECT count(*) FROM gowm_history.tracklet_projection_queue
       WHERE data_scope_key=$1 AND source_key=$2 AND source_local_target_id=$3
         AND tracker_session_key=$4`,
      [scope, source, target, session]
    );
    assert.equal(activeTrackletQueue, 1, "10k writes for one Dirty Key must coalesce to one active queue item");
    assert.equal(totalTrackletQueue, SAMPLE.positions, "append-only queue evidence must retain superseded inputs");

    const tracklets = new PostgresTrackletProjectionRepository(pool);
    const claim = (await tracklets.claimTracklets(`history-perf-tracklet-${suffix}`, 1, 120))[0];
    assert(claim, "10k Tracklet Dirty Key was not claimable");
    let trackletVersionId = "";
    const trackletRebuildMs = await timed(async () => {
      trackletVersionId = await tracklets.rebuildAndComplete(claim);
    });
    within(trackletRebuildMs, MAX_MS.trackletRebuild, "10k position Tracklet rebuild");
    const tracklet = await pool.query<{ sample_count: number; sequence_count: number; start_event_time: Date | string }>(
      `SELECT sample_count,sequence_count,start_event_time
       FROM public.mobility_tracklet_version WHERE tracklet_version_id=$1::uuid`,
      [trackletVersionId]
    );
    assert.equal(Number(tracklet.rows[0]?.sample_count), SAMPLE.positions);
    assert.equal(Number(tracklet.rows[0]?.sequence_count), 1);

    const firstSegment = await pool.query<{ segment_no: number; start_time: Date | string }>(
      `SELECT segment_no,start_time FROM public.mobility_tracklet_segment
       WHERE tracklet_version_id=$1::uuid ORDER BY segment_no LIMIT 1`,
      [trackletVersionId]
    );
    const segment = firstSegment.rows[0];
    assert(segment, "Tracklet segment is missing");
    const sliceStart = iso(segment.start_time);
    const sliceEnd = new Date(Date.parse(sliceStart) + SAMPLE.trajectorySamples * 10).toISOString();
    let slicedSamples = 0;
    const trajectorySliceMs = await timed(async () => {
      const sliced = await new PostgresMobilityDbTrajectorySlicer(pool).slice({
        dataScopeKey: scope,
        sourceTrackletVersionId: trackletVersionId,
        sourceSegmentNo: Number(segment.segment_no),
        period: { start: sliceStart, end: sliceEnd, bounds: "[)" },
        sequenceNo: 1,
        requestedPeriodNo: 1
      });
      assert(sliced, "5k MobilityDB trajectory slice returned no data");
      slicedSamples = sliced.sampleCount;
    });
    within(trajectorySliceMs, MAX_MS.trajectorySlice, "5k sample Historical Trajectory slice");
    assert.equal(slicedSamples, SAMPLE.trajectorySamples);

    const intervalRepository = new PostgresTaskIntervalProjectionRepository(pool);
    await seedOperationalTask(pool, scope, intervalTask);
    await seedThousandTaskEvents(pool, scope, intervalTask);
    const intervalClaim = (await intervalRepository.claim(`history-perf-interval-${suffix}`, 1, 120))[0];
    assert(intervalClaim, "1k Task Event Dirty Key was not claimable");
    let intervalInputCount = 0;
    let intervalRevisionCount = 0;
    const intervalReconstructionMs = await timed(async () => {
      const input = await intervalRepository.load(intervalClaim);
      intervalInputCount = input.events.length;
      const reconstruction = reconstructTaskExecutionIntervals(input.events, input.profile);
      const committed = await intervalRepository.commit(input, reconstruction);
      intervalRevisionCount = committed.appendedRevisionIds.length + committed.reusedRevisionIds.length;
    });
    within(intervalReconstructionMs, MAX_MS.intervalReconstruction, "1k Task Event interval reconstruction");
    assert.equal(intervalInputCount, SAMPLE.taskEvents);
    assert.equal(intervalRevisionCount, 1);
    const persistedIntervalInputs = await scalar(pool,
      `SELECT count(*) FROM gowm_history.task_execution_interval_input input
       JOIN gowm_history.task_execution_interval_revision revision USING (interval_revision_id)
       JOIN gowm_history.task_execution_interval interval USING (interval_id)
       WHERE interval.data_scope_key=$1 AND interval.operational_task_id=$2`,
      [scope, intervalTask]
    );
    assert.equal(persistedIntervalInputs, SAMPLE.taskEvents);

    await seedDirtyTaskKeys(pool, scope, suffix, SAMPLE.dirtyKeysSeeded);
    const coordinator = new HistoricalProjectionCoordinator({
      intervals: intervalRepository,
      tracklets
    });
    let tickResult: Awaited<ReturnType<HistoricalProjectionCoordinator["tick"]>> | undefined;
    const boundedWorkerTickMs = await timed(async () => {
      tickResult = await coordinator.tick({
        workerId: `history-perf-bounded-${suffix}`,
        batchSize: SAMPLE.dirtyKeysRequested,
        leaseSeconds: 120,
        retryDelayMs: 0
      });
    });
    within(boundedWorkerTickMs, MAX_MS.boundedWorkerTick, "100 Dirty Key bounded worker tick");
    assert(tickResult, "bounded worker returned no result");
    assert.equal(tickResult.taskIntervalsClaimed, SAMPLE.dirtyKeysRequested);
    assert.equal(tickResult.taskIntervalsProjected, SAMPLE.dirtyKeysRequested);
    assert.equal(tickResult.trackletsClaimed, 0, "completed 10k Tracklet work must not be reclaimed");
    assert.equal(tickResult.finalizationsClaimed, 1, "bounded full tick must claim the pending 10k Tracklet finalization");
    assert.equal(tickResult.trackletsFinalized, 1, "bounded full tick must finish the pending Tracklet finalization");
    assert.equal(tickResult.historicalProjectionFailures, 0, JSON.stringify(tickResult));
    const remainingTaskDirtyKeys = await scalar(pool,
      `SELECT count(*) FROM gowm_history.task_interval_projection_queue
       WHERE data_scope_key=$1 AND state IN ('QUEUED','FAILED')
         AND operational_task_id LIKE $2`,
      [scope, `history-perf-dirty-${suffix}-%`]
    );
    assert.equal(
      remainingTaskDirtyKeys,
      1,
      "bounded Task tick must leave the 101st Dirty Key for a later tick"
    );

    await seedDirtyTrackletKeys(pool, scope, source, suffix, SAMPLE.dirtyKeysSeeded);
    let boundedTrackletClaims: Awaited<ReturnType<PostgresTrackletProjectionRepository["claimTracklets"]>> = [];
    const boundedTrackletClaimMs = await timed(async () => {
      boundedTrackletClaims = await tracklets.claimTracklets(
        `history-perf-tracklet-bounded-${suffix}`,
        SAMPLE.dirtyKeysRequested,
        120
      );
    });
    within(
      boundedTrackletClaimMs,
      MAX_MS.boundedTrackletClaim,
      "100 Tracklet Dirty Key bounded claim"
    );
    assert.equal(
      boundedTrackletClaims.length,
      SAMPLE.dirtyKeysRequested,
      "bounded Tracklet claim must stop at the requested batch size"
    );
    const remainingTrackletDirtyKeys = await scalar(pool,
      `SELECT count(*) FROM gowm_history.tracklet_projection_queue
       WHERE data_scope_key=$1 AND source_key=$2
         AND state IN ('QUEUED','FAILED')
         AND source_local_target_id LIKE $3`,
      [scope, source, `history-perf-tracklet-dirty-${suffix}-%`]
    );
    assert.equal(
      remainingTrackletDirtyKeys,
      1,
      "bounded Tracklet claim must leave the 101st Dirty Key for a later tick"
    );

    const previewIndexes = evenlySpacedIndexes(SAMPLE.positions, SAMPLE.previewLimit);
    let previewCount = 0;
    const previewMs = await timed(async () => {
      const preview = await pool.query<{ preview_count: number }>(
        `WITH selected AS (
           SELECT trajectory FROM public.mobility_tracklet_version
           WHERE tracklet_version_id=$1::uuid
         ), requested AS (
           SELECT sample_index,ordinality
           FROM unnest($2::integer[]) WITH ORDINALITY sample(sample_index,ordinality)
         )
         SELECT count(*)::integer AS preview_count
         FROM selected CROSS JOIN requested
         WHERE timestampN(selected.trajectory,requested.sample_index) IS NOT NULL`,
        [trackletVersionId, previewIndexes]
      );
      previewCount = Number(preview.rows[0]?.preview_count);
    });
    assert.equal(previewCount, SAMPLE.previewLimit);
    assert(previewCount < SAMPLE.positions, "large trajectory must not be serialized as unbounded inline JSON");

    await pool.query("ANALYZE public.world_observation");
    await pool.query("ANALYZE public.world_observation_head");
    await pool.query("ANALYZE public.operational_task_event");
    await pool.query("ANALYZE public.mobility_tracklet_segment");
    const plans = {
      trackletSelection: await explain(pool,
        `SELECT observation.observation_id
         FROM public.world_observation observation
         JOIN public.world_observation_head head
           ON head.current_observation_id=observation.observation_id
         WHERE observation.data_scope_key=$1 AND observation.source=$2
           AND observation.source_local_target_id=$3
           AND COALESCE(observation.tracker_session_id,'__UNSCOPED__')=$4
         ORDER BY observation.observation_id LIMIT 100`,
        [scope, source, target, session]
      ),
      taskEventHistory: await explain(pool,
        `SELECT event_id FROM public.operational_task_event
         WHERE data_scope_key=$1 AND operational_task_id=$2
         ORDER BY event_time,received_time,source_authority,source_event_key,source_revision_no,event_id
         LIMIT 100`,
        [scope, intervalTask]
      ),
      trackletSegments: await explain(pool,
        `SELECT segment_no,start_time,end_time FROM public.mobility_tracklet_segment
         WHERE tracklet_version_id=$1::uuid ORDER BY segment_no`,
        [trackletVersionId]
      ),
      boundedPreview: await explain(pool,
        `WITH selected AS (
           SELECT trajectory FROM public.mobility_tracklet_version
           WHERE tracklet_version_id=$1::uuid
         ), requested AS (
           SELECT sample_index FROM unnest($2::integer[]) sample(sample_index)
         )
         SELECT timestampN(selected.trajectory,requested.sample_index)
         FROM selected CROSS JOIN requested`,
        [trackletVersionId, previewIndexes]
      )
    };
    const requiredIndexes = [
      "world_observation_tracklet_selection_idx",
      "world_observation_head_current_idx",
      "operational_task_event_deterministic_history_idx",
      "mobility_tracklet_segment_pkey",
      "mobility_tracklet_version_pkey"
    ] as const;
    const indexCatalog = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname='public' AND indexname=ANY($1::text[])
       ORDER BY indexname`,
      [[...requiredIndexes]]
    );
    const presentIndexes = new Set(indexCatalog.rows.map((row) => row.indexname));
    for (const name of requiredIndexes) {
      assert(presentIndexes.has(name), `required index is absent: ${name}`);
    }
    // At 10k observations the selection and head indexes must be chosen by the
    // planner. The one-row Tracklet tables may truthfully prefer a sequential
    // scan, so their primary keys are catalog-gated without forcing the planner.
    requireIndex(plans.trackletSelection, "world_observation_tracklet_selection_idx");
    requireIndex(plans.trackletSelection, "world_observation_head_current_idx");
    requireIndex(plans.taskEventHistory, "operational_task_event_deterministic_history_idx");
    const hotPathIndexesObservedInExplain = [
      plans.trackletSelection.indexes.has("world_observation_tracklet_selection_idx"),
      plans.trackletSelection.indexes.has("world_observation_head_current_idx"),
      plans.taskEventHistory.indexes.has("operational_task_event_deterministic_history_idx")
    ].every(Boolean);
    assert(hotPathIndexesObservedInExplain);
    const planEvidence = Object.fromEntries(Object.entries(plans).map(([name, plan]) => [name, {
      nodeTypes: [...plan.nodeTypes].sort(),
      indexes: [...plan.indexes].sort()
    }]));

    const totalMs = performance.now() - started;
    within(totalMs, MAX_MS.total, "complete historical performance sample");
    process.stdout.write(`${JSON.stringify({
      status: "PASS",
      gate: "GOWM_V07_HISTORY_PERFORMANCE_SAMPLE",
      versions,
      sample: SAMPLE,
      thresholdsMs: MAX_MS,
      timingsMs: {
        positionFixture: rounded(positionFixtureMs),
        trackletRebuild: rounded(trackletRebuildMs),
        trajectorySlice: rounded(trajectorySliceMs),
        intervalReconstruction: rounded(intervalReconstructionMs),
        boundedWorkerTick: rounded(boundedWorkerTickMs),
        boundedTrackletClaim: rounded(boundedTrackletClaimMs),
        boundedPreview: rounded(previewMs),
        total: rounded(totalMs)
      },
      checks: {
        activeDirtyRowsAfter10kPositions: activeTrackletQueue,
        appendOnlyDirtyEvidenceRows: totalTrackletQueue,
        rebuiltTrackletSamples: Number(tracklet.rows[0]?.sample_count),
        slicedTrajectorySamples: slicedSamples,
        intervalInputEvents: intervalInputCount,
        persistedIntervalInputs,
        boundedWorkerClaimed: tickResult.taskIntervalsClaimed,
        boundedTaskDirtyKeysClaimed: tickResult.taskIntervalsClaimed,
        boundedTrackletDirtyKeysClaimed: boundedTrackletClaims.length,
        boundedWorkerTrackletsFinalized: tickResult.trackletsFinalized,
        dirtyKeysRemaining: remainingTaskDirtyKeys,
        taskDirtyKeysRemaining: remainingTaskDirtyKeys,
        trackletDirtyKeysRemaining: remainingTrackletDirtyKeys,
        storedTrackletSamples: Number(tracklet.rows[0]?.sample_count),
        inlinePreviewPoints: previewCount,
        previewBounded: previewCount === SAMPLE.previewLimit,
        hotPathIndexesObservedInExplain,
        requiredIndexCatalogEntriesPresent: presentIndexes.size === requiredIndexes.length,
        explainPlanHash: sha256(planEvidence)
      },
      requiredIndexes: [...requiredIndexes],
      planEvidence,
      interpretation: "bounded developer-workstation sample only; not production capacity or SLO certification",
      sharedRuntimeMutated: false
    })}\n`);
  } finally {
    await pool.end();
  }
}

async function seedFoundation(
  pool: pg.Pool,
  fixture: { scope: string; source: string; pipeline: string; stream: string; processingRunId: string }
): Promise<string> {
  await pool.query(
    `INSERT INTO public.data_scope(scope_key,operational_domain,description)
     VALUES ($1,'TEST','v0.7 bounded history performance sample')`,
    [fixture.scope]
  );
  await pool.query(
    `INSERT INTO public.source_registry(source_key,data_scope_key,source_type,default_analysis_space_key)
     VALUES ($1,$2,'VALIDATION','default')`,
    [fixture.source, fixture.scope]
  );
  await pool.query(
    `INSERT INTO public.producer_pipeline(pipeline_key,source_key,pipeline_version,output_kind)
     VALUES ($1,$2,'0.7.0','CANONICAL_OBSERVATION')`,
    [fixture.pipeline, fixture.source]
  );
  await pool.query(
    `INSERT INTO public.datastream(datastream_key,source_key,data_scope_key,pipeline_key,schema_version)
     VALUES ($1,$2,$3,$4,'1.2')`,
    [fixture.stream, fixture.source, fixture.scope, fixture.pipeline]
  );
  await pool.query(
    `INSERT INTO public.processing_run(
       processing_run_id,processor_name,processor_version,config_hash,code_digest,
       deterministic,started_at,completed_at
     ) VALUES ($1,'gowm-v07-history-performance','0.7.0',$2,'validation-only',true,clock_timestamp(),clock_timestamp())`,
    [fixture.processingRunId, sha256({ fixture: fixture.scope })]
  );
  const clock = await pool.query<{ clock_model_id: string }>(
    `INSERT INTO public.source_clock_model(
       source_key,model_version,clock_domain,residual_sigma_ms,estimation_method
     ) VALUES ($1,'history-performance-v1','DECLARED_UTC',0,'VALIDATION_FIXED_UTC')
     RETURNING clock_model_id`,
    [fixture.source]
  );
  return requiredString(clock.rows[0]?.clock_model_id, "clock model id");
}

async function seedPositionFixture(
  pool: pg.Pool,
  fixture: {
    scope: string; source: string; pipeline: string; stream: string; target: string;
    session: string; processingRunId: string; clockModelId: string;
  }
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.world_observation(
         observation_id,observer_type,observer_id,subject_type,subject_id,
         observation_type,geometry,value,confidence,observed_at,received_at,
         source,correlation_id,metadata,data_scope_key,source_record_key,
         source_revision_no,origin_kind,source_local_target_id,tracker_session_id,
         datastream_key,producer_pipeline_key,upstream_received_time,raw_reference,
         payload_hash,entity_binding_status
       )
       SELECT
         $1 || '-observation-' || item::text,'VALIDATION_SENSOR',$2,'VEHICLE',$3,
         'position',ST_SetSRID(ST_MakePoint(116.4+item*1e-8,39.9),4326),'{}',1,
         '2026-08-30T00:00:00Z'::timestamptz + item*interval '10 milliseconds',
         clock_timestamp(),$2,$1,'{}',$4,$1 || '-observation-' || item::text,1,
         'SIMULATION',$3,$5,$6,$7,clock_timestamp(),
         'inline://history-performance/' || item::text,
         'sha256:' || encode(digest(($1 || ':observation:' || item::text)::text,'sha256'),'hex'),
         'DECLARED'
       FROM generate_series(1,$8::integer) item`,
      [
        fixture.scope, fixture.source, fixture.target, fixture.scope, fixture.session,
        fixture.stream, fixture.pipeline, SAMPLE.positions
      ]
    );
    await client.query(
      `INSERT INTO public.world_observation_head(source_key,source_record_key,current_observation_id)
       SELECT $1,observation_id,observation_id
       FROM public.world_observation WHERE data_scope_key=$2 AND source=$1`,
      [fixture.source, fixture.scope]
    );
    await client.query(
      `INSERT INTO public.observation_time_solution(
         time_solution_id,observation_id,clock_model_id,processing_run_id,
         phenomenon_time_estimate,phenomenon_time_window,uncertainty_seconds,solution_method
       )
       SELECT md5(observation.observation_id || ':time')::uuid,observation.observation_id,
              $1::uuid,$2::uuid,observation.observed_at,
              span(observation.observed_at,observation.observed_at+interval '1 millisecond',true,false),
              0,'VALIDATION_FIXED_UTC'
       FROM public.world_observation observation
       WHERE observation.data_scope_key=$3 AND observation.source=$4`,
      [fixture.clockModelId, fixture.processingRunId, fixture.scope, fixture.source]
    );
    await client.query(
      `INSERT INTO public.measurement(
         measurement_id,observation_id,time_solution_id,processing_run_id,
         measurement_key,measurement_stage,observed_property,result_kind,
         source_geometry,measurement_model,measurement_model_version,
         algorithm_confidence,quality_score,continuity_token,manual_cut_before,
         command_fingerprint
       )
       SELECT md5(observation.observation_id || ':measurement')::uuid,
              observation.observation_id,solution.time_solution_id,$1::uuid,
              'position','NORMALIZED','position','POSITION',observation.geometry,
              'GOWM_V07_HISTORY_PERFORMANCE','0.7.0',1,1,$2,false,
              'sha256:' || encode(digest((observation.observation_id || ':measurement')::text,'sha256'),'hex')
       FROM public.world_observation observation
       JOIN public.observation_time_solution solution USING (observation_id)
       WHERE observation.data_scope_key=$3 AND observation.source=$4`,
      [fixture.processingRunId, `${fixture.session}:continuous`, fixture.scope, fixture.source]
    );
    // The v0.7 AFTER INSERT trigger performs only Dirty Queue enqueue/coalesce;
    // this statement intentionally exercises all 10k trigger invocations.
    await client.query(
      `INSERT INTO public.position_measurement(
         measurement_id,analysis_space_key,source_position,position,
         accuracy_radius_m,accuracy_model,accuracy_confidence
       )
       SELECT measurement.measurement_id,'default',observation.geometry::geometry(Point,4326),
              ST_SetSRID(ST_MakePoint(448000+item.ordinality*0.01,4417000),32650),
              1,'HARD_RADIUS',0.95
       FROM public.world_observation observation
       JOIN public.measurement measurement USING (observation_id)
       CROSS JOIN LATERAL (
         SELECT regexp_replace(observation.observation_id,'.*-','')::integer AS ordinality
       ) item
       WHERE observation.data_scope_key=$1 AND observation.source=$2`,
      [fixture.scope, fixture.source]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedOperationalTask(pool: pg.Pool, scope: string, taskId: string): Promise<void> {
  const reference = await pool.query<{ reference_key: string }>(
    `INSERT INTO public.world_reference_identity(entity_kind,internal_id,data_scope_key)
     VALUES ('OPERATIONAL_TASK',$1,$2) RETURNING reference_key`,
    [taskId, scope]
  );
  await pool.query(
    `INSERT INTO public.operational_task(data_scope_key,operational_task_id,reference_key)
     VALUES ($1,$2,$3)`,
    [scope, taskId, requiredString(reference.rows[0]?.reference_key, "task reference key")]
  );
}

async function seedThousandTaskEvents(pool: pg.Pool, scope: string, taskId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE public.operational_task_event DISABLE TRIGGER operational_task_event_history_queue");
    await client.query(
      `INSERT INTO public.operational_task_event(
         data_scope_key,event_id,operational_task_id,event_type,event_time,received_time,
         actor_reference_keys,target_reference_keys,payload,confidence,provenance,
         correlation_claims,world_version,source_authority,source_event_key,
         source_revision_no,arrival_classification,projection_disposition,content_hash
       )
       SELECT $1,$2 || '-event-' || item::text,$2,
              CASE WHEN item=1 THEN 'EXECUTION_STARTED_OBSERVED'
                   WHEN item=$3 THEN 'EXECUTION_STOPPED_OBSERVED'
                   ELSE 'EXECUTION_PROGRESS_OBSERVED' END,
              '2026-08-30T01:00:00Z'::timestamptz+item*interval '1 millisecond',
              '2026-08-30T01:01:00Z'::timestamptz+item*interval '1 millisecond',
              '[]','[]',jsonb_build_object('taskType','PERFORMANCE_SAMPLE'),1,
              jsonb_build_array(jsonb_build_object(
                'evidenceId',$2 || '-evidence-' || item::text,
                'authority','history-performance','evidenceType','PERFORMANCE_EVENT',
                'observedAt','2026-08-30T01:00:00Z'
              )),'[]',nextval('public.world_version_seq'),'history-performance',
              $2 || '-source-event-' || item::text,item,'CURRENT','PENDING',
              public.grounding_sha256(($2 || ':' || item::text)::text)
       FROM generate_series(1,$3::integer) item`,
      [scope, taskId, SAMPLE.taskEvents]
    );
    await client.query("ALTER TABLE public.operational_task_event ENABLE TRIGGER operational_task_event_history_queue");
    await client.query("SELECT gowm_history.enqueue_task_interval_projection($1,$2)", [scope, taskId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedDirtyTaskKeys(pool: pg.Pool, scope: string, suffix: string, count: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.world_reference_identity(entity_kind,internal_id,data_scope_key)
       SELECT 'OPERATIONAL_TASK',$2 || '-' || item::text,$1
       FROM generate_series(1,$3::integer) item`,
      [scope, `history-perf-dirty-${suffix}`, count]
    );
    await client.query(
      `INSERT INTO public.operational_task(data_scope_key,operational_task_id,reference_key)
       SELECT $1,identity.internal_id,identity.reference_key
       FROM public.world_reference_identity identity
       WHERE identity.data_scope_key=$1 AND identity.entity_kind='OPERATIONAL_TASK'
         AND identity.internal_id LIKE $2`,
      [scope, `history-perf-dirty-${suffix}-%`]
    );
    await client.query(
      `INSERT INTO public.operational_task_event(
         data_scope_key,event_id,operational_task_id,event_type,event_time,received_time,
         actor_reference_keys,target_reference_keys,payload,confidence,provenance,
         correlation_claims,world_version,source_authority,source_event_key,
         source_revision_no,arrival_classification,projection_disposition,content_hash
       )
       SELECT $1,task_id || '-event-' || event_no::text,task_id,
              CASE event_no WHEN 1 THEN 'EXECUTION_STARTED_OBSERVED' ELSE 'EXECUTION_STOPPED_OBSERVED' END,
              '2026-08-30T02:00:00Z'::timestamptz+event_no*interval '1 second',
              '2026-08-30T02:01:00Z'::timestamptz+event_no*interval '1 second',
              '[]','[]',jsonb_build_object('taskType','DIRTY_KEY_SAMPLE'),1,
              jsonb_build_array(jsonb_build_object(
                'evidenceId',task_id || '-evidence-' || event_no::text,
                'authority','history-performance','evidenceType','PERFORMANCE_EVENT',
                'observedAt','2026-08-30T02:00:00Z'
              )),'[]',nextval('public.world_version_seq'),'history-performance',
              task_id || '-source-' || event_no::text,event_no,'CURRENT','PENDING',
              public.grounding_sha256((task_id || ':' || event_no::text)::text)
       FROM (
         SELECT $2 || '-' || task_no::text AS task_id,event_no
         FROM generate_series(1,$3::integer) task_no
         CROSS JOIN generate_series(1,2) event_no
       ) fixture`,
      [scope, `history-perf-dirty-${suffix}`, count]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedDirtyTrackletKeys(
  pool: pg.Pool,
  scope: string,
  source: string,
  suffix: string,
  count: number
): Promise<void> {
  const targetPrefix = `history-perf-tracklet-dirty-${suffix}`;
  await pool.query(
    `SELECT gowm_history.enqueue_tracklet_projection(
       $1,
       $2,
       $3 || '-' || item::text,
       $3 || '-session-' || item::text,
       'default',
       'source-local-default',
       public.grounding_sha256(($3 || ':' || item::text)::text)
     )
     FROM generate_series(1,$4::integer) item`,
    [scope, source, targetPrefix, count]
  );
}

interface ExplainEvidence {
  plan: unknown;
  nodeTypes: Set<string>;
  indexes: Set<string>;
}

async function explain(pool: pg.Pool, sql: string, values: readonly unknown[]): Promise<ExplainEvidence> {
  const result = await pool.query<Record<string, unknown>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [...values]);
  const plan = result.rows[0]?.["QUERY PLAN"];
  if (plan === undefined) throw new Error("EXPLAIN returned no JSON plan");
  const nodeTypes = new Set<string>();
  const indexes = new Set<string>();
  walkPlan(plan, (record) => {
    if (typeof record["Node Type"] === "string") nodeTypes.add(record["Node Type"]);
    if (typeof record["Index Name"] === "string") indexes.add(record["Index Name"]);
  });
  return { plan, nodeTypes, indexes };
}

function walkPlan(value: unknown, visit: (record: JsonRecord) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkPlan(item, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as JsonRecord;
  visit(record);
  for (const child of Object.values(record)) walkPlan(child, visit);
}

function requireIndex(evidence: ExplainEvidence, name: string): void {
  assert(evidence.indexes.has(name), `EXPLAIN did not use required index ${name}: ${JSON.stringify(evidence.plan)}`);
}

function evenlySpacedIndexes(sampleCount: number, limit: number): number[] {
  assert(limit > 1 && sampleCount >= limit);
  return Array.from({ length: limit }, (_unused, index) => 1 + Math.floor(index * (sampleCount - 1) / (limit - 1)));
}

async function scalar(pool: pg.Pool, sql: string, values: readonly unknown[]): Promise<number> {
  const result = await pool.query<{ count: string | number }>(sql, [...values]);
  const value = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(value)) throw new Error("count query did not return an integer");
  return value;
}

async function timed(action: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await action();
  return performance.now() - started;
}

function within(value: number, maximum: number, label: string): void {
  assert(value <= maximum, `${label} exceeded the bounded validation threshold (${rounded(value)}ms > ${maximum}ms)`);
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid timestamp: ${String(value)}`);
  return date.toISOString();
}
