BEGIN;

ALTER TABLE public.world_reference_identity
  DROP CONSTRAINT world_reference_entity_kind,
  ADD CONSTRAINT world_reference_entity_kind CHECK (entity_kind IN (
    'WORLD_OBJECT','SPATIAL_OBJECT','DATA_SCOPE','DATASET','LAYER','LAYER_FEATURE',
    'QUERY_RESULT','DERIVED_REFERENCE','REFERENCE_SET','OPERATIONAL_TASK',
    'TASK_EXECUTION_INTERVAL','HISTORICAL_TRAJECTORY'
  ));

CREATE TABLE gowm_history.historical_trajectory (
  historical_trajectory_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),
  reference_key text NOT NULL UNIQUE REFERENCES public.world_reference_identity(reference_key),
  subject_reference_key text NOT NULL REFERENCES public.world_reference_identity(reference_key),
  interval_id uuid NOT NULL REFERENCES gowm_history.task_execution_interval(interval_id),
  phase_scope text NOT NULL CHECK (phase_scope IN ('EXECUTION_ENVELOPE','ACTIVE_PHASES_ONLY')),
  source_selection_kind text NOT NULL CHECK (source_selection_kind IN ('EXPLICIT_SOURCE','ONLY_CANDIDATE')),
  selected_source_key text,
  selected_tracker_session_key text,
  analysis_space_key text NOT NULL REFERENCES public.analysis_space(analysis_space_key),
  semantic_request_hash text NOT NULL CHECK (semantic_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    data_scope_key, subject_reference_key, interval_id, phase_scope,
    semantic_request_hash
  ),
  UNIQUE (historical_trajectory_id, data_scope_key),
  CHECK (
    source_selection_kind = 'ONLY_CANDIDATE'
    OR selected_source_key IS NOT NULL
  )
);

CREATE INDEX historical_trajectory_semantic_lookup_idx
  ON gowm_history.historical_trajectory(
    data_scope_key, subject_reference_key, interval_id, phase_scope,
    semantic_request_hash
  );

