BEGIN;
-- Add exact interval-revision overloads; retain frozen v1 signatures unchanged.
CREATE FUNCTION gowm_history_v1.historical_trajectory_outcome_as_of(
  p_subject_reference_key text,
  p_interval_reference_key text,
  p_phase_scope text,
  p_semantic_request_hash text,
  p_captured_at timestamptz,
  p_exact_interval_revision_no integer
)
RETURNS SETOF gowm_history_v1.historical_trajectory_outcome
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history, gowm_history_v1
AS $fn$
  SELECT
    outcome.outcome_id,
    outcome.data_scope_key,
    outcome.subject_reference_key,
    outcome.interval_reference_key,
    outcome.phase_scope,
    outcome.semantic_request_hash,
    outcome.outcome_revision_no,
    outcome.outcome_status,
    outcome.reason_code,
    outcome.reason_codes,
    outcome.projection_pending,
    outcome.analysis_id,
    outcome.evaluated_as_of,
    outcome.content_hash,
    outcome.created_at
  FROM gowm_history.historical_trajectory_outcome outcome
  JOIN public.analysis_record analysis ON analysis.analysis_id=outcome.analysis_id
  WHERE outcome.data_scope_key = gowm_history_v1.current_data_scope_key()
    AND outcome.subject_reference_key = p_subject_reference_key
    AND outcome.interval_reference_key = p_interval_reference_key
    AND outcome.phase_scope = p_phase_scope
    AND outcome.semantic_request_hash = p_semantic_request_hash
    AND outcome.created_at <= p_captured_at
    AND analysis.data_scope_key = outcome.data_scope_key
    AND analysis.analysis_as_of <= p_captured_at
    AND analysis.query_payload #>> '{executionIntervalReferenceKey,id}' = p_interval_reference_key
    AND analysis.query_payload #>> '{executionIntervalReferenceKey,version}' = p_exact_interval_revision_no::text
  ORDER BY outcome.created_at DESC, outcome.outcome_revision_no DESC
  LIMIT 1
$fn$;

CREATE FUNCTION gowm_history_v1.historical_trajectory_as_of(
  p_subject_reference_key text,
  p_interval_reference_key text,
  p_phase_scope text,
  p_semantic_request_hash text,
  p_captured_at timestamptz,
  p_exact_revision_no integer,
  p_exact_interval_revision_no integer
)
RETURNS SETOF gowm_history_v1.historical_trajectory_effective
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history, gowm_history_v1
AS $fn$
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
    revision.analysis_id,
    revision.created_at
  FROM gowm_history.historical_trajectory identity
  JOIN gowm_history.task_execution_interval interval USING (interval_id)
  JOIN LATERAL (
    SELECT candidate.*
    FROM gowm_history.historical_trajectory_revision candidate
    WHERE candidate.historical_trajectory_id = identity.historical_trajectory_id
      AND candidate.created_at <= p_captured_at
      AND EXISTS (
        SELECT 1 FROM gowm_history.task_execution_interval_revision interval_revision
        WHERE interval_revision.interval_revision_id=candidate.interval_revision_id
          AND interval_revision.revision_no=p_exact_interval_revision_no
          AND interval_revision.created_at <= p_captured_at
      )
      AND (p_exact_revision_no IS NULL OR candidate.revision_no = p_exact_revision_no)
    ORDER BY candidate.created_at DESC, candidate.revision_no DESC
    LIMIT 1
  ) revision ON true
  WHERE identity.data_scope_key = gowm_history_v1.current_data_scope_key()
    AND identity.subject_reference_key = p_subject_reference_key
    AND interval.reference_key = p_interval_reference_key
    AND identity.phase_scope = p_phase_scope
    AND identity.semantic_request_hash = p_semantic_request_hash
$fn$;

REVOKE ALL ON FUNCTION gowm_history_v1.historical_trajectory_outcome_as_of(text,text,text,text,timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION gowm_history_v1.historical_trajectory_as_of(text,text,text,text,timestamptz,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_history_v1.historical_trajectory_outcome_as_of(text,text,text,text,timestamptz,integer) TO gowm_history_reader;
GRANT EXECUTE ON FUNCTION gowm_history_v1.historical_trajectory_as_of(text,text,text,text,timestamptz,integer,integer) TO gowm_history_reader;
COMMIT;
