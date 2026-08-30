\set ON_ERROR_STOP on

BEGIN;

CREATE FUNCTION pg_temp.history_security_snapshot(p_query_id text)
RETURNS jsonb
LANGUAGE sql
AS $snapshot$
  WITH seed AS (
    SELECT jsonb_build_object(
      'querySnapshotId','snapshot_legacy_' || substr(encode(public.digest(p_query_id,'sha256'),'hex'),1,32),
      'mode','BEST_EFFORT','consistency','BEST_EFFORT',
      'capturedAt','2026-08-30T00:00:00.000Z','resources','[]'::jsonb,
      'manifestHash','sha256:' || repeat('0',64)
    ) AS value
  )
  SELECT jsonb_set(
    value,'{manifestHash}',
    to_jsonb(gowm_capability.canonical_legacy_query_snapshot_hash(value)),false
  ) FROM seed
$snapshot$;

INSERT INTO public.data_scope(scope_key,operational_domain,description) VALUES
  ('history-security-a','TEST','Historical security negative scope A'),
  ('history-security-b','TEST','Historical security negative scope B');

INSERT INTO public.world_reference_identity(
  reference_key,entity_kind,internal_id,data_scope_key
) VALUES
  ('wrf_51000000000000000000000000000001','OPERATIONAL_TASK','history-security-task-a','history-security-a'),
  ('wrf_51000000000000000000000000000002','WORLD_OBJECT','history-security-subject-a','history-security-a'),
  ('wrf_51000000000000000000000000000003','TASK_EXECUTION_INTERVAL','51000000-0000-0000-0000-000000000001','history-security-a'),
  ('wrf_51000000000000000000000000000004','OPERATIONAL_TASK','history-security-task-b','history-security-b'),
  ('wrf_51000000000000000000000000000005','WORLD_OBJECT','history-security-subject-b','history-security-b'),
  ('wrf_51000000000000000000000000000006','TASK_EXECUTION_INTERVAL','51000000-0000-0000-0000-000000000004','history-security-b'),
  ('wrf_51000000000000000000000000000007','HISTORICAL_TRAJECTORY','51000000-0000-0000-0000-000000000007','history-security-b'),
  ('wrf_51000000000000000000000000000008','QUERY_RESULT','51000000-0000-0000-0000-000000000008','history-security-b');

INSERT INTO public.operational_task(data_scope_key,operational_task_id,reference_key) VALUES
  ('history-security-a','history-security-task-a','wrf_51000000000000000000000000000001'),
  ('history-security-b','history-security-task-b','wrf_51000000000000000000000000000004');

INSERT INTO gowm_history.task_execution_interval(
  interval_id,data_scope_key,operational_task_id,task_reference_key,execution_no,reference_key
) VALUES
  ('51000000-0000-0000-0000-000000000001','history-security-a','history-security-task-a',
   'wrf_51000000000000000000000000000001',1,'wrf_51000000000000000000000000000003'),
  ('51000000-0000-0000-0000-000000000004','history-security-b','history-security-task-b',
   'wrf_51000000000000000000000000000004',1,'wrf_51000000000000000000000000000006');

INSERT INTO gowm_history.task_execution_interval_revision(
  interval_revision_id,interval_id,revision_no,execution_range,lifecycle_state,
  derivation_kind,stability_state,input_event_set_hash,profile_key,profile_version,
  profile_hash,confidence,reason_codes,world_version,content_hash
)
SELECT fixture.interval_revision_id,fixture.interval_id,1,
       tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)'),
       'CLOSED','OBSERVED_ONLY','SEALED',fixture.event_hash,
       profile.profile_key,profile.profile_version,profile.content_hash,1,'{}',
       fixture.world_version,fixture.content_hash
FROM gowm_history.method_profile profile
CROSS JOIN (VALUES
  ('51000000-0000-0000-0000-000000000002'::uuid,'51000000-0000-0000-0000-000000000001'::uuid,
   'sha256:1111111111111111111111111111111111111111111111111111111111111111',5101,
   'sha256:2121212121212121212121212121212121212121212121212121212121212121'),
  ('51000000-0000-0000-0000-000000000005'::uuid,'51000000-0000-0000-0000-000000000004'::uuid,
   'sha256:2222222222222222222222222222222222222222222222222222222222222222',5102,
   'sha256:2323232323232323232323232323232323232323232323232323232323232323')
) fixture(interval_revision_id,interval_id,event_hash,world_version,content_hash)
WHERE profile.profile_key='task-interval-observed-v1' AND profile.profile_version='1.0';

