\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.data_scope(scope_key, operational_domain, description) VALUES
  ('history-trajectory-a', 'TEST', 'Historical trajectory assertion scope A'),
  ('history-trajectory-b', 'TEST', 'Historical trajectory assertion scope B');

INSERT INTO public.world_reference_identity(
  reference_key, entity_kind, internal_id, data_scope_key
) VALUES
  ('wrf_50000000000000000000000000000001','OPERATIONAL_TASK','history-trajectory-task','history-trajectory-a'),
  ('wrf_50000000000000000000000000000002','WORLD_OBJECT','history-trajectory-subject','history-trajectory-a'),
  ('wrf_50000000000000000000000000000003','TASK_EXECUTION_INTERVAL','50000000-0000-0000-0000-000000000001','history-trajectory-a'),
  ('wrf_50000000000000000000000000000004','HISTORICAL_TRAJECTORY','50000000-0000-0000-0000-000000000004','history-trajectory-a'),
  ('wrf_50000000000000000000000000000005','WORLD_OBJECT','history-trajectory-other-scope','history-trajectory-b');

INSERT INTO public.operational_task(data_scope_key, operational_task_id, reference_key)
VALUES ('history-trajectory-a','history-trajectory-task','wrf_50000000000000000000000000000001');

INSERT INTO gowm_history.task_execution_interval(
  interval_id, data_scope_key, operational_task_id, task_reference_key,
  execution_no, reference_key
) VALUES (
  '50000000-0000-0000-0000-000000000001','history-trajectory-a',
  'history-trajectory-task','wrf_50000000000000000000000000000001',1,
  'wrf_50000000000000000000000000000003'
);

INSERT INTO gowm_history.task_execution_interval_revision(
  interval_revision_id, interval_id, revision_no, execution_range,
  lifecycle_state, derivation_kind, stability_state, input_event_set_hash,
  profile_key, profile_version, profile_hash, confidence, reason_codes,
  world_version, content_hash
)
SELECT
  '50000000-0000-0000-0000-000000000002',
  '50000000-0000-0000-0000-000000000001',1,
  tstzrange('2026-01-01T00:00:00Z','2026-01-01T00:00:10Z','[)'),
  'CLOSED','OBSERVED_ONLY','SEALED',
  'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  profile_key,profile_version,content_hash,1,'{}',5001,
  'sha256:2222222222222222222222222222222222222222222222222222222222222222'
FROM gowm_history.method_profile
WHERE profile_key='task-interval-observed-v1' AND profile_version='1.0';

INSERT INTO gowm_history.task_execution_phase(
  interval_revision_id,phase_no,phase_kind,phase_range
) VALUES
  ('50000000-0000-0000-0000-000000000002',1,'RUNNING',tstzrange('2026-01-01T00:00:00Z','2026-01-01T00:00:04Z','[)')),
  ('50000000-0000-0000-0000-000000000002',2,'PAUSED',tstzrange('2026-01-01T00:00:04Z','2026-01-01T00:00:06Z','[)')),
  ('50000000-0000-0000-0000-000000000002',3,'RUNNING',tstzrange('2026-01-01T00:00:06Z','2026-01-01T00:00:10Z','[)'));

SELECT set_config('gowm.history_projection_write','on',true);
INSERT INTO gowm_history.task_execution_interval_head(interval_id,current_revision_id)
VALUES ('50000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002');
SELECT set_config('gowm.history_projection_write','off',true);

INSERT INTO public.world_reference_descriptor_version(
  reference_key,data_scope_key,reference_type,display_name,object_version,
  world_version,provenance,content_hash
) VALUES (
  'wrf_50000000000000000000000000000003','history-trajectory-a',
  'TASK_EXECUTION_INTERVAL','Historical trajectory assertion interval','1',5001,
  '[]','sha256:2323232323232323232323232323232323232323232323232323232323232323'
);

INSERT INTO public.source_registry(
  source_key,data_scope_key,source_type,default_analysis_space_key
) VALUES ('history-trajectory-source','history-trajectory-a','ASSERTION','default');

INSERT INTO public.mobility_tracklet(
  tracklet_id,data_scope_key,source_key,source_local_target_id,
  tracker_session_key,analysis_space_key,tracklet_scope
) VALUES (
  '50000000-0000-0000-0000-000000000010','history-trajectory-a',
  'history-trajectory-source','vehicle-50','session-50','default','SOURCE_LOCAL'
);

DO $mobility_fixture$
DECLARE
  first_sequence tgeompoint;
  second_sequence tgeompoint;
  sequence_set tgeompoint;
BEGIN
  first_sequence := tgeompointSeq(ARRAY[
    tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-01-01T00:00:00Z'::timestamptz),
    tgeompoint(ST_SetSRID(ST_MakePoint(448004,4417000),32650),'2026-01-01T00:00:04Z'::timestamptz)
  ],'linear');
  second_sequence := tgeompointSeq(ARRAY[
    tgeompoint(ST_SetSRID(ST_MakePoint(448006,4417000),32650),'2026-01-01T00:00:06Z'::timestamptz),
    tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-01-01T00:00:10Z'::timestamptz)
  ],'linear');
  sequence_set := tgeompointSeqSet(ARRAY[first_sequence,second_sequence]);

  INSERT INTO public.mobility_tracklet_version(
    tracklet_version_id,tracklet_id,version_no,profile_key,version_state,
    trajectory,extent_box,start_event_time,end_event_time,start_position,end_position,
    content_hash,sample_count,sequence_count,quality_score
  ) VALUES (
    '50000000-0000-0000-0000-000000000011',
    '50000000-0000-0000-0000-000000000010',1,'source-local-default','PROVISIONAL',
    sequence_set,stbox(sequence_set),'2026-01-01T00:00:00Z','2026-01-01T00:00:10Z',
    ST_SetSRID(ST_MakePoint(448000,4417000),32650),
    ST_SetSRID(ST_MakePoint(448010,4417000),32650),
    'history-trajectory-tracklet-v1',4,2,1
  );
  INSERT INTO public.mobility_tracklet_segment(
    tracklet_version_id,segment_no,trajectory,sample_count,start_time,end_time
  ) VALUES
    ('50000000-0000-0000-0000-000000000011',1,first_sequence,2,'2026-01-01T00:00:00Z','2026-01-01T00:00:04Z'),
    ('50000000-0000-0000-0000-000000000011',2,second_sequence,2,'2026-01-01T00:00:06Z','2026-01-01T00:00:10Z');
  INSERT INTO public.mobility_tracklet_gap(
    tracklet_version_id,gap_no,previous_segment_no,next_segment_no,gap_time,
    primary_reason,reason_codes,observability_state
  ) VALUES (
    '50000000-0000-0000-0000-000000000011',1,1,2,
    tstzrange('2026-01-01T00:00:04Z','2026-01-01T00:00:06Z','()'),
    'SOURCE_COVERAGE_GAP',ARRAY['SOURCE_COVERAGE_GAP'],'UNKNOWN'
  );
