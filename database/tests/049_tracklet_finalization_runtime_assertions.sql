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
    1, 'history-tracklet-content-v1', 2, 1, 1
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

CREATE TEMP TABLE finalization_assertion_state(
  sealed_revision uuid,
  sealed_captured_at timestamptz,
  reopened_revision uuid
);

DO $projection_queue_fence$
DECLARE
  queue_id uuid;
  claimed gowm_history.tracklet_projection_queue%ROWTYPE;
BEGIN
  queue_id := gowm_history.enqueue_tracklet_projection(
    'history-tracklet-a', 'history-tracklet-source', 'vehicle-49', 'session-49',
    'default', 'source-local-default',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  SELECT * INTO STRICT claimed
  FROM gowm_history.claim_tracklet_projection('tracklet-worker', 1, interval '30 seconds');
  IF claimed.queue_id IS DISTINCT FROM queue_id THEN
    RAISE EXCEPTION 'tracklet projection claimed an unexpected dirty key';
  END IF;
  IF gowm_history.complete_tracklet_projection(
       queue_id, 'tracklet-worker', claimed.generation - 1,
       '49000000-0000-0000-0000-000000000004'
     ) THEN
    RAISE EXCEPTION 'stale tracklet worker generation completed a queue item';
  END IF;
  IF NOT gowm_history.complete_tracklet_projection(
       queue_id, 'tracklet-worker', claimed.generation,
       '49000000-0000-0000-0000-000000000004'
     ) THEN
    RAISE EXCEPTION 'current tracklet worker could not complete a queue item';
  END IF;
END
$projection_queue_fence$;

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
  claimed gowm_history.tracklet_finalization_queue%ROWTYPE;
  finalization_id uuid;
BEGIN
  SELECT reopened_revision INTO STRICT finalization_id FROM finalization_assertion_state;
  SELECT * INTO STRICT claimed
  FROM gowm_history.claim_tracklet_finalization('finalization-worker', 1, interval '30 seconds');
  IF gowm_history.complete_tracklet_finalization(
       claimed.queue_id, 'finalization-worker', claimed.generation - 1, finalization_id
     ) THEN
    RAISE EXCEPTION 'stale finalization worker generation completed a queue item';
  END IF;
  IF NOT gowm_history.complete_tracklet_finalization(
       claimed.queue_id, 'finalization-worker', claimed.generation, finalization_id
     ) THEN
    RAISE EXCEPTION 'current finalization worker could not complete a queue item';
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