INSERT INTO public.source_registry(
  source_key,data_scope_key,source_type,default_analysis_space_key
) VALUES
  ('history-security-source-a','history-security-a','ASSERTION','default'),
  ('history-security-source-b','history-security-b','ASSERTION','default');

INSERT INTO public.producer_pipeline(
  pipeline_key,source_key,pipeline_version,output_kind
) VALUES
  ('history-security-pipeline-a','history-security-source-a','1.0','POSITION'),
  ('history-security-pipeline-b','history-security-source-b','1.0','POSITION');

INSERT INTO public.datastream(
  datastream_key,source_key,data_scope_key,pipeline_key,schema_version
) VALUES
  ('history-security-stream-a','history-security-source-a','history-security-a','history-security-pipeline-a','1.0'),
  ('history-security-stream-b','history-security-source-b','history-security-b','history-security-pipeline-b','1.0');

INSERT INTO public.processing_run(
  processing_run_id,processor_name,processor_version,config_hash,code_digest,
  deterministic,started_at,completed_at
) VALUES (
  '51000000-0000-0000-0000-000000000010','history-security-assertion','1.0',
  'history-security-config','history-security-code',true,
  '2026-08-30T00:00:00Z','2026-08-30T00:00:01Z'
);

INSERT INTO public.pipeline_watermark_revision(
  watermark_revision_id,datastream_key,producer_pipeline_key,processing_run_id,
  time_basis,upstream_basis_reference,closed_through_event_time,allowed_lateness,
  last_received_time,completeness_state
) VALUES (
  '51000000-0000-0000-0000-000000000011','history-security-stream-b',
  'history-security-pipeline-b','51000000-0000-0000-0000-000000000010',
  'UPSTREAM_AUTHORITY_UTC','history-security-watermark-b','2026-08-30T00:00:10Z',
  interval '1 second','2026-08-30T00:00:11Z','COMPLETE'
);

INSERT INTO public.mobility_tracklet(
  tracklet_id,data_scope_key,source_key,source_local_target_id,
  tracker_session_key,analysis_space_key,tracklet_scope
) VALUES
  ('51000000-0000-0000-0000-000000000020','history-security-a','history-security-source-a',
   'vehicle-a','session-a','default','SOURCE_LOCAL'),
  ('51000000-0000-0000-0000-000000000021','history-security-b','history-security-source-b',
   'vehicle-b','session-b','default','SOURCE_LOCAL');

DO $mobility_fixtures$
DECLARE
  trajectory_value tgeompoint;
BEGIN
  trajectory_value := tgeompointSeqSet(ARRAY[
    tgeompointSeq(ARRAY[
      tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-08-30T00:00:00Z'::timestamptz),
      tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-08-30T00:00:10Z'::timestamptz)
    ],'linear')
  ]);

  INSERT INTO public.mobility_tracklet_version(
    tracklet_version_id,tracklet_id,version_no,profile_key,version_state,
    trajectory,extent_box,start_event_time,end_event_time,start_position,end_position,
    content_hash,sample_count,sequence_count,quality_score
  ) VALUES
    ('51000000-0000-0000-0000-000000000022','51000000-0000-0000-0000-000000000020',1,
     'source-local-default','PROVISIONAL',trajectory_value,stbox(trajectory_value),
     '2026-08-30T00:00:00Z','2026-08-30T00:00:10Z',
     ST_SetSRID(ST_MakePoint(448000,4417000),32650),ST_SetSRID(ST_MakePoint(448010,4417000),32650),
     'history-security-tracklet-a',2,1,1),
    ('51000000-0000-0000-0000-000000000023','51000000-0000-0000-0000-000000000021',1,
     'source-local-default','PROVISIONAL',trajectory_value,stbox(trajectory_value),
     '2026-08-30T00:00:00Z','2026-08-30T00:00:10Z',
     ST_SetSRID(ST_MakePoint(448000,4417000),32650),ST_SetSRID(ST_MakePoint(448010,4417000),32650),
     'history-security-tracklet-b',2,1,1);

  INSERT INTO public.mobility_tracklet_segment(
    tracklet_version_id,segment_no,trajectory,sample_count,start_time,end_time
  ) VALUES
    ('51000000-0000-0000-0000-000000000022',1,
     tgeompointSeq(ARRAY[
       tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-08-30T00:00:00Z'::timestamptz),
       tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-08-30T00:00:10Z'::timestamptz)
     ],'linear'),2,'2026-08-30T00:00:00Z','2026-08-30T00:00:10Z'),
    ('51000000-0000-0000-0000-000000000023',1,
     tgeompointSeq(ARRAY[
       tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-08-30T00:00:00Z'::timestamptz),
       tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-08-30T00:00:10Z'::timestamptz)
     ],'linear'),2,'2026-08-30T00:00:00Z','2026-08-30T00:00:10Z');