END
$mobility_fixture$;

INSERT INTO gowm_history.tracklet_finalization_revision(
  finalization_revision_id,tracklet_version_id,revision_no,finalization_state,
  finalization_as_of,observed_through,profile_key,profile_version,profile_hash,
  watermark_set_hash,reason_codes,content_hash
)
SELECT
  '50000000-0000-0000-0000-000000000012',
  '50000000-0000-0000-0000-000000000011',1,'PROVISIONAL',
  clock_timestamp(),NULL,profile_key,profile_version,content_hash,
  'sha256:1212121212121212121212121212121212121212121212121212121212121212',
  ARRAY['WATERMARK_UNAVAILABLE'],
  'sha256:1313131313131313131313131313131313131313131313131313131313131313'
FROM gowm_history.method_profile
WHERE profile_key='tracklet-finalization-watermark-v1' AND profile_version='1.0';

INSERT INTO public.analysis_record(
  analysis_id,data_scope_key,service_name,tool_name,tool_version,algorithm,
  algorithm_version,status,analysis_as_of,query_payload,result_payload,
  method_snapshot,snapshot_hash
) VALUES (
  '50000000-0000-0000-0000-000000000020','history-trajectory-a',
  'historical-trace-assertion','history.get-trajectory','1.0',
  'trajectory-single-authoritative','1.0','PARTIAL',clock_timestamp(),
  '{}','{}','{}','sha256:3333333333333333333333333333333333333333333333333333333333333333'
);

DO $analysis_lineage$
DECLARE
  input_no integer := 1;
  resource_kind text;
  resource_id text;
  resource_version text;
  resource_hash text;
  resource_row jsonb;
BEGIN
  FOR resource_row IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_array('TASK_EXECUTION_INTERVAL','wrf_50000000000000000000000000000003'),
    jsonb_build_array('MOBILITY_TRACKLET_VERSION','50000000-0000-0000-0000-000000000011'),
    jsonb_build_array('TRACKLET_FINALIZATION_REVISION','50000000-0000-0000-0000-000000000012'),
    jsonb_build_array('METHOD_PROFILE','trajectory-single-authoritative-v1'),
    jsonb_build_array('ANALYSIS_SPACE','default')
  ))
  LOOP
    resource_kind := resource_row->>0;
    resource_id := resource_row->>1;
    resource_version := '1';
    resource_hash := NULL;
    IF resource_kind='METHOD_PROFILE' THEN
      resource_version := '1.0';
      SELECT profile.content_hash INTO STRICT resource_hash
      FROM gowm_history.method_profile profile
      WHERE profile.profile_key='trajectory-single-authoritative-v1'
        AND profile.profile_version='1.0';
    END IF;
    PERFORM public.register_analysis_resource_input(
      '50000000-0000-0000-0000-000000000020',input_no,resource_kind,
      CASE WHEN resource_kind='TASK_EXECUTION_INTERVAL' THEN 'gowm' ELSE 'gowm.history' END,
      resource_kind,resource_id,resource_version,resource_hash,NULL,'PINNED',
      'history-trajectory-assertion',NULL,NULL
    );
    input_no := input_no + 1;
  END LOOP;

  FOREACH resource_kind IN ARRAY ARRAY[
    'TASK_EVENT_SET','TRACKLET_INPUT_SET','TIME_SOLUTION_SET','WATERMARK_SET'
  ]
  LOOP
    PERFORM public.register_analysis_input_set(
      '50000000-0000-0000-0000-000000000020',resource_kind,1,
      'sha256:4444444444444444444444444444444444444444444444444444444444444444',
      NULL,'history-trajectory-assertion'
    );
  END LOOP;
END
$analysis_lineage$;

INSERT INTO gowm_history.historical_trajectory(
  historical_trajectory_id,data_scope_key,reference_key,subject_reference_key,
  interval_id,phase_scope,source_selection_kind,selected_source_key,
  selected_tracker_session_key,analysis_space_key,semantic_request_hash
) VALUES (
  '50000000-0000-0000-0000-000000000004','history-trajectory-a',
  'wrf_50000000000000000000000000000004','wrf_50000000000000000000000000000002',
  '50000000-0000-0000-0000-000000000001','ACTIVE_PHASES_ONLY',
  'EXPLICIT_SOURCE','history-trajectory-source','session-50','default',
  'sha256:5555555555555555555555555555555555555555555555555555555555555555'
);

CREATE TEMP TABLE trajectory_assertion_state(
  first_revision uuid,
  second_revision uuid,
  first_captured_at timestamptz
);

DO $first_trajectory_revision$
DECLARE
  first_sequence tgeompoint;
  second_sequence tgeompoint;
  sequence_set tgeompoint;
  profile_hash text;