CREATE TABLE gowm_history.historical_trajectory_revision (
  trajectory_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  historical_trajectory_id uuid NOT NULL
    REFERENCES gowm_history.historical_trajectory(historical_trajectory_id),
  revision_no integer NOT NULL CHECK (revision_no > 0),
  interval_revision_id uuid NOT NULL
    REFERENCES gowm_history.task_execution_interval_revision(interval_revision_id),
  trajectory tgeompoint(SequenceSet,Point) NOT NULL,
  extent_box stbox NOT NULL,
  requested_time tstzmultirange NOT NULL,
  defined_time tstzmultirange NOT NULL,
  start_event_time timestamptz NOT NULL,
  end_event_time timestamptz NOT NULL,
  sample_count integer NOT NULL CHECK (sample_count > 0),
  sequence_count integer NOT NULL CHECK (sequence_count > 0),
  gap_count integer NOT NULL CHECK (gap_count >= 0),
  temporal_coverage_ratio double precision NOT NULL
    CHECK (temporal_coverage_ratio BETWEEN 0 AND 1),
  prefix_complete boolean NOT NULL,
  suffix_complete boolean NOT NULL,
  finalization_state text NOT NULL CHECK (finalization_state IN (
    'PROVISIONAL','SEALED','CONFLICTED'
  )),
  input_set_hash text NOT NULL CHECK (input_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  profile_key text NOT NULL,
  profile_version text NOT NULL,
  profile_hash text NOT NULL CHECK (profile_hash ~ '^sha256:[0-9a-f]{64}$'),
  world_version bigint NOT NULL DEFAULT nextval('public.world_version_seq') CHECK (world_version >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  analysis_id uuid NOT NULL REFERENCES public.analysis_record(analysis_id),
  supersedes_revision_id uuid
    REFERENCES gowm_history.historical_trajectory_revision(trajectory_revision_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (historical_trajectory_id, revision_no),
  UNIQUE (historical_trajectory_id, content_hash),
  UNIQUE (trajectory_revision_id, historical_trajectory_id),
  FOREIGN KEY (profile_key, profile_version)
    REFERENCES gowm_history.method_profile(profile_key, profile_version),
  CHECK (end_event_time >= start_event_time),
  CHECK (NOT isempty(requested_time)),
  CHECK (NOT isempty(defined_time)),
  CHECK (defined_time <@ requested_time),
  CHECK (supersedes_revision_id IS NULL OR supersedes_revision_id <> trajectory_revision_id)
);

CREATE INDEX historical_trajectory_revision_as_of_idx
  ON gowm_history.historical_trajectory_revision(
    historical_trajectory_id, created_at DESC, revision_no DESC
  );
CREATE INDEX historical_trajectory_revision_trajectory_gist_idx
  ON gowm_history.historical_trajectory_revision USING gist(trajectory);
CREATE INDEX historical_trajectory_revision_requested_gist_idx
  ON gowm_history.historical_trajectory_revision USING gist(requested_time);

CREATE TABLE gowm_history.historical_trajectory_segment (
  trajectory_revision_id uuid NOT NULL
    REFERENCES gowm_history.historical_trajectory_revision(trajectory_revision_id),
  segment_no integer NOT NULL CHECK (segment_no > 0),
  source_tracklet_version_id uuid NOT NULL,
  source_segment_no integer NOT NULL CHECK (source_segment_no > 0),
  interval_revision_id uuid NOT NULL,
  phase_no integer,
  trajectory tgeompoint(Sequence,Point) NOT NULL,
  sample_count integer NOT NULL CHECK (sample_count > 0),
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (trajectory_revision_id, segment_no),
  FOREIGN KEY (source_tracklet_version_id, source_segment_no)
    REFERENCES public.mobility_tracklet_segment(tracklet_version_id, segment_no),
  FOREIGN KEY (interval_revision_id, phase_no)
    REFERENCES gowm_history.task_execution_phase(interval_revision_id, phase_no),
  CHECK (end_time >= start_time),
  CHECK (phase_no IS NOT NULL OR interval_revision_id IS NOT NULL)
);

CREATE INDEX historical_trajectory_segment_trajectory_gist_idx
  ON gowm_history.historical_trajectory_segment USING gist(trajectory);
CREATE INDEX historical_trajectory_segment_time_idx
  ON gowm_history.historical_trajectory_segment(start_time, end_time, trajectory_revision_id);

CREATE TABLE gowm_history.historical_trajectory_gap (
  trajectory_revision_id uuid NOT NULL
    REFERENCES gowm_history.historical_trajectory_revision(trajectory_revision_id),
  gap_no integer NOT NULL CHECK (gap_no > 0),
  gap_kind text NOT NULL CHECK (gap_kind IN (
    'UNKNOWN_INPUT_GAP','SOURCE_COVERAGE_GAP','TRACKLET_BOUNDARY_GAP'
  )),
  gap_time tstzrange NOT NULL,
  left_measurement_id uuid REFERENCES public.position_measurement(measurement_id),
  right_measurement_id uuid REFERENCES public.position_measurement(measurement_id),
  source_tracklet_version_id uuid,
  source_tracklet_gap_no integer,
  reason_codes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (trajectory_revision_id, gap_no),
  FOREIGN KEY (source_tracklet_version_id, source_tracklet_gap_no)
    REFERENCES public.mobility_tracklet_gap(tracklet_version_id, gap_no),
  CHECK (NOT isempty(gap_time)),
  CHECK ((source_tracklet_version_id IS NULL) = (source_tracklet_gap_no IS NULL))
);

CREATE INDEX historical_trajectory_gap_time_gist_idx
  ON gowm_history.historical_trajectory_gap USING gist(gap_time);

CREATE TABLE gowm_history.historical_trajectory_excluded_period (
  trajectory_revision_id uuid NOT NULL
    REFERENCES gowm_history.historical_trajectory_revision(trajectory_revision_id),
  excluded_no integer NOT NULL CHECK (excluded_no > 0),
  exclusion_kind text NOT NULL CHECK (exclusion_kind = 'EXCLUDED_PAUSED_PHASE'),
  excluded_time tstzrange NOT NULL,
  interval_revision_id uuid NOT NULL,
  phase_no integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (trajectory_revision_id, excluded_no),
  FOREIGN KEY (interval_revision_id, phase_no)
    REFERENCES gowm_history.task_execution_phase(interval_revision_id, phase_no),
  CHECK (NOT isempty(excluded_time))
);

CREATE INDEX historical_trajectory_excluded_time_gist_idx
  ON gowm_history.historical_trajectory_excluded_period USING gist(excluded_time);

CREATE TABLE gowm_history.historical_trajectory_input (
  trajectory_revision_id uuid NOT NULL
    REFERENCES gowm_history.historical_trajectory_revision(trajectory_revision_id),
  input_no integer NOT NULL CHECK (input_no > 0),
  input_kind text NOT NULL CHECK (input_kind IN (
    'TASK_INTERVAL_REVISION','TASK_EVENT_SET','TRACKLET_VERSION',
    'TRACKLET_FINALIZATION_REVISION','TRACKLET_INPUT_SET','TIME_SOLUTION_SET',
    'WATERMARK_SET','METHOD_PROFILE','ANALYSIS_SPACE'
  )),
  resource_namespace text NOT NULL CHECK (resource_namespace ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  resource_kind text NOT NULL CHECK (resource_kind ~ '^[A-Z][A-Z0-9_]{1,127}$'),
  resource_id text NOT NULL CHECK (length(btrim(resource_id)) BETWEEN 1 AND 256),
  resource_version text NOT NULL CHECK (length(btrim(resource_version)) BETWEEN 1 AND 128),
  resource_content_hash text
    CHECK (resource_content_hash IS NULL OR resource_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  pinning text NOT NULL CHECK (pinning = 'PINNED'),
  authority text NOT NULL CHECK (length(btrim(authority)) BETWEEN 1 AND 128),
  analysis_input_no integer CHECK (analysis_input_no IS NULL OR analysis_input_no > 0),
  analysis_input_set_kind text
    CHECK (analysis_input_set_kind IS NULL OR analysis_input_set_kind ~ '^[A-Z][A-Z0-9_]{1,127}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (trajectory_revision_id, input_no),
  UNIQUE (trajectory_revision_id, input_kind, resource_namespace, resource_kind, resource_id),
  CHECK (num_nonnulls(analysis_input_no, analysis_input_set_kind) = 1)
);

CREATE INDEX historical_trajectory_input_resource_idx
  ON gowm_history.historical_trajectory_input(
    resource_namespace, resource_kind, resource_id, resource_version,
    trajectory_revision_id
  );

CREATE TABLE gowm_history.historical_trajectory_head (
  historical_trajectory_id uuid PRIMARY KEY
    REFERENCES gowm_history.historical_trajectory(historical_trajectory_id),
  current_revision_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (current_revision_id, historical_trajectory_id)
    REFERENCES gowm_history.historical_trajectory_revision(
      trajectory_revision_id, historical_trajectory_id
    )
);

CREATE TABLE gowm_history.historical_trajectory_outcome (
  outcome_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),
  subject_reference_key text NOT NULL REFERENCES public.world_reference_identity(reference_key),
  interval_reference_key text NOT NULL REFERENCES public.world_reference_identity(reference_key),
  phase_scope text NOT NULL CHECK (phase_scope IN ('EXECUTION_ENVELOPE','ACTIVE_PHASES_ONLY')),
  semantic_request_hash text NOT NULL CHECK (semantic_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  outcome_revision_no integer NOT NULL CHECK (outcome_revision_no > 0),
  outcome_status text NOT NULL CHECK (outcome_status IN (
    'AVAILABLE','NO_DATA','PARTIAL','INDETERMINATE','PENDING','FAILED'
  )),
  reason_code text NOT NULL CHECK (reason_code IN (
    'TRAJECTORY_AVAILABLE','TASK_INTERVAL_UNAVAILABLE','TRACKLET_NOT_FOUND',
    'SOURCE_SELECTION_REQUIRED','ENTITY_BINDING_AMBIGUOUS',
    'MULTIPLE_TRACKLETS_AMBIGUOUS','ANALYSIS_SPACE_MISMATCH',
    'PARTIAL_TIME_COVERAGE','TRAJECTORY_GAP','OPEN_EXECUTION',
    'PROJECTION_PENDING','RESOURCE_MISSING','SCHEMA_MISMATCH'
  )),
  reason_codes text[] NOT NULL CHECK (cardinality(reason_codes) > 0),
  projection_pending boolean NOT NULL DEFAULT false,
  analysis_id uuid REFERENCES public.analysis_record(analysis_id),
  evaluated_as_of timestamptz NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    data_scope_key, subject_reference_key, interval_reference_key, phase_scope,
    semantic_request_hash, outcome_revision_no
  ),
  UNIQUE (
    data_scope_key, subject_reference_key, interval_reference_key, phase_scope,
    semantic_request_hash, content_hash
  ),
  CHECK (reason_code = ANY(reason_codes)),
  CHECK (projection_pending = (reason_code = 'PROJECTION_PENDING'))
);

CREATE INDEX historical_trajectory_outcome_as_of_idx
  ON gowm_history.historical_trajectory_outcome(
    data_scope_key, subject_reference_key, interval_reference_key, phase_scope,
    semantic_request_hash, created_at DESC, outcome_revision_no DESC
  );

CREATE TABLE gowm_history.historical_trajectory_projection_queue (
  queue_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),
  subject_reference_key text NOT NULL REFERENCES public.world_reference_identity(reference_key),
  interval_reference_key text NOT NULL REFERENCES public.world_reference_identity(reference_key),
  interval_revision_no integer NOT NULL CHECK (interval_revision_no > 0),
  phase_scope text NOT NULL CHECK (phase_scope IN (
    'EXECUTION_ENVELOPE','ACTIVE_PHASES_ONLY'
  )),
  semantic_request_hash text NOT NULL CHECK (semantic_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL,
  query_payload jsonb NOT NULL CHECK (jsonb_typeof(query_payload) = 'object'),
  requested_snapshot jsonb NOT NULL CHECK (jsonb_typeof(requested_snapshot) = 'object'),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
    'QUEUED','RUNNING','COMPLETED','FAILED'
  )),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  lease_until timestamptz,
  locked_by text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  trajectory_revision_id uuid
    REFERENCES gowm_history.historical_trajectory_revision(trajectory_revision_id),
  outcome_id uuid REFERENCES gowm_history.historical_trajectory_outcome(outcome_id),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (data_scope_key, request_hash),
  CHECK ((state = 'RUNNING') = (
    locked_by IS NOT NULL AND locked_at IS NOT NULL AND lease_until IS NOT NULL
  )),
  CHECK (lease_until IS NULL OR locked_at IS NULL OR lease_until > locked_at),
  CHECK (
    (state = 'COMPLETED' AND processed_at IS NOT NULL
      AND num_nonnulls(trajectory_revision_id, outcome_id) = 1)
    OR
    (state <> 'COMPLETED' AND processed_at IS NULL
      AND num_nonnulls(trajectory_revision_id, outcome_id) = 0)
  )
);

CREATE INDEX historical_trajectory_projection_queue_claim_idx
  ON gowm_history.historical_trajectory_projection_queue(
    available_at, created_at, queue_id
  )
  WHERE state IN ('QUEUED','FAILED','RUNNING');
CREATE INDEX historical_trajectory_projection_queue_request_idx
  ON gowm_history.historical_trajectory_projection_queue(
    data_scope_key, subject_reference_key, interval_reference_key,
    phase_scope, semantic_request_hash, captured_at DESC
  );

CREATE TRIGGER historical_trajectory_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.historical_trajectory
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();
CREATE TRIGGER historical_trajectory_revision_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.historical_trajectory_revision
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();
CREATE TRIGGER historical_trajectory_segment_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.historical_trajectory_segment
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();
CREATE TRIGGER historical_trajectory_gap_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.historical_trajectory_gap
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();
CREATE TRIGGER historical_trajectory_excluded_period_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.historical_trajectory_excluded_period
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();
CREATE TRIGGER historical_trajectory_input_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.historical_trajectory_input
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();
CREATE TRIGGER historical_trajectory_outcome_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.historical_trajectory_outcome
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();

CREATE FUNCTION gowm_history.protect_historical_trajectory_head_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF current_setting('gowm.history_projection_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'historical trajectory head is projection-owned'
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

CREATE TRIGGER historical_trajectory_head_projection_owned
  BEFORE INSERT OR UPDATE OR DELETE ON gowm_history.historical_trajectory_head
  FOR EACH ROW EXECUTE FUNCTION gowm_history.protect_historical_trajectory_head_write();

CREATE FUNCTION gowm_history.protect_historical_trajectory_projection_queue_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'historical trajectory projection queue evidence cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY[
        'state','generation','available_at','locked_at','lease_until','locked_by',
        'attempts','trajectory_revision_id','outcome_id','processed_at','last_error'
      ]) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'state','generation','available_at','locked_at','lease_until','locked_by',
        'attempts','trajectory_revision_id','outcome_id','processed_at','last_error'
      ]) THEN
    RAISE EXCEPTION 'historical trajectory projection queue request is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER historical_trajectory_projection_queue_payload_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.historical_trajectory_projection_queue
  FOR EACH ROW EXECUTE FUNCTION gowm_history.protect_historical_trajectory_projection_queue_payload();