END
$mobility_fixtures$;

INSERT INTO gowm_history.tracklet_finalization_revision(
  finalization_revision_id,tracklet_version_id,revision_no,finalization_state,
  finalization_as_of,observed_through,profile_key,profile_version,profile_hash,
  watermark_set_hash,reason_codes,content_hash
)
SELECT fixture.finalization_id,fixture.tracklet_version_id,1,'PROVISIONAL',
       clock_timestamp(),NULL,profile.profile_key,profile.profile_version,profile.content_hash,
       fixture.watermark_hash,ARRAY['WATERMARK_UNAVAILABLE'],fixture.content_hash
FROM gowm_history.method_profile profile
CROSS JOIN (VALUES
  ('51000000-0000-0000-0000-000000000024'::uuid,'51000000-0000-0000-0000-000000000022'::uuid,
   'sha256:3131313131313131313131313131313131313131313131313131313131313131',
   'sha256:4141414141414141414141414141414141414141414141414141414141414141'),
  ('51000000-0000-0000-0000-000000000025'::uuid,'51000000-0000-0000-0000-000000000023'::uuid,
   'sha256:3232323232323232323232323232323232323232323232323232323232323232',
   'sha256:4242424242424242424242424242424242424242424242424242424242424242')
) fixture(finalization_id,tracklet_version_id,watermark_hash,content_hash)
WHERE profile.profile_key='tracklet-finalization-watermark-v1' AND profile.profile_version='1.0';

INSERT INTO public.analysis_record(
  analysis_id,data_scope_key,service_name,tool_name,tool_version,algorithm,
  algorithm_version,status,analysis_as_of,query_payload,result_payload,
  method_snapshot,snapshot_hash
) VALUES
  ('51000000-0000-0000-0000-000000000030','history-security-a','gowm.historical-trace',
   'history.get-trajectory','1.0','history-security','1.0','PARTIAL',clock_timestamp(),
   '{}','{}','{}','sha256:5151515151515151515151515151515151515151515151515151515151515151'),
  ('51000000-0000-0000-0000-000000000031','history-security-b','gowm.historical-trace',
   'history.get-trajectory','1.0','history-security','1.0','PARTIAL',clock_timestamp(),
   '{}','{}','{}','sha256:5252525252525252525252525252525252525252525252525252525252525252');

DO $foreign_trajectory_fixture$
DECLARE
  trajectory_value tgeompoint;
  profile_hash text;
BEGIN
  trajectory_value := tgeompointSeqSet(ARRAY[
    tgeompointSeq(ARRAY[
      tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-08-30T00:00:00Z'::timestamptz),
      tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-08-30T00:00:10Z'::timestamptz)
    ],'linear')
  ]);
  SELECT content_hash INTO STRICT profile_hash
  FROM gowm_history.method_profile
  WHERE profile_key='trajectory-single-authoritative-v1' AND profile_version='1.0';

  INSERT INTO gowm_history.historical_trajectory(
    historical_trajectory_id,data_scope_key,reference_key,subject_reference_key,
    interval_id,phase_scope,source_selection_kind,selected_source_key,
    selected_tracker_session_key,analysis_space_key,semantic_request_hash
  ) VALUES (
    '51000000-0000-0000-0000-000000000007','history-security-b',
    'wrf_51000000000000000000000000000007','wrf_51000000000000000000000000000005',
    '51000000-0000-0000-0000-000000000004','EXECUTION_ENVELOPE','EXPLICIT_SOURCE',
    'history-security-source-b','session-b','default',
    'sha256:5353535353535353535353535353535353535353535353535353535353535353'
  );
  INSERT INTO gowm_history.historical_trajectory_revision(
    trajectory_revision_id,historical_trajectory_id,revision_no,interval_revision_id,
    trajectory,extent_box,requested_time,defined_time,start_event_time,end_event_time,
    sample_count,sequence_count,gap_count,temporal_coverage_ratio,prefix_complete,
    suffix_complete,finalization_state,input_set_hash,profile_key,profile_version,
    profile_hash,world_version,content_hash,analysis_id
  ) VALUES (
    '51000000-0000-0000-0000-000000000008','51000000-0000-0000-0000-000000000007',1,
    '51000000-0000-0000-0000-000000000005',trajectory_value,stbox(trajectory_value),
    tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
    tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
    '2026-08-30T00:00:00Z','2026-08-30T00:00:10Z',2,1,0,1,true,true,'PROVISIONAL',
    'sha256:5454545454545454545454545454545454545454545454545454545454545454',
    'trajectory-single-authoritative-v1','1.0',profile_hash,5103,
    'sha256:5555555555555555555555555555555555555555555555555555555555555555',
    '51000000-0000-0000-0000-000000000031'
  );
