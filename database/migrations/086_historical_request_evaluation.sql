BEGIN;
CREATE TABLE gowm_history.historical_request_evaluation (
 evaluation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 queue_id uuid NOT NULL UNIQUE REFERENCES gowm_history.historical_trajectory_projection_queue,
 generation bigint NOT NULL, request_hash text NOT NULL, snapshot_hash text NOT NULL,
 full_request_hash text NOT NULL CHECK(full_request_hash ~ '^sha256:[0-9a-f]{64}$'),
 trajectory_revision_id uuid NOT NULL REFERENCES gowm_history.historical_trajectory_revision,
 analysis_id uuid NOT NULL UNIQUE REFERENCES public.analysis_record,
 input_set_hash text NOT NULL, content_hash text NOT NULL,
 reused boolean NOT NULL, claimed_at timestamptz NOT NULL, evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON gowm_history.historical_request_evaluation FROM PUBLIC;
CREATE FUNCTION gowm_history.protect_request_evaluation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'request evaluation is immutable' USING ERRCODE='55000'; END
$fn$;
CREATE TRIGGER historical_request_evaluation_immutable BEFORE UPDATE OR DELETE ON gowm_history.historical_request_evaluation
 FOR EACH ROW EXECUTE FUNCTION gowm_history.protect_request_evaluation();

CREATE FUNCTION gowm_history.evaluate_historical_request(
 p_queue_id uuid,p_worker_id text,p_generation bigint,p_revision_id uuid,p_content_hash text,
 p_resource_inputs jsonb,p_input_sets jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,gowm_history,gowm_history_v1 AS $fn$
DECLARE q gowm_history.historical_trajectory_projection_queue; r gowm_history.historical_trajectory_revision;
 h gowm_history.historical_trajectory; a public.analysis_record; new_analysis uuid; evaluation uuid;
 input_row jsonb; required_kind text; pin jsonb; lookup_id text;
 interval_record gowm_history.task_execution_interval; interval_revision_record gowm_history.task_execution_interval_revision;
 p_data_scope_key text; p_analysis_space_key text; p_selected_source_key text; p_selected_tracker_session_key text;
 analysis_captured_at timestamptz; computed_hash text; p_profile_key text; p_profile_version text; p_profile_hash text;
BEGIN
 SELECT * INTO STRICT q FROM gowm_history.historical_trajectory_projection_queue WHERE queue_id=p_queue_id FOR UPDATE;
 IF q.state<>'RUNNING' OR q.locked_by IS DISTINCT FROM p_worker_id OR q.generation<>p_generation OR q.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'request evaluation fence lost' USING ERRCODE='55000'; END IF;
 IF q.data_scope_key IS DISTINCT FROM gowm_history_v1.current_data_scope_key()
 THEN RAISE EXCEPTION 'request evaluation scope mismatch' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_resource_inputs) IS DISTINCT FROM 'array' OR jsonb_typeof(p_input_sets) IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'request inputs must be arrays' USING ERRCODE='22023'; END IF;
 SELECT * INTO STRICT r FROM gowm_history.historical_trajectory_revision WHERE trajectory_revision_id=p_revision_id;
 SELECT * INTO STRICT h FROM gowm_history.historical_trajectory WHERE historical_trajectory_id=r.historical_trajectory_id;
 SELECT * INTO STRICT interval_record FROM gowm_history.task_execution_interval WHERE interval_id=h.interval_id;
 SELECT * INTO STRICT interval_revision_record FROM gowm_history.task_execution_interval_revision WHERE interval_revision_id=r.interval_revision_id;
 IF h.data_scope_key<>q.data_scope_key OR h.subject_reference_key<>q.subject_reference_key OR h.phase_scope<>q.phase_scope
  OR h.semantic_request_hash<>q.semantic_request_hash OR interval_record.reference_key<>q.interval_reference_key
  OR interval_revision_record.revision_no<>q.interval_revision_no OR r.content_hash IS DISTINCT FROM p_content_hash
 THEN RAISE EXCEPTION 'request evaluation result identity mismatch' USING ERRCODE='23514'; END IF;
 IF h.source_selection_kind IS DISTINCT FROM q.query_payload#>>'{sourceSelection,mode}'
  OR (h.source_selection_kind='EXPLICIT_SOURCE' AND (
    h.selected_source_key IS DISTINCT FROM q.query_payload#>>'{sourceSelection,sourceKey}'
    OR (q.query_payload#>>'{sourceSelection,trackerSessionKey}' IS NOT NULL
      AND h.selected_tracker_session_key IS DISTINCT FROM q.query_payload#>>'{sourceSelection,trackerSessionKey}')))
  OR r.profile_key IS DISTINCT FROM q.query_payload#>>'{sourceSelectionProfileReferenceKey,id}'
  OR r.profile_version IS DISTINCT FROM q.query_payload#>>'{sourceSelectionProfileReferenceKey,version}'
  OR (q.query_payload ? 'analysisSpaceReferenceKey' AND h.analysis_space_key IS DISTINCT FROM q.query_payload#>>'{analysisSpaceReferenceKey,id}')
 THEN RAISE EXCEPTION 'request source or rule configuration mismatch' USING ERRCODE='23514'; END IF;
 IF q.snapshot_hash IS DISTINCT FROM public.grounding_sha256(gowm_history_v2.canonical_json(q.requested_snapshot-'manifestHash'))
  OR q.snapshot_hash IS DISTINCT FROM q.requested_snapshot->>'manifestHash'
  OR (q.requested_snapshot->>'capturedAt')::timestamptz IS DISTINCT FROM q.captured_at
 THEN RAISE EXCEPTION 'request evaluation snapshot mismatch' USING ERRCODE='23514'; END IF;
 computed_hash:=public.grounding_sha256(jsonb_build_object('resources',p_resource_inputs,'sets',p_input_sets)::text);
 IF r.input_set_hash IS DISTINCT FROM computed_hash THEN RAISE EXCEPTION 'request evaluation input hash mismatch' USING ERRCODE='23514'; END IF;
 p_data_scope_key:=q.data_scope_key;analysis_captured_at:=q.captured_at;
 p_profile_key:=r.profile_key;p_profile_version:=r.profile_version;p_profile_hash:=r.profile_hash;
 p_analysis_space_key:=h.analysis_space_key;p_selected_source_key:=h.selected_source_key;p_selected_tracker_session_key:=h.selected_tracker_session_key;
 IF interval_revision_record.created_at>q.captured_at OR NOT EXISTS(SELECT 1 FROM gowm_history.method_profile
   WHERE profile_key=r.profile_key AND profile_version=r.profile_version AND content_hash=r.profile_hash AND created_at<=q.captured_at)
 THEN RAISE EXCEPTION 'request input is newer than frozen capture' USING ERRCODE='23514'; END IF;
  FOREACH required_kind IN ARRAY ARRAY[
    'TASK_INTERVAL_REVISION','TRACKLET_VERSION','TRACKLET_FINALIZATION_REVISION',
    'METHOD_PROFILE','ANALYSIS_SPACE'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_resource_inputs) item
      WHERE item->>'inputKind' = required_kind
    ) THEN
      RAISE EXCEPTION 'historical trajectory resource lineage is incomplete: %', required_kind
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR input_row IN SELECT value FROM jsonb_array_elements(p_resource_inputs)
  LOOP
    CASE input_row->>'inputKind'
      WHEN 'TASK_INTERVAL_REVISION' THEN
        IF input_row->>'resourceNamespace' IS DISTINCT FROM 'gowm'
           OR input_row->>'resourceKind' IS DISTINCT FROM 'TASK_EXECUTION_INTERVAL'
           OR input_row->>'resourceId' IS DISTINCT FROM interval_record.reference_key
           OR (input_row->>'resourceVersion')::integer IS DISTINCT FROM
              interval_revision_record.revision_no
           OR (NULLIF(input_row->>'resourceContentHash', '') IS NOT NULL
               AND input_row->>'resourceContentHash' IS DISTINCT FROM
                   interval_revision_record.content_hash) THEN
          RAISE EXCEPTION 'historical trajectory task interval pin is not exact'
            USING ERRCODE = '23514';
        END IF;
      WHEN 'TRACKLET_VERSION' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM public.mobility_tracklet_version version
          JOIN public.mobility_tracklet tracklet USING (tracklet_id)
          WHERE version.tracklet_version_id = (input_row->>'resourceId')::uuid
            AND version.version_no = (input_row->>'resourceVersion')::integer
            AND version.created_at <= analysis_captured_at
            AND input_row->>'resourceContentHash'=CASE WHEN version.content_hash ~ '^[0-9a-f]{64}$' THEN 'sha256:'||version.content_hash ELSE version.content_hash END
            AND EXISTS(SELECT 1 FROM public.world_reference_identity subject WHERE subject.reference_key=q.subject_reference_key
              AND subject.entity_kind='WORLD_OBJECT' AND subject.internal_id=tracklet.world_object_id AND subject.data_scope_key=q.data_scope_key)
            AND tracklet.data_scope_key = p_data_scope_key
            AND tracklet.analysis_space_key = p_analysis_space_key
            AND (p_selected_source_key IS NULL OR tracklet.source_key = p_selected_source_key)
            AND (
              p_selected_tracker_session_key IS NULL
              OR tracklet.tracker_session_key = p_selected_tracker_session_key
            )
        ) THEN
          RAISE EXCEPTION 'historical trajectory tracklet pin is absent, cross-scope, or after captured-at'
            USING ERRCODE = '42501';
        END IF;
      WHEN 'TRACKLET_FINALIZATION_REVISION' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM gowm_history.tracklet_finalization_revision finalization
          JOIN public.mobility_tracklet_version version USING (tracklet_version_id)
          JOIN public.mobility_tracklet tracklet USING (tracklet_id)
          WHERE finalization.finalization_revision_id = (input_row->>'resourceId')::uuid
            AND finalization.revision_no = (input_row->>'resourceVersion')::integer
            AND finalization.created_at <= analysis_captured_at
            AND finalization.content_hash=input_row->>'resourceContentHash'
            AND tracklet.data_scope_key = p_data_scope_key
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(p_resource_inputs) tracklet_input
              WHERE tracklet_input->>'inputKind' = 'TRACKLET_VERSION'
                AND (tracklet_input->>'resourceId')::uuid = version.tracklet_version_id
            )
        ) THEN
          RAISE EXCEPTION 'historical trajectory finalization pin is absent, cross-scope, or after captured-at'
            USING ERRCODE = '42501';
        END IF;
      WHEN 'METHOD_PROFILE' THEN
        IF input_row->>'resourceId' IS DISTINCT FROM p_profile_key
           OR input_row->>'resourceVersion' IS DISTINCT FROM p_profile_version
           OR NULLIF(input_row->>'resourceContentHash', '') IS DISTINCT FROM p_profile_hash THEN
          RAISE EXCEPTION 'historical trajectory method profile pin is not exact'
            USING ERRCODE = '23514';
        END IF;
      WHEN 'ANALYSIS_SPACE' THEN
        IF input_row->>'resourceId' IS DISTINCT FROM p_analysis_space_key THEN
          RAISE EXCEPTION 'historical trajectory analysis-space pin is not exact'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        NULL;
    END CASE;
  END LOOP;


 FOR pin IN SELECT value FROM jsonb_array_elements(q.requested_snapshot->'resources') LOOP
  lookup_id:=regexp_replace(pin->>'resourceId','^(gowm[.]mobility|gowm[.]history|gowm):','');
  IF pin->>'resourceKind'='HISTORY_METHOD_PROFILE' AND lookup_id<>r.profile_key THEN
   IF pin->>'pinning' IS DISTINCT FROM 'PINNED' OR NOT EXISTS(SELECT 1 FROM gowm_history.method_profile profile WHERE profile.profile_key=lookup_id
     AND profile.profile_version=pin->>'version' AND profile.content_hash=pin->>'contentHash' AND profile.created_at<=q.captured_at)
   THEN RAISE EXCEPTION 'upstream method profile pin mismatch' USING ERRCODE='23514'; END IF;
   CONTINUE;
  END IF;
  IF pin->>'resourceKind' IN ('TASK_EXECUTION_INTERVAL' ,'TRACKLET_VERSION','TRACKLET_FINALIZATION','HISTORY_METHOD_PROFILE','ANALYSIS_SPACE') THEN
   IF pin->>'pinning' IS DISTINCT FROM 'PINNED' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_resource_inputs) v
     WHERE v->>'resourceKind'=pin->>'resourceKind' AND v->>'resourceId'=lookup_id
       AND v->>'resourceVersion'=pin->>'version' AND v->>'resourceContentHash'=pin->>'contentHash')
   THEN RAISE EXCEPTION 'request explicit resource pin mismatch' USING ERRCODE='23514'; END IF;
  ELSIF pin->>'resourceKind' IN ('WATERMARK','WATERMARK_REVISION') THEN
   IF pin->>'pinning' IS DISTINCT FROM 'PINNED' OR pin->>'version' IS DISTINCT FROM lookup_id OR NOT EXISTS(SELECT 1 FROM gowm_history.tracklet_finalization_watermark_input w
     JOIN public.pipeline_watermark_revision wr USING(watermark_revision_id)
     WHERE w.watermark_revision_id=lookup_id::uuid AND wr.created_at<=q.captured_at
       AND pin->>'contentHash'=public.grounding_sha256(gowm_history_v2.canonical_json(jsonb_build_object(
         'watermarkRevisionId',w.watermark_revision_id::text,'datastreamKey',w.datastream_key,
         'closedThroughEventTime',to_char(w.closed_through_event_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'allowedLateness',w.allowed_lateness::text,'completenessState',w.completeness_state,
         'createdAt',to_char(w.watermark_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
       AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_resource_inputs) v
         WHERE v->>'inputKind'='TRACKLET_FINALIZATION_REVISION' AND v->>'resourceId'=w.finalization_revision_id::text))
   THEN RAISE EXCEPTION 'request watermark pin mismatch' USING ERRCODE='23514'; END IF;
  ELSIF pin->>'resourceKind'='HISTORICAL_TRAJECTORY' AND lookup_id=h.reference_key THEN
   IF pin->>'version'<>r.revision_no::text OR (pin ? 'contentHash' AND pin->>'contentHash'<>r.content_hash)
   THEN RAISE EXCEPTION 'request trajectory pin mismatch' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
 SELECT * INTO STRICT a FROM public.analysis_record WHERE analysis_id=r.analysis_id;
 INSERT INTO public.analysis_record(data_scope_key,service_name,tool_name,tool_version,algorithm,algorithm_version,
   status,analysis_as_of,query_payload,result_payload,method_snapshot,snapshot_hash)
 VALUES(q.data_scope_key,a.service_name,a.tool_name,a.tool_version,a.algorithm,a.algorithm_version,a.status,q.captured_at,
   q.query_payload,a.result_payload,a.method_snapshot||jsonb_build_object('capturedAt',gowm_history_v2.iso_millis(q.captured_at)),computed_hash)
 RETURNING analysis_id INTO new_analysis;
 INSERT INTO public.analysis_resource_input(analysis_id,input_no,input_role,resource_namespace,resource_kind,resource_id,
  resource_version,resource_content_hash,resource_world_version,pinning,authority,world_reference_key,source_analysis_id)
 SELECT new_analysis,input_no,input_role,resource_namespace,resource_kind,resource_id,resource_version,resource_content_hash,
  resource_world_version,pinning,authority,world_reference_key,source_analysis_id FROM public.analysis_resource_input WHERE analysis_id=r.analysis_id;
 INSERT INTO public.analysis_input_set(analysis_id,input_set_kind,item_count,item_set_digest,manifest_artifact_ref,authority)
 SELECT new_analysis,input_set_kind,item_count,item_set_digest,manifest_artifact_ref,authority FROM public.analysis_input_set WHERE analysis_id=r.analysis_id;
 INSERT INTO gowm_history.historical_request_evaluation(queue_id,generation,request_hash,snapshot_hash,full_request_hash,trajectory_revision_id,
  analysis_id,input_set_hash,content_hash,reused,claimed_at)
 VALUES(q.queue_id,q.generation,q.request_hash,q.snapshot_hash,public.grounding_sha256(gowm_history_v2.canonical_json(q.query_payload)),r.trajectory_revision_id,new_analysis,computed_hash,r.content_hash,r.created_at<=q.captured_at,q.locked_at)
 RETURNING evaluation_id INTO evaluation;
 RETURN evaluation;
END
$fn$;
CREATE FUNCTION gowm_history.complete_evaluated_historical_request(p_queue_id uuid,p_worker_id text,p_generation bigint,p_evaluation_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,gowm_history AS $fn$
DECLARE q gowm_history.historical_trajectory_projection_queue; e gowm_history.historical_request_evaluation;
BEGIN
 SELECT * INTO q FROM gowm_history.historical_trajectory_projection_queue WHERE queue_id=p_queue_id FOR UPDATE;
 IF NOT FOUND OR q.state<>'RUNNING' OR q.locked_by IS DISTINCT FROM p_worker_id OR q.generation<>p_generation OR q.lease_until<=clock_timestamp() THEN RETURN false; END IF;
 SELECT * INTO e FROM gowm_history.historical_request_evaluation WHERE evaluation_id=p_evaluation_id;
 IF NOT FOUND OR e.queue_id<>q.queue_id OR e.generation<>q.generation OR e.request_hash<>q.request_hash OR e.snapshot_hash<>q.snapshot_hash
  OR e.full_request_hash IS DISTINCT FROM public.grounding_sha256(gowm_history_v2.canonical_json(q.query_payload))
  OR e.evaluated_at<=q.captured_at OR NOT EXISTS(SELECT 1 FROM public.analysis_record a
    JOIN gowm_history.historical_trajectory_revision r ON r.trajectory_revision_id=e.trajectory_revision_id
    WHERE a.analysis_id=e.analysis_id AND a.data_scope_key=q.data_scope_key AND a.analysis_as_of=q.captured_at
      AND a.query_payload=q.query_payload AND a.snapshot_hash=e.input_set_hash AND r.input_set_hash=e.input_set_hash AND r.content_hash=e.content_hash)
 THEN RAISE EXCEPTION 'request completion proof mismatch' USING ERRCODE='23514'; END IF;
 IF q.data_scope_key IS DISTINCT FROM gowm_history_v1.current_data_scope_key() THEN RAISE EXCEPTION 'request completion scope mismatch' USING ERRCODE='42501'; END IF;
 UPDATE gowm_history.historical_trajectory_projection_queue SET state='COMPLETED',trajectory_revision_id=e.trajectory_revision_id,
   outcome_id=NULL,processed_at=clock_timestamp(),locked_at=NULL,lease_until=NULL,locked_by=NULL,last_error=NULL WHERE queue_id=q.queue_id;
 RETURN true;
END
$fn$;
-- A proof cannot be committed without the corresponding completed fenced queue.
CREATE FUNCTION gowm_history.require_evaluation_completion() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,gowm_history AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM gowm_history.historical_trajectory_projection_queue q WHERE q.queue_id=NEW.queue_id
  AND q.state='COMPLETED' AND q.generation=NEW.generation AND q.trajectory_revision_id=NEW.trajectory_revision_id)
 THEN RAISE EXCEPTION 'uncommitted request evaluation' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER request_evaluation_completed AFTER INSERT ON gowm_history.historical_request_evaluation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gowm_history.require_evaluation_completion();
CREATE INDEX historical_evaluated_snapshot_lookup ON gowm_history.historical_trajectory_projection_queue(data_scope_key,snapshot_hash) WHERE state='COMPLETED';
CREATE FUNCTION gowm_history_v1.evaluated_historical_trajectory(p_query jsonb,p_snapshot jsonb)
RETURNS SETOF gowm_history_v1.historical_trajectory_effective LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,gowm_history,gowm_history_v1 AS $fn$
SELECT
  identity.historical_trajectory_id,
  identity.data_scope_key,
  identity.reference_key,
  identity.subject_reference_key,
  identity.interval_id,
  identity.phase_scope,
  identity.semantic_request_hash,
  revision.trajectory_revision_id,
  revision.revision_no,
  revision.interval_revision_id,
  revision.trajectory,
  revision.extent_box,
  revision.requested_time,
  revision.defined_time,
  revision.start_event_time,
  revision.end_event_time,
  revision.sample_count,
  revision.sequence_count,
  revision.gap_count,
  revision.temporal_coverage_ratio,
  revision.prefix_complete,
  revision.suffix_complete,
  revision.finalization_state,
  revision.input_set_hash,
  revision.profile_key,
  revision.profile_version,
  revision.profile_hash,
  revision.world_version,
  revision.content_hash,
  evaluation.analysis_id,
  revision.created_at
FROM gowm_history.historical_trajectory_projection_queue queue
JOIN gowm_history.historical_request_evaluation evaluation USING(queue_id)
JOIN gowm_history.historical_trajectory_revision revision ON revision.trajectory_revision_id=evaluation.trajectory_revision_id
JOIN gowm_history.historical_trajectory identity USING(historical_trajectory_id)
WHERE queue.data_scope_key=gowm_history_v1.current_data_scope_key()
 AND queue.snapshot_hash=p_snapshot->>'manifestHash'
 AND queue.state='COMPLETED' AND queue.generation=evaluation.generation
 AND queue.trajectory_revision_id=evaluation.trajectory_revision_id
 AND queue.request_hash=evaluation.request_hash AND queue.snapshot_hash=evaluation.snapshot_hash
 AND evaluation.full_request_hash=public.grounding_sha256(gowm_history_v2.canonical_json(p_query))
 AND queue.query_payload=p_query AND queue.requested_snapshot=p_snapshot
$fn$;
CREATE FUNCTION gowm_history_v1.historical_request_evaluation_identity(p_query jsonb,p_snapshot jsonb)
RETURNS TABLE(evaluation_id uuid,analysis_id uuid,evaluated_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,gowm_history,gowm_history_v1 AS $fn$
 SELECT e.evaluation_id,e.analysis_id,e.evaluated_at FROM gowm_history.historical_request_evaluation e
 JOIN gowm_history.historical_trajectory_projection_queue q USING(queue_id)
 WHERE q.data_scope_key=gowm_history_v1.current_data_scope_key() AND q.state='COMPLETED'
  AND q.generation=e.generation AND q.trajectory_revision_id=e.trajectory_revision_id
  AND q.request_hash=e.request_hash AND q.snapshot_hash=e.snapshot_hash
  AND q.snapshot_hash=p_snapshot->>'manifestHash' AND q.query_payload=p_query AND q.requested_snapshot=p_snapshot
  AND e.full_request_hash=public.grounding_sha256(gowm_history_v2.canonical_json(p_query))
$fn$;
REVOKE ALL ON FUNCTION gowm_history_v1.historical_request_evaluation_identity(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_history_v1.historical_request_evaluation_identity(jsonb,jsonb) TO gowm_history_reader;
REVOKE ALL ON FUNCTION gowm_history.evaluate_historical_request(uuid,text,bigint,uuid,text,jsonb,jsonb),
 gowm_history.complete_evaluated_historical_request(uuid,text,bigint,uuid),
 gowm_history_v1.evaluated_historical_trajectory(jsonb,jsonb),gowm_history.protect_request_evaluation(),gowm_history.require_evaluation_completion() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_history.evaluate_historical_request(uuid,text,bigint,uuid,text,jsonb,jsonb),
 gowm_history.complete_evaluated_historical_request(uuid,text,bigint,uuid) TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history_v1.evaluated_historical_trajectory(jsonb,jsonb) TO gowm_history_reader;
COMMIT;