BEGIN
  first_sequence := tgeompointSeq(ARRAY[
    tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-01-01T00:00:00Z'::timestamptz),
    tgeompoint(ST_SetSRID(ST_MakePoint(448004,4417000),32650),'2026-01-01T00:00:04Z'::timestamptz)
  ],'linear');
  second_sequence := tgeompointSeq(ARRAY[
    tgeompoint(ST_SetSRID(ST_MakePoint(448006,4417000),32650),'2026-01-01T00:00:06Z'::timestamptz),
    tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-01-01T00:00:10Z'::timestamptz)
  ],'linear');
  sequence_set := tgeompointSeqSet(ARRAY[first_sequence,second_sequence]);
  SELECT content_hash INTO STRICT profile_hash
  FROM gowm_history.method_profile
  WHERE profile_key='trajectory-single-authoritative-v1' AND profile_version='1.0';

  INSERT INTO gowm_history.historical_trajectory_revision(
    trajectory_revision_id,historical_trajectory_id,revision_no,interval_revision_id,
    trajectory,extent_box,requested_time,defined_time,start_event_time,end_event_time,
    sample_count,sequence_count,gap_count,temporal_coverage_ratio,prefix_complete,
    suffix_complete,finalization_state,input_set_hash,profile_key,profile_version,
    profile_hash,world_version,content_hash,analysis_id
  ) VALUES (
    '50000000-0000-0000-0000-000000000005',
    '50000000-0000-0000-0000-000000000004',1,
    '50000000-0000-0000-0000-000000000002',sequence_set,stbox(sequence_set),
    tstzmultirange(
      tstzrange('2026-01-01T00:00:00Z','2026-01-01T00:00:04Z','[)'),
      tstzrange('2026-01-01T00:00:06Z','2026-01-01T00:00:10Z','[)')
    ),
    tstzmultirange(
      tstzrange('2026-01-01T00:00:00Z','2026-01-01T00:00:04Z','[)'),
      tstzrange('2026-01-01T00:00:06Z','2026-01-01T00:00:10Z','[)')
    ),
    '2026-01-01T00:00:00Z','2026-01-01T00:00:10Z',4,2,1,1,true,true,
    'PROVISIONAL','sha256:6666666666666666666666666666666666666666666666666666666666666666',
    'trajectory-single-authoritative-v1','1.0',profile_hash,5002,
    'sha256:7777777777777777777777777777777777777777777777777777777777777777',
    '50000000-0000-0000-0000-000000000020'
  );

  INSERT INTO gowm_history.historical_trajectory_segment(
    trajectory_revision_id,segment_no,source_tracklet_version_id,source_segment_no,
    interval_revision_id,phase_no,trajectory,sample_count,start_time,end_time
  ) VALUES
    ('50000000-0000-0000-0000-000000000005',1,'50000000-0000-0000-0000-000000000011',1,
     '50000000-0000-0000-0000-000000000002',1,first_sequence,2,'2026-01-01T00:00:00Z','2026-01-01T00:00:04Z'),
    ('50000000-0000-0000-0000-000000000005',2,'50000000-0000-0000-0000-000000000011',2,
     '50000000-0000-0000-0000-000000000002',3,second_sequence,2,'2026-01-01T00:00:06Z','2026-01-01T00:00:10Z');
  INSERT INTO gowm_history.historical_trajectory_gap(
    trajectory_revision_id,gap_no,gap_kind,gap_time,source_tracklet_version_id,
    source_tracklet_gap_no,reason_codes
  ) VALUES (
    '50000000-0000-0000-0000-000000000005',1,'SOURCE_COVERAGE_GAP',
    tstzrange('2026-01-01T00:00:04Z','2026-01-01T00:00:06Z','()'),
    '50000000-0000-0000-0000-000000000011',1,ARRAY['SOURCE_COVERAGE_GAP']
  );
  INSERT INTO gowm_history.historical_trajectory_excluded_period(
    trajectory_revision_id,excluded_no,exclusion_kind,excluded_time,
    interval_revision_id,phase_no
  ) VALUES (
    '50000000-0000-0000-0000-000000000005',1,'EXCLUDED_PAUSED_PHASE',
    tstzrange('2026-01-01T00:00:04Z','2026-01-01T00:00:06Z','[)'),
    '50000000-0000-0000-0000-000000000002',2
  );

  INSERT INTO gowm_history.historical_trajectory_input(
    trajectory_revision_id,input_no,input_kind,resource_namespace,resource_kind,
    resource_id,resource_version,resource_content_hash,pinning,authority,
    analysis_input_no,analysis_input_set_kind
  ) VALUES
    ('50000000-0000-0000-0000-000000000005',1,'TASK_INTERVAL_REVISION','gowm','TASK_EXECUTION_INTERVAL','wrf_50000000000000000000000000000003','1',NULL,'PINNED','history-trajectory-assertion',1,NULL),
    ('50000000-0000-0000-0000-000000000005',2,'TRACKLET_VERSION','gowm.history','MOBILITY_TRACKLET_VERSION','50000000-0000-0000-0000-000000000011','1',NULL,'PINNED','history-trajectory-assertion',2,NULL),
    ('50000000-0000-0000-0000-000000000005',3,'TRACKLET_FINALIZATION_REVISION','gowm.history','TRACKLET_FINALIZATION_REVISION','50000000-0000-0000-0000-000000000012','1',NULL,'PINNED','history-trajectory-assertion',3,NULL),
    ('50000000-0000-0000-0000-000000000005',4,'METHOD_PROFILE','gowm.history','METHOD_PROFILE','trajectory-single-authoritative-v1','1.0',profile_hash,'PINNED','history-trajectory-assertion',4,NULL),
    ('50000000-0000-0000-0000-000000000005',5,'ANALYSIS_SPACE','gowm.history','ANALYSIS_SPACE','default','1',NULL,'PINNED','history-trajectory-assertion',5,NULL),
    ('50000000-0000-0000-0000-000000000005',6,'TASK_EVENT_SET','gowm.analysis','TASK_EVENT_SET','50000000-0000-0000-0000-000000000020','sha256:4444444444444444444444444444444444444444444444444444444444444444','sha256:4444444444444444444444444444444444444444444444444444444444444444','PINNED','history-trajectory-assertion',NULL,'TASK_EVENT_SET'),
    ('50000000-0000-0000-0000-000000000005',7,'TRACKLET_INPUT_SET','gowm.analysis','TRACKLET_INPUT_SET','50000000-0000-0000-0000-000000000020','sha256:4444444444444444444444444444444444444444444444444444444444444444','sha256:4444444444444444444444444444444444444444444444444444444444444444','PINNED','history-trajectory-assertion',NULL,'TRACKLET_INPUT_SET'),
    ('50000000-0000-0000-0000-000000000005',8,'TIME_SOLUTION_SET','gowm.analysis','TIME_SOLUTION_SET','50000000-0000-0000-0000-000000000020','sha256:4444444444444444444444444444444444444444444444444444444444444444','sha256:4444444444444444444444444444444444444444444444444444444444444444','PINNED','history-trajectory-assertion',NULL,'TIME_SOLUTION_SET'),
    ('50000000-0000-0000-0000-000000000005',9,'WATERMARK_SET','gowm.analysis','WATERMARK_SET','50000000-0000-0000-0000-000000000020','sha256:4444444444444444444444444444444444444444444444444444444444444444','sha256:4444444444444444444444444444444444444444444444444444444444444444','PINNED','history-trajectory-assertion',NULL,'WATERMARK_SET');

  PERFORM set_config('gowm.history_projection_write','on',true);
  INSERT INTO gowm_history.historical_trajectory_head(
    historical_trajectory_id,current_revision_id
  ) VALUES (
    '50000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000005'
  );
  PERFORM set_config('gowm.history_projection_write','off',true);
  INSERT INTO trajectory_assertion_state(first_revision,first_captured_at)
  VALUES ('50000000-0000-0000-0000-000000000005',clock_timestamp());
