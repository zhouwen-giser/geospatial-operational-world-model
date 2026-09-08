BEGIN;
-- Decode canonical Gateway identity only for lookup. Preserve the frozen payload,
-- snapshot, hashes, permissions and capturedAt checks from migration 067.
CREATE OR REPLACE FUNCTION gowm_history.enqueue_historical_trajectory_projection(
  p_data_scope_key text,
  p_subject_reference_key text,
  p_interval_reference_key text,
  p_interval_revision_no integer,
  p_phase_scope text,
  p_semantic_request_hash text,
  p_snapshot_hash text,
  p_captured_at timestamptz,
  p_query_payload jsonb,
  p_requested_snapshot jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history, gowm_history_v1
AS $fn$
DECLARE
  subject_scope text;
  interval_scope text;
  interval_kind text;
  snapshot_resource jsonb;
  snapshot_resource_scope text;
  request_digest text;
  result_id uuid;
  result_state text;
  result_attempts integer;
BEGIN
  IF gowm_history_v1.current_data_scope_key() IS DISTINCT FROM p_data_scope_key THEN
    RAISE EXCEPTION 'historical trajectory enqueue scope was not selected first'
      USING ERRCODE = '42501';
  END IF;
  IF p_interval_revision_no IS NULL OR p_interval_revision_no <= 0
     OR p_phase_scope NOT IN ('EXECUTION_ENVELOPE','ACTIVE_PHASES_ONLY')
     OR p_semantic_request_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_snapshot_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_captured_at IS NULL
     OR jsonb_typeof(p_query_payload) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_requested_snapshot) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_requested_snapshot->'resources') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_requested_snapshot->'resources') > 512 THEN
    RAISE EXCEPTION 'historical trajectory enqueue request is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT identity.data_scope_key
  INTO subject_scope
  FROM public.world_reference_identity identity
  WHERE identity.reference_key = p_subject_reference_key;
  IF NOT FOUND OR subject_scope IS DISTINCT FROM p_data_scope_key THEN
    RAISE EXCEPTION 'historical trajectory subject is unavailable or cross-scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT identity.data_scope_key, identity.entity_kind
  INTO interval_scope, interval_kind
  FROM public.world_reference_identity identity
  WHERE identity.reference_key = p_interval_reference_key;
  IF NOT FOUND OR interval_scope IS DISTINCT FROM p_data_scope_key
     OR interval_kind <> 'TASK_EXECUTION_INTERVAL' THEN
    RAISE EXCEPTION 'historical trajectory interval is unavailable or cross-scope'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM gowm_history.task_execution_interval interval
    JOIN gowm_history.task_execution_interval_revision revision USING (interval_id)
    WHERE interval.data_scope_key = p_data_scope_key
      AND interval.reference_key = p_interval_reference_key
      AND revision.revision_no = p_interval_revision_no
      AND revision.created_at <= p_captured_at
  ) THEN
    RAISE EXCEPTION 'historical trajectory interval revision is unavailable at capturedAt'
      USING ERRCODE = '23503';
  END IF;

  IF p_query_payload #>> '{subjectReferenceKey,id}' IS DISTINCT FROM p_subject_reference_key
     OR p_query_payload #>> '{executionIntervalReferenceKey,id}' IS DISTINCT FROM p_interval_reference_key
     OR p_query_payload #>> '{executionIntervalReferenceKey,version}' IS DISTINCT FROM p_interval_revision_no::text
     OR p_query_payload->>'phaseScope' IS DISTINCT FROM p_phase_scope
     OR p_requested_snapshot->>'manifestHash' IS DISTINCT FROM p_snapshot_hash
     OR (p_requested_snapshot->>'capturedAt')::timestamptz IS DISTINCT FROM p_captured_at THEN
    RAISE EXCEPTION 'historical trajectory frozen request identity conflicts with queue columns'
      USING ERRCODE = '23514';
  END IF;

  FOR snapshot_resource IN
    SELECT value FROM jsonb_array_elements(p_requested_snapshot->'resources')
  LOOP
    snapshot_resource_scope := NULL;
    CASE snapshot_resource->>'resourceKind'
      WHEN 'TASK_EXECUTION_INTERVAL' THEN
        SELECT identity.data_scope_key
        INTO snapshot_resource_scope
        FROM public.world_reference_identity identity
        WHERE identity.reference_key = CASE
          WHEN snapshot_resource->>'resourceId' LIKE 'gowm:%'
          THEN substr(snapshot_resource->>'resourceId', 6)
          ELSE snapshot_resource->>'resourceId' END
          AND identity.entity_kind = 'TASK_EXECUTION_INTERVAL';
      WHEN 'TRACKLET_VERSION' THEN
        SELECT tracklet.data_scope_key
        INTO snapshot_resource_scope
        FROM public.mobility_tracklet_version version
        JOIN public.mobility_tracklet tracklet USING (tracklet_id)
        WHERE version.tracklet_version_id = (CASE
          WHEN snapshot_resource->>'resourceId' LIKE 'gowm.mobility:%'
          THEN substr(snapshot_resource->>'resourceId', 15)
          ELSE snapshot_resource->>'resourceId' END)::uuid;
      WHEN 'TRACKLET_FINALIZATION' THEN
        SELECT tracklet.data_scope_key
        INTO snapshot_resource_scope
        FROM gowm_history.tracklet_finalization_revision finalization
        JOIN public.mobility_tracklet_version version USING (tracklet_version_id)
        JOIN public.mobility_tracklet tracklet USING (tracklet_id)
        WHERE finalization.finalization_revision_id = (CASE
          WHEN snapshot_resource->>'resourceId' LIKE 'gowm.history:%'
          THEN substr(snapshot_resource->>'resourceId', 14)
          ELSE snapshot_resource->>'resourceId' END)::uuid;
      WHEN 'WATERMARK_REVISION' THEN
        SELECT stream.data_scope_key
        INTO snapshot_resource_scope
        FROM public.pipeline_watermark_revision watermark
        JOIN public.datastream stream USING (datastream_key)
        WHERE watermark.watermark_revision_id = (snapshot_resource->>'resourceId')::uuid;
      WHEN 'WATERMARK' THEN
        SELECT stream.data_scope_key
        INTO snapshot_resource_scope
        FROM public.pipeline_watermark_revision watermark
        JOIN public.datastream stream USING (datastream_key)
        WHERE watermark.watermark_revision_id = (snapshot_resource->>'resourceId')::uuid;
      ELSE
        CONTINUE;
    END CASE;

    IF snapshot_resource_scope IS NULL THEN
      RAISE EXCEPTION 'historical trajectory snapshot resource is unavailable'
        USING ERRCODE = '23503';
    END IF;
    IF snapshot_resource_scope IS DISTINCT FROM p_data_scope_key THEN
      RAISE EXCEPTION 'historical trajectory snapshot resource crosses data scope'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  request_digest := public.grounding_sha256(jsonb_build_array(
    p_data_scope_key, p_subject_reference_key, p_interval_reference_key,
    p_interval_revision_no, p_phase_scope, p_semantic_request_hash,
    p_snapshot_hash, p_captured_at
  )::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_data_scope_key || E'\u001f' || request_digest,
    0
  ));

  INSERT INTO gowm_history.historical_trajectory_projection_queue(
    data_scope_key, subject_reference_key, interval_reference_key,
    interval_revision_no, phase_scope, semantic_request_hash, snapshot_hash,
    captured_at, query_payload, requested_snapshot, request_hash
  ) VALUES (
    p_data_scope_key, p_subject_reference_key, p_interval_reference_key,
    p_interval_revision_no, p_phase_scope, p_semantic_request_hash,
    p_snapshot_hash, p_captured_at, p_query_payload, p_requested_snapshot,
    request_digest
  ) ON CONFLICT (data_scope_key, request_hash) DO UPDATE SET
    state = CASE
      WHEN gowm_history.historical_trajectory_projection_queue.state = 'FAILED'
       AND gowm_history.historical_trajectory_projection_queue.attempts < 10
      THEN 'QUEUED'
      ELSE gowm_history.historical_trajectory_projection_queue.state
    END,
    available_at = CASE
      WHEN gowm_history.historical_trajectory_projection_queue.state = 'FAILED'
       AND gowm_history.historical_trajectory_projection_queue.attempts < 10
      THEN clock_timestamp()
      ELSE gowm_history.historical_trajectory_projection_queue.available_at
    END,
    last_error = CASE
      WHEN gowm_history.historical_trajectory_projection_queue.state = 'FAILED'
       AND gowm_history.historical_trajectory_projection_queue.attempts < 10
      THEN NULL
      ELSE gowm_history.historical_trajectory_projection_queue.last_error
    END
  RETURNING queue_id, state, attempts
  INTO result_id, result_state, result_attempts;

  IF result_state = 'FAILED' AND result_attempts >= 10 THEN
    RAISE EXCEPTION 'historical trajectory projection retry budget is exhausted'
      USING ERRCODE = '55000';
  END IF;
  RETURN result_id;
END
$fn$;

-- v2 counts original measurements: a nonempty interpolated slice may contain zero.
ALTER TABLE gowm_history.historical_trajectory_revision
 DROP CONSTRAINT historical_trajectory_revision_sample_count_check,
 ADD CONSTRAINT historical_trajectory_revision_sample_count_check CHECK (sample_count >= 0);
COMMIT;