END
$foreign_trajectory_fixture$;

WITH job AS (
  INSERT INTO gowm_capability.gateway_job(
    job_kind,principal_hash,data_scope_key,request_hash,state,started_at,completed_at
  ) VALUES (
    'WORLD_QUERY','sha256:' || repeat('6',64),'history-security-b',
    'sha256:' || repeat('7',64),'SUCCEEDED',clock_timestamp(),clock_timestamp()
  ) RETURNING job_id
)
INSERT INTO gowm_capability.world_query_job(
  query_id,job_id,public_job_id,request_id,principal_ref,principal_hash,
  idempotency_key,request_hash,parameter_schema_hash,plan_hash,submission,
  authentication_method,authenticated_at,data_scope_claim,
  query_snapshot_manifest,effective_snapshot_manifest,principal_context
)
SELECT 'history-security-query-b',job_id,'history-security-job-b','history-security-request-b',
       'principal:history-security','sha256:' || repeat('6',64),'history-security-idempotency-b',
       'sha256:' || repeat('7',64),'sha256:' || repeat('8',64),'sha256:' || repeat('9',64),
       '{"requestId":"history-security-request-b","idempotencyKey":"history-security-idempotency-b","parameterSchemaHash":"sha256:8888888888888888888888888888888888888888888888888888888888888888","plan":{"queryId":"history-security-query-b"}}',
       'SQL_ASSERTION',clock_timestamp(),'history-security-b',
       pg_temp.history_security_snapshot('history-security-query-b'),
       pg_temp.history_security_snapshot('history-security-query-b'),
       '{"mode":"STATIC_SERVICE","principalRef":"principal:history-security","authenticationMethod":"SQL_ASSERTION"}'::jsonb
FROM job;

INSERT INTO public.world_query_result_reference(
  result_reference_id,reference_key,query_id,data_scope_key,result_hash,status,
  data_snapshot_hash,compute_snapshot_hash,result_record,artifact_refs,valid_until
) VALUES (
  '51000000-0000-0000-0000-000000000040','wrf_51000000000000000000000000000008',
  'history-security-query-b','history-security-b','sha256:' || repeat('a',64),'COMPLETED',
  'sha256:' || repeat('b',64),'sha256:' || repeat('c',64),'{}',
  '["artifact://history-security/foreign"]',clock_timestamp()+interval '1 hour'
);
INSERT INTO public.world_query_artifact(
  artifact_id,result_reference_id,artifact_ref,content_hash,media_type
) VALUES (
  '51000000-0000-0000-0000-000000000041','51000000-0000-0000-0000-000000000040',
  'artifact://history-security/foreign','sha256:' || repeat('d',64),'application/json'
);

CREATE FUNCTION pg_temp.history_security_resources(
  p_tracklet_version_id uuid,
  p_finalization_revision_id uuid
)
RETURNS jsonb
LANGUAGE sql
AS $resources$
  SELECT jsonb_build_array(
    jsonb_build_object(
      'inputKind','TASK_INTERVAL_REVISION','analysisInputNo',1,'inputRole','TASK_EXECUTION_INTERVAL',
      'resourceNamespace','gowm','resourceKind','TASK_EXECUTION_INTERVAL',
      'resourceId','wrf_51000000000000000000000000000003','resourceVersion','1',
      'resourceContentHash','','resourceWorldVersion','','authority','history-security-assertion',
      'worldReferenceKey','','sourceAnalysisId',''
    ),
    jsonb_build_object(
      'inputKind','TRACKLET_VERSION','analysisInputNo',2,'inputRole','MOBILITY_TRACKLET_VERSION',
      'resourceNamespace','gowm.mobility','resourceKind','MOBILITY_TRACKLET_VERSION',
      'resourceId',p_tracklet_version_id,'resourceVersion','1',
      'resourceContentHash','','resourceWorldVersion','','authority','history-security-assertion',
      'worldReferenceKey','','sourceAnalysisId',''
    ),
    jsonb_build_object(
      'inputKind','TRACKLET_FINALIZATION_REVISION','analysisInputNo',3,
      'inputRole','TRACKLET_FINALIZATION_REVISION','resourceNamespace','gowm.history',
      'resourceKind','TRACKLET_FINALIZATION_REVISION','resourceId',p_finalization_revision_id,
      'resourceVersion','1','resourceContentHash','','resourceWorldVersion','',
      'authority','history-security-assertion','worldReferenceKey','','sourceAnalysisId',''
    ),
    jsonb_build_object(
      'inputKind','METHOD_PROFILE','analysisInputNo',4,'inputRole','METHOD_PROFILE',
      'resourceNamespace','gowm.history','resourceKind','METHOD_PROFILE',
      'resourceId','trajectory-single-authoritative-v1','resourceVersion','1.0',
      'resourceContentHash',(SELECT content_hash FROM gowm_history.method_profile
        WHERE profile_key='trajectory-single-authoritative-v1' AND profile_version='1.0'),
      'resourceWorldVersion','','authority','history-security-assertion',
      'worldReferenceKey','','sourceAnalysisId',''
    ),
    jsonb_build_object(
      'inputKind','ANALYSIS_SPACE','analysisInputNo',5,'inputRole','ANALYSIS_SPACE',
      'resourceNamespace','gowm','resourceKind','ANALYSIS_SPACE','resourceId','default',
      'resourceVersion','1','resourceContentHash','','resourceWorldVersion','',
      'authority','history-security-assertion','worldReferenceKey','','sourceAnalysisId',''
    )
  )