END
$first_trajectory_revision$;

SELECT pg_sleep(0.01);

DO $second_trajectory_revision$
DECLARE
  prior_revision_id uuid;
  sequence_set tgeompoint;
BEGIN
  SELECT state.first_revision INTO STRICT prior_revision_id
  FROM trajectory_assertion_state state;
  SELECT trajectory INTO STRICT sequence_set
  FROM gowm_history.historical_trajectory_revision
  WHERE trajectory_revision_id = prior_revision_id;
  INSERT INTO gowm_history.historical_trajectory_revision(
    trajectory_revision_id,historical_trajectory_id,revision_no,interval_revision_id,
    trajectory,extent_box,requested_time,defined_time,start_event_time,end_event_time,
    sample_count,sequence_count,gap_count,temporal_coverage_ratio,prefix_complete,
    suffix_complete,finalization_state,input_set_hash,profile_key,profile_version,
    profile_hash,world_version,content_hash,analysis_id,supersedes_revision_id
  )
  SELECT
    '50000000-0000-0000-0000-000000000006',source.historical_trajectory_id,2,
    source.interval_revision_id,source.trajectory,source.extent_box,
    source.requested_time,source.defined_time,source.start_event_time,
    source.end_event_time,source.sample_count,source.sequence_count,source.gap_count,
    source.temporal_coverage_ratio,source.prefix_complete,source.suffix_complete,'PROVISIONAL',
    'sha256:8888888888888888888888888888888888888888888888888888888888888888',
    source.profile_key,source.profile_version,source.profile_hash,5003,
    'sha256:9999999999999999999999999999999999999999999999999999999999999999',
    source.analysis_id,source.trajectory_revision_id
  FROM gowm_history.historical_trajectory_revision source
  WHERE source.trajectory_revision_id = prior_revision_id;

  INSERT INTO gowm_history.historical_trajectory_segment
  SELECT '50000000-0000-0000-0000-000000000006',segment_no,
    source_tracklet_version_id,source_segment_no,interval_revision_id,phase_no,
    trajectory,sample_count,start_time,end_time,clock_timestamp()
  FROM gowm_history.historical_trajectory_segment
  WHERE trajectory_revision_id = prior_revision_id;
  INSERT INTO gowm_history.historical_trajectory_gap
  SELECT '50000000-0000-0000-0000-000000000006',gap_no,gap_kind,gap_time,
    left_measurement_id,right_measurement_id,source_tracklet_version_id,
    source_tracklet_gap_no,reason_codes,clock_timestamp()
  FROM gowm_history.historical_trajectory_gap
  WHERE trajectory_revision_id = prior_revision_id;
  INSERT INTO gowm_history.historical_trajectory_excluded_period
  SELECT '50000000-0000-0000-0000-000000000006',excluded_no,exclusion_kind,
    excluded_time,interval_revision_id,phase_no,clock_timestamp()
  FROM gowm_history.historical_trajectory_excluded_period
  WHERE trajectory_revision_id = prior_revision_id;
  INSERT INTO gowm_history.historical_trajectory_input
  SELECT '50000000-0000-0000-0000-000000000006',input_no,input_kind,
    resource_namespace,resource_kind,resource_id,resource_version,
    resource_content_hash,pinning,authority,analysis_input_no,
    analysis_input_set_kind,clock_timestamp()
  FROM gowm_history.historical_trajectory_input
  WHERE trajectory_revision_id = prior_revision_id;

  PERFORM set_config('gowm.history_projection_write','on',true);
  UPDATE gowm_history.historical_trajectory_head
  SET current_revision_id='50000000-0000-0000-0000-000000000006',
      updated_at=clock_timestamp()
  WHERE historical_trajectory_id='50000000-0000-0000-0000-000000000004';
  PERFORM set_config('gowm.history_projection_write','off',true);
  UPDATE trajectory_assertion_state
  SET second_revision='50000000-0000-0000-0000-000000000006';
END
$second_trajectory_revision$;

CREATE TEMP TABLE outcome_assertion_state(first_captured_at timestamptz);

