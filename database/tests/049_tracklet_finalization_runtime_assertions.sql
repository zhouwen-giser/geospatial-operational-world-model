\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.data_scope(scope_key, operational_domain, description)
VALUES ('history-tracklet-a', 'TEST', 'Tracklet finalization assertion scope');

INSERT INTO public.source_registry(
  source_key, data_scope_key, source_type, default_analysis_space_key
) VALUES (
  'history-tracklet-source', 'history-tracklet-a', 'ASSERTION', 'default'
);

INSERT INTO public.producer_pipeline(
  pipeline_key, source_key, pipeline_version, output_kind
) VALUES (
  'history-tracklet-pipeline', 'history-tracklet-source', '1.0', 'POSITION'
);

INSERT INTO public.datastream(
  datastream_key, source_key, data_scope_key, pipeline_key, schema_version
) VALUES (
  'history-tracklet-stream', 'history-tracklet-source', 'history-tracklet-a',
  'history-tracklet-pipeline', '1.0'
);

INSERT INTO public.processing_run(
  processing_run_id, processor_name, processor_version, config_hash,
  code_digest, deterministic, started_at, completed_at
) VALUES (
  '49000000-0000-0000-0000-000000000001',
  'history-tracklet-assertion', '1.0', 'history-tracklet-config',
  'history-tracklet-code', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z'
);

INSERT INTO public.pipeline_watermark_revision(
  watermark_revision_id, datastream_key, producer_pipeline_key,
  processing_run_id, time_basis, upstream_basis_reference,
  closed_through_event_time, allowed_lateness, last_received_time,
  completeness_state
) VALUES (
  '49000000-0000-0000-0000-000000000002',
  'history-tracklet-stream', 'history-tracklet-pipeline',
  '49000000-0000-0000-0000-000000000001',
  'UPSTREAM_AUTHORITY_UTC', 'history-tracklet-watermark-1',
  '2026-01-01T00:00:10Z', interval '1 second', '2026-01-01T00:00:11Z',
  'COMPLETE'
);

INSERT INTO public.mobility_tracklet(
  tracklet_id, data_scope_key, source_key, source_local_target_id,
  tracker_session_key, analysis_space_key, tracklet_scope
) VALUES (
  '49000000-0000-0000-0000-000000000003',
  'history-tracklet-a', 'history-tracklet-source', 'vehicle-49',
  'session-49', 'default', 'SOURCE_LOCAL'
);

DO $insert_tracklet_version$
DECLARE
  trajectory_value tgeompoint;
BEGIN
  trajectory_value := tgeompointSeqSet(ARRAY[
    tgeompointSeq(ARRAY[
      tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-01-01T00:00:00Z'::timestamptz),
      tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-01-01T00:00:05Z'::timestamptz)
    ],'linear')
  ]);

  INSERT INTO public.mobility_tracklet_version(
    tracklet_version_id, tracklet_id, version_no, profile_key, version_state,
    trajectory, extent_box, start_event_time, end_event_time,
    start_position, end_position, max_accuracy_radius_m, content_hash,
    sample_count, sequence_count, quality_score
  ) VALUES (
    '49000000-0000-0000-0000-000000000004',
    '49000000-0000-0000-0000-000000000003', 1, 'source-local-default',
    'PROVISIONAL', trajectory_value, stbox(trajectory_value),
    '2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z',
    ST_SetSRID(ST_MakePoint(448000,4417000),32650),
    ST_SetSRID(ST_MakePoint(448010,4417000),32650),
    1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 2, 1, 1
  );

  INSERT INTO public.mobility_tracklet_segment(
    tracklet_version_id, segment_no, trajectory, sample_count, start_time, end_time
  ) VALUES (
    '49000000-0000-0000-0000-000000000004', 1,
    tgeompointSeq(ARRAY[
      tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-01-01T00:00:00Z'::timestamptz),
      tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-01-01T00:00:05Z'::timestamptz)
    ],'linear'),
    2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z'
  );
END
$insert_tracklet_version$;

INSERT INTO public.mobility_tracklet(
  tracklet_id, data_scope_key, source_key, source_local_target_id,
  tracker_session_key, analysis_space_key, tracklet_scope
) VALUES (
  '49000000-0000-0000-0000-000000000009',
  'history-tracklet-a', 'history-tracklet-source', 'vehicle-49-other',
  'session-49-other', 'default', 'SOURCE_LOCAL'
);