CREATE FUNCTION gowm_history.enqueue_historical_trajectory_projection(
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
        WHERE identity.reference_key = snapshot_resource->>'resourceId'
          AND identity.entity_kind = 'TASK_EXECUTION_INTERVAL';
      WHEN 'TRACKLET_VERSION' THEN
        SELECT tracklet.data_scope_key
        INTO snapshot_resource_scope
        FROM public.mobility_tracklet_version version
        JOIN public.mobility_tracklet tracklet USING (tracklet_id)
        WHERE version.tracklet_version_id = (snapshot_resource->>'resourceId')::uuid;
      WHEN 'TRACKLET_FINALIZATION' THEN
        SELECT tracklet.data_scope_key
        INTO snapshot_resource_scope
        FROM gowm_history.tracklet_finalization_revision finalization
        JOIN public.mobility_tracklet_version version USING (tracklet_version_id)
        JOIN public.mobility_tracklet tracklet USING (tracklet_id)
        WHERE finalization.finalization_revision_id =
              (snapshot_resource->>'resourceId')::uuid;
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

CREATE FUNCTION gowm_history.claim_historical_trajectory_projection(
  p_worker_id text,
  p_batch_size integer DEFAULT 100,
  p_lease interval DEFAULT interval '30 seconds'
)
RETURNS SETOF gowm_history.historical_trajectory_projection_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
BEGIN
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 128
     OR p_batch_size NOT BETWEEN 1 AND 1000
     OR p_lease <= interval '0'
     OR p_lease > interval '15 minutes' THEN
    RAISE EXCEPTION 'historical trajectory projection claim is invalid'
      USING ERRCODE = '22023';
  END IF;

  WITH exhausted AS (
    SELECT queue.queue_id
    FROM gowm_history.historical_trajectory_projection_queue queue
    WHERE queue.state = 'RUNNING'
      AND queue.lease_until <= clock_timestamp()
      AND queue.attempts >= 10
    FOR UPDATE SKIP LOCKED
  )
  UPDATE gowm_history.historical_trajectory_projection_queue queue
  SET state = 'FAILED',
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      last_error = COALESCE(queue.last_error, 'historical trajectory projection retry budget exhausted')
  FROM exhausted
  WHERE queue.queue_id = exhausted.queue_id;

  RETURN QUERY
  WITH candidates AS (
    SELECT queue.queue_id
    FROM gowm_history.historical_trajectory_projection_queue queue
    WHERE queue.available_at <= clock_timestamp()
      AND queue.attempts < 10
      AND (
        queue.state IN ('QUEUED','FAILED')
        OR (queue.state = 'RUNNING' AND queue.lease_until <= clock_timestamp())
      )
    ORDER BY queue.available_at, queue.created_at, queue.queue_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE gowm_history.historical_trajectory_projection_queue queue
  SET state = 'RUNNING',
      generation = queue.generation + 1,
      attempts = queue.attempts + 1,
      locked_at = clock_timestamp(),
      lease_until = clock_timestamp() + p_lease,
      locked_by = p_worker_id,
      trajectory_revision_id = NULL,
      outcome_id = NULL,
      processed_at = NULL
  FROM candidates
  WHERE queue.queue_id = candidates.queue_id
  RETURNING queue.*;
END
$fn$;

CREATE FUNCTION gowm_history.complete_historical_trajectory_projection(
  p_queue_id uuid,
  p_worker_id text,
  p_generation bigint,
  p_trajectory_revision_id uuid,
  p_outcome_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  projection_record gowm_history.historical_trajectory_projection_queue%ROWTYPE;
BEGIN
  IF num_nonnulls(p_trajectory_revision_id, p_outcome_id) <> 1 THEN
    RAISE EXCEPTION 'historical trajectory completion requires exactly one result'
      USING ERRCODE = '22023';
  END IF;

  SELECT queue.*
  INTO projection_record
  FROM gowm_history.historical_trajectory_projection_queue queue
  WHERE queue.queue_id = p_queue_id
  FOR UPDATE;
  IF NOT FOUND
     OR projection_record.state <> 'RUNNING'
     OR projection_record.locked_by IS DISTINCT FROM p_worker_id
     OR projection_record.generation <> p_generation
     OR projection_record.lease_until <= clock_timestamp() THEN
    RETURN false;
  END IF;

  IF p_trajectory_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM gowm_history.historical_trajectory_revision revision
    JOIN gowm_history.historical_trajectory trajectory USING (historical_trajectory_id)
    JOIN gowm_history.task_execution_interval interval USING (interval_id)
    JOIN gowm_history.task_execution_interval_revision interval_revision
      ON interval_revision.interval_revision_id = revision.interval_revision_id
    WHERE revision.trajectory_revision_id = p_trajectory_revision_id
      AND trajectory.data_scope_key = projection_record.data_scope_key
      AND trajectory.subject_reference_key = projection_record.subject_reference_key
      AND interval.reference_key = projection_record.interval_reference_key
      AND interval_revision.revision_no = projection_record.interval_revision_no
      AND trajectory.phase_scope = projection_record.phase_scope
      AND trajectory.semantic_request_hash = projection_record.semantic_request_hash
      AND revision.created_at > projection_record.captured_at
  ) THEN
    RAISE EXCEPTION 'historical trajectory completion result conflicts with queued request'
      USING ERRCODE = '23514';
  END IF;

  IF p_outcome_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM gowm_history.historical_trajectory_outcome outcome
    WHERE outcome.outcome_id = p_outcome_id
      AND outcome.data_scope_key = projection_record.data_scope_key
      AND outcome.subject_reference_key = projection_record.subject_reference_key
      AND outcome.interval_reference_key = projection_record.interval_reference_key
      AND outcome.phase_scope = projection_record.phase_scope
      AND outcome.semantic_request_hash = projection_record.semantic_request_hash
      AND outcome.evaluated_as_of = projection_record.captured_at
      AND outcome.created_at > projection_record.captured_at
  ) THEN
    RAISE EXCEPTION 'historical trajectory outcome conflicts with queued request'
      USING ERRCODE = '23514';
  END IF;

  UPDATE gowm_history.historical_trajectory_projection_queue queue
  SET state = 'COMPLETED',
      trajectory_revision_id = p_trajectory_revision_id,
      outcome_id = p_outcome_id,
      processed_at = clock_timestamp(),
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      last_error = NULL
  WHERE queue.queue_id = p_queue_id;
  RETURN true;
END
$fn$;

CREATE FUNCTION gowm_history.fail_historical_trajectory_projection(
  p_queue_id uuid,
  p_worker_id text,
  p_generation bigint,
  p_error text,
  p_retry_at timestamptz DEFAULT clock_timestamp()
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  changed integer;
BEGIN
  UPDATE gowm_history.historical_trajectory_projection_queue queue
  SET state = 'FAILED',
      available_at = greatest(COALESCE(p_retry_at, clock_timestamp()), clock_timestamp()),
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      trajectory_revision_id = NULL,
      outcome_id = NULL,
      processed_at = NULL,
      last_error = left(COALESCE(p_error, 'historical trajectory projection failed'), 2048)
  WHERE queue.queue_id = p_queue_id
    AND queue.state = 'RUNNING'
    AND queue.locked_by = p_worker_id
    AND queue.generation = p_generation
    AND queue.lease_until > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$fn$;

CREATE FUNCTION gowm_history.record_historical_trajectory_outcome(
  p_data_scope_key text,
  p_subject_reference_key text,
  p_interval_reference_key text,
  p_phase_scope text,
  p_semantic_request_hash text,
  p_outcome_status text,
  p_reason_code text,
  p_reason_codes text[],
  p_projection_pending boolean,
  p_analysis_id uuid,
  p_evaluated_as_of timestamptz,
  p_content_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  subject_scope text;
  interval_scope text;
  interval_kind text;
  analysis_scope text;
  existing_id uuid;
  next_revision integer;
  result_id uuid;
BEGIN
  SELECT identity.data_scope_key
  INTO STRICT subject_scope
  FROM public.world_reference_identity identity
  WHERE identity.reference_key = p_subject_reference_key;
  SELECT identity.data_scope_key, identity.entity_kind
  INTO STRICT interval_scope, interval_kind
  FROM public.world_reference_identity identity
  WHERE identity.reference_key = p_interval_reference_key;
  IF subject_scope IS DISTINCT FROM p_data_scope_key
     OR interval_scope IS DISTINCT FROM p_data_scope_key
     OR interval_kind <> 'TASK_EXECUTION_INTERVAL' THEN
    RAISE EXCEPTION 'historical trajectory outcome references are cross-scope or incompatible'
      USING ERRCODE = '42501';
  END IF;

  IF p_analysis_id IS NOT NULL THEN
    SELECT analysis.data_scope_key
    INTO STRICT analysis_scope
    FROM public.analysis_record analysis
    WHERE analysis.analysis_id = p_analysis_id;
    IF analysis_scope IS DISTINCT FROM p_data_scope_key THEN
      RAISE EXCEPTION 'historical trajectory outcome analysis crosses data scope'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_data_scope_key || E'\u001f' || p_subject_reference_key || E'\u001f' ||
    p_interval_reference_key || E'\u001f' || p_phase_scope || E'\u001f' ||
    p_semantic_request_hash,
    0
  ));

  SELECT outcome.outcome_id
  INTO existing_id
  FROM gowm_history.historical_trajectory_outcome outcome
  WHERE outcome.data_scope_key = p_data_scope_key
    AND outcome.subject_reference_key = p_subject_reference_key
    AND outcome.interval_reference_key = p_interval_reference_key
    AND outcome.phase_scope = p_phase_scope
    AND outcome.semantic_request_hash = p_semantic_request_hash
    AND outcome.content_hash = p_content_hash;
  IF FOUND THEN
    RETURN existing_id;
  END IF;

  SELECT COALESCE(max(outcome.outcome_revision_no), 0) + 1
  INTO next_revision
  FROM gowm_history.historical_trajectory_outcome outcome
  WHERE outcome.data_scope_key = p_data_scope_key
    AND outcome.subject_reference_key = p_subject_reference_key
    AND outcome.interval_reference_key = p_interval_reference_key
    AND outcome.phase_scope = p_phase_scope
    AND outcome.semantic_request_hash = p_semantic_request_hash;

  INSERT INTO gowm_history.historical_trajectory_outcome(
    data_scope_key, subject_reference_key, interval_reference_key, phase_scope,
    semantic_request_hash, outcome_revision_no, outcome_status, reason_code,
    reason_codes, projection_pending, analysis_id, evaluated_as_of, content_hash
  ) VALUES (
    p_data_scope_key, p_subject_reference_key, p_interval_reference_key,
    p_phase_scope, p_semantic_request_hash, next_revision, p_outcome_status,
    p_reason_code, p_reason_codes, p_projection_pending, p_analysis_id,
    p_evaluated_as_of, p_content_hash
  ) RETURNING outcome_id INTO result_id;
  RETURN result_id;
END
$fn$;

CREATE FUNCTION gowm_history.register_historical_trajectory_revision(
  p_data_scope_key text,
  p_subject_reference_key text,
  p_interval_id uuid,
  p_phase_scope text,
  p_source_selection_kind text,
  p_selected_source_key text,
  p_selected_tracker_session_key text,
  p_analysis_space_key text,
  p_semantic_request_hash text,
  p_interval_revision_id uuid,
  p_trajectory tgeompoint,
  p_extent_box stbox,
  p_requested_time tstzmultirange,
  p_defined_time tstzmultirange,
  p_start_event_time timestamptz,
  p_end_event_time timestamptz,
  p_sample_count integer,
  p_sequence_count integer,
  p_gap_count integer,
  p_temporal_coverage_ratio double precision,
  p_prefix_complete boolean,
  p_suffix_complete boolean,
  p_finalization_state text,
  p_input_set_hash text,
  p_profile_key text,
  p_profile_version text,
  p_profile_hash text,
  p_content_hash text,
  p_analysis_id uuid,
  p_supersedes_revision_id uuid,
  p_segments jsonb,
  p_gaps jsonb,
  p_excluded_periods jsonb,
  p_resource_inputs jsonb,
  p_input_sets jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  subject_scope text;
  interval_record gowm_history.task_execution_interval%ROWTYPE;
  interval_revision_record gowm_history.task_execution_interval_revision%ROWTYPE;
  profile_record gowm_history.method_profile%ROWTYPE;
  analysis_scope text;
  analysis_captured_at timestamptz;
  history_record gowm_history.historical_trajectory%ROWTYPE;
  current_revision uuid;
  existing_revision uuid;
  next_revision integer;
  new_revision uuid := gen_random_uuid();
  new_reference text;
  new_world_version bigint := nextval('public.world_version_seq');
  segment_row jsonb;
  gap_row jsonb;
  exclusion_row jsonb;
  input_row jsonb;
  set_row jsonb;
  next_input_no integer := 1;
  required_kind text;
  artifact_scope text;
  artifact_match_count integer;
BEGIN
  IF jsonb_typeof(p_segments) <> 'array'
     OR jsonb_typeof(p_gaps) <> 'array'
     OR jsonb_typeof(p_excluded_periods) <> 'array'
     OR jsonb_typeof(p_resource_inputs) <> 'array'
     OR jsonb_typeof(p_input_sets) <> 'array' THEN
    RAISE EXCEPTION 'historical trajectory child and lineage inputs must be arrays'
      USING ERRCODE = '22023';
  END IF;

  SELECT identity.data_scope_key
  INTO STRICT subject_scope
  FROM public.world_reference_identity identity
  WHERE identity.reference_key = p_subject_reference_key;
  IF subject_scope IS DISTINCT FROM p_data_scope_key THEN
    RAISE EXCEPTION 'historical trajectory subject crosses data scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT interval.*
  INTO STRICT interval_record
  FROM gowm_history.task_execution_interval interval
  WHERE interval.interval_id = p_interval_id;
  IF interval_record.data_scope_key IS DISTINCT FROM p_data_scope_key THEN
    RAISE EXCEPTION 'historical trajectory interval crosses data scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT revision.*
  INTO STRICT interval_revision_record
  FROM gowm_history.task_execution_interval_revision revision
  WHERE revision.interval_revision_id = p_interval_revision_id
    AND revision.interval_id = p_interval_id;

  SELECT profile.*
  INTO STRICT profile_record
  FROM gowm_history.method_profile profile
  WHERE profile.profile_key = p_profile_key
    AND profile.profile_version = p_profile_version
    AND profile.profile_kind = 'TRAJECTORY_SELECTION';
  IF profile_record.content_hash IS DISTINCT FROM p_profile_hash THEN
    RAISE EXCEPTION 'historical trajectory profile hash is not pinned exactly'
      USING ERRCODE = '23514';
  END IF;

  SELECT analysis.data_scope_key, analysis.analysis_as_of
  INTO STRICT analysis_scope, analysis_captured_at
  FROM public.analysis_record analysis
  WHERE analysis.analysis_id = p_analysis_id
  FOR SHARE;
  IF analysis_scope IS DISTINCT FROM p_data_scope_key THEN
    RAISE EXCEPTION 'historical trajectory analysis crosses data scope'
      USING ERRCODE = '42501';
  END IF;
  IF interval_revision_record.created_at > analysis_captured_at
     OR profile_record.created_at > analysis_captured_at THEN
    RAISE EXCEPTION 'historical trajectory input was created after analysis captured-at'
      USING ERRCODE = '23514';
  END IF;

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

  FOR segment_row IN SELECT value FROM jsonb_array_elements(p_segments)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM public.mobility_tracklet_segment segment
      JOIN public.mobility_tracklet_version version
        ON version.tracklet_version_id = segment.tracklet_version_id
      JOIN public.mobility_tracklet tracklet USING (tracklet_id)
      WHERE segment.tracklet_version_id =
            (segment_row->>'sourceTrackletVersionId')::uuid
        AND segment.segment_no = (segment_row->>'sourceSegmentNo')::integer
        AND tracklet.data_scope_key = p_data_scope_key
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(p_resource_inputs) tracklet_input
          WHERE tracklet_input->>'inputKind' = 'TRACKLET_VERSION'
            AND (tracklet_input->>'resourceId')::uuid = segment.tracklet_version_id
            AND (tracklet_input->>'resourceVersion')::integer = version.version_no
        )
    ) THEN
      RAISE EXCEPTION 'historical trajectory segment crosses scope or is not pinned'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOR gap_row IN SELECT value FROM jsonb_array_elements(p_gaps)
  LOOP
    IF NULLIF(gap_row->>'sourceTrackletVersionId', '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.mobility_tracklet_gap gap
         JOIN public.mobility_tracklet_version version
           ON version.tracklet_version_id = gap.tracklet_version_id
         JOIN public.mobility_tracklet tracklet USING (tracklet_id)
         WHERE gap.tracklet_version_id =
               (gap_row->>'sourceTrackletVersionId')::uuid
           AND gap.gap_no = (gap_row->>'sourceTrackletGapNo')::integer
           AND tracklet.data_scope_key = p_data_scope_key
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(p_resource_inputs) tracklet_input
             WHERE tracklet_input->>'inputKind' = 'TRACKLET_VERSION'
               AND (tracklet_input->>'resourceId')::uuid = gap.tracklet_version_id
               AND (tracklet_input->>'resourceVersion')::integer = version.version_no
           )
       ) THEN
      RAISE EXCEPTION 'historical trajectory gap crosses scope or is not pinned'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  FOREACH required_kind IN ARRAY ARRAY[
    'TASK_EVENT_SET','TRACKLET_INPUT_SET','TIME_SOLUTION_SET','WATERMARK_SET'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_input_sets) item
      WHERE item->>'inputSetKind' = required_kind
    ) THEN
      RAISE EXCEPTION 'historical trajectory input-set lineage is incomplete: %', required_kind
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF public.grounding_sha256(jsonb_build_object(
       'resources', p_resource_inputs,
       'sets', p_input_sets
     )::text) IS DISTINCT FROM p_input_set_hash THEN
    RAISE EXCEPTION 'historical trajectory input set hash mismatch'
      USING ERRCODE = '23514';
  END IF;

  IF p_finalization_state = 'SEALED' AND (
    interval_revision_record.lifecycle_state <> 'CLOSED'
    OR interval_revision_record.stability_state <> 'SEALED'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_resource_inputs) item
      LEFT JOIN gowm_history.tracklet_finalization_revision finalization
        ON finalization.finalization_revision_id = NULLIF(item->>'resourceId', '')::uuid
      WHERE item->>'inputKind' = 'TRACKLET_FINALIZATION_REVISION'
        AND COALESCE(finalization.finalization_state, '') <> 'SEALED'
    )
  ) THEN
    RAISE EXCEPTION 'historical trajectory cannot be sealed with provisional inputs'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_data_scope_key || E'\u001f' || p_subject_reference_key || E'\u001f' ||
    p_interval_id::text || E'\u001f' || p_phase_scope || E'\u001f' || p_semantic_request_hash,
    0
  ));

  SELECT trajectory_identity.*
  INTO history_record
  FROM gowm_history.historical_trajectory trajectory_identity
  WHERE trajectory_identity.data_scope_key = p_data_scope_key
    AND trajectory_identity.subject_reference_key = p_subject_reference_key
    AND trajectory_identity.interval_id = p_interval_id
    AND trajectory_identity.phase_scope = p_phase_scope
    AND trajectory_identity.semantic_request_hash = p_semantic_request_hash;

  IF NOT FOUND THEN
    history_record.historical_trajectory_id := gen_random_uuid();
    INSERT INTO public.world_reference_identity(entity_kind, internal_id, data_scope_key)
    VALUES (
      'HISTORICAL_TRAJECTORY', history_record.historical_trajectory_id::text,
      p_data_scope_key
    ) RETURNING reference_key INTO new_reference;

    INSERT INTO gowm_history.historical_trajectory(
      historical_trajectory_id, data_scope_key, reference_key, subject_reference_key,
      interval_id, phase_scope, source_selection_kind, selected_source_key,
      selected_tracker_session_key, analysis_space_key, semantic_request_hash
    ) VALUES (
      history_record.historical_trajectory_id, p_data_scope_key, new_reference,
      p_subject_reference_key, p_interval_id, p_phase_scope, p_source_selection_kind,
      p_selected_source_key, p_selected_tracker_session_key, p_analysis_space_key,
      p_semantic_request_hash
    ) RETURNING * INTO history_record;
  ELSIF history_record.source_selection_kind IS DISTINCT FROM p_source_selection_kind
     OR history_record.selected_source_key IS DISTINCT FROM p_selected_source_key
     OR history_record.selected_tracker_session_key IS DISTINCT FROM p_selected_tracker_session_key
     OR history_record.analysis_space_key IS DISTINCT FROM p_analysis_space_key THEN
    RAISE EXCEPTION 'historical trajectory semantic identity conflict'
      USING ERRCODE = '23505';
  END IF;

  SELECT revision.trajectory_revision_id
  INTO existing_revision
  FROM gowm_history.historical_trajectory_revision revision
  WHERE revision.historical_trajectory_id = history_record.historical_trajectory_id
    AND revision.content_hash = p_content_hash;
  IF FOUND THEN
    RETURN existing_revision;
  END IF;

  SELECT head.current_revision_id
  INTO current_revision
  FROM gowm_history.historical_trajectory_head head
  WHERE head.historical_trajectory_id = history_record.historical_trajectory_id
  FOR UPDATE;
  IF FOUND AND p_supersedes_revision_id IS DISTINCT FROM current_revision THEN
    RAISE EXCEPTION 'historical trajectory revision must supersede current head'
      USING ERRCODE = '40001';
  ELSIF NOT FOUND AND p_supersedes_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'first historical trajectory revision cannot supersede another revision'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(max(revision.revision_no), 0) + 1
  INTO next_revision
  FROM gowm_history.historical_trajectory_revision revision
  WHERE revision.historical_trajectory_id = history_record.historical_trajectory_id;

  INSERT INTO gowm_history.historical_trajectory_revision(
    trajectory_revision_id, historical_trajectory_id, revision_no,
    interval_revision_id, trajectory, extent_box, requested_time, defined_time,
    start_event_time, end_event_time, sample_count, sequence_count, gap_count,
    temporal_coverage_ratio, prefix_complete, suffix_complete, finalization_state,
    input_set_hash, profile_key, profile_version, profile_hash, world_version,
    content_hash, analysis_id, supersedes_revision_id
  ) VALUES (
    new_revision, history_record.historical_trajectory_id, next_revision,
    p_interval_revision_id, p_trajectory, p_extent_box, p_requested_time,
    p_defined_time, p_start_event_time, p_end_event_time, p_sample_count,
    p_sequence_count, p_gap_count, p_temporal_coverage_ratio,
    p_prefix_complete, p_suffix_complete, p_finalization_state, p_input_set_hash,
    p_profile_key, p_profile_version, p_profile_hash, new_world_version,
    p_content_hash, p_analysis_id, p_supersedes_revision_id
  );

  FOR segment_row IN SELECT value FROM jsonb_array_elements(p_segments)
  LOOP
    INSERT INTO gowm_history.historical_trajectory_segment(
      trajectory_revision_id, segment_no, source_tracklet_version_id,
      source_segment_no, interval_revision_id, phase_no, trajectory,
      sample_count, start_time, end_time
    ) VALUES (
      new_revision,
      (segment_row->>'segmentNo')::integer,
      (segment_row->>'sourceTrackletVersionId')::uuid,
      (segment_row->>'sourceSegmentNo')::integer,
      p_interval_revision_id,
      NULLIF(segment_row->>'phaseNo', '')::integer,
      (segment_row->>'trajectory')::tgeompoint,
      (segment_row->>'sampleCount')::integer,
      (segment_row->>'startTime')::timestamptz,
      (segment_row->>'endTime')::timestamptz
    );
  END LOOP;

  FOR gap_row IN SELECT value FROM jsonb_array_elements(p_gaps)
  LOOP
    INSERT INTO gowm_history.historical_trajectory_gap(
      trajectory_revision_id, gap_no, gap_kind, gap_time,
      left_measurement_id, right_measurement_id, source_tracklet_version_id,
      source_tracklet_gap_no, reason_codes
    ) VALUES (
      new_revision,
      (gap_row->>'gapNo')::integer,
      gap_row->>'gapKind',
      (gap_row->>'gapTime')::tstzrange,
      NULLIF(gap_row->>'leftMeasurementId', '')::uuid,
      NULLIF(gap_row->>'rightMeasurementId', '')::uuid,
      NULLIF(gap_row->>'sourceTrackletVersionId', '')::uuid,
      NULLIF(gap_row->>'sourceTrackletGapNo', '')::integer,
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(gap_row->'reasonCodes')), '{}')
    );
  END LOOP;

  FOR exclusion_row IN SELECT value FROM jsonb_array_elements(p_excluded_periods)
  LOOP
    INSERT INTO gowm_history.historical_trajectory_excluded_period(
      trajectory_revision_id, excluded_no, exclusion_kind, excluded_time,
      interval_revision_id, phase_no
    ) VALUES (
      new_revision,
      (exclusion_row->>'excludedNo')::integer,
      exclusion_row->>'exclusionKind',
      (exclusion_row->>'excludedTime')::tstzrange,
      p_interval_revision_id,
      (exclusion_row->>'phaseNo')::integer
    );
  END LOOP;

  FOR input_row IN SELECT value FROM jsonb_array_elements(p_resource_inputs)
  LOOP
    PERFORM public.register_analysis_resource_input(
      p_analysis_id,
      (input_row->>'analysisInputNo')::integer,
      input_row->>'inputRole',
      input_row->>'resourceNamespace',
      input_row->>'resourceKind',
      input_row->>'resourceId',
      input_row->>'resourceVersion',
      NULLIF(input_row->>'resourceContentHash', ''),
      NULLIF(input_row->>'resourceWorldVersion', '')::bigint,
      'PINNED',
      input_row->>'authority',
      NULLIF(input_row->>'worldReferenceKey', ''),
      NULLIF(input_row->>'sourceAnalysisId', '')::uuid
    );

    INSERT INTO gowm_history.historical_trajectory_input(
      trajectory_revision_id, input_no, input_kind, resource_namespace,
      resource_kind, resource_id, resource_version, resource_content_hash,
      pinning, authority, analysis_input_no
    ) VALUES (
      new_revision,
      next_input_no,
      input_row->>'inputKind',
      input_row->>'resourceNamespace',
      input_row->>'resourceKind',
      input_row->>'resourceId',
      input_row->>'resourceVersion',
      NULLIF(input_row->>'resourceContentHash', ''),
      'PINNED',
      input_row->>'authority',
      (input_row->>'analysisInputNo')::integer
    );
    next_input_no := next_input_no + 1;
  END LOOP;

  FOR set_row IN SELECT value FROM jsonb_array_elements(p_input_sets)
  LOOP
    IF NULLIF(set_row->>'manifestArtifactRef', '') IS NOT NULL THEN
      SELECT count(*)::integer, min(reference.data_scope_key)
      INTO artifact_match_count, artifact_scope
      FROM public.world_query_artifact artifact
      JOIN public.world_query_result_reference reference USING (result_reference_id)
      WHERE artifact.artifact_ref = set_row->>'manifestArtifactRef';

      IF artifact_match_count = 0 THEN
        RAISE EXCEPTION 'historical trajectory input artifact is unavailable'
          USING ERRCODE = '23503';
      END IF;
      IF artifact_match_count <> 1 THEN
        RAISE EXCEPTION 'historical trajectory input artifact identity is ambiguous'
          USING ERRCODE = '23514';
      END IF;
      IF artifact_scope IS DISTINCT FROM p_data_scope_key THEN
        RAISE EXCEPTION 'historical trajectory input artifact crosses data scope'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    PERFORM public.register_analysis_input_set(
      p_analysis_id,
      set_row->>'inputSetKind',
      (set_row->>'itemCount')::bigint,
      set_row->>'itemSetDigest',
      NULLIF(set_row->>'manifestArtifactRef', ''),
      set_row->>'authority'
    );

    INSERT INTO gowm_history.historical_trajectory_input(
      trajectory_revision_id, input_no, input_kind, resource_namespace,
      resource_kind, resource_id, resource_version, resource_content_hash,
      pinning, authority, analysis_input_set_kind
    ) VALUES (
      new_revision,
      next_input_no,
      set_row->>'inputSetKind',
      'gowm.analysis',
      set_row->>'inputSetKind',
      p_analysis_id::text,
      set_row->>'itemSetDigest',
      set_row->>'itemSetDigest',
      'PINNED',
      set_row->>'authority',
      set_row->>'inputSetKind'
    );
    next_input_no := next_input_no + 1;
  END LOOP;

  IF (SELECT count(*) FROM gowm_history.historical_trajectory_segment
      WHERE trajectory_revision_id = new_revision) <> p_sequence_count
     OR (SELECT count(*) FROM gowm_history.historical_trajectory_gap
         WHERE trajectory_revision_id = new_revision) <> p_gap_count
     OR (SELECT COALESCE(sum(segment.sample_count), 0)
         FROM gowm_history.historical_trajectory_segment segment
         WHERE segment.trajectory_revision_id = new_revision) <> p_sample_count THEN
    RAISE EXCEPTION 'historical trajectory child counts conflict with revision summary'
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('gowm.history_projection_write', 'on', true);
  INSERT INTO gowm_history.historical_trajectory_head(
    historical_trajectory_id, current_revision_id
  ) VALUES (
    history_record.historical_trajectory_id, new_revision
  ) ON CONFLICT (historical_trajectory_id) DO UPDATE
    SET current_revision_id = EXCLUDED.current_revision_id,
        updated_at = clock_timestamp();
  PERFORM set_config('gowm.history_projection_write', 'off', true);

  INSERT INTO public.world_reference_descriptor_version(
    reference_key, data_scope_key, reference_type, display_name,
    object_version, world_version, provenance, content_hash
  ) VALUES (
    history_record.reference_key,
    p_data_scope_key,
    'HISTORICAL_TRAJECTORY',
    'Historical trajectory for ' || p_subject_reference_key,
    next_revision::text,
    new_world_version,
    jsonb_build_array(jsonb_build_object(
      'authority', 'gowm.history',
      'trajectoryRevisionId', new_revision,
      'analysisId', p_analysis_id,
      'inputSetHash', p_input_set_hash
    )),
    public.grounding_sha256(
      history_record.reference_key || ':' || next_revision::text || ':' || p_content_hash
    )
  );

  RETURN new_revision;