DO $pending_outcome$
BEGIN
  PERFORM gowm_history.record_historical_trajectory_outcome(
    'history-trajectory-a',
    'wrf_50000000000000000000000000000002',
    'wrf_50000000000000000000000000000003',
    'ACTIVE_PHASES_ONLY',
    'sha256:5555555555555555555555555555555555555555555555555555555555555555',
    'PENDING','PROJECTION_PENDING',ARRAY['PROJECTION_PENDING'],true,NULL,
    clock_timestamp(),
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  INSERT INTO outcome_assertion_state VALUES (clock_timestamp());
END
$pending_outcome$;

SELECT pg_sleep(0.01);

DO $available_outcome$
DECLARE
  first_id uuid;
  replay_id uuid;
BEGIN
  first_id := gowm_history.record_historical_trajectory_outcome(
    'history-trajectory-a',
    'wrf_50000000000000000000000000000002',
    'wrf_50000000000000000000000000000003',
    'ACTIVE_PHASES_ONLY',
    'sha256:5555555555555555555555555555555555555555555555555555555555555555',
    'AVAILABLE','TRAJECTORY_AVAILABLE',ARRAY['TRAJECTORY_AVAILABLE'],false,
    '50000000-0000-0000-0000-000000000020',clock_timestamp(),
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  );
  replay_id := gowm_history.record_historical_trajectory_outcome(
    'history-trajectory-a',
    'wrf_50000000000000000000000000000002',
    'wrf_50000000000000000000000000000003',
    'ACTIVE_PHASES_ONLY',
    'sha256:5555555555555555555555555555555555555555555555555555555555555555',
    'AVAILABLE','TRAJECTORY_AVAILABLE',ARRAY['TRAJECTORY_AVAILABLE'],false,
    '50000000-0000-0000-0000-000000000020',clock_timestamp(),
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  );
  IF first_id IS DISTINCT FROM replay_id THEN
    RAISE EXCEPTION 'identical historical outcome was not idempotent';
  END IF;
END
$available_outcome$;

DO $as_of_and_lineage$
DECLARE
  captured_at timestamptz;
  outcome_captured_at timestamptz;
  initial_revision_id uuid;
BEGIN
  SELECT state.first_captured_at,state.first_revision
  INTO STRICT captured_at,initial_revision_id
  FROM trajectory_assertion_state state;
  SELECT first_captured_at INTO STRICT outcome_captured_at
  FROM outcome_assertion_state;
  PERFORM set_config('gowm.data_scope_key','history-trajectory-a',true);

  IF (SELECT trajectory_revision_id
      FROM gowm_history_v1.historical_trajectory_as_of(
        'wrf_50000000000000000000000000000002',
        'wrf_50000000000000000000000000000003',
        'ACTIVE_PHASES_ONLY',
        'sha256:5555555555555555555555555555555555555555555555555555555555555555',
        captured_at,NULL
      )) IS DISTINCT FROM initial_revision_id THEN
    RAISE EXCEPTION 'semantic as-of trajectory lookup floated to a later revision';
  END IF;
  IF (SELECT trajectory_revision_id
      FROM gowm_history_v1.historical_trajectory_revision_by_reference_as_of(
        'wrf_50000000000000000000000000000004',1,clock_timestamp()
      )) IS DISTINCT FROM initial_revision_id THEN
    RAISE EXCEPTION 'exact pinned trajectory revision was not replayable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gowm_history_v1.historical_trajectory_as_of(
      'wrf_50000000000000000000000000000005',
      'wrf_50000000000000000000000000000003',
      'ACTIVE_PHASES_ONLY',
      'sha256:5555555555555555555555555555555555555555555555555555555555555555',
      clock_timestamp(),NULL
    )
  ) THEN
    RAISE EXCEPTION 'cross-scope subject escaped historical trajectory lookup';
  END IF;
  IF (SELECT reason_code
      FROM gowm_history_v1.historical_trajectory_outcome_as_of(
        'wrf_50000000000000000000000000000002',
        'wrf_50000000000000000000000000000003',
        'ACTIVE_PHASES_ONLY',
        'sha256:5555555555555555555555555555555555555555555555555555555555555555',
        outcome_captured_at
      )) <> 'PROJECTION_PENDING' THEN
    RAISE EXCEPTION 'historical outcome as-of lookup floated to a later diagnosis';
  END IF;
  IF (SELECT count(*) FROM public.analysis_resource_input
      WHERE analysis_id='50000000-0000-0000-0000-000000000020') <> 5
     OR (SELECT count(*) FROM public.analysis_input_set
         WHERE analysis_id='50000000-0000-0000-0000-000000000020') <> 4
     OR (SELECT count(DISTINCT input_kind)
         FROM gowm_history.historical_trajectory_input
         WHERE trajectory_revision_id=initial_revision_id) <> 9 THEN
    RAISE EXCEPTION 'historical trajectory analysis/input lineage is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gowm_history.historical_trajectory_gap
    WHERE trajectory_revision_id=initial_revision_id
      AND gap_kind='EXCLUDED_PAUSED_PHASE'
  ) OR NOT EXISTS (
    SELECT 1 FROM gowm_history.historical_trajectory_excluded_period
    WHERE trajectory_revision_id=initial_revision_id
      AND exclusion_kind='EXCLUDED_PAUSED_PHASE'
  ) THEN
    RAISE EXCEPTION 'paused exclusion was conflated with an unknown trajectory gap';
  END IF;
END
$as_of_and_lineage$;

CREATE TEMP TABLE trajectory_queue_assertion_state(
  queue_id uuid PRIMARY KEY,
  old_generation bigint,
  new_generation bigint,
  other_queue_id uuid,
  captured_at timestamptz NOT NULL,
  revision_id uuid
);
GRANT SELECT,INSERT,UPDATE ON trajectory_queue_assertion_state
  TO gowm_history_service,gowm_history_worker_service;

SET LOCAL ROLE gowm_history_service;
SELECT gowm_history_v1.set_data_scope('history-trajectory-a');
DO $enqueue_projection$
DECLARE
  request_captured_at timestamptz := clock_timestamp();
  queue_id uuid;
  replay_queue_id uuid;
  query_payload jsonb;
  requested_snapshot jsonb;
BEGIN
  query_payload := jsonb_build_object(
      'subjectReferenceKey',jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id','wrf_50000000000000000000000000000002','version','1'),
      'executionIntervalReferenceKey',jsonb_build_object('namespace','gowm','kind','TASK_EXECUTION_INTERVAL','id','wrf_50000000000000000000000000000003','version','1'),
      'phaseScope','EXECUTION_ENVELOPE',
      'sourceSelection',jsonb_build_object('mode','EXPLICIT_SOURCE','sourceKey','history-trajectory-source','trackerSessionKey','session-50'),
      'sourceSelectionProfileReferenceKey',jsonb_build_object('namespace','gowm','kind','HISTORY_METHOD_PROFILE','id','trajectory-single-authoritative-v1','version','1.0')
    );
  requested_snapshot := jsonb_build_object(
      'querySnapshotId','history-trajectory-queue-1','mode','PINNED','consistency','PINNED',
      'capturedAt',request_captured_at,'resources',jsonb_build_array(),
      'manifestHash','sha256:abababababababababababababababababababababababababababababababab'
    );
  queue_id := gowm_history.enqueue_historical_trajectory_projection(
    'history-trajectory-a','wrf_50000000000000000000000000000002',
    'wrf_50000000000000000000000000000003',1,'EXECUTION_ENVELOPE',
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'sha256:abababababababababababababababababababababababababababababababab',
    request_captured_at,query_payload,requested_snapshot
  );
  replay_queue_id := gowm_history.enqueue_historical_trajectory_projection(
    'history-trajectory-a','wrf_50000000000000000000000000000002',
    'wrf_50000000000000000000000000000003',1,'EXECUTION_ENVELOPE',
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'sha256:abababababababababababababababababababababababababababababababab',
    request_captured_at,query_payload,requested_snapshot
  );
  IF replay_queue_id IS DISTINCT FROM queue_id THEN
    RAISE EXCEPTION 'historical trajectory enqueue was not idempotent';
  END IF;
  INSERT INTO trajectory_queue_assertion_state(queue_id,captured_at)
  VALUES (queue_id,request_captured_at);