INSERT INTO public.mobility_tracklet_version(
  tracklet_version_id, tracklet_id, version_no, profile_key, version_state,
  trajectory, extent_box, start_event_time, end_event_time,
  start_position, end_position, max_accuracy_radius_m, content_hash,
  sample_count, sequence_count, quality_score
)
SELECT
  '49000000-0000-0000-0000-000000000010',
  '49000000-0000-0000-0000-000000000009',
  1, version.profile_key, version.version_state,
  version.trajectory, version.extent_box,
  version.start_event_time, version.end_event_time,
  version.start_position, version.end_position,
  version.max_accuracy_radius_m,
  repeat('b', 64), version.sample_count, version.sequence_count,
  version.quality_score
FROM public.mobility_tracklet_version version
WHERE version.tracklet_version_id = '49000000-0000-0000-0000-000000000004';

CREATE TEMP TABLE finalization_assertion_state(
  sealed_revision uuid,
  sealed_captured_at timestamptz,
  reopened_revision uuid
);

DO $projection_queue_fence$
DECLARE
  queue_id uuid;
  other_queue_id uuid;
  initial_claim gowm_history.tracklet_projection_queue%ROWTYPE;
  crashed_claim gowm_history.tracklet_projection_queue%ROWTYPE;
  candidate gowm_history.tracklet_projection_queue%ROWTYPE;
  reclaimed_claim gowm_history.tracklet_projection_queue%ROWTYPE;
  other_claim gowm_history.tracklet_projection_queue%ROWTYPE;
  restart_error constant text := 'tracklet projection restart diagnostic';
