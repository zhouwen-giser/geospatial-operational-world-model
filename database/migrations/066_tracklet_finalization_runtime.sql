BEGIN;

CREATE TABLE gowm_history.tracklet_projection_queue (
  queue_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),
  source_key text NOT NULL,
  source_local_target_id text NOT NULL CHECK (length(btrim(source_local_target_id)) BETWEEN 1 AND 256),
  tracker_session_key text NOT NULL CHECK (length(btrim(tracker_session_key)) BETWEEN 1 AND 256),
  analysis_space_key text NOT NULL REFERENCES public.analysis_space(analysis_space_key),
  profile_key text NOT NULL REFERENCES public.tracklet_rule_profile(profile_key),
  desired_input_set_hash text NOT NULL CHECK (desired_input_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
    'QUEUED','RUNNING','COMPLETED','FAILED','SUPERSEDED'
  )),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  lease_until timestamptz,
  locked_by text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  rebuilt_tracklet_version_id uuid REFERENCES public.mobility_tracklet_version(tracklet_version_id),
  processed_at timestamptz,
  last_error text,
  superseded_by_input_set_hash text
    CHECK (superseded_by_input_set_hash IS NULL OR superseded_by_input_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    data_scope_key, source_key, source_local_target_id, tracker_session_key,
    analysis_space_key, profile_key, desired_input_set_hash
  ),
  FOREIGN KEY (source_key, data_scope_key)
    REFERENCES public.source_registry(source_key, data_scope_key),
  CHECK ((state = 'RUNNING') = (locked_by IS NOT NULL AND locked_at IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (lease_until IS NULL OR locked_at IS NULL OR lease_until > locked_at),
  CHECK ((state = 'COMPLETED') = (processed_at IS NOT NULL)),
  CHECK ((state = 'SUPERSEDED') = (superseded_by_input_set_hash IS NOT NULL)),
  CHECK (rebuilt_tracklet_version_id IS NULL OR state = 'COMPLETED')
);

CREATE INDEX tracklet_projection_queue_claim_idx
  ON gowm_history.tracklet_projection_queue(available_at, created_at, queue_id)
  WHERE state IN ('QUEUED','FAILED');
CREATE INDEX tracklet_projection_queue_dirty_key_idx
  ON gowm_history.tracklet_projection_queue(
    data_scope_key, source_key, source_local_target_id, tracker_session_key,
    analysis_space_key, profile_key, created_at DESC
  );

CREATE TABLE gowm_history.tracklet_finalization_revision (
  finalization_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracklet_version_id uuid NOT NULL REFERENCES public.mobility_tracklet_version(tracklet_version_id),
  revision_no integer NOT NULL CHECK (revision_no > 0),
  finalization_state text NOT NULL CHECK (finalization_state IN (
    'PROVISIONAL','SEALED','REOPENED','CONFLICTED'
  )),
  finalization_as_of timestamptz NOT NULL,
  observed_through timestamptz,
  profile_key text NOT NULL,
  profile_version text NOT NULL,
  profile_hash text NOT NULL CHECK (profile_hash ~ '^sha256:[0-9a-f]{64}$'),
  watermark_set_hash text NOT NULL CHECK (watermark_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason_codes text[] NOT NULL DEFAULT '{}',
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  supersedes_revision_id uuid
    REFERENCES gowm_history.tracklet_finalization_revision(finalization_revision_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tracklet_version_id, revision_no),
  UNIQUE (tracklet_version_id, content_hash),
  UNIQUE (finalization_revision_id, tracklet_version_id),
  FOREIGN KEY (profile_key, profile_version)
    REFERENCES gowm_history.method_profile(profile_key, profile_version),
  CHECK (supersedes_revision_id IS NULL OR supersedes_revision_id <> finalization_revision_id)
);

CREATE INDEX tracklet_finalization_revision_as_of_idx
  ON gowm_history.tracklet_finalization_revision(
    tracklet_version_id, created_at DESC, revision_no DESC
  );

CREATE TABLE gowm_history.tracklet_finalization_watermark_input (
  finalization_revision_id uuid NOT NULL
    REFERENCES gowm_history.tracklet_finalization_revision(finalization_revision_id),
  input_no integer NOT NULL CHECK (input_no > 0),
  datastream_key text NOT NULL REFERENCES public.datastream(datastream_key),
  watermark_revision_id uuid NOT NULL
    REFERENCES public.pipeline_watermark_revision(watermark_revision_id),
  closed_through_event_time timestamptz,
  allowed_lateness interval NOT NULL CHECK (allowed_lateness >= interval '0'),
  completeness_state text NOT NULL,
  watermark_created_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (finalization_revision_id, input_no),
  UNIQUE (finalization_revision_id, datastream_key),
  UNIQUE (finalization_revision_id, watermark_revision_id)
);

CREATE TABLE gowm_history.tracklet_finalization_head (
  tracklet_version_id uuid PRIMARY KEY REFERENCES public.mobility_tracklet_version(tracklet_version_id),
  current_finalization_revision_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (current_finalization_revision_id, tracklet_version_id)
    REFERENCES gowm_history.tracklet_finalization_revision(
      finalization_revision_id, tracklet_version_id
    )
);

CREATE TABLE gowm_history.tracklet_finalization_queue (
  queue_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracklet_version_id uuid NOT NULL REFERENCES public.mobility_tracklet_version(tracklet_version_id),
  desired_evidence_hash text NOT NULL CHECK (desired_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  finalization_as_of timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
    'QUEUED','RUNNING','COMPLETED','FAILED','SUPERSEDED'
  )),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  lease_until timestamptz,
  locked_by text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  finalization_revision_id uuid
    REFERENCES gowm_history.tracklet_finalization_revision(finalization_revision_id),
  processed_at timestamptz,
  last_error text,
  superseded_by_evidence_hash text
    CHECK (superseded_by_evidence_hash IS NULL OR superseded_by_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tracklet_version_id, desired_evidence_hash),
  CHECK ((state = 'RUNNING') = (locked_by IS NOT NULL AND locked_at IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (lease_until IS NULL OR locked_at IS NULL OR lease_until > locked_at),
  CHECK ((state = 'COMPLETED') = (processed_at IS NOT NULL)),
  CHECK ((state = 'SUPERSEDED') = (superseded_by_evidence_hash IS NOT NULL)),
  CHECK (finalization_revision_id IS NULL OR state = 'COMPLETED')
);

CREATE INDEX tracklet_finalization_queue_claim_idx
  ON gowm_history.tracklet_finalization_queue(available_at, created_at, queue_id)
  WHERE state IN ('QUEUED','FAILED');
CREATE INDEX tracklet_finalization_queue_version_idx
  ON gowm_history.tracklet_finalization_queue(tracklet_version_id, created_at DESC);

CREATE TRIGGER tracklet_finalization_revision_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.tracklet_finalization_revision
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();
CREATE TRIGGER tracklet_finalization_watermark_input_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.tracklet_finalization_watermark_input
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();

CREATE FUNCTION gowm_history.protect_tracklet_finalization_head_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF current_setting('gowm.history_projection_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'tracklet finalization head is projection-owned'
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

CREATE TRIGGER tracklet_finalization_head_projection_owned
  BEFORE INSERT OR UPDATE OR DELETE ON gowm_history.tracklet_finalization_head
  FOR EACH ROW EXECUTE FUNCTION gowm_history.protect_tracklet_finalization_head_write();

CREATE FUNCTION gowm_history.protect_tracklet_queue_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% evidence cannot be deleted', TG_TABLE_NAME USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'tracklet_projection_queue' THEN
    IF (to_jsonb(NEW) - ARRAY[
          'state','generation','available_at','locked_at','lease_until','locked_by','attempts',
          'rebuilt_tracklet_version_id','processed_at','last_error','superseded_by_input_set_hash'
        ]) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY[
          'state','generation','available_at','locked_at','lease_until','locked_by','attempts',
          'rebuilt_tracklet_version_id','processed_at','last_error','superseded_by_input_set_hash'
        ]) THEN
      RAISE EXCEPTION 'tracklet projection queue identity is immutable' USING ERRCODE = '55000';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - ARRAY[
          'state','generation','available_at','locked_at','lease_until','locked_by','attempts',
          'finalization_revision_id','processed_at','last_error','superseded_by_evidence_hash'
        ]) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY[
          'state','generation','available_at','locked_at','lease_until','locked_by','attempts',
          'finalization_revision_id','processed_at','last_error','superseded_by_evidence_hash'
        ]) THEN
      RAISE EXCEPTION 'tracklet finalization queue identity is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER tracklet_projection_queue_payload_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.tracklet_projection_queue
  FOR EACH ROW EXECUTE FUNCTION gowm_history.protect_tracklet_queue_payload();
CREATE TRIGGER tracklet_finalization_queue_payload_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.tracklet_finalization_queue
  FOR EACH ROW EXECUTE FUNCTION gowm_history.protect_tracklet_queue_payload();

CREATE FUNCTION gowm_history.enqueue_tracklet_projection(
  p_data_scope_key text,
  p_source_key text,
  p_source_local_target_id text,
  p_tracker_session_key text,
  p_analysis_space_key text,
  p_profile_key text,
  p_desired_input_set_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  result_id uuid;
BEGIN
  PERFORM 1
  FROM public.source_registry source
  JOIN public.analysis_space space ON space.analysis_space_key = p_analysis_space_key
  JOIN public.tracklet_rule_profile profile ON profile.profile_key = p_profile_key
  WHERE source.source_key = p_source_key
    AND source.data_scope_key = p_data_scope_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tracklet dirty key is unavailable or cross-scope'
      USING ERRCODE = '42501';
  END IF;

  UPDATE gowm_history.tracklet_projection_queue queue
  SET state = 'SUPERSEDED',
      superseded_by_input_set_hash = p_desired_input_set_hash,
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      last_error = NULL
  WHERE queue.data_scope_key = p_data_scope_key
    AND queue.source_key = p_source_key
    AND queue.source_local_target_id = p_source_local_target_id
    AND queue.tracker_session_key = p_tracker_session_key
    AND queue.analysis_space_key = p_analysis_space_key
    AND queue.profile_key = p_profile_key
    AND queue.desired_input_set_hash <> p_desired_input_set_hash
    AND queue.state IN ('QUEUED','FAILED');

  INSERT INTO gowm_history.tracklet_projection_queue(
    data_scope_key, source_key, source_local_target_id, tracker_session_key,
    analysis_space_key, profile_key, desired_input_set_hash
  ) VALUES (
    p_data_scope_key, p_source_key, p_source_local_target_id,
    p_tracker_session_key, p_analysis_space_key, p_profile_key,
    p_desired_input_set_hash
  ) ON CONFLICT (
    data_scope_key, source_key, source_local_target_id, tracker_session_key,
    analysis_space_key, profile_key, desired_input_set_hash
  ) DO UPDATE SET
    state = CASE
      WHEN gowm_history.tracklet_projection_queue.state = 'FAILED' THEN 'QUEUED'
      ELSE gowm_history.tracklet_projection_queue.state
    END,
    available_at = CASE
      WHEN gowm_history.tracklet_projection_queue.state = 'FAILED' THEN clock_timestamp()
      ELSE gowm_history.tracklet_projection_queue.available_at
    END,
    last_error = CASE
      WHEN gowm_history.tracklet_projection_queue.state = 'FAILED' THEN NULL
      ELSE gowm_history.tracklet_projection_queue.last_error
    END
  RETURNING queue_id INTO result_id;
  RETURN result_id;
END
$fn$;

CREATE FUNCTION gowm_history.enqueue_tracklet_projection_from_position()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  dirty record;
  desired_hash text;
BEGIN
  SELECT
    observation.data_scope_key,
    observation.source AS source_key,
    observation.source_local_target_id,
    COALESCE(observation.tracker_session_id, '__UNSCOPED__') AS tracker_session_key,
    NEW.analysis_space_key,
    measurement.time_solution_id,
    observation.observation_id
  INTO STRICT dirty
  FROM public.measurement measurement
  JOIN public.world_observation observation
    ON observation.observation_id = measurement.observation_id
  WHERE measurement.measurement_id = NEW.measurement_id;

  desired_hash := public.grounding_sha256(jsonb_build_array(
    dirty.data_scope_key,
    dirty.source_key,
    dirty.source_local_target_id,
    dirty.tracker_session_key,
    dirty.analysis_space_key,
    NEW.measurement_id,
    dirty.time_solution_id,
    dirty.observation_id,
    NEW.created_at
  )::text);

  PERFORM gowm_history.enqueue_tracklet_projection(
    dirty.data_scope_key,
    dirty.source_key,
    dirty.source_local_target_id,
    dirty.tracker_session_key,
    dirty.analysis_space_key,
    'source-local-default',
    desired_hash
  );
  RETURN NEW;
END
$fn$;

CREATE TRIGGER position_measurement_tracklet_dirty_queue
  AFTER INSERT ON public.position_measurement
  FOR EACH ROW EXECUTE FUNCTION gowm_history.enqueue_tracklet_projection_from_position();

CREATE FUNCTION gowm_history.claim_tracklet_projection(
  p_worker_id text,
  p_batch_size integer DEFAULT 100,
  p_lease interval DEFAULT interval '30 seconds'
)
RETURNS SETOF gowm_history.tracklet_projection_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
BEGIN
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 128
     OR p_batch_size NOT BETWEEN 1 AND 1000
     OR p_lease <= interval '0'
     OR p_lease > interval '15 minutes' THEN
    RAISE EXCEPTION 'tracklet claim request is invalid' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT queue.queue_id
    FROM gowm_history.tracklet_projection_queue queue
    WHERE queue.available_at <= clock_timestamp()
      AND (
        queue.state IN ('QUEUED','FAILED')
        OR (queue.state = 'RUNNING' AND queue.lease_until <= clock_timestamp())
      )
    ORDER BY queue.available_at, queue.created_at, queue.queue_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE gowm_history.tracklet_projection_queue queue
  SET state = 'RUNNING',
      generation = queue.generation + 1,
      attempts = queue.attempts + 1,
      locked_at = clock_timestamp(),
      lease_until = clock_timestamp() + p_lease,
      locked_by = p_worker_id,
      rebuilt_tracklet_version_id = NULL,
      processed_at = NULL,
      last_error = NULL
  FROM candidates
  WHERE queue.queue_id = candidates.queue_id
  RETURNING queue.*;
END
$fn$;

CREATE FUNCTION gowm_history.classify_tracklet_lineage(
  p_parent_version_id uuid,
  p_child_version_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  parent_profile_hash text;
  child_profile_hash text;
  parent_end timestamptz;
BEGIN
  SELECT profile.config_hash, version.end_event_time
  INTO STRICT parent_profile_hash, parent_end
  FROM public.mobility_tracklet_version version
  JOIN public.tracklet_rule_profile profile USING (profile_key)
  WHERE version.tracklet_version_id = p_parent_version_id;

  SELECT profile.config_hash
  INTO STRICT child_profile_hash
  FROM public.mobility_tracklet_version version
  JOIN public.tracklet_rule_profile profile USING (profile_key)
  WHERE version.tracklet_version_id = p_child_version_id;

  IF child_profile_hash IS DISTINCT FROM parent_profile_hash THEN
    RETURN 'RULE_CHANGE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.mobility_tracklet_input child_input
    JOIN public.observation_time_solution solution
      ON solution.time_solution_id = child_input.time_solution_id
    JOIN public.mobility_tracklet_input parent_input
      ON parent_input.tracklet_version_id = p_parent_version_id
     AND parent_input.time_solution_id = solution.supersedes_time_solution_id
    WHERE child_input.tracklet_version_id = p_child_version_id
  ) THEN
    RETURN 'CLOCK_CORRECTION';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.mobility_tracklet_input child_input
    JOIN public.observation_time_solution solution
      ON solution.time_solution_id = child_input.time_solution_id
    JOIN public.world_observation observation
      ON observation.observation_id = child_input.observation_id
    JOIN public.mobility_tracklet_version parent_version
      ON parent_version.tracklet_version_id = p_parent_version_id
    LEFT JOIN public.mobility_tracklet_input parent_input
      ON parent_input.tracklet_version_id = p_parent_version_id
     AND parent_input.measurement_id = child_input.measurement_id
    WHERE child_input.tracklet_version_id = p_child_version_id
      AND parent_input.measurement_id IS NULL
      AND solution.phenomenon_time_estimate <= parent_end
      AND observation.created_at > parent_version.created_at
  ) THEN
    RETURN 'LATE_DATA';
  END IF;

  RETURN 'SUPERSEDES';
END
$fn$;

CREATE FUNCTION gowm_history.rebuild_mobility_tracklet_v2(
  p_scope text,
  p_source text,
  p_target text,
  p_tracker_session text,
  p_space text,
  p_profile text,
  p_manual_revision boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  logical_tracklet uuid;
  parent_version uuid;
  child_version uuid;
  lineage_kind text;
BEGIN
  SELECT tracklet.tracklet_id, head.current_version_id
  INTO logical_tracklet, parent_version
  FROM public.mobility_tracklet tracklet
  LEFT JOIN public.mobility_tracklet_head head USING (tracklet_id)
  WHERE tracklet.data_scope_key = p_scope
    AND tracklet.source_key = p_source
    AND tracklet.source_local_target_id = p_target
    AND tracklet.tracker_session_key = p_tracker_session
    AND tracklet.analysis_space_key = p_space;

  child_version := public.gowm_rebuild_mobility_tracklet(
    p_scope, p_source, p_target, p_tracker_session, p_space, p_profile
  );

  IF parent_version IS NOT NULL AND child_version IS DISTINCT FROM parent_version THEN
    lineage_kind := CASE
      WHEN p_manual_revision THEN 'MANUAL_REVISION'
      ELSE gowm_history.classify_tracklet_lineage(parent_version, child_version)
    END;
    INSERT INTO public.mobility_tracklet_lineage(
      parent_version_id, child_version_id, lineage_type, reason
    ) VALUES (
      parent_version,
      child_version,
      lineage_kind,
      'GOWM v0.7 deterministic rebuild lineage classification'
    ) ON CONFLICT DO NOTHING;
  END IF;

  RETURN child_version;
END
$fn$;

CREATE FUNCTION gowm_history.enqueue_tracklet_finalization(
  p_tracklet_version_id uuid,
  p_finalization_as_of timestamptz,
  p_desired_evidence_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  result_id uuid;
BEGIN
  PERFORM 1
  FROM public.mobility_tracklet_version version
  WHERE version.tracklet_version_id = p_tracklet_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tracklet version is unavailable' USING ERRCODE = '23503';
  END IF;

  UPDATE gowm_history.tracklet_finalization_queue queue
  SET state = 'SUPERSEDED',
      superseded_by_evidence_hash = p_desired_evidence_hash,
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      last_error = NULL
  WHERE queue.tracklet_version_id = p_tracklet_version_id
    AND queue.desired_evidence_hash <> p_desired_evidence_hash
    AND queue.state IN ('QUEUED','FAILED');

  INSERT INTO gowm_history.tracklet_finalization_queue(
    tracklet_version_id, desired_evidence_hash, finalization_as_of
  ) VALUES (
    p_tracklet_version_id, p_desired_evidence_hash, p_finalization_as_of
  ) ON CONFLICT (tracklet_version_id, desired_evidence_hash)
    DO UPDATE SET
      state = CASE
        WHEN gowm_history.tracklet_finalization_queue.state = 'FAILED' THEN 'QUEUED'
        ELSE gowm_history.tracklet_finalization_queue.state
      END,
      available_at = CASE
        WHEN gowm_history.tracklet_finalization_queue.state = 'FAILED' THEN clock_timestamp()
        ELSE gowm_history.tracklet_finalization_queue.available_at
      END,
      last_error = CASE
        WHEN gowm_history.tracklet_finalization_queue.state = 'FAILED' THEN NULL
        ELSE gowm_history.tracklet_finalization_queue.last_error
      END
  RETURNING queue_id INTO result_id;
  RETURN result_id;
END
$fn$;

CREATE FUNCTION gowm_history.fail_tracklet_projection(
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
  UPDATE gowm_history.tracklet_projection_queue queue
  SET state = 'FAILED',
      available_at = greatest(p_retry_at, clock_timestamp()),
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      rebuilt_tracklet_version_id = NULL,
      processed_at = NULL,
      last_error = left(COALESCE(p_error, 'tracklet projection failed'), 2048)
  WHERE queue.queue_id = p_queue_id
    AND queue.state = 'RUNNING'
    AND queue.locked_by = p_worker_id
    AND queue.generation = p_generation
    AND queue.lease_until > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$fn$;

CREATE FUNCTION gowm_history.complete_tracklet_projection(
  p_queue_id uuid,
  p_worker_id text,
  p_generation bigint,
  p_tracklet_version_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  changed integer;
  projection_record gowm_history.tracklet_projection_queue%ROWTYPE;
  version_hash text;
BEGIN
  SELECT queue.*
  INTO projection_record
  FROM gowm_history.tracklet_projection_queue queue
  WHERE queue.queue_id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND
     OR projection_record.state <> 'RUNNING'
     OR projection_record.locked_by IS DISTINCT FROM p_worker_id
     OR projection_record.generation <> p_generation
     OR projection_record.lease_until <= clock_timestamp() THEN
    RETURN false;
  END IF;

  SELECT version.content_hash
  INTO STRICT version_hash
  FROM public.mobility_tracklet_version version
  JOIN public.mobility_tracklet tracklet USING (tracklet_id)
  WHERE version.tracklet_version_id = p_tracklet_version_id
    AND tracklet.data_scope_key = projection_record.data_scope_key
    AND tracklet.source_key = projection_record.source_key
    AND tracklet.source_local_target_id = projection_record.source_local_target_id
    AND tracklet.tracker_session_key = projection_record.tracker_session_key
    AND tracklet.analysis_space_key = projection_record.analysis_space_key
    AND version.profile_key = projection_record.profile_key;

  UPDATE gowm_history.tracklet_projection_queue queue
  SET state = 'COMPLETED',
      rebuilt_tracklet_version_id = p_tracklet_version_id,
      processed_at = clock_timestamp(),
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      last_error = NULL
  WHERE queue.queue_id = p_queue_id;
  GET DIAGNOSTICS changed = ROW_COUNT;

  PERFORM gowm_history.enqueue_tracklet_finalization(
    p_tracklet_version_id,
    clock_timestamp(),
    public.grounding_sha256(p_tracklet_version_id::text || ':' || version_hash)
  );
  RETURN changed = 1;
END
$fn$;

CREATE FUNCTION gowm_history.claim_tracklet_finalization(
  p_worker_id text,
  p_batch_size integer DEFAULT 100,
  p_lease interval DEFAULT interval '30 seconds'
)
RETURNS SETOF gowm_history.tracklet_finalization_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
BEGIN
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 128
     OR p_batch_size NOT BETWEEN 1 AND 1000
     OR p_lease <= interval '0'
     OR p_lease > interval '15 minutes' THEN
    RAISE EXCEPTION 'tracklet finalization claim request is invalid' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT queue.queue_id
    FROM gowm_history.tracklet_finalization_queue queue
    WHERE queue.available_at <= clock_timestamp()
      AND (
        queue.state IN ('QUEUED','FAILED')
        OR (queue.state = 'RUNNING' AND queue.lease_until <= clock_timestamp())
      )
    ORDER BY queue.available_at, queue.created_at, queue.queue_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE gowm_history.tracklet_finalization_queue queue
  SET state = 'RUNNING',
      generation = queue.generation + 1,
      attempts = queue.attempts + 1,
      locked_at = clock_timestamp(),
      lease_until = clock_timestamp() + p_lease,
      locked_by = p_worker_id,
      finalization_revision_id = NULL,
      processed_at = NULL,
      last_error = NULL
  FROM candidates
  WHERE queue.queue_id = candidates.queue_id
  RETURNING queue.*;
END
$fn$;

CREATE FUNCTION gowm_history.register_tracklet_finalization_revision(
  p_tracklet_version_id uuid,
  p_finalization_state text,
  p_finalization_as_of timestamptz,
  p_observed_through timestamptz,
  p_profile_key text,
  p_profile_version text,
  p_profile_hash text,
  p_watermark_set_hash text,
  p_reason_codes text[],
  p_content_hash text,
  p_supersedes_revision_id uuid,
  p_watermark_inputs jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  version_record record;
  profile_record gowm_history.method_profile%ROWTYPE;
  current_revision uuid;
  prior_state text;
  next_revision integer;
  new_revision uuid := gen_random_uuid();
  existing_revision uuid;
  input_row jsonb;
  watermark_record public.pipeline_watermark_revision%ROWTYPE;
  computed_state text;
  missing_stream_count integer;
  stale_solution_count integer;
  active_dirty_count integer;
  computed_hash text;
  computed_observed_through timestamptz;
BEGIN
  IF jsonb_typeof(p_watermark_inputs) <> 'array' THEN
    RAISE EXCEPTION 'watermark inputs must be an array' USING ERRCODE = '22023';
  END IF;

  SELECT version.*, tracklet.data_scope_key, tracklet.source_key,
         tracklet.source_local_target_id, tracklet.tracker_session_key,
         tracklet.analysis_space_key
  INTO STRICT version_record
  FROM public.mobility_tracklet_version version
  JOIN public.mobility_tracklet tracklet USING (tracklet_id)
  WHERE version.tracklet_version_id = p_tracklet_version_id
  FOR SHARE;
  IF p_finalization_as_of < version_record.created_at THEN
    RAISE EXCEPTION 'tracklet finalization as-of precedes the tracklet version'
      USING ERRCODE = '23514';
  END IF;

  SELECT profile.*
  INTO STRICT profile_record
  FROM gowm_history.method_profile profile
  WHERE profile.profile_key = p_profile_key
    AND profile.profile_version = p_profile_version
    AND profile.profile_kind = 'TRACKLET_FINALIZATION';
  IF profile_record.content_hash IS DISTINCT FROM p_profile_hash THEN
    RAISE EXCEPTION 'tracklet finalization profile hash is not pinned exactly'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_tracklet_version_id::text, 0));

  SELECT revision.finalization_revision_id
  INTO existing_revision
  FROM gowm_history.tracklet_finalization_revision revision
  WHERE revision.tracklet_version_id = p_tracklet_version_id
    AND revision.content_hash = p_content_hash;
  IF FOUND THEN
    RETURN existing_revision;
  END IF;

  SELECT head.current_finalization_revision_id, revision.finalization_state
  INTO current_revision, prior_state
  FROM gowm_history.tracklet_finalization_head head
  JOIN gowm_history.tracklet_finalization_revision revision
    ON revision.finalization_revision_id = head.current_finalization_revision_id
  WHERE head.tracklet_version_id = p_tracklet_version_id
  FOR UPDATE OF head;
  IF FOUND AND p_supersedes_revision_id IS DISTINCT FROM current_revision THEN
    RAISE EXCEPTION 'tracklet finalization revision must supersede current head'
      USING ERRCODE = '40001';
  ELSIF NOT FOUND AND p_supersedes_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'first finalization revision cannot supersede another revision'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)
  INTO missing_stream_count
  FROM (
    SELECT DISTINCT observation.datastream_key
    FROM public.mobility_tracklet_input input
    JOIN public.world_observation observation
      ON observation.observation_id = input.observation_id
    WHERE input.tracklet_version_id = p_tracklet_version_id
  ) stream
  WHERE NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_watermark_inputs) item
    WHERE item->>'datastreamKey' = stream.datastream_key
  );

  SELECT count(*)
  INTO stale_solution_count
  FROM public.mobility_tracklet_input input
  WHERE input.tracklet_version_id = p_tracklet_version_id
    AND EXISTS (
      SELECT 1
      FROM public.observation_time_solution successor
      WHERE successor.supersedes_time_solution_id = input.time_solution_id
        AND successor.created_at <= p_finalization_as_of
    );

  SELECT count(*)
  INTO active_dirty_count
  FROM gowm_history.tracklet_projection_queue queue
  WHERE queue.data_scope_key = version_record.data_scope_key
    AND queue.source_key = version_record.source_key
    AND queue.source_local_target_id = version_record.source_local_target_id
    AND queue.tracker_session_key = version_record.tracker_session_key
    AND queue.analysis_space_key = version_record.analysis_space_key
    AND queue.profile_key = version_record.profile_key
    AND queue.created_at <= p_finalization_as_of
    AND queue.state IN ('QUEUED','RUNNING','FAILED')
    AND queue.rebuilt_tracklet_version_id IS DISTINCT FROM p_tracklet_version_id;

  computed_state := CASE
    WHEN version_record.version_state = 'CONFLICTED' THEN 'CONFLICTED'
    WHEN missing_stream_count > 0 OR stale_solution_count > 0 OR active_dirty_count > 0
      THEN CASE WHEN prior_state = 'SEALED' THEN 'REOPENED' ELSE 'PROVISIONAL' END
    WHEN jsonb_array_length(p_watermark_inputs) = 0 THEN
      CASE WHEN prior_state = 'SEALED' THEN 'REOPENED' ELSE 'PROVISIONAL' END
    WHEN EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_watermark_inputs) item
      WHERE COALESCE(item->>'completenessState', '') <> 'COMPLETE'
         OR NULLIF(item->>'closedThroughEventTime', '')::timestamptz IS NULL
         OR NULLIF(item->>'closedThroughEventTime', '')::timestamptz < version_record.end_event_time
    ) THEN CASE WHEN prior_state = 'SEALED' THEN 'REOPENED' ELSE 'PROVISIONAL' END
    ELSE 'SEALED'
  END;

  IF p_finalization_state IS DISTINCT FROM computed_state THEN
    RAISE EXCEPTION 'requested finalization state % conflicts with evidence-derived state %',
      p_finalization_state, computed_state USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(max(revision.revision_no), 0) + 1
  INTO next_revision
  FROM gowm_history.tracklet_finalization_revision revision
  WHERE revision.tracklet_version_id = p_tracklet_version_id;

  INSERT INTO gowm_history.tracklet_finalization_revision(
    finalization_revision_id, tracklet_version_id, revision_no, finalization_state,
    finalization_as_of, observed_through, profile_key, profile_version, profile_hash,
    watermark_set_hash, reason_codes, content_hash, supersedes_revision_id
  ) VALUES (
    new_revision, p_tracklet_version_id, next_revision, computed_state,
    p_finalization_as_of, p_observed_through, p_profile_key, p_profile_version,
    p_profile_hash, p_watermark_set_hash, COALESCE(p_reason_codes, '{}'),
    p_content_hash, p_supersedes_revision_id
  );

  FOR input_row IN SELECT value FROM jsonb_array_elements(p_watermark_inputs)
  LOOP
    SELECT watermark.*
    INTO STRICT watermark_record
    FROM public.pipeline_watermark_revision watermark
    JOIN public.datastream stream
      ON stream.datastream_key = watermark.datastream_key
    WHERE watermark.watermark_revision_id = (input_row->>'watermarkRevisionId')::uuid
      AND watermark.datastream_key = input_row->>'datastreamKey'
      AND watermark.created_at <= p_finalization_as_of
      AND stream.data_scope_key = version_record.data_scope_key;

    IF watermark_record.closed_through_event_time IS DISTINCT FROM
         NULLIF(input_row->>'closedThroughEventTime', '')::timestamptz
       OR watermark_record.allowed_lateness IS DISTINCT FROM
         (input_row->>'allowedLateness')::interval
       OR watermark_record.completeness_state IS DISTINCT FROM
         input_row->>'completenessState'
       OR watermark_record.created_at IS DISTINCT FROM
         (input_row->>'watermarkCreatedAt')::timestamptz THEN
      RAISE EXCEPTION 'watermark evidence is not pinned exactly'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.pipeline_watermark_revision successor
      WHERE successor.datastream_key = watermark_record.datastream_key
        AND successor.producer_pipeline_key = watermark_record.producer_pipeline_key
        AND successor.created_at <= p_finalization_as_of
        AND (successor.created_at, successor.watermark_revision_id) >
            (watermark_record.created_at, watermark_record.watermark_revision_id)
    ) THEN
      RAISE EXCEPTION 'watermark input is not the latest revision at finalization as-of'
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO gowm_history.tracklet_finalization_watermark_input(
      finalization_revision_id, input_no, datastream_key, watermark_revision_id,
      closed_through_event_time, allowed_lateness, completeness_state,
      watermark_created_at
    ) VALUES (
      new_revision,
      (input_row->>'inputNo')::integer,
      watermark_record.datastream_key,
      watermark_record.watermark_revision_id,
      watermark_record.closed_through_event_time,
      watermark_record.allowed_lateness,
      watermark_record.completeness_state,
      watermark_record.created_at
    );
  END LOOP;

  SELECT public.grounding_sha256(COALESCE(jsonb_agg(jsonb_build_array(
    input.input_no,
    input.datastream_key,
    input.watermark_revision_id,
    input.closed_through_event_time,
    input.allowed_lateness,
    input.completeness_state,
    input.watermark_created_at
  ) ORDER BY input.input_no)::text, '[]'))
  INTO computed_hash
  FROM gowm_history.tracklet_finalization_watermark_input input
  WHERE input.finalization_revision_id = new_revision;
  IF computed_hash IS DISTINCT FROM p_watermark_set_hash THEN
    RAISE EXCEPTION 'tracklet finalization watermark set hash mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT min(input.closed_through_event_time)
  INTO computed_observed_through
  FROM gowm_history.tracklet_finalization_watermark_input input
  WHERE input.finalization_revision_id = new_revision;
  IF p_observed_through IS DISTINCT FROM computed_observed_through THEN
    RAISE EXCEPTION 'tracklet finalization observed-through conflicts with pinned watermarks'
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('gowm.history_projection_write', 'on', true);
  INSERT INTO gowm_history.tracklet_finalization_head(
    tracklet_version_id, current_finalization_revision_id
  ) VALUES (
    p_tracklet_version_id, new_revision
  ) ON CONFLICT (tracklet_version_id) DO UPDATE
    SET current_finalization_revision_id = EXCLUDED.current_finalization_revision_id,
        updated_at = clock_timestamp();
  PERFORM set_config('gowm.history_projection_write', 'off', true);

  RETURN new_revision;