END
$enqueue_projection$;
RESET ROLE;

SET LOCAL ROLE gowm_history_worker_service;
DO $first_projection_claim$
DECLARE
  claimed gowm_history.historical_trajectory_projection_queue%ROWTYPE;
BEGIN
  SELECT * INTO STRICT claimed
  FROM gowm_history.claim_historical_trajectory_projection(
    'history-worker-old',1,interval '5 minutes'
  );
  UPDATE trajectory_queue_assertion_state
  SET old_generation=claimed.generation
  WHERE queue_id=claimed.queue_id;
END
$first_projection_claim$;
RESET ROLE;

UPDATE gowm_history.historical_trajectory_projection_queue queue
SET locked_at=clock_timestamp()-interval '2 seconds',
    lease_until=clock_timestamp()-interval '1 second',
    last_error='retained restart diagnostic'
WHERE queue.queue_id=(SELECT state.queue_id FROM trajectory_queue_assertion_state state);

SET LOCAL ROLE gowm_history_service;
SELECT gowm_history_v1.set_data_scope('history-trajectory-a');
DO $enqueue_other_projection$
DECLARE
  request_captured_at timestamptz := clock_timestamp();
  enqueued_queue_id uuid;
BEGIN
  enqueued_queue_id := gowm_history.enqueue_historical_trajectory_projection(
    'history-trajectory-a',
    'wrf_50000000000000000000000000000002',
    'wrf_50000000000000000000000000000003',
    1,
    'ACTIVE_PHASES_ONLY',
    'sha256:dededededededededededededededededededededededededededededededede',
    'sha256:bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc',
    request_captured_at,
    jsonb_build_object(
      'subjectReferenceKey',jsonb_build_object('id','wrf_50000000000000000000000000000002'),
      'executionIntervalReferenceKey',jsonb_build_object('id','wrf_50000000000000000000000000000003','version','1'),
      'phaseScope','ACTIVE_PHASES_ONLY'
    ),
    jsonb_build_object(
      'querySnapshotId','history-trajectory-queue-2','mode','PINNED','consistency','PINNED',
      'capturedAt',request_captured_at,'resources',jsonb_build_array(),
      'manifestHash','sha256:bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc'
    )
  );
  UPDATE trajectory_queue_assertion_state
  SET other_queue_id=enqueued_queue_id;
END
$enqueue_other_projection$;
RESET ROLE;

SET LOCAL ROLE gowm_history_worker_service;
DO $reclaim_projection$
DECLARE
  claimed gowm_history.historical_trajectory_projection_queue%ROWTYPE;
  reclaimed_count integer := 0;
  other_count integer := 0;
BEGIN
  FOR claimed IN
    SELECT * FROM gowm_history.claim_historical_trajectory_projection(
      'history-worker-new',2,interval '5 minutes'
    )
  LOOP
    IF claimed.queue_id=(SELECT state.queue_id FROM trajectory_queue_assertion_state state) THEN
      reclaimed_count := reclaimed_count+1;
      IF claimed.last_error IS DISTINCT FROM 'retained restart diagnostic' THEN
        RAISE EXCEPTION 'historical projection reclaim discarded last_error';
      END IF;
      UPDATE trajectory_queue_assertion_state
      SET new_generation=claimed.generation
      WHERE queue_id=claimed.queue_id;
    ELSIF claimed.queue_id=(SELECT state.other_queue_id FROM trajectory_queue_assertion_state state) THEN
      other_count := other_count+1;
    END IF;
  END LOOP;
  IF reclaimed_count<>1 OR other_count<>1 THEN
    RAISE EXCEPTION 'expired historical projection blocked another queue key';
  END IF;
END
$reclaim_projection$;
RESET ROLE;

SET LOCAL ROLE gowm_history_worker_service;
SELECT gowm_history_v1.set_data_scope('history-trajectory-a');
DO $controlled_historical_write$
DECLARE
  sequence_set tgeompoint;
  extent_value stbox;
  profile_hash text;
  resources jsonb;
  input_sets jsonb;
  input_hash text;
  segments jsonb;
  gaps jsonb;
  created_revision_id uuid;