END
$fn$;

CREATE VIEW gowm_history_v1.historical_trajectory_effective
WITH (security_barrier = true)
AS
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
JOIN gowm_history.historical_trajectory_head head USING (historical_trajectory_id)
JOIN gowm_history.historical_trajectory_revision revision
  ON revision.trajectory_revision_id = head.current_revision_id
WHERE identity.data_scope_key = gowm_history_v1.current_data_scope_key();

CREATE VIEW gowm_history_v1.historical_trajectory_segment
WITH (security_barrier = true)
AS
SELECT
  segment.trajectory_revision_id,
  segment.segment_no,
  segment.source_tracklet_version_id,
  segment.source_segment_no,
  segment.interval_revision_id,
  segment.phase_no,
  segment.trajectory,
  segment.sample_count,
  segment.start_time,
  segment.end_time
FROM gowm_history.historical_trajectory_segment segment
JOIN gowm_history.historical_trajectory_revision revision USING (trajectory_revision_id)
JOIN gowm_history.historical_trajectory identity USING (historical_trajectory_id)
WHERE identity.data_scope_key = gowm_history_v1.current_data_scope_key();

CREATE VIEW gowm_history_v1.historical_trajectory_gap
WITH (security_barrier = true)
AS
SELECT
  gap.trajectory_revision_id,
  gap.gap_no,
  gap.gap_kind,
  gap.gap_time,
  gap.left_measurement_id,
  gap.right_measurement_id,
  gap.source_tracklet_version_id,
  gap.source_tracklet_gap_no,
  gap.reason_codes