$resources$;

CREATE FUNCTION pg_temp.history_security_sets(p_artifact_ref text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
AS $sets$
  SELECT jsonb_build_array(
    jsonb_build_object('inputSetKind','TASK_EVENT_SET','itemCount',1,
      'itemSetDigest','sha256:6161616161616161616161616161616161616161616161616161616161616161',
      'manifestArtifactRef',COALESCE(p_artifact_ref,''),'authority','history-security-assertion'),
    jsonb_build_object('inputSetKind','TRACKLET_INPUT_SET','itemCount',1,
      'itemSetDigest','sha256:6262626262626262626262626262626262626262626262626262626262626262',
      'manifestArtifactRef','','authority','history-security-assertion'),
    jsonb_build_object('inputSetKind','TIME_SOLUTION_SET','itemCount',1,
      'itemSetDigest','sha256:6363636363636363636363636363636363636363636363636363636363636363',
      'manifestArtifactRef','','authority','history-security-assertion'),
    jsonb_build_object('inputSetKind','WATERMARK_SET','itemCount',1,
      'itemSetDigest','sha256:6464646464646464646464646464646464646464646464646464646464646464',
      'manifestArtifactRef','','authority','history-security-assertion')
  )
$sets$;

DO $cross_scope_watermark$
DECLARE
  profile_hash text;
  watermark public.pipeline_watermark_revision%ROWTYPE;
  watermark_inputs jsonb;
BEGIN
  SELECT content_hash INTO STRICT profile_hash FROM gowm_history.method_profile
  WHERE profile_key='tracklet-finalization-watermark-v1' AND profile_version='1.0';
  SELECT * INTO STRICT watermark FROM public.pipeline_watermark_revision
  WHERE watermark_revision_id='51000000-0000-0000-0000-000000000011';
  watermark_inputs := jsonb_build_array(jsonb_build_object(
    'inputNo',1,'datastreamKey',watermark.datastream_key,
    'watermarkRevisionId',watermark.watermark_revision_id,
    'closedThroughEventTime',watermark.closed_through_event_time,
    'allowedLateness',watermark.allowed_lateness,
    'completenessState',watermark.completeness_state,
    'watermarkCreatedAt',watermark.created_at
  ));
  BEGIN
    PERFORM gowm_history.register_tracklet_finalization_revision(
      '51000000-0000-0000-0000-000000000022','SEALED',clock_timestamp(),
      watermark.closed_through_event_time,'tracklet-finalization-watermark-v1','1.0',
      profile_hash,'sha256:7171717171717171717171717171717171717171717171717171717171717171',
      ARRAY['COMPLETE'],'sha256:7272727272727272727272727272727272727272727272727272727272727272',
      NULL,watermark_inputs
    );
    RAISE EXCEPTION 'cross-scope watermark was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$cross_scope_watermark$;

DO $foreign_effective_snapshot$
DECLARE
  captured_at timestamptz := clock_timestamp();
  snapshot_hash text := 'sha256:7373737373737373737373737373737373737373737373737373737373737373';
  requested_snapshot jsonb;
BEGIN
  PERFORM gowm_history_v1.set_data_scope('history-security-a');
  requested_snapshot := jsonb_build_object(
    'querySnapshotId','history-security-foreign-pin','mode','PINNED','consistency','PINNED',
    'capturedAt',captured_at,'resources',jsonb_build_array(jsonb_build_object(
      'resourceKind','TRACKLET_VERSION','resourceId','51000000-0000-0000-0000-000000000023',
      'version','1','contentHash','sha256:7474747474747474747474747474747474747474747474747474747474747474',
      'pinning','PINNED'
    )),'manifestHash',snapshot_hash
  );
  BEGIN
    PERFORM gowm_history.enqueue_historical_trajectory_projection(
      'history-security-a','wrf_51000000000000000000000000000002',
      'wrf_51000000000000000000000000000003',1,'EXECUTION_ENVELOPE',
      'sha256:7575757575757575757575757575757575757575757575757575757575757575',
      snapshot_hash,captured_at,
      jsonb_build_object(
        'subjectReferenceKey',jsonb_build_object('id','wrf_51000000000000000000000000000002'),
        'executionIntervalReferenceKey',jsonb_build_object(
          'id','wrf_51000000000000000000000000000003','version','1'),
        'phaseScope','EXECUTION_ENVELOPE'
      ),requested_snapshot
    );
    RAISE EXCEPTION 'foreign effective snapshot pin was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$foreign_effective_snapshot$;

DO $cross_scope_history_inputs$
DECLARE
  trajectory_value tgeompoint;
  profile_hash text;
  resources jsonb;
  input_sets jsonb;
  input_hash text;
  segments jsonb;
  foreign_segments jsonb;
BEGIN
  trajectory_value := tgeompointSeqSet(ARRAY[
    tgeompointSeq(ARRAY[
      tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-08-30T00:00:00Z'::timestamptz),
      tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-08-30T00:00:10Z'::timestamptz)
    ],'linear')
  ]);
  SELECT content_hash INTO STRICT profile_hash FROM gowm_history.method_profile
  WHERE profile_key='trajectory-single-authoritative-v1' AND profile_version='1.0';
  segments := jsonb_build_array(jsonb_build_object(
    'segmentNo',1,'sourceTrackletVersionId','51000000-0000-0000-0000-000000000022',
    'sourceSegmentNo',1,'phaseNo','','trajectory',
    tgeompointSeq(ARRAY[
      tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-08-30T00:00:00Z'::timestamptz),
      tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-08-30T00:00:10Z'::timestamptz)
    ],'linear')::text,
    'sampleCount',2,'startTime','2026-08-30T00:00:00Z','endTime','2026-08-30T00:00:10Z'
  ));

  resources := pg_temp.history_security_resources(
    '51000000-0000-0000-0000-000000000023','51000000-0000-0000-0000-000000000025'
  );
  input_sets := pg_temp.history_security_sets();
  input_hash := public.grounding_sha256(jsonb_build_object('resources',resources,'sets',input_sets)::text);
  BEGIN
    PERFORM gowm_history.register_historical_trajectory_revision(
      'history-security-a','wrf_51000000000000000000000000000002',
      '51000000-0000-0000-0000-000000000001','EXECUTION_ENVELOPE','EXPLICIT_SOURCE',
      'history-security-source-b','session-b','default',
      'sha256:7676767676767676767676767676767676767676767676767676767676767676',
      '51000000-0000-0000-0000-000000000002',trajectory_value,stbox(trajectory_value),
      tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
      tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
      '2026-08-30T00:00:00Z','2026-08-30T00:00:10Z',2,1,0,1,true,true,'PROVISIONAL',
      input_hash,'trajectory-single-authoritative-v1','1.0',profile_hash,
      'sha256:7777777777777777777777777777777777777777777777777777777777777777',
      '51000000-0000-0000-0000-000000000030',NULL,segments,'[]','[]',resources,input_sets
    );
    RAISE EXCEPTION 'cross-scope tracklet was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  resources := pg_temp.history_security_resources(
    '51000000-0000-0000-0000-000000000022','51000000-0000-0000-0000-000000000024'
  );
  input_sets := pg_temp.history_security_sets();
  input_hash := public.grounding_sha256(jsonb_build_object('resources',resources,'sets',input_sets)::text);
  BEGIN
    PERFORM gowm_history.register_historical_trajectory_revision(
      'history-security-a','wrf_51000000000000000000000000000002',
      '51000000-0000-0000-0000-000000000001','EXECUTION_ENVELOPE','EXPLICIT_SOURCE',
      'history-security-source-b','session-b','default',
      'sha256:7878787878787878787878787878787878787878787878787878787878787878',
      '51000000-0000-0000-0000-000000000002',trajectory_value,stbox(trajectory_value),
      tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
      tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
      '2026-08-30T00:00:00Z','2026-08-30T00:00:10Z',2,1,0,1,true,true,'PROVISIONAL',
      input_hash,'trajectory-single-authoritative-v1','1.0',profile_hash,
      'sha256:7979797979797979797979797979797979797979797979797979797979797979',
      '51000000-0000-0000-0000-000000000030',NULL,segments,'[]','[]',resources,input_sets
    );
    RAISE EXCEPTION 'source selection escaped to another scope';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  foreign_segments := jsonb_build_array(jsonb_build_object(
    'segmentNo',1,'sourceTrackletVersionId','51000000-0000-0000-0000-000000000023',
    'sourceSegmentNo',1,'phaseNo','','trajectory',
    tgeompointSeq(ARRAY[
      tgeompoint(ST_SetSRID(ST_MakePoint(448000,4417000),32650),'2026-08-30T00:00:00Z'::timestamptz),
      tgeompoint(ST_SetSRID(ST_MakePoint(448010,4417000),32650),'2026-08-30T00:00:10Z'::timestamptz)
    ],'linear')::text,
    'sampleCount',2,'startTime','2026-08-30T00:00:00Z','endTime','2026-08-30T00:00:10Z'
  ));
  BEGIN
    PERFORM gowm_history.register_historical_trajectory_revision(
      'history-security-a','wrf_51000000000000000000000000000002',
      '51000000-0000-0000-0000-000000000001','EXECUTION_ENVELOPE','EXPLICIT_SOURCE',
      'history-security-source-a','session-a','default',
      'sha256:7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a',
      '51000000-0000-0000-0000-000000000002',trajectory_value,stbox(trajectory_value),
      tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
      tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
      '2026-08-30T00:00:00Z','2026-08-30T00:00:10Z',2,1,0,1,true,true,'PROVISIONAL',
      input_hash,'trajectory-single-authoritative-v1','1.0',profile_hash,
      'sha256:7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b',
      '51000000-0000-0000-0000-000000000030',NULL,foreign_segments,'[]','[]',resources,input_sets
    );
    RAISE EXCEPTION 'cross-scope tracklet segment was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  input_sets := pg_temp.history_security_sets('artifact://history-security/foreign');
  input_hash := public.grounding_sha256(jsonb_build_object('resources',resources,'sets',input_sets)::text);
  BEGIN
    PERFORM gowm_history.register_historical_trajectory_revision(
      'history-security-a','wrf_51000000000000000000000000000002',
      '51000000-0000-0000-0000-000000000001','EXECUTION_ENVELOPE','EXPLICIT_SOURCE',
      'history-security-source-a','session-a','default',
      'sha256:8080808080808080808080808080808080808080808080808080808080808080',
      '51000000-0000-0000-0000-000000000002',trajectory_value,stbox(trajectory_value),
      tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
      tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
      '2026-08-30T00:00:00Z','2026-08-30T00:00:10Z',2,1,0,1,true,true,'PROVISIONAL',
      input_hash,'trajectory-single-authoritative-v1','1.0',profile_hash,
      'sha256:8181818181818181818181818181818181818181818181818181818181818181',
      '51000000-0000-0000-0000-000000000030',NULL,segments,'[]','[]',resources,input_sets
    );
    RAISE EXCEPTION 'cross-scope artifact was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  input_sets := pg_temp.history_security_sets('artifact://history-security/missing');
  input_hash := public.grounding_sha256(jsonb_build_object('resources',resources,'sets',input_sets)::text);
  BEGIN
    PERFORM gowm_history.register_historical_trajectory_revision(
      'history-security-a','wrf_51000000000000000000000000000002',
      '51000000-0000-0000-0000-000000000001','EXECUTION_ENVELOPE','EXPLICIT_SOURCE',
      'history-security-source-a','session-a','default',
      'sha256:8282828282828282828282828282828282828282828282828282828282828282',
      '51000000-0000-0000-0000-000000000002',trajectory_value,stbox(trajectory_value),
      tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
      tstzmultirange(tstzrange('2026-08-30T00:00:00Z','2026-08-30T00:00:10Z','[)')),
      '2026-08-30T00:00:00Z','2026-08-30T00:00:10Z',2,1,0,1,true,true,'PROVISIONAL',
      input_hash,'trajectory-single-authoritative-v1','1.0',profile_hash,
      'sha256:8383838383838383838383838383838383838383838383838383838383838383',
      '51000000-0000-0000-0000-000000000030',NULL,segments,'[]','[]',resources,input_sets
    );
    RAISE EXCEPTION 'missing artifact was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$cross_scope_history_inputs$;