END
$fn$;

CREATE FUNCTION gowm_history.complete_tracklet_finalization(
  p_queue_id uuid,
  p_worker_id text,
  p_generation bigint,
  p_finalization_revision_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  changed integer;
BEGIN
  UPDATE gowm_history.tracklet_finalization_queue queue
  SET state = 'COMPLETED',
      finalization_revision_id = p_finalization_revision_id,
      processed_at = clock_timestamp(),
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      last_error = NULL
  WHERE queue.queue_id = p_queue_id
    AND queue.state = 'RUNNING'
    AND queue.locked_by = p_worker_id
    AND queue.generation = p_generation
    AND queue.lease_until > clock_timestamp()
    AND EXISTS (
      SELECT 1
      FROM gowm_history.tracklet_finalization_revision revision
      WHERE revision.finalization_revision_id = p_finalization_revision_id
        AND revision.tracklet_version_id = queue.tracklet_version_id
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$fn$;

CREATE FUNCTION gowm_history.fail_tracklet_finalization(
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
  UPDATE gowm_history.tracklet_finalization_queue queue
  SET state = 'FAILED',
      available_at = greatest(p_retry_at, clock_timestamp()),
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      finalization_revision_id = NULL,
      processed_at = NULL,
      last_error = left(COALESCE(p_error, 'tracklet finalization failed'), 2048)
  WHERE queue.queue_id = p_queue_id
    AND queue.state = 'RUNNING'
    AND queue.locked_by = p_worker_id
    AND queue.generation = p_generation
    AND queue.lease_until > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$fn$;

CREATE VIEW gowm_history_v1.tracklet_version_effective
WITH (security_barrier = true)
AS
SELECT
  tracklet.data_scope_key,
  tracklet.source_key,
  tracklet.source_local_target_id,
  tracklet.tracker_session_key,
  tracklet.analysis_space_key,
  tracklet.tracklet_id,
  version.tracklet_version_id,
  version.version_no,
  version.profile_key,
  version.version_state AS source_version_state,
  COALESCE(finalization.finalization_state, version.version_state) AS finalization_state,
  finalization.finalization_revision_id,
  finalization.revision_no AS finalization_revision_no,
  finalization.finalization_as_of,
  finalization.observed_through,
  finalization.watermark_set_hash,
  finalization.reason_codes AS finalization_reason_codes,
  version.trajectory,
  version.extent_box,
  version.start_event_time,
  version.end_event_time,
  version.sample_count,
  version.sequence_count,
  version.content_hash,
  version.created_at
FROM public.mobility_tracklet tracklet
JOIN public.mobility_tracklet_version version USING (tracklet_id)
LEFT JOIN gowm_history.tracklet_finalization_head head USING (tracklet_version_id)
LEFT JOIN gowm_history.tracklet_finalization_revision finalization
  ON finalization.finalization_revision_id = head.current_finalization_revision_id
WHERE tracklet.data_scope_key = gowm_history_v1.current_data_scope_key();

CREATE FUNCTION gowm_history_v1.tracklet_version_as_of(
  p_tracklet_version_id uuid,
  p_captured_at timestamptz,
  p_exact_finalization_revision_no integer DEFAULT NULL
)
RETURNS SETOF gowm_history_v1.tracklet_version_effective
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history, gowm_history_v1
AS $fn$
  SELECT
    tracklet.data_scope_key,
    tracklet.source_key,
    tracklet.source_local_target_id,
    tracklet.tracker_session_key,
    tracklet.analysis_space_key,
    tracklet.tracklet_id,
    version.tracklet_version_id,
    version.version_no,
    version.profile_key,
    version.version_state AS source_version_state,
    COALESCE(finalization.finalization_state, version.version_state) AS finalization_state,
    finalization.finalization_revision_id,
    finalization.revision_no AS finalization_revision_no,
    finalization.finalization_as_of,
    finalization.observed_through,
    finalization.watermark_set_hash,
    finalization.reason_codes AS finalization_reason_codes,
    version.trajectory,
    version.extent_box,
    version.start_event_time,
    version.end_event_time,
    version.sample_count,
    version.sequence_count,
    version.content_hash,
    version.created_at
  FROM public.mobility_tracklet tracklet
  JOIN public.mobility_tracklet_version version USING (tracklet_id)
  LEFT JOIN LATERAL (
    SELECT revision.*
    FROM gowm_history.tracklet_finalization_revision revision
    WHERE revision.tracklet_version_id = version.tracklet_version_id
      AND revision.created_at <= p_captured_at
      AND (
        p_exact_finalization_revision_no IS NULL
        OR revision.revision_no = p_exact_finalization_revision_no
      )
    ORDER BY revision.created_at DESC, revision.revision_no DESC
    LIMIT 1
  ) finalization ON true
  WHERE tracklet.data_scope_key = gowm_history_v1.current_data_scope_key()
    AND version.tracklet_version_id = p_tracklet_version_id
    AND version.created_at <= p_captured_at
    AND (
      p_exact_finalization_revision_no IS NULL
      OR finalization.finalization_revision_id IS NOT NULL
    )
$fn$;

REVOKE ALL ON ALL TABLES IN SCHEMA gowm_history, gowm_history_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_history, gowm_history_v1 FROM PUBLIC;

GRANT SELECT ON gowm_history_v1.tracklet_version_effective TO gowm_history_reader;
GRANT EXECUTE ON FUNCTION gowm_history_v1.tracklet_version_as_of(uuid, timestamptz, integer)
  TO gowm_history_reader;

GRANT EXECUTE ON FUNCTION gowm_history.enqueue_tracklet_projection(
  text, text, text, text, text, text, text
) TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.claim_tracklet_projection(text, integer, interval)
  TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.rebuild_mobility_tracklet_v2(
  text, text, text, text, text, text, boolean
) TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.complete_tracklet_projection(uuid, text, bigint, uuid)
  TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.fail_tracklet_projection(
  uuid, text, bigint, text, timestamptz
) TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.enqueue_tracklet_finalization(uuid, timestamptz, text)
  TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.claim_tracklet_finalization(text, integer, interval)
  TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.register_tracklet_finalization_revision(
  uuid, text, timestamptz, timestamptz, text, text, text, text, text[], text, uuid, jsonb
) TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.complete_tracklet_finalization(uuid, text, bigint, uuid)
  TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.fail_tracklet_finalization(
  uuid, text, bigint, text, timestamptz
) TO gowm_history_worker;

COMMENT ON TABLE gowm_history.tracklet_projection_queue IS
  'Dirty-key queue populated by successful position projection; its trigger only enqueues and never rebuilds.';
COMMENT ON TABLE gowm_history.tracklet_finalization_revision IS
  'Append-only finalization evidence for a fixed immutable mobility_tracklet_version.';
COMMENT ON VIEW gowm_history_v1.tracklet_version_effective IS
  'Scope-filtered effective finalization; absence of finalization evidence falls back to the immutable source version state.';

COMMIT;
