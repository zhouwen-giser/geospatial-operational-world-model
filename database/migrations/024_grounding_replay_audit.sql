BEGIN;

CREATE TABLE grounding_replay_audit (
  replay_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  replay_kind text NOT NULL CHECK (replay_kind IN ('REFERENCE_SEARCH_PROJECTION','QUERY_RESULT')),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 128),
  source_event_range jsonb NOT NULL CHECK (jsonb_typeof(source_event_range)='object'),
  input_evidence_hash text NOT NULL CHECK (input_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  expected_output_checksum text NOT NULL CHECK (expected_output_checksum ~ '^sha256:[0-9a-f]{64}$'),
  replay_output_checksum text NOT NULL CHECK (replay_output_checksum ~ '^sha256:[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN (
    'MATCH','REBUILT_DIFFERENCE','DATA_VERSION_DIFFERENCE',
    'COMPUTE_VERSION_DIFFERENCE','CHECKSUM_MISMATCH'
  )),
  difference_report jsonb NOT NULL CHECK (jsonb_typeof(difference_report)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX grounding_replay_audit_scope_time_idx
  ON grounding_replay_audit(data_scope_key,created_at DESC,replay_id);

CREATE FUNCTION grounding_sha256(p_value text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT 'sha256:' || encode(digest(convert_to(p_value,'UTF8'),'sha256'),'hex') $$;

CREATE FUNCTION reference_catalog_input_checksum(p_data_scope_key text)
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
  WITH evidence AS (
    SELECT jsonb_build_array('IDENTITY',reference_key,entity_kind,internal_id) AS item
    FROM world_reference_identity WHERE data_scope_key=p_data_scope_key
    UNION ALL
    SELECT jsonb_build_array('DESCRIPTOR',reference_key,descriptor_version,content_hash)
    FROM world_reference_descriptor_version WHERE data_scope_key=p_data_scope_key
    UNION ALL
    SELECT jsonb_build_array('NAME',reference_key,name_kind,language_tag,normalized_text,source_ref,confidence,valid_from,valid_to)
    FROM world_reference_name WHERE data_scope_key=p_data_scope_key
    UNION ALL
    SELECT jsonb_build_array('EXTERNAL',reference_key,authority,identifier_kind,normalized_value,confidence,valid_from,valid_to)
    FROM world_reference_external_identifier WHERE data_scope_key=p_data_scope_key
  )
  SELECT grounding_sha256(COALESCE(jsonb_agg(item ORDER BY item::text)::text,'[]')) FROM evidence
$fn$;

CREATE FUNCTION reference_search_projection_checksum(p_data_scope_key text)
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
  SELECT grounding_sha256(COALESCE(jsonb_agg(
    jsonb_build_array(reference_key,entity_kind,search_kind,normalized_text,
                      match_priority,source_id,source_confidence)
    ORDER BY reference_key,search_kind,normalized_text,source_id
  )::text,'[]'))
  FROM reference_search_projection WHERE data_scope_key=p_data_scope_key
$fn$;

CREATE FUNCTION rebuild_reference_search_projection_audited(
  p_data_scope_key text,
  p_policy_version text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
DECLARE
  input_hash text;
  previous_checksum text;
  replay_checksum text;
  rebuilt_count integer;
  event_range jsonb;
  result_id uuid;
BEGIN
  IF p_policy_version IS NULL OR length(p_policy_version) NOT BETWEEN 1 AND 128 OR
     NOT EXISTS (SELECT 1 FROM public.data_scope WHERE scope_key=p_data_scope_key) THEN
    RAISE EXCEPTION 'replay request is invalid' USING ERRCODE='22023';
  END IF;
  input_hash := public.reference_catalog_input_checksum(p_data_scope_key);
  previous_checksum := public.reference_search_projection_checksum(p_data_scope_key);
  SELECT jsonb_build_object(
    'firstEvidenceAt',min(created_at),
    'lastEvidenceAt',max(created_at)
  ) INTO event_range
  FROM (
    SELECT created_at FROM public.world_reference_identity WHERE data_scope_key=p_data_scope_key
    UNION ALL SELECT created_at FROM public.world_reference_descriptor_version WHERE data_scope_key=p_data_scope_key
    UNION ALL SELECT created_at FROM public.world_reference_name WHERE data_scope_key=p_data_scope_key
    UNION ALL SELECT created_at FROM public.world_reference_external_identifier WHERE data_scope_key=p_data_scope_key
  ) evidence;
  rebuilt_count := public.rebuild_reference_search_projection(p_data_scope_key);
  replay_checksum := public.reference_search_projection_checksum(p_data_scope_key);
  INSERT INTO public.grounding_replay_audit(
    data_scope_key,replay_kind,policy_version,source_event_range,input_evidence_hash,
    expected_output_checksum,replay_output_checksum,outcome,difference_report
  ) VALUES (
    p_data_scope_key,'REFERENCE_SEARCH_PROJECTION',p_policy_version,COALESCE(event_range,'{}'::jsonb),input_hash,
    previous_checksum,replay_checksum,
    CASE WHEN previous_checksum=replay_checksum THEN 'MATCH' ELSE 'REBUILT_DIFFERENCE' END,
    jsonb_build_object(
      'changed',previous_checksum<>replay_checksum,
      'rowsRebuilt',rebuilt_count,
      'previousChecksum',previous_checksum,
      'replayChecksum',replay_checksum
    )
  ) RETURNING replay_id INTO result_id;
  RETURN result_id;
END
$fn$;

CREATE FUNCTION record_query_result_replay(
  p_query_id text,
  p_replay_result_hash text,
  p_replay_data_snapshot_hash text,
  p_replay_compute_snapshot_hash text,
  p_policy_version text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,gowm_capability
AS $fn$
DECLARE
  record_row record;
  replay_outcome text;
  result_id uuid;
BEGIN
  SELECT result.data_scope_key,result.result_hash,result.data_snapshot_hash,result.compute_snapshot_hash,
         query.submission,gateway.started_at,gateway.completed_at
  INTO STRICT record_row
  FROM public.world_query_result_reference result
  JOIN gowm_capability.world_query_job query USING(query_id)
  JOIN gowm_capability.gateway_job gateway ON gateway.job_id=query.job_id
  WHERE result.query_id=p_query_id;

  IF p_replay_result_hash=record_row.result_hash AND
     p_replay_data_snapshot_hash=record_row.data_snapshot_hash AND
     p_replay_compute_snapshot_hash=record_row.compute_snapshot_hash THEN
    replay_outcome := 'MATCH';
  ELSIF p_replay_data_snapshot_hash<>record_row.data_snapshot_hash THEN
    replay_outcome := 'DATA_VERSION_DIFFERENCE';
  ELSIF p_replay_compute_snapshot_hash<>record_row.compute_snapshot_hash THEN
    replay_outcome := 'COMPUTE_VERSION_DIFFERENCE';
  ELSE
    replay_outcome := 'CHECKSUM_MISMATCH';
  END IF;

  INSERT INTO public.grounding_replay_audit(
    data_scope_key,replay_kind,policy_version,source_event_range,input_evidence_hash,
    expected_output_checksum,replay_output_checksum,outcome,difference_report
  ) VALUES (
    record_row.data_scope_key,'QUERY_RESULT',p_policy_version,
    jsonb_build_object('startedAt',record_row.started_at,'completedAt',record_row.completed_at),
    public.grounding_sha256(jsonb_build_object(
      'submission',record_row.submission,
      'dataSnapshotHash',record_row.data_snapshot_hash,
      'computeSnapshotHash',record_row.compute_snapshot_hash
    )::text),
    record_row.result_hash,p_replay_result_hash,replay_outcome,
    jsonb_build_object(
      'expectedDataSnapshotHash',record_row.data_snapshot_hash,
      'replayDataSnapshotHash',p_replay_data_snapshot_hash,
      'expectedComputeSnapshotHash',record_row.compute_snapshot_hash,
      'replayComputeSnapshotHash',p_replay_compute_snapshot_hash,
      'expectedResultHash',record_row.result_hash,
      'replayResultHash',p_replay_result_hash
    )
  ) RETURNING replay_id INTO result_id;
  RETURN result_id;
END
$fn$;

CREATE FUNCTION reject_grounding_replay_mutation()
RETURNS trigger LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'grounding replay audit is append-only' USING ERRCODE='55000';
END
$fn$;

CREATE TRIGGER grounding_replay_audit_immutable
  BEFORE UPDATE OR DELETE ON grounding_replay_audit
  FOR EACH ROW EXECUTE FUNCTION reject_grounding_replay_mutation();

REVOKE ALL ON FUNCTION grounding_sha256(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reference_catalog_input_checksum(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reference_search_projection_checksum(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rebuild_reference_search_projection_audited(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_query_result_replay(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_grounding_replay_mutation() FROM PUBLIC;

COMMIT;