DO $analysis_resource_scope$
BEGIN
  BEGIN
    PERFORM public.register_analysis_resource_input(
      '51000000-0000-0000-0000-000000000030',90,'FOREIGN_WORLD_REFERENCE',
      'gowm','WORLD_OBJECT','wrf_51000000000000000000000000000005','1',
      NULL,NULL,'PINNED','history-security-assertion',
      'wrf_51000000000000000000000000000005',NULL
    );
    RAISE EXCEPTION 'cross-scope analysis resource input was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$analysis_resource_scope$;

SET LOCAL ROLE gowm_history_reader;
SELECT gowm_history_v1.set_data_scope('history-security-b');
DO $foreign_reference_control$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM gowm_history_v1.historical_trajectory_revision_by_reference_as_of(
      'wrf_51000000000000000000000000000007',1,clock_timestamp()
    )
  ) THEN
    RAISE EXCEPTION 'foreign trajectory control fixture is not readable in its own scope';
  END IF;
END
$foreign_reference_control$;
SELECT gowm_history_v1.set_data_scope('history-security-a');
DO $forged_trajectory_reference$
BEGIN
  IF EXISTS (
    SELECT 1 FROM gowm_history_v1.historical_trajectory_revision_by_reference_as_of(
      'wrf_51000000000000000000000000000007',1,clock_timestamp()
    )
  ) OR EXISTS (
    SELECT 1 FROM gowm_history_v1.historical_trajectory_revision_by_reference_as_of(
      'wrf_ffffffffffffffffffffffffffffffff',1,clock_timestamp()
    )
  ) THEN
    RAISE EXCEPTION 'foreign or forged historical trajectory reference was resolved';
  END IF;