BEGIN
  SELECT version.trajectory,version.extent_box
  INTO STRICT sequence_set,extent_value
  FROM public.mobility_tracklet_version version
  WHERE version.tracklet_version_id='50000000-0000-0000-0000-000000000011';
  SELECT profile.content_hash INTO STRICT profile_hash
  FROM gowm_history.method_profile profile
  WHERE profile.profile_key='trajectory-single-authoritative-v1'
    AND profile.profile_version='1.0';

  resources := jsonb_build_array(
    jsonb_build_object('inputKind','TASK_INTERVAL_REVISION','analysisInputNo',1,'inputRole','TASK_EXECUTION_INTERVAL','resourceNamespace','gowm','resourceKind','TASK_EXECUTION_INTERVAL','resourceId','wrf_50000000000000000000000000000003','resourceVersion','1','resourceContentHash','','resourceWorldVersion','','authority','history-trajectory-assertion','worldReferenceKey','','sourceAnalysisId',''),
    jsonb_build_object('inputKind','TRACKLET_VERSION','analysisInputNo',2,'inputRole','MOBILITY_TRACKLET_VERSION','resourceNamespace','gowm.history','resourceKind','MOBILITY_TRACKLET_VERSION','resourceId','50000000-0000-0000-0000-000000000011','resourceVersion','1','resourceContentHash','','resourceWorldVersion','','authority','history-trajectory-assertion','worldReferenceKey','','sourceAnalysisId',''),
    jsonb_build_object('inputKind','TRACKLET_FINALIZATION_REVISION','analysisInputNo',3,'inputRole','TRACKLET_FINALIZATION_REVISION','resourceNamespace','gowm.history','resourceKind','TRACKLET_FINALIZATION_REVISION','resourceId','50000000-0000-0000-0000-000000000012','resourceVersion','1','resourceContentHash','','resourceWorldVersion','','authority','history-trajectory-assertion','worldReferenceKey','','sourceAnalysisId',''),
    jsonb_build_object('inputKind','METHOD_PROFILE','analysisInputNo',4,'inputRole','METHOD_PROFILE','resourceNamespace','gowm.history','resourceKind','METHOD_PROFILE','resourceId','trajectory-single-authoritative-v1','resourceVersion','1.0','resourceContentHash',profile_hash,'resourceWorldVersion','','authority','history-trajectory-assertion','worldReferenceKey','','sourceAnalysisId',''),
    jsonb_build_object('inputKind','ANALYSIS_SPACE','analysisInputNo',5,'inputRole','ANALYSIS_SPACE','resourceNamespace','gowm.history','resourceKind','ANALYSIS_SPACE','resourceId','default','resourceVersion','1','resourceContentHash','','resourceWorldVersion','','authority','history-trajectory-assertion','worldReferenceKey','','sourceAnalysisId','')
  );
  input_sets := jsonb_build_array(
    jsonb_build_object('inputSetKind','TASK_EVENT_SET','itemCount',1,'itemSetDigest','sha256:4444444444444444444444444444444444444444444444444444444444444444','manifestArtifactRef','','authority','history-trajectory-assertion'),
    jsonb_build_object('inputSetKind','TRACKLET_INPUT_SET','itemCount',1,'itemSetDigest','sha256:4444444444444444444444444444444444444444444444444444444444444444','manifestArtifactRef','','authority','history-trajectory-assertion'),
    jsonb_build_object('inputSetKind','TIME_SOLUTION_SET','itemCount',1,'itemSetDigest','sha256:4444444444444444444444444444444444444444444444444444444444444444','manifestArtifactRef','','authority','history-trajectory-assertion'),
    jsonb_build_object('inputSetKind','WATERMARK_SET','itemCount',1,'itemSetDigest','sha256:4444444444444444444444444444444444444444444444444444444444444444','manifestArtifactRef','','authority','history-trajectory-assertion')
  );
  input_hash := public.grounding_sha256(jsonb_build_object(
    'resources',resources,'sets',input_sets
  )::text);
  SELECT jsonb_agg(jsonb_build_object(
    'segmentNo',segment.segment_no,
    'sourceTrackletVersionId',segment.tracklet_version_id,
    'sourceSegmentNo',segment.segment_no,
    'phaseNo',CASE segment.segment_no WHEN 1 THEN 1 ELSE 3 END,
    'trajectory',segment.trajectory::text,
    'sampleCount',segment.sample_count,
    'startTime',segment.start_time,
    'endTime',segment.end_time
  ) ORDER BY segment.segment_no)
  INTO segments
  FROM public.mobility_tracklet_segment segment
  WHERE segment.tracklet_version_id='50000000-0000-0000-0000-000000000011';
  gaps := jsonb_build_array(jsonb_build_object(
    'gapNo',1,'gapKind','SOURCE_COVERAGE_GAP',
    'gapTime','("2026-01-01 00:00:04+00","2026-01-01 00:00:06+00")',
    'leftMeasurementId','','rightMeasurementId','',
    'sourceTrackletVersionId','50000000-0000-0000-0000-000000000011',
    'sourceTrackletGapNo',1,'reasonCodes',jsonb_build_array('SOURCE_COVERAGE_GAP')
  ));

  created_revision_id := gowm_history.register_historical_trajectory_revision(
    'history-trajectory-a','wrf_50000000000000000000000000000002',
    '50000000-0000-0000-0000-000000000001','EXECUTION_ENVELOPE',
    'EXPLICIT_SOURCE','history-trajectory-source','session-50','default',
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    '50000000-0000-0000-0000-000000000002',sequence_set,extent_value,
    tstzmultirange(tstzrange('2026-01-01T00:00:00Z','2026-01-01T00:00:10Z','[)')),
    tstzmultirange(
      tstzrange('2026-01-01T00:00:00Z','2026-01-01T00:00:04Z','[)'),
      tstzrange('2026-01-01T00:00:06Z','2026-01-01T00:00:10Z','[)')
    ),
    '2026-01-01T00:00:00Z','2026-01-01T00:00:10Z',4,2,1,0.8,true,true,
    'PROVISIONAL',input_hash,'trajectory-single-authoritative-v1','1.0',profile_hash,
    'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    '50000000-0000-0000-0000-000000000020',NULL,segments,gaps,'[]',resources,input_sets
  );
  IF gowm_history.complete_historical_trajectory_projection(
    (SELECT state.queue_id FROM trajectory_queue_assertion_state state),
    'history-worker-old',
    (SELECT state.old_generation FROM trajectory_queue_assertion_state state),
    created_revision_id,NULL
  ) THEN
    RAISE EXCEPTION 'stale historical trajectory worker completed';
  END IF;
  IF NOT gowm_history.complete_historical_trajectory_projection(
    (SELECT state.queue_id FROM trajectory_queue_assertion_state state),
    'history-worker-new',
    (SELECT state.new_generation FROM trajectory_queue_assertion_state state),
    created_revision_id,NULL
  ) THEN
    RAISE EXCEPTION 'current historical trajectory projection fence was rejected';
  END IF;
  UPDATE trajectory_queue_assertion_state SET revision_id=created_revision_id;
  IF NOT EXISTS (
    SELECT 1 FROM gowm_history.historical_trajectory_revision revision
    WHERE revision.trajectory_revision_id=created_revision_id
  ) OR (SELECT count(*) FROM gowm_history.historical_trajectory_revision revision
        JOIN gowm_history.historical_trajectory identity USING (historical_trajectory_id)
        WHERE identity.data_scope_key='history-trajectory-a'
          AND identity.subject_reference_key='wrf_50000000000000000000000000000002'
          AND identity.phase_scope='EXECUTION_ENVELOPE'
          AND identity.semantic_request_hash='sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')<>1 THEN
    RAISE EXCEPTION 'controlled worker trajectory write was not exactly-once';
  END IF;