BEGIN
  queue_id := gowm_history.enqueue_tracklet_projection(
    'history-tracklet-a', 'history-tracklet-source', 'vehicle-49', 'session-49',
    'default', 'source-local-default',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  SELECT * INTO STRICT initial_claim
  FROM gowm_history.claim_tracklet_projection(
    'tracklet-worker-first', 1, interval '30 seconds'
  );
  IF initial_claim.queue_id IS DISTINCT FROM queue_id THEN
    RAISE EXCEPTION 'tracklet projection claimed an unexpected dirty key';
  END IF;
  IF NOT gowm_history.fail_tracklet_projection(
       queue_id,
       'tracklet-worker-first',
       initial_claim.generation,
       restart_error,
       clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'tracklet worker could not persist its pre-restart error';
  END IF;

  SELECT * INTO STRICT crashed_claim
  FROM gowm_history.claim_tracklet_projection(
    'tracklet-worker-crashed', 1, interval '30 seconds'
  );
  IF crashed_claim.queue_id IS DISTINCT FROM queue_id
     OR crashed_claim.generation <> initial_claim.generation + 1
     OR crashed_claim.last_error IS DISTINCT FROM restart_error THEN
    RAISE EXCEPTION 'tracklet retry did not preserve queue identity, generation, or last_error';
  END IF;

  UPDATE gowm_history.tracklet_projection_queue queue
  SET locked_at = clock_timestamp() - interval '2 seconds',
      lease_until = clock_timestamp() - interval '1 second'
  WHERE queue.queue_id = crashed_claim.queue_id;

  other_queue_id := gowm_history.enqueue_tracklet_projection(
    'history-tracklet-a', 'history-tracklet-source',
    'vehicle-49-other', 'session-49-other',
    'default', 'source-local-default',
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  );
  FOR candidate IN
    SELECT *
    FROM gowm_history.claim_tracklet_projection(
      'tracklet-worker-restarted', 2, interval '30 seconds'
    )
  LOOP
    IF candidate.queue_id = queue_id THEN
      reclaimed_claim := candidate;
    ELSIF candidate.queue_id = other_queue_id THEN
      other_claim := candidate;
    END IF;
  END LOOP;

  IF reclaimed_claim.queue_id IS NULL
     OR reclaimed_claim.generation <> crashed_claim.generation + 1
     OR reclaimed_claim.last_error IS DISTINCT FROM restart_error THEN
    RAISE EXCEPTION 'expired Tracklet Lease was not reclaimed with its last_error intact';
  END IF;
  IF other_claim.queue_id IS NULL THEN
    RAISE EXCEPTION 'expired Tracklet reclaim blocked another Tracklet Key';
  END IF;

  IF gowm_history.complete_tracklet_projection(
       queue_id, 'tracklet-worker-restarted', crashed_claim.generation,
       '49000000-0000-0000-0000-000000000004'
     ) THEN
    RAISE EXCEPTION 'stale tracklet worker generation completed a queue item';
  END IF;
  IF NOT gowm_history.complete_tracklet_projection(
       queue_id, 'tracklet-worker-restarted', reclaimed_claim.generation,
       '49000000-0000-0000-0000-000000000004'
     ) THEN
    RAISE EXCEPTION 'current tracklet worker could not complete a queue item';
  END IF;
  IF NOT gowm_history.complete_tracklet_projection(
       other_queue_id, 'tracklet-worker-restarted', other_claim.generation,
       '49000000-0000-0000-0000-000000000010'
     ) THEN
    RAISE EXCEPTION 'tracklet restart could not complete the independent Tracklet Key';
  END IF;
  IF (SELECT count(*)
      FROM public.mobility_tracklet_version version
      WHERE version.tracklet_id IN (
        '49000000-0000-0000-0000-000000000003',
        '49000000-0000-0000-0000-000000000009'
      )) <> 2 THEN
    RAISE EXCEPTION 'tracklet restart duplicated an existing content Revision';
  END IF;
END
$projection_queue_fence$;

INSERT INTO public.source_clock_model(
  clock_model_id, source_key, model_version, clock_domain,
  offset_seconds, residual_sigma_ms, estimation_method
) VALUES (
  '49000000-0000-0000-0000-000000000006',
  'history-tracklet-source', 'history-tracklet-clock-v1', 'DECLARED_UTC',
  0, 0, 'DECLARED_UTC'
);

INSERT INTO public.world_observation(
  observation_id, observer_type, observer_id, subject_type, subject_id,
  observation_type, geometry, value, confidence, observed_at, received_at,
  source, correlation_id, metadata, schema_version, status,
  data_scope_key, source_record_key, source_revision_no, origin_kind,
  source_local_target_id, tracker_session_id, datastream_key,
  producer_pipeline_key, source_time_value, upstream_received_time,
  raw_reference, payload_hash, quality_flags, entity_binding_status
) VALUES (
  'history-tracklet-trigger-observation', 'Sensor', 'history-tracklet-sensor',
  'Vehicle', 'vehicle-49-trigger', 'position',
  ST_SetSRID(ST_MakePoint(120.1,30.1),4326),
  '{"positionSource":"P2-T01-trigger"}'::jsonb, 1,
  '2026-01-01T00:00:05Z', '2026-01-01T00:00:06Z',
  'history-tracklet-source', 'history-tracklet-trigger-correlation', '{}'::jsonb,
  '1.2', 'accepted', 'history-tracklet-a', 'history-tracklet-trigger-record',
  1, 'PHYSICAL_SENSOR', 'vehicle-49-trigger', 'session-49-trigger',
  'history-tracklet-stream', 'history-tracklet-pipeline',
  '2026-01-01T00:00:05Z', '2026-01-01T00:00:06Z',
  'inline://history-tracklet/trigger-observation', repeat('4',64),
  ARRAY['P2_T01_TRIGGER_ASSERTION'], 'DECLARED'
);

INSERT INTO public.observation_time_solution(
  time_solution_id, observation_id, clock_model_id, processing_run_id,
  phenomenon_time_estimate, phenomenon_time_window, uncertainty_seconds,
  solution_method
) VALUES (
  '49000000-0000-0000-0000-000000000007',
  'history-tracklet-trigger-observation',
  '49000000-0000-0000-0000-000000000006',
  '49000000-0000-0000-0000-000000000001',
  '2026-01-01T00:00:05Z',
  span(
    '2026-01-01T00:00:04Z'::timestamptz,
    '2026-01-01T00:00:06Z'::timestamptz,
    true, false
  ),
  0, 'DECLARED_UTC'
);

INSERT INTO public.measurement(
  measurement_id, observation_id, time_solution_id, processing_run_id,
  measurement_key, measurement_stage, observed_property, result_kind,
  source_geometry, measurement_model, measurement_model_version,
  quality_flags, attributes, command_fingerprint
) VALUES (
  '49000000-0000-0000-0000-000000000008',
  'history-tracklet-trigger-observation',
  '49000000-0000-0000-0000-000000000007',
  '49000000-0000-0000-0000-000000000001',
  'trigger-position', 'NORMALIZED', 'position', 'POSITION',
  ST_SetSRID(ST_MakePoint(120.1,30.1),4326),
  'P2_T01_ASSERTION', '1.0', ARRAY[]::text[], '{}'::jsonb,
  'sha256:trigger-position-measurement'
);

INSERT INTO public.position_measurement(
  measurement_id, analysis_space_key, source_position, position, accuracy_model
) VALUES (
  '49000000-0000-0000-0000-000000000008', 'default',
  ST_SetSRID(ST_MakePoint(120.1,30.1),4326),
  ST_Transform(
    ST_SetSRID(ST_MakePoint(120.1,30.1),4326),
    (SELECT canonical_srid FROM public.analysis_space WHERE analysis_space_key='default')
  ),
  'UNKNOWN'
);

DO $position_trigger_dirty_queue$
DECLARE
  expected_hash text;
  queued gowm_history.tracklet_projection_queue%ROWTYPE;
BEGIN
  SELECT public.grounding_sha256(jsonb_build_array(
    observation.data_scope_key,
    observation.source,
    observation.source_local_target_id,
    COALESCE(observation.tracker_session_id, '__UNSCOPED__'),
    position_record.analysis_space_key,
    measurement_record.measurement_id,
    measurement_record.time_solution_id,
    observation.observation_id,
    position_record.created_at
  )::text)
  INTO STRICT expected_hash
  FROM public.position_measurement position_record
  JOIN public.measurement measurement_record
    ON measurement_record.measurement_id = position_record.measurement_id
  JOIN public.world_observation observation
    ON observation.observation_id = measurement_record.observation_id
  WHERE position_record.measurement_id = '49000000-0000-0000-0000-000000000008';

  SELECT * INTO STRICT queued
  FROM gowm_history.tracklet_projection_queue queue
  WHERE queue.desired_input_set_hash = expected_hash;

  IF queued.data_scope_key <> 'history-tracklet-a'
     OR queued.source_key <> 'history-tracklet-source'
     OR queued.source_local_target_id <> 'vehicle-49-trigger'
     OR queued.tracker_session_key <> 'session-49-trigger'
     OR queued.analysis_space_key <> 'default'
     OR queued.profile_key <> 'source-local-default' THEN
    RAISE EXCEPTION 'position AFTER INSERT trigger lost the scoped tracklet dirty key';
  END IF;
  IF queued.state <> 'QUEUED'
     OR queued.generation <> 0
     OR queued.attempts <> 0
     OR queued.rebuilt_tracklet_version_id IS NOT NULL
     OR queued.processed_at IS NOT NULL
     OR queued.last_error IS NOT NULL THEN
    RAISE EXCEPTION 'position AFTER INSERT trigger did not create a pristine queued item';
  END IF;
END
$position_trigger_dirty_queue$;

DO $seal_tracklet$
DECLARE
  watermark public.pipeline_watermark_revision%ROWTYPE;
  profile_hash text;
  watermark_inputs jsonb;
  watermark_hash text;
  revision_id uuid;
BEGIN
  SELECT * INTO STRICT watermark
  FROM public.pipeline_watermark_revision
  WHERE watermark_revision_id = '49000000-0000-0000-0000-000000000002';
  SELECT content_hash INTO STRICT profile_hash
  FROM gowm_history.method_profile
  WHERE profile_key = 'tracklet-finalization-watermark-v1'
    AND profile_version = '1.0';

  watermark_inputs := jsonb_build_array(jsonb_build_object(
    'inputNo', 1,
    'datastreamKey', watermark.datastream_key,
    'watermarkRevisionId', watermark.watermark_revision_id,
    'closedThroughEventTime', watermark.closed_through_event_time,
    'allowedLateness', watermark.allowed_lateness::text,
    'completenessState', watermark.completeness_state,
    'watermarkCreatedAt', watermark.created_at
  ));
  SELECT public.grounding_sha256(jsonb_agg(jsonb_build_array(
    (item->>'inputNo')::integer,
    item->>'datastreamKey',
    (item->>'watermarkRevisionId')::uuid,
    (item->>'closedThroughEventTime')::timestamptz,
    (item->>'allowedLateness')::interval,
    item->>'completenessState',
    (item->>'watermarkCreatedAt')::timestamptz
  ) ORDER BY (item->>'inputNo')::integer)::text)
  INTO watermark_hash
  FROM jsonb_array_elements(watermark_inputs) item;

  revision_id := gowm_history.register_tracklet_finalization_revision(
    '49000000-0000-0000-0000-000000000004',
    'SEALED', clock_timestamp(), watermark.closed_through_event_time,
    'tracklet-finalization-watermark-v1', '1.0', profile_hash,
    watermark_hash, ARRAY['WATERMARK_COMPLETE'],
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    NULL, watermark_inputs
  );
  INSERT INTO finalization_assertion_state(sealed_revision, sealed_captured_at)
  VALUES (revision_id, clock_timestamp());

  IF (SELECT version_state FROM public.mobility_tracklet_version
      WHERE tracklet_version_id = '49000000-0000-0000-0000-000000000004') <> 'PROVISIONAL' THEN
    RAISE EXCEPTION 'tracklet finalization mutated mobility_tracklet_version.version_state';
  END IF;
END
$seal_tracklet$;

SELECT pg_sleep(0.01);

INSERT INTO public.pipeline_watermark_revision(
  watermark_revision_id, datastream_key, producer_pipeline_key,
  processing_run_id, supersedes_watermark_revision_id, time_basis,
  upstream_basis_reference, closed_through_event_time, allowed_lateness,
  last_received_time, completeness_state
) VALUES (
  '49000000-0000-0000-0000-000000000005',
  'history-tracklet-stream', 'history-tracklet-pipeline',
  '49000000-0000-0000-0000-000000000001',
  '49000000-0000-0000-0000-000000000002',
  'UPSTREAM_AUTHORITY_UTC', 'history-tracklet-watermark-2',
  '2026-01-01T00:00:02Z', interval '1 second', '2026-01-02T00:00:00Z',
  'INCOMPLETE'
);

DO $reopen_tracklet$
DECLARE
  watermark public.pipeline_watermark_revision%ROWTYPE;
  profile_hash text;
  watermark_inputs jsonb;
  watermark_hash text;
  prior_id uuid;
  revision_id uuid;
  captured_at timestamptz;
BEGIN
  SELECT * INTO STRICT watermark
  FROM public.pipeline_watermark_revision
  WHERE watermark_revision_id = '49000000-0000-0000-0000-000000000005';
  SELECT content_hash INTO STRICT profile_hash
  FROM gowm_history.method_profile
  WHERE profile_key = 'tracklet-finalization-watermark-v1'
    AND profile_version = '1.0';
  SELECT sealed_revision, sealed_captured_at INTO STRICT prior_id, captured_at
  FROM finalization_assertion_state;

  watermark_inputs := jsonb_build_array(jsonb_build_object(
    'inputNo',1,'datastreamKey',watermark.datastream_key,
    'watermarkRevisionId',watermark.watermark_revision_id,
    'closedThroughEventTime',watermark.closed_through_event_time,
    'allowedLateness',watermark.allowed_lateness::text,
    'completenessState',watermark.completeness_state,
    'watermarkCreatedAt',watermark.created_at
  ));
  SELECT public.grounding_sha256(jsonb_agg(jsonb_build_array(
    (item->>'inputNo')::integer,item->>'datastreamKey',
    (item->>'watermarkRevisionId')::uuid,
    (item->>'closedThroughEventTime')::timestamptz,
    (item->>'allowedLateness')::interval,item->>'completenessState',
    (item->>'watermarkCreatedAt')::timestamptz
  ) ORDER BY (item->>'inputNo')::integer)::text)
  INTO watermark_hash FROM jsonb_array_elements(watermark_inputs) item;

  revision_id := gowm_history.register_tracklet_finalization_revision(
    '49000000-0000-0000-0000-000000000004',
    'REOPENED', clock_timestamp(), watermark.closed_through_event_time,
    'tracklet-finalization-watermark-v1','1.0',profile_hash,watermark_hash,
    ARRAY['WATERMARK_INCOMPLETE'],
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    prior_id,watermark_inputs
  );
  UPDATE finalization_assertion_state SET reopened_revision = revision_id;

  PERFORM set_config('gowm.data_scope_key', 'history-tracklet-a', true);
  IF (SELECT finalization_state
      FROM gowm_history_v1.tracklet_version_as_of(
        '49000000-0000-0000-0000-000000000004', captured_at, NULL
      )) <> 'SEALED' THEN
    RAISE EXCEPTION 'tracklet finalization as-of lookup floated to reopened evidence';
  END IF;
  IF (SELECT finalization_state FROM gowm_history.tracklet_finalization_revision
      WHERE finalization_revision_id = prior_id) <> 'SEALED' THEN
    RAISE EXCEPTION 'old sealed finalization revision was not preserved';
  END IF;
END
$reopen_tracklet$;

DO $finalization_queue_fence$
DECLARE
  finalization_id uuid;
  target_queue_id uuid;
  independent_queue_id uuid;
  initial_claim gowm_history.tracklet_finalization_queue%ROWTYPE;
  crashed_claim gowm_history.tracklet_finalization_queue%ROWTYPE;
  candidate gowm_history.tracklet_finalization_queue%ROWTYPE;
  reclaimed_claim gowm_history.tracklet_finalization_queue%ROWTYPE;
  other_claim gowm_history.tracklet_finalization_queue%ROWTYPE;
  restart_error constant text := 'tracklet finalization restart diagnostic';
BEGIN
  SELECT reopened_revision INTO STRICT finalization_id FROM finalization_assertion_state;
  SELECT queue.queue_id INTO STRICT target_queue_id
  FROM gowm_history.tracklet_finalization_queue queue
  WHERE queue.tracklet_version_id = '49000000-0000-0000-0000-000000000004'
    AND queue.state = 'QUEUED';
  SELECT queue.queue_id INTO STRICT independent_queue_id
  FROM gowm_history.tracklet_finalization_queue queue
  WHERE queue.tracklet_version_id = '49000000-0000-0000-0000-000000000010'
    AND queue.state = 'QUEUED';

  UPDATE gowm_history.tracklet_finalization_queue queue
  SET available_at = clock_timestamp() + interval '5 minutes'
  WHERE queue.queue_id = independent_queue_id;

  SELECT * INTO STRICT initial_claim
  FROM gowm_history.claim_tracklet_finalization(
    'finalization-worker-first', 1, interval '30 seconds'
  );
  IF initial_claim.queue_id IS DISTINCT FROM target_queue_id THEN
    RAISE EXCEPTION 'finalization worker claimed an unexpected Tracklet Key';
  END IF;
  IF NOT gowm_history.fail_tracklet_finalization(
       target_queue_id,
       'finalization-worker-first',
       initial_claim.generation,
       restart_error,
       clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'finalization worker could not persist its pre-restart error';
  END IF;

  SELECT * INTO STRICT crashed_claim
  FROM gowm_history.claim_tracklet_finalization(
    'finalization-worker-crashed', 1, interval '30 seconds'
  );
  IF crashed_claim.queue_id IS DISTINCT FROM target_queue_id
     OR crashed_claim.generation <> initial_claim.generation + 1
     OR crashed_claim.last_error IS DISTINCT FROM restart_error THEN
    RAISE EXCEPTION 'finalization retry did not preserve queue identity, generation, or last_error';
  END IF;

  UPDATE gowm_history.tracklet_finalization_queue queue
  SET locked_at = clock_timestamp() - interval '2 seconds',
      lease_until = clock_timestamp() - interval '1 second'
  WHERE queue.queue_id = target_queue_id;
  UPDATE gowm_history.tracklet_finalization_queue queue
  SET available_at = clock_timestamp()
  WHERE queue.queue_id = independent_queue_id;

  FOR candidate IN
    SELECT *
    FROM gowm_history.claim_tracklet_finalization(
      'finalization-worker-restarted', 2, interval '30 seconds'
    )
  LOOP
    IF candidate.queue_id = target_queue_id THEN
      reclaimed_claim := candidate;
    ELSIF candidate.queue_id = independent_queue_id THEN
      other_claim := candidate;
    END IF;
  END LOOP;

  IF reclaimed_claim.queue_id IS NULL
     OR reclaimed_claim.generation <> crashed_claim.generation + 1
     OR reclaimed_claim.last_error IS DISTINCT FROM restart_error THEN
    RAISE EXCEPTION 'expired Finalization Lease was not reclaimed with its last_error intact';
  END IF;
  IF other_claim.queue_id IS NULL THEN
    RAISE EXCEPTION 'expired Finalization reclaim blocked another Tracklet Key';
  END IF;

  IF gowm_history.complete_tracklet_finalization(
       target_queue_id,
       'finalization-worker-restarted',
       crashed_claim.generation,
       finalization_id
     ) THEN
    RAISE EXCEPTION 'stale finalization worker generation completed a queue item';
  END IF;
  IF NOT gowm_history.complete_tracklet_finalization(
       target_queue_id,
       'finalization-worker-restarted',
       reclaimed_claim.generation,
       finalization_id
     ) THEN
    RAISE EXCEPTION 'current finalization worker could not complete a queue item';
  END IF;
  IF NOT gowm_history.fail_tracklet_finalization(
       independent_queue_id,
       'finalization-worker-restarted',
       other_claim.generation,
       'independent Tracklet Key intentionally deferred',
       clock_timestamp() + interval '5 minutes'
     ) THEN
    RAISE EXCEPTION 'independent Finalization Key could not make progress';
  END IF;
  IF (SELECT count(*)
      FROM gowm_history.tracklet_finalization_revision revision
      WHERE revision.tracklet_version_id = '49000000-0000-0000-0000-000000000004') <> 2
     OR EXISTS (
       SELECT revision.content_hash
       FROM gowm_history.tracklet_finalization_revision revision
       WHERE revision.tracklet_version_id = '49000000-0000-0000-0000-000000000004'
       GROUP BY revision.content_hash
       HAVING count(*) > 1
     ) THEN
    RAISE EXCEPTION 'finalization restart duplicated an existing content Revision';
  END IF;
END
$finalization_queue_fence$;

DO $append_only$
BEGIN
  BEGIN
    UPDATE gowm_history.tracklet_finalization_revision
    SET observed_through = clock_timestamp();
    RAISE EXCEPTION 'tracklet finalization revision was mutable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  IF NOT has_function_privilege(
       'gowm_history_worker',
       'gowm_history.fail_tracklet_projection(uuid,text,bigint,text,timestamptz)',
       'EXECUTE'
     ) OR NOT has_function_privilege(
       'gowm_history_worker',
       'gowm_history.fail_tracklet_finalization(uuid,text,bigint,text,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'history worker lacks controlled retry/failure queue operations';
  END IF;
  IF NOT pg_has_role('gowm_history_worker_service', 'gowm_history_worker', 'MEMBER')
     OR NOT has_function_privilege(
       'gowm_history_worker_service',
       'gowm_history.claim_tracklet_projection(text,integer,interval)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'history worker login is not bound to the controlled worker role';
  END IF;
  IF has_table_privilege(
       'gowm_history_worker_service',
       'gowm_history.tracklet_projection_queue',
       'INSERT,UPDATE,DELETE'
     ) THEN
    RAISE EXCEPTION 'history worker login received direct queue mutation privileges';
  END IF;
END
$append_only$;

SELECT set_config('gowm.data_scope_key', '', true);
SET LOCAL ROLE gowm_history_reader;

DO $scope_before_read$
BEGIN
  IF EXISTS (SELECT 1 FROM gowm_history_v1.tracklet_version_effective) THEN
    RAISE EXCEPTION 'tracklet version was visible before scope selection';
  END IF;
END
$scope_before_read$;

SELECT gowm_history_v1.set_data_scope('history-tracklet-a');

DO $effective_state$
BEGIN
  IF (SELECT finalization_state FROM gowm_history_v1.tracklet_version_effective
      WHERE tracklet_version_id = '49000000-0000-0000-0000-000000000004') <> 'REOPENED' THEN
    RAISE EXCEPTION 'tracklet effective view did not expose latest finalization revision';
  END IF;
  IF (SELECT content_hash FROM gowm_history_v1.tracklet_version_effective
      WHERE tracklet_version_id = '49000000-0000-0000-0000-000000000004') <>
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' THEN
    RAISE EXCEPTION 'legacy tracklet content hash was not normalized by the v0.7 read contract';
  END IF;
END
$effective_state$;

RESET ROLE;
SET LOCAL ROLE gowm_history_writer;
DO $controlled_head$
BEGIN
  BEGIN
    UPDATE gowm_history.tracklet_finalization_head
    SET updated_at = clock_timestamp();
    RAISE EXCEPTION 'history writer received direct finalization head mutation';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$controlled_head$;
RESET ROLE;

ROLLBACK;
SELECT 'TRACKLET_FINALIZATION_RUNTIME_ASSERTIONS_PASS' AS result;