END
$forged_trajectory_reference$;
RESET ROLE;

INSERT INTO public.world_observation(
  observation_id,observer_type,observer_id,subject_type,subject_id,observation_type,
  geometry,value,confidence,observed_at,received_at,source,correlation_id,metadata,
  schema_version,status,data_scope_key,source_record_key,source_revision_no,origin_kind,
  source_local_target_id,tracker_session_id,datastream_key,producer_pipeline_key,
  upstream_received_time,raw_reference,payload_hash,quality_flags,entity_binding_status
) VALUES (
  'history-security-source-record-a','ASSERTION_SENSOR','history-security-source-a',
  'VEHICLE','history-security-subject-a','position',
  ST_SetSRID(ST_MakePoint(120.1,30.1),4326),'{}',1,
  '2026-08-30T00:00:01Z','2026-08-30T00:00:02Z','history-security-source-a',
  'history-security-correlation','{}','1.2','accepted','history-security-a',
  'immutable-record',1,'PHYSICAL_SENSOR','vehicle-a','session-a',
  'history-security-stream-a','history-security-pipeline-a','2026-08-30T00:00:02Z',
  'inline://history-security/source-record-a',repeat('8',64),'{}','DECLARED'
);

DO $same_source_record_conflict$
BEGIN
  BEGIN
    INSERT INTO public.world_observation(
      observation_id,observer_type,observer_id,subject_type,subject_id,observation_type,
      geometry,value,confidence,observed_at,received_at,source,correlation_id,metadata,
      schema_version,status,data_scope_key,source_record_key,source_revision_no,origin_kind,
      source_local_target_id,tracker_session_id,datastream_key,producer_pipeline_key,
      upstream_received_time,raw_reference,payload_hash,quality_flags,entity_binding_status
    ) VALUES (
      'history-security-source-record-conflict','ASSERTION_SENSOR','history-security-source-a',
      'VEHICLE','history-security-subject-a','position',
      ST_SetSRID(ST_MakePoint(120.2,30.2),4326),'{"changed":true}',1,
      '2026-08-30T00:00:01Z','2026-08-30T00:00:03Z','history-security-source-a',
      'history-security-correlation-conflict','{}','1.2','accepted','history-security-a',
      'immutable-record',1,'PHYSICAL_SENSOR','vehicle-a','session-a',
      'history-security-stream-a','history-security-pipeline-a','2026-08-30T00:00:03Z',
      'inline://history-security/source-record-conflict',repeat('9',64),'{}','DECLARED'
    );
    RAISE EXCEPTION 'same source record revision accepted conflicting content';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$same_source_record_conflict$;

ROLLBACK;

SELECT 'HISTORICAL_SECURITY_NEGATIVE_ASSERTIONS_PASS' AS result;