FROM gowm_history.historical_trajectory_gap gap
JOIN gowm_history.historical_trajectory_revision revision USING (trajectory_revision_id)
JOIN gowm_history.historical_trajectory identity USING (historical_trajectory_id)
WHERE identity.data_scope_key = gowm_history_v1.current_data_scope_key();

CREATE VIEW gowm_history_v1.historical_trajectory_excluded_period
WITH (security_barrier = true)
AS
SELECT
  excluded.trajectory_revision_id,
  excluded.excluded_no,
  excluded.exclusion_kind,
  excluded.excluded_time,
  excluded.interval_revision_id,
  excluded.phase_no
FROM gowm_history.historical_trajectory_excluded_period excluded
JOIN gowm_history.historical_trajectory_revision revision USING (trajectory_revision_id)
JOIN gowm_history.historical_trajectory identity USING (historical_trajectory_id)
WHERE identity.data_scope_key = gowm_history_v1.current_data_scope_key();

CREATE VIEW gowm_history_v1.historical_trajectory_input
WITH (security_barrier = true)
AS
SELECT
  input.trajectory_revision_id,
  input.input_no,
  input.input_kind,
  input.resource_namespace,
  input.resource_kind,
  input.resource_id,
  input.resource_version,
  input.resource_content_hash,
  input.pinning,
  input.authority,
  input.analysis_input_no,
  input.analysis_input_set_kind