END
$controlled_historical_write$;
RESET ROLE;

DO $controlled_historical_validation$
DECLARE
  revision_id uuid;
BEGIN
  SELECT state.revision_id INTO STRICT revision_id
  FROM trajectory_queue_assertion_state state;
  IF NOT EXISTS (
    SELECT 1 FROM public.world_reference_descriptor_version descriptor
    JOIN gowm_history.historical_trajectory identity
      ON identity.reference_key=descriptor.reference_key
    WHERE identity.historical_trajectory_id=(
      SELECT revision.historical_trajectory_id
      FROM gowm_history.historical_trajectory_revision revision
      WHERE revision.trajectory_revision_id=revision_id
    ) AND descriptor.object_version='1'
  ) THEN
    RAISE EXCEPTION 'controlled historical trajectory write did not persist revision/reference lineage';
  END IF;
  PERFORM gowm_platform_validation_v1.set_scope('history-trajectory-a',NULL);
  IF NOT EXISTS (
    SELECT 1 FROM gowm_platform_validation_v1.world_reference_version reference
    WHERE reference.reference_key='wrf_50000000000000000000000000000003'
      AND reference.entity_kind='TASK_EXECUTION_INTERVAL'
      AND reference.current_version='1'
  ) OR NOT EXISTS (
    SELECT 1 FROM gowm_platform_validation_v1.world_reference_version reference
    JOIN gowm_history.historical_trajectory identity
      ON identity.reference_key=reference.reference_key
    JOIN gowm_history.historical_trajectory_revision revision
      ON revision.historical_trajectory_id=identity.historical_trajectory_id
    WHERE revision.trajectory_revision_id=revision_id
      AND reference.entity_kind='HISTORICAL_TRAJECTORY'
      AND reference.current_version='1'
  ) THEN
    RAISE EXCEPTION 'v0.7 interval/trajectory references are absent from validation authority';
  END IF;
END
$controlled_historical_validation$;

SET LOCAL ROLE gowm_history_worker_service;
SELECT gowm_history_v1.set_data_scope('history-trajectory-a');
DO $worker_write_boundaries$
BEGIN
  BEGIN
    UPDATE gowm_history.historical_trajectory_projection_queue
    SET available_at=clock_timestamp();
    RAISE EXCEPTION 'history worker received direct queue mutation';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    UPDATE gowm_history.historical_trajectory_head
    SET updated_at=clock_timestamp();
    RAISE EXCEPTION 'history worker received direct trajectory head mutation';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.analysis_record(
      data_scope_key,service_name,tool_name,tool_version,algorithm,
      algorithm_version,status,analysis_as_of,query_payload,result_payload,
      method_snapshot,snapshot_hash
    ) VALUES (
      'history-trajectory-b','gowm.historical-trace','history.get-trajectory','1.0',
      'scope-escape-probe','1.0','FAILED',clock_timestamp(),'{}','{}','{}',
      'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    );
    RAISE EXCEPTION 'history worker wrote analysis outside selected scope';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$worker_write_boundaries$;
RESET ROLE;

DO $append_only$
BEGIN
  BEGIN
    UPDATE gowm_history.historical_trajectory_revision
    SET temporal_coverage_ratio=0;
    RAISE EXCEPTION 'historical trajectory revision was mutable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
  BEGIN
    DELETE FROM gowm_history.historical_trajectory_outcome;
    RAISE EXCEPTION 'historical trajectory outcome was deletable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
END
$append_only$;

SELECT set_config('gowm.data_scope_key','',true);
SET LOCAL ROLE gowm_history_reader;
DO $scope_before_read$
BEGIN
  IF EXISTS (SELECT 1 FROM gowm_history_v1.historical_trajectory_effective)
     OR EXISTS (SELECT 1 FROM gowm_history_v1.historical_trajectory_segment)
     OR EXISTS (SELECT 1 FROM gowm_history_v1.historical_trajectory_outcome) THEN
    RAISE EXCEPTION 'historical trajectory was visible before scope selection';
  END IF;
END
$scope_before_read$;
SELECT gowm_history_v1.set_data_scope('history-trajectory-a');
DO $scoped_children$
BEGIN
  IF (SELECT revision_no FROM gowm_history_v1.historical_trajectory_effective
      WHERE reference_key='wrf_50000000000000000000000000000004') <> 2
     OR (SELECT count(*) FROM gowm_history_v1.historical_trajectory_segment
         WHERE trajectory_revision_id='50000000-0000-0000-0000-000000000006') <> 2
     OR (SELECT count(*) FROM gowm_history_v1.historical_trajectory_gap
         WHERE trajectory_revision_id='50000000-0000-0000-0000-000000000006') <> 1
     OR (SELECT count(*) FROM gowm_history_v1.historical_trajectory_excluded_period
         WHERE trajectory_revision_id='50000000-0000-0000-0000-000000000006') <> 1
     OR (SELECT count(*) FROM gowm_history_v1.historical_trajectory_input
         WHERE trajectory_revision_id='50000000-0000-0000-0000-000000000006') <> 9
     OR (SELECT reason_code
         FROM gowm_history_v1.historical_trajectory_outcome_as_of(
           'wrf_50000000000000000000000000000002',
           'wrf_50000000000000000000000000000003',
           'ACTIVE_PHASES_ONLY',
           'sha256:5555555555555555555555555555555555555555555555555555555555555555',
           clock_timestamp()
         )) <> 'TRAJECTORY_AVAILABLE' THEN
    RAISE EXCEPTION 'scope-selected historical trajectory child views are incomplete';
  END IF;
  BEGIN
    PERFORM count(*) FROM gowm_history.historical_trajectory_revision;
    RAISE EXCEPTION 'history reader accessed trajectory base tables';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$scoped_children$;
RESET ROLE;

SET LOCAL ROLE gowm_history_writer;
DO $controlled_head$
BEGIN
  BEGIN
    UPDATE gowm_history.historical_trajectory_head
    SET updated_at=clock_timestamp();
    RAISE EXCEPTION 'history writer received direct trajectory head mutation';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$controlled_head$;
RESET ROLE;

ROLLBACK;
SELECT 'HISTORICAL_TRAJECTORY_CONTRACT_ASSERTIONS_PASS' AS result;