FROM gowm_history.historical_trajectory_input input
JOIN gowm_history.historical_trajectory_revision revision USING (trajectory_revision_id)
JOIN gowm_history.historical_trajectory identity USING (historical_trajectory_id)
WHERE identity.data_scope_key = gowm_history_v1.current_data_scope_key();

CREATE VIEW gowm_history_v1.historical_trajectory_outcome
WITH (security_barrier = true)
AS
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
WHERE outcome.data_scope_key = gowm_history_v1.current_data_scope_key();

CREATE FUNCTION gowm_history_v1.historical_trajectory_outcome_as_of(
  p_subject_reference_key text,
  p_interval_reference_key text,
  p_phase_scope text,
  p_semantic_request_hash text,
  p_captured_at timestamptz
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
  WHERE outcome.data_scope_key = gowm_history_v1.current_data_scope_key()
    AND outcome.subject_reference_key = p_subject_reference_key
    AND outcome.interval_reference_key = p_interval_reference_key
    AND outcome.phase_scope = p_phase_scope
    AND outcome.semantic_request_hash = p_semantic_request_hash
    AND outcome.created_at <= p_captured_at
  ORDER BY outcome.created_at DESC, outcome.outcome_revision_no DESC
  LIMIT 1
$fn$;

CREATE FUNCTION gowm_history_v1.historical_trajectory_as_of(
  p_subject_reference_key text,
  p_interval_reference_key text,
  p_phase_scope text,
  p_semantic_request_hash text,
  p_captured_at timestamptz,
  p_exact_revision_no integer DEFAULT NULL
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

CREATE FUNCTION gowm_history_v1.historical_trajectory_revision_by_reference_as_of(
  p_trajectory_reference_key text,
  p_exact_revision_no integer,
  p_captured_at timestamptz
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
  JOIN gowm_history.historical_trajectory_revision revision USING (historical_trajectory_id)
  WHERE identity.data_scope_key = gowm_history_v1.current_data_scope_key()
    AND identity.reference_key = p_trajectory_reference_key
    AND revision.revision_no = p_exact_revision_no
    AND revision.created_at <= p_captured_at
$fn$;

CREATE FUNCTION gowm_history.enforce_history_worker_analysis_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF current_user IN ('gowm_history_worker','gowm_history_worker_service') THEN
    IF current_setting('gowm.data_scope_key', true) IS NULL
       OR current_setting('gowm.data_scope_key', true) = ''
       OR NEW.data_scope_key IS DISTINCT FROM current_setting('gowm.data_scope_key', true)
       OR NEW.service_name <> 'gowm.historical-trace'
       OR NEW.tool_name <> 'history.get-trajectory'
       OR NEW.tool_version <> '1.0' THEN
      RAISE EXCEPTION 'history worker analysis write is outside its selected scope or contract'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER analysis_record_history_worker_scope
  BEFORE INSERT ON public.analysis_record
  FOR EACH ROW EXECUTE FUNCTION gowm_history.enforce_history_worker_analysis_scope();

CREATE OR REPLACE VIEW gowm_platform_validation_v1.world_reference_version
WITH (security_barrier = true)
AS
SELECT identity.reference_key,identity.entity_kind,descriptor.descriptor_version,
       CASE
         WHEN identity.entity_kind IN ('WORLD_OBJECT','SPATIAL_OBJECT')
          AND descriptor.object_version IS NOT NULL
          AND descriptor.object_version=COALESCE(state.version::text,spatial.version_no::text)
         THEN descriptor.descriptor_version::text
         ELSE COALESCE(state.version::text,spatial.version_no::text,descriptor.object_version,
                       CASE WHEN identity.entity_kind IN ('DATA_SCOPE','OPERATIONAL_TASK') THEN '1' END)
       END AS current_version,
       COALESCE(state.version::text,spatial.version_no::text,descriptor.object_version) AS object_version,
       COALESCE(state.version,descriptor.world_version) AS world_version,
       COALESCE(descriptor.valid_to,upper(spatial.valid_time),'infinity'::timestamptz) AS valid_to,
       COALESCE(state.updated_at,spatial.created_at,descriptor.created_at,identity.created_at) AS created_at,
       descriptor.stale,descriptor.revalidation_required,
       COALESCE(descriptor.content_hash,CASE WHEN state.object_id IS NOT NULL THEN
         'sha256:'||encode(digest(convert_to(state.state::text||':'||state.version::text,'UTF8'),'sha256'),'hex') END) AS content_hash,
       LEAST(retirement.retired_at,object.deleted_at) <= statement_timestamp() AS retired,
       descriptor.object_version AS descriptor_object_version
FROM public.world_reference_identity identity
LEFT JOIN public.world_reference_retirement retirement USING(reference_key)
LEFT JOIN public.world_object object ON identity.entity_kind='WORLD_OBJECT'
  AND object.id=identity.internal_id AND object.data_scope_key=identity.data_scope_key
LEFT JOIN public.world_object_state state ON state.object_id=object.id
LEFT JOIN LATERAL (
  SELECT version.* FROM public.spatial_object_version version
  JOIN public.spatial_object source USING(spatial_object_id)
  WHERE identity.entity_kind='SPATIAL_OBJECT' AND source.spatial_object_id::text=identity.internal_id
    AND source.data_scope_key=identity.data_scope_key
  ORDER BY version.version_no DESC LIMIT 1
) spatial ON true
LEFT JOIN LATERAL (
  SELECT version.* FROM public.world_reference_descriptor_version version
  WHERE version.reference_key=identity.reference_key AND version.data_scope_key=identity.data_scope_key
  ORDER BY version.descriptor_version DESC LIMIT 1
) descriptor ON true
WHERE identity.data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
  AND identity.entity_kind IN (
    'WORLD_OBJECT','SPATIAL_OBJECT','DATA_SCOPE','OPERATIONAL_TASK',
    'TASK_EXECUTION_INTERVAL','HISTORICAL_TRAJECTORY'
  );

REVOKE ALL ON ALL TABLES IN SCHEMA gowm_history, gowm_history_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_history, gowm_history_v1 FROM PUBLIC;

GRANT SELECT ON
  gowm_history_v1.historical_trajectory_effective,
  gowm_history_v1.historical_trajectory_segment,
  gowm_history_v1.historical_trajectory_gap,
  gowm_history_v1.historical_trajectory_excluded_period,
  gowm_history_v1.historical_trajectory_input,
  gowm_history_v1.historical_trajectory_outcome
TO gowm_history_reader;

GRANT EXECUTE ON FUNCTION gowm_history_v1.historical_trajectory_as_of(
  text, text, text, text, timestamptz, integer
) TO gowm_history_reader;
GRANT EXECUTE ON FUNCTION gowm_history_v1.historical_trajectory_revision_by_reference_as_of(
  text, integer, timestamptz
) TO gowm_history_reader;
GRANT EXECUTE ON FUNCTION gowm_history_v1.historical_trajectory_outcome_as_of(
  text, text, text, text, timestamptz
) TO gowm_history_reader;

GRANT EXECUTE ON FUNCTION gowm_history.register_historical_trajectory_revision(
  text, text, uuid, text, text, text, text, text, text, uuid, tgeompoint,
  stbox, tstzmultirange, tstzmultirange, timestamptz, timestamptz, integer,
  integer, integer, double precision, boolean, boolean, text, text, text, text,
  text, text, uuid, uuid, jsonb, jsonb, jsonb, jsonb, jsonb
) TO gowm_history_writer;
GRANT EXECUTE ON FUNCTION gowm_history.record_historical_trajectory_outcome(
  text, text, text, text, text, text, text, text[], boolean, uuid, timestamptz, text
) TO gowm_history_writer;

GRANT USAGE ON SCHEMA gowm_history TO gowm_history_service;
GRANT EXECUTE ON FUNCTION gowm_history.enqueue_historical_trajectory_projection(
  text, text, text, integer, text, text, text, timestamptz, jsonb, jsonb
) TO gowm_history_service;
GRANT EXECUTE ON FUNCTION gowm_history.claim_historical_trajectory_projection(
  text, integer, interval
) TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.complete_historical_trajectory_projection(
  uuid, text, bigint, uuid, uuid
) TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.fail_historical_trajectory_projection(
  uuid, text, bigint, text, timestamptz
) TO gowm_history_worker;

GRANT gowm_history_reader TO gowm_history_worker;
GRANT SELECT ON
  public.operational_task_event,
  public.world_reference_identity,
  public.world_observation,
  public.mobility_tracklet,
  public.mobility_tracklet_version,
  public.mobility_tracklet_segment,
  public.mobility_tracklet_gap,
  public.mobility_tracklet_input,
  public.entity_binding,
  public.analysis_space,
  public.measurement,
  public.observation_time_solution,
  public.pipeline_watermark_revision,
  public.analysis_record,
  gowm_history.method_profile,
  gowm_history.task_execution_interval,
  gowm_history.task_execution_interval_revision,
  gowm_history.task_execution_phase,
  gowm_history.task_execution_interval_input,
  gowm_history.task_execution_interval_head,
  gowm_history.task_interval_projection_queue,
  gowm_history.tracklet_projection_queue,
  gowm_history.tracklet_finalization_revision,
  gowm_history.tracklet_finalization_watermark_input,
  gowm_history.tracklet_finalization_head,
  gowm_history.historical_trajectory,
  gowm_history.historical_trajectory_revision,
  gowm_history.historical_trajectory_head,
  gowm_history.historical_trajectory_outcome
TO gowm_history_worker;
GRANT INSERT (
  data_scope_key, service_name, tool_name, tool_version, algorithm,
  algorithm_version, status, analysis_as_of, query_payload, result_payload,
  method_snapshot, snapshot_hash, supersedes_analysis_id
) ON public.analysis_record TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION public.grounding_sha256(text) TO gowm_history_worker;

COMMENT ON TABLE gowm_history.historical_trajectory_revision IS
  'Append-only, gap-preserving trajectory derived from exact interval, tracklet, finalization, watermark, profile, and analysis inputs.';
COMMENT ON TABLE gowm_history.historical_trajectory_excluded_period IS
  'Paused ACTIVE_PHASES_ONLY periods are explicit exclusions and are never counted as unknown gaps.';
COMMENT ON FUNCTION gowm_history_v1.historical_trajectory_as_of(
  text, text, text, text, timestamptz, integer
) IS
  'Stable semantic identity lookup. It ignores the mutable current head and enforces created_at <= capturedAt; exact revision pins never float.';
COMMENT ON TABLE gowm_history.historical_trajectory_outcome IS
  'Append-only replay-safe projection outcomes, including ambiguity and pending diagnoses when no trajectory revision exists.';
COMMENT ON FUNCTION gowm_history_v1.historical_trajectory_outcome_as_of(
  text, text, text, text, timestamptz
) IS
  'Returns the latest scoped outcome created at or before capturedAt for a stable historical request identity; no current head is consulted.';
COMMENT ON TABLE gowm_history.historical_trajectory_projection_queue IS
  'Controlled immutable request queue freezing the exact query and effective snapshot. Workers use bounded leases and generation fences; results become visible only to later capturedAt reads.';
COMMENT ON FUNCTION gowm_history.enqueue_historical_trajectory_projection(
  text, text, text, integer, text, text, text, timestamptz, jsonb, jsonb
) IS
  'Scope-first idempotent enqueue for one frozen historical trajectory request; no trajectory computation occurs in the Provider transaction.';

COMMIT;
