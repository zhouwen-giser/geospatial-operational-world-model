BEGIN;

CREATE SCHEMA gowm_history;

ALTER TABLE public.operational_task_event
  DROP CONSTRAINT operational_task_event_event_type_check,
  ADD CONSTRAINT operational_task_event_event_type_check CHECK (event_type IN (
    'CONTROL_REQUEST_OBSERVED','CONTROL_ACCEPTED_OBSERVED','CONTROL_REJECTED_OBSERVED',
    'EXECUTION_STARTED_OBSERVED','EXECUTION_PROGRESS_OBSERVED','EXECUTION_PAUSED_OBSERVED',
    'EXECUTION_RESUMED_OBSERVED','EXECUTION_STOPPED_OBSERVED','CONTROL_COMPLETED_REPORTED',
    'PHYSICAL_EFFECT_PARTIALLY_CONFIRMED','PHYSICAL_EFFECT_CONFIRMED',
    'PHYSICAL_EFFECT_CONTRADICTED','EXECUTION_FAILED_OBSERVED',
    'EXECUTION_CANCELLED_OBSERVED','OBSERVATION_GAP_OPENED','OBSERVATION_GAP_CLOSED'
  ));

-- Keep the current Operational Task projection composable with the newly
-- accepted explicit resume event. Historical interval reconstruction remains
-- authoritative for phase boundaries; this projection only exposes the latest
-- observed activity state.
CREATE OR REPLACE FUNCTION public.compute_operational_task_snapshot(
  p_data_scope_key text,
  p_operational_task_id text,
  p_policy_version text
)
RETURNS jsonb LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
  WITH event_rows AS (
    SELECT event.*,
           operational_source_priority(event.source_authority,p_policy_version) AS source_priority,
           COALESCE(event.confidence,0) AS effective_confidence
    FROM operational_task_event event
    WHERE event.data_scope_key=p_data_scope_key
      AND event.operational_task_id=p_operational_task_id
  ),
  summary AS (
    SELECT min(event_time) AS first_observed_at,max(event_time) AS last_observed_at,
           max(received_time) AS last_received_at,count(*) AS event_count
    FROM event_rows
  ),
  control AS (
    SELECT CASE event_type
      WHEN 'CONTROL_REQUEST_OBSERVED' THEN 'REQUESTED_OBSERVED'
      WHEN 'CONTROL_ACCEPTED_OBSERVED' THEN 'ACCEPTED_OBSERVED'
      WHEN 'CONTROL_REJECTED_OBSERVED' THEN 'REJECTED_OBSERVED'
      WHEN 'CONTROL_COMPLETED_REPORTED' THEN 'COMPLETED_REPORTED'
      WHEN 'EXECUTION_FAILED_OBSERVED' THEN 'FAILED_REPORTED'
      WHEN 'EXECUTION_CANCELLED_OBSERVED' THEN 'CANCELLED_REPORTED'
    END AS value
    FROM event_rows
    WHERE event_type IN (
      'CONTROL_REQUEST_OBSERVED','CONTROL_ACCEPTED_OBSERVED','CONTROL_REJECTED_OBSERVED',
      'CONTROL_COMPLETED_REPORTED','EXECUTION_FAILED_OBSERVED','EXECUTION_CANCELLED_OBSERVED'
    )
    ORDER BY event_time DESC,source_priority DESC,effective_confidence DESC,event_id DESC LIMIT 1
  ),
  activity AS (
    SELECT CASE event_type
      WHEN 'EXECUTION_STARTED_OBSERVED' THEN 'STARTED_OBSERVED'
      WHEN 'EXECUTION_PROGRESS_OBSERVED' THEN 'ACTIVE_OBSERVED'
      WHEN 'EXECUTION_PAUSED_OBSERVED' THEN 'PAUSED_OBSERVED'
      WHEN 'EXECUTION_RESUMED_OBSERVED' THEN 'ACTIVE_OBSERVED'
      WHEN 'EXECUTION_STOPPED_OBSERVED' THEN 'STOPPED_OBSERVED'
    END AS value
    FROM event_rows
    WHERE event_type IN (
      'EXECUTION_STARTED_OBSERVED','EXECUTION_PROGRESS_OBSERVED',
      'EXECUTION_PAUSED_OBSERVED','EXECUTION_RESUMED_OBSERVED','EXECUTION_STOPPED_OBSERVED'
    )
    ORDER BY event_time DESC,source_priority DESC,effective_confidence DESC,event_id DESC LIMIT 1
  ),
  physical_outcome AS (
    SELECT CASE event_type
      WHEN 'PHYSICAL_EFFECT_PARTIALLY_CONFIRMED' THEN 'PARTIALLY_VERIFIED'
      WHEN 'PHYSICAL_EFFECT_CONFIRMED' THEN 'VERIFIED'
      WHEN 'PHYSICAL_EFFECT_CONTRADICTED' THEN 'CONTRADICTED'
    END AS value
    FROM event_rows
    WHERE event_type IN (
      'PHYSICAL_EFFECT_PARTIALLY_CONFIRMED','PHYSICAL_EFFECT_CONFIRMED','PHYSICAL_EFFECT_CONTRADICTED'
    )
    ORDER BY event_time DESC,source_priority DESC,effective_confidence DESC,event_id DESC LIMIT 1
  ),
  gap AS (
    SELECT CASE event_type WHEN 'OBSERVATION_GAP_OPENED' THEN 'OBSERVATION_GAP' ELSE 'FRESH' END AS value
    FROM event_rows WHERE event_type IN ('OBSERVATION_GAP_OPENED','OBSERVATION_GAP_CLOSED')
    ORDER BY event_time DESC,source_priority DESC,effective_confidence DESC,event_id DESC LIMIT 1
  ),
  task_type AS (
    SELECT NULLIF(payload->>'taskType','') AS value FROM event_rows
    WHERE NULLIF(payload->>'taskType','') IS NOT NULL
    ORDER BY event_time DESC,source_priority DESC,effective_confidence DESC,event_id DESC LIMIT 1
  ),
  actors AS (
    SELECT COALESCE(jsonb_agg(item ORDER BY item::text),'[]'::jsonb) AS value FROM (
      SELECT DISTINCT actor.item FROM event_rows
      CROSS JOIN LATERAL jsonb_array_elements(actor_reference_keys) actor(item)
    ) unique_actors
  ),
  targets AS (
    SELECT COALESCE(jsonb_agg(item ORDER BY item::text),'[]'::jsonb) AS value FROM (
      SELECT DISTINCT target.item FROM event_rows
      CROSS JOIN LATERAL jsonb_array_elements(target_reference_keys) target(item)
    ) unique_targets
  ),
  evidence AS (
    SELECT COALESCE(jsonb_agg(event_id ORDER BY event_time,source_priority,effective_confidence,event_id),'[]'::jsonb) AS value
    FROM (
      SELECT * FROM event_rows
      ORDER BY event_time,source_priority,effective_confidence,event_id LIMIT 1000
    ) bounded
  ),
  claim_summary AS (
    SELECT COALESCE(jsonb_object_agg(external_kind,claim_count ORDER BY external_kind),'{}'::jsonb) AS value
    FROM (
      SELECT claim.external_kind,count(*) AS claim_count
      FROM external_correlation_claim claim
      JOIN event_rows event ON event.event_id=claim.source_id
      WHERE claim.data_scope_key=p_data_scope_key AND claim.source_kind='OPERATIONAL_EVENT'
      GROUP BY claim.external_kind
    ) counts
  )
  SELECT CASE WHEN summary.event_count=0 THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
    'referenceKey',jsonb_build_object(
      'namespace','gowm','kind','OPERATIONAL_TASK','id',task.reference_key,'version','1'
    ),
    'operationalTaskId',p_operational_task_id,
    'taskType',COALESCE(task_type.value,'OPERATIONAL_TASK'),
    'controlState',COALESCE(control.value,'NO_CONTROL_EVENT'),
    'activityState',COALESCE(activity.value,'NOT_OBSERVED'),
    'outcomeVerification',COALESCE(
      physical_outcome.value,
      CASE WHEN summary.event_count>0 THEN 'UNVERIFIED' ELSE 'NOT_APPLICABLE' END
    ),
    'observability',COALESCE(gap.value,CASE WHEN summary.event_count>0 THEN 'FRESH' ELSE 'NO_DATA' END),
    'actorReferenceKeys',actors.value,
    'targetReferenceKeys',targets.value,
    'firstObservedAt',summary.first_observed_at,
    'lastObservedAt',summary.last_observed_at,
    'lastReceivedAt',summary.last_received_at,
    'evidenceIds',evidence.value,
    'correlationClaimSummary',claim_summary.value,
    'projectionPolicyVersion',p_policy_version
  )) END
  FROM summary
  JOIN operational_task task
    ON task.data_scope_key=p_data_scope_key AND task.operational_task_id=p_operational_task_id
  CROSS JOIN actors CROSS JOIN targets CROSS JOIN evidence CROSS JOIN claim_summary
  LEFT JOIN control ON true LEFT JOIN activity ON true LEFT JOIN physical_outcome ON true
  LEFT JOIN gap ON true LEFT JOIN task_type ON true
$fn$;

ALTER TABLE public.world_reference_identity
  DROP CONSTRAINT world_reference_entity_kind,
  ADD CONSTRAINT world_reference_entity_kind CHECK (entity_kind IN (
    'WORLD_OBJECT','SPATIAL_OBJECT','DATA_SCOPE','DATASET','LAYER','LAYER_FEATURE',
    'QUERY_RESULT','DERIVED_REFERENCE','REFERENCE_SET','OPERATIONAL_TASK',
    'TASK_EXECUTION_INTERVAL'
  ));

CREATE INDEX operational_task_event_deterministic_history_idx
  ON public.operational_task_event(
    data_scope_key,
    operational_task_id,
    event_time,
    received_time,
    source_authority,
    source_event_key,
    source_revision_no,
    event_id
  );

CREATE TABLE gowm_history.method_profile (
  profile_key text NOT NULL CHECK (length(btrim(profile_key)) BETWEEN 1 AND 128),
  profile_version text NOT NULL CHECK (length(btrim(profile_version)) BETWEEN 1 AND 64),
  profile_kind text NOT NULL CHECK (profile_kind IN (
    'TASK_INTERVAL','TRACKLET_FINALIZATION','TRAJECTORY_SELECTION'
  )),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (profile_key, profile_version),
  UNIQUE (profile_key, content_hash)
);

WITH profiles(profile_key, profile_version, profile_kind, definition) AS (
  VALUES
    (
      'task-interval-observed-v1',
      '1.0',
      'TASK_INTERVAL',
      '{"eventSemantics":"OBSERVED_ONLY","legacyResumeFromStarted":true,"progressImpliesResume":false,"sameTimeConflict":"CONFLICTED"}'::jsonb
    ),
    (
      'tracklet-finalization-watermark-v1',
      '1.0',
      'TRACKLET_FINALIZATION',
      '{"allInputDatastreamsRequired":true,"closedThroughIncludesAllowedLateness":true,"timeSolutionMustBeCurrentAsOf":true}'::jsonb
    ),
    (
      'trajectory-single-authoritative-v1',
      '1.0',
      'TRAJECTORY_SELECTION',
      '{"sourceSelection":"SINGLE_AUTHORITATIVE_SOURCE","crossGapInterpolation":false,"multipleCandidates":"INDETERMINATE"}'::jsonb
    )
)
INSERT INTO gowm_history.method_profile(
  profile_key, profile_version, profile_kind, definition, content_hash
)
SELECT
  profile_key,
  profile_version,
  profile_kind,
  definition,
  public.grounding_sha256(definition::text)
FROM profiles;

CREATE TABLE gowm_history.task_execution_interval (
  interval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),
  operational_task_id text NOT NULL,
  task_reference_key text NOT NULL REFERENCES public.world_reference_identity(reference_key),
  execution_no integer NOT NULL CHECK (execution_no > 0),
  reference_key text NOT NULL UNIQUE REFERENCES public.world_reference_identity(reference_key),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (data_scope_key, operational_task_id, execution_no),
  UNIQUE (interval_id, data_scope_key),
  FOREIGN KEY (data_scope_key, operational_task_id)
    REFERENCES public.operational_task(data_scope_key, operational_task_id)
);

CREATE TABLE gowm_history.task_execution_interval_revision (
  interval_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interval_id uuid NOT NULL REFERENCES gowm_history.task_execution_interval(interval_id),
  revision_no integer NOT NULL CHECK (revision_no > 0),
  execution_range tstzrange NOT NULL,
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('OPEN','CLOSED','CONFLICTED')),
  derivation_kind text NOT NULL CHECK (derivation_kind IN ('OBSERVED_ONLY','MIXED','CONFLICTED')),
  stability_state text NOT NULL CHECK (stability_state IN ('PROVISIONAL','SEALED','CONFLICTED')),
  start_event_id text,
  terminal_event_id text,
  input_event_set_hash text NOT NULL CHECK (input_event_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  profile_key text NOT NULL,
  profile_version text NOT NULL,
  profile_hash text NOT NULL CHECK (profile_hash ~ '^sha256:[0-9a-f]{64}$'),
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  reason_codes text[] NOT NULL DEFAULT '{}',
  world_version bigint NOT NULL DEFAULT nextval('public.world_version_seq') CHECK (world_version >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  supersedes_revision_id uuid REFERENCES gowm_history.task_execution_interval_revision(interval_revision_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (interval_id, revision_no),
  UNIQUE (interval_id, content_hash),
  UNIQUE (interval_revision_id, interval_id),
  FOREIGN KEY (profile_key, profile_version)
    REFERENCES gowm_history.method_profile(profile_key, profile_version),
  CHECK (NOT isempty(execution_range)),
  CHECK (lower_inf(execution_range) OR lower_inc(execution_range)),
  CHECK (upper_inf(execution_range) OR NOT upper_inc(execution_range)),
  CHECK (
    (lifecycle_state = 'OPEN' AND NOT lower_inf(execution_range) AND upper_inf(execution_range))
    OR (lifecycle_state = 'CLOSED' AND NOT lower_inf(execution_range) AND NOT upper_inf(execution_range))
    OR lifecycle_state = 'CONFLICTED'
  ),
  CHECK (supersedes_revision_id IS NULL OR supersedes_revision_id <> interval_revision_id)
);

CREATE INDEX task_execution_interval_revision_as_of_idx
  ON gowm_history.task_execution_interval_revision(interval_id, created_at DESC, revision_no DESC);
CREATE INDEX task_execution_interval_revision_range_gist_idx
  ON gowm_history.task_execution_interval_revision USING gist(execution_range);

CREATE TABLE gowm_history.task_execution_phase (
  interval_revision_id uuid NOT NULL
    REFERENCES gowm_history.task_execution_interval_revision(interval_revision_id),
  phase_no integer NOT NULL CHECK (phase_no > 0),
  phase_kind text NOT NULL CHECK (phase_kind IN ('RUNNING','PAUSED','UNKNOWN')),
  phase_range tstzrange NOT NULL,
  start_event_id text,
  end_event_id text,
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  reason_codes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interval_revision_id, phase_no),
  CHECK (NOT isempty(phase_range)),
  CHECK (lower_inf(phase_range) OR lower_inc(phase_range)),
  CHECK (upper_inf(phase_range) OR NOT upper_inc(phase_range))
);

CREATE INDEX task_execution_phase_range_gist_idx
  ON gowm_history.task_execution_phase USING gist(phase_range);

CREATE TABLE gowm_history.task_execution_interval_input (
  interval_revision_id uuid NOT NULL
    REFERENCES gowm_history.task_execution_interval_revision(interval_revision_id),
  event_no integer NOT NULL CHECK (event_no > 0),
  data_scope_key text NOT NULL,
  operational_event_id text NOT NULL,
  event_content_hash text NOT NULL CHECK (event_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  input_role text NOT NULL CHECK (input_role IN (
    'START_BOUNDARY','TERMINAL_BOUNDARY','PHASE_BOUNDARY','PROGRESS','CONFLICT','ORPHAN_EVIDENCE'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interval_revision_id, event_no),
  UNIQUE (interval_revision_id, operational_event_id),
  FOREIGN KEY (data_scope_key, operational_event_id)
    REFERENCES public.operational_task_event(data_scope_key, event_id)
);

CREATE TABLE gowm_history.task_execution_interval_head (
  interval_id uuid PRIMARY KEY REFERENCES gowm_history.task_execution_interval(interval_id),
  current_revision_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (current_revision_id, interval_id)
    REFERENCES gowm_history.task_execution_interval_revision(interval_revision_id, interval_id)
);

CREATE TABLE gowm_history.task_interval_projection_queue (
  queue_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),
  operational_task_id text NOT NULL CHECK (length(btrim(operational_task_id)) BETWEEN 1 AND 256),
  desired_event_set_hash text NOT NULL CHECK (desired_event_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
    'QUEUED','RUNNING','COMPLETED','FAILED','SUPERSEDED'
  )),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  lease_until timestamptz,
  locked_by text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processed_at timestamptz,
  last_error text,
  superseded_by_event_set_hash text
    CHECK (superseded_by_event_set_hash IS NULL OR superseded_by_event_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (data_scope_key, operational_task_id, desired_event_set_hash),
  CHECK ((state = 'RUNNING') = (locked_by IS NOT NULL AND locked_at IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (lease_until IS NULL OR locked_at IS NULL OR lease_until > locked_at),
  CHECK ((state = 'COMPLETED') = (processed_at IS NOT NULL)),
  CHECK ((state = 'SUPERSEDED') = (superseded_by_event_set_hash IS NOT NULL))
);

CREATE INDEX task_interval_projection_queue_claim_idx
  ON gowm_history.task_interval_projection_queue(available_at, created_at, queue_id)
  WHERE state IN ('QUEUED','FAILED');
CREATE INDEX task_interval_projection_queue_task_idx
  ON gowm_history.task_interval_projection_queue(
    data_scope_key, operational_task_id, created_at DESC, queue_id
  );

CREATE FUNCTION gowm_history.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER history_method_profile_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.method_profile
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();
CREATE TRIGGER task_execution_interval_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.task_execution_interval
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();
CREATE TRIGGER task_execution_interval_revision_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.task_execution_interval_revision
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();
CREATE TRIGGER task_execution_phase_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.task_execution_phase
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();
CREATE TRIGGER task_execution_interval_input_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.task_execution_interval_input
  FOR EACH ROW EXECUTE FUNCTION gowm_history.reject_append_only_mutation();

CREATE FUNCTION gowm_history.protect_task_interval_head_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF current_setting('gowm.history_projection_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'task execution interval head is projection-owned'
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

CREATE TRIGGER task_execution_interval_head_projection_owned
  BEFORE INSERT OR UPDATE OR DELETE ON gowm_history.task_execution_interval_head
  FOR EACH ROW EXECUTE FUNCTION gowm_history.protect_task_interval_head_write();

CREATE FUNCTION gowm_history.protect_task_interval_queue_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task interval queue evidence cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY[
        'state','generation','available_at','locked_at','lease_until','locked_by',
        'attempts','processed_at','last_error','superseded_by_event_set_hash'
      ]) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY[
        'state','generation','available_at','locked_at','lease_until','locked_by',
        'attempts','processed_at','last_error','superseded_by_event_set_hash'
      ]) THEN
    RAISE EXCEPTION 'task interval queue identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER task_interval_projection_queue_payload_immutable
  BEFORE UPDATE OR DELETE ON gowm_history.task_interval_projection_queue
  FOR EACH ROW EXECUTE FUNCTION gowm_history.protect_task_interval_queue_payload();

CREATE FUNCTION gowm_history.enqueue_task_interval_projection(
  p_data_scope_key text,
  p_operational_task_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  desired_hash text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.data_scope scope WHERE scope.scope_key = p_data_scope_key
  ) THEN
    RAISE EXCEPTION 'task interval scope is unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_data_scope_key || E'\u001f' || p_operational_task_id,
    0
  ));

  SELECT public.grounding_sha256(COALESCE(jsonb_agg(
    jsonb_build_array(
      event.event_time,
      event.received_time,
      event.source_authority,
      event.source_event_key,
      event.source_revision_no,
      event.event_id,
      event.content_hash
    ) ORDER BY
      event.event_time,
      event.received_time,
      event.source_authority,
      event.source_event_key,
      event.source_revision_no,
      event.event_id
  )::text, '[]'))
  INTO desired_hash
  FROM public.operational_task_event event
  WHERE event.data_scope_key = p_data_scope_key
    AND event.operational_task_id = p_operational_task_id;

  UPDATE gowm_history.task_interval_projection_queue queue
  SET state = 'SUPERSEDED',
      superseded_by_event_set_hash = desired_hash,
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      last_error = NULL
  WHERE queue.data_scope_key = p_data_scope_key
    AND queue.operational_task_id = p_operational_task_id
    AND queue.desired_event_set_hash <> desired_hash
    AND queue.state IN ('QUEUED','FAILED');

  INSERT INTO gowm_history.task_interval_projection_queue(
    data_scope_key, operational_task_id, desired_event_set_hash
  ) VALUES (
    p_data_scope_key, p_operational_task_id, desired_hash
  ) ON CONFLICT (data_scope_key, operational_task_id, desired_event_set_hash)
    DO UPDATE SET
      state = CASE
        WHEN gowm_history.task_interval_projection_queue.state = 'FAILED' THEN 'QUEUED'
        ELSE gowm_history.task_interval_projection_queue.state
      END,
      available_at = CASE
        WHEN gowm_history.task_interval_projection_queue.state = 'FAILED' THEN clock_timestamp()
        ELSE gowm_history.task_interval_projection_queue.available_at
      END,
      last_error = CASE
        WHEN gowm_history.task_interval_projection_queue.state = 'FAILED' THEN NULL
        ELSE gowm_history.task_interval_projection_queue.last_error
      END;

  RETURN desired_hash;
END
$fn$;

CREATE FUNCTION gowm_history.enqueue_task_interval_projection_from_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
BEGIN
  PERFORM gowm_history.enqueue_task_interval_projection(
    NEW.data_scope_key, NEW.operational_task_id
  );
  RETURN NEW;
END
$fn$;

CREATE TRIGGER operational_task_event_history_queue
  AFTER INSERT ON public.operational_task_event
  FOR EACH ROW EXECUTE FUNCTION gowm_history.enqueue_task_interval_projection_from_event();

INSERT INTO gowm_history.task_interval_projection_queue(
  data_scope_key, operational_task_id, desired_event_set_hash
)
SELECT
  event.data_scope_key,
  event.operational_task_id,
  public.grounding_sha256(jsonb_agg(
    jsonb_build_array(
      event.event_time,
      event.received_time,
      event.source_authority,
      event.source_event_key,
      event.source_revision_no,
      event.event_id,
      event.content_hash
    ) ORDER BY
      event.event_time,
      event.received_time,
      event.source_authority,
      event.source_event_key,
      event.source_revision_no,
      event.event_id
  )::text)
FROM public.operational_task_event event
GROUP BY event.data_scope_key, event.operational_task_id
ON CONFLICT DO NOTHING;

CREATE FUNCTION gowm_history.claim_task_interval_projection(
  p_worker_id text,
  p_batch_size integer DEFAULT 100,
  p_lease interval DEFAULT interval '30 seconds'
)
RETURNS SETOF gowm_history.task_interval_projection_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
BEGIN
  IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 128
     OR p_batch_size NOT BETWEEN 1 AND 1000
     OR p_lease <= interval '0'
     OR p_lease > interval '15 minutes' THEN
    RAISE EXCEPTION 'task interval claim request is invalid' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT queue.queue_id
    FROM gowm_history.task_interval_projection_queue queue
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
  UPDATE gowm_history.task_interval_projection_queue queue
  SET state = 'RUNNING',
      generation = queue.generation + 1,
      attempts = queue.attempts + 1,
      locked_at = clock_timestamp(),
      lease_until = clock_timestamp() + p_lease,
      locked_by = p_worker_id,
      processed_at = NULL
  FROM candidates
  WHERE queue.queue_id = candidates.queue_id
  RETURNING queue.*;
END
$fn$;

CREATE FUNCTION gowm_history.complete_task_interval_projection(
  p_queue_id uuid,
  p_worker_id text,
  p_generation bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  changed integer;
BEGIN
  UPDATE gowm_history.task_interval_projection_queue queue
  SET state = 'COMPLETED',
      processed_at = clock_timestamp(),
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      last_error = NULL
  WHERE queue.queue_id = p_queue_id
    AND queue.state = 'RUNNING'
    AND queue.locked_by = p_worker_id
    AND queue.generation = p_generation
    AND queue.lease_until > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$fn$;

CREATE FUNCTION gowm_history.fail_task_interval_projection(
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
  UPDATE gowm_history.task_interval_projection_queue queue
  SET state = 'FAILED',
      available_at = greatest(p_retry_at, clock_timestamp()),
      locked_at = NULL,
      lease_until = NULL,
      locked_by = NULL,
      processed_at = NULL,
      last_error = left(COALESCE(p_error, 'projection failed'), 2048)
  WHERE queue.queue_id = p_queue_id
    AND queue.state = 'RUNNING'
    AND queue.locked_by = p_worker_id
    AND queue.generation = p_generation
    AND queue.lease_until > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END
$fn$;

CREATE FUNCTION gowm_history.register_task_execution_interval_revision(
  p_data_scope_key text,
  p_operational_task_id text,
  p_execution_no integer,
  p_execution_range tstzrange,
  p_lifecycle_state text,
  p_derivation_kind text,
  p_stability_state text,
  p_start_event_id text,
  p_terminal_event_id text,
  p_input_event_set_hash text,
  p_profile_key text,
  p_profile_version text,
  p_profile_hash text,
  p_confidence double precision,
  p_reason_codes text[],
  p_content_hash text,
  p_supersedes_revision_id uuid,
  p_phases jsonb,
  p_inputs jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
DECLARE
  task_reference text;
  interval_row gowm_history.task_execution_interval%ROWTYPE;
  existing_revision uuid;
  new_revision uuid := gen_random_uuid();
  next_revision integer;
  new_reference text;
  new_world_version bigint := nextval('public.world_version_seq');
  phase_row jsonb;
  input_row jsonb;
  profile_record gowm_history.method_profile%ROWTYPE;
  current_revision uuid;
  input_count integer := 0;
  total_event_count integer;
  computed_input_hash text;
BEGIN
  IF jsonb_typeof(p_phases) <> 'array' OR jsonb_typeof(p_inputs) <> 'array'
     OR jsonb_array_length(p_inputs) = 0 THEN
    RAISE EXCEPTION 'task interval phases and inputs must be arrays with at least one input'
      USING ERRCODE = '22023';
  END IF;

  SELECT task.reference_key
  INTO STRICT task_reference
  FROM public.operational_task task
  WHERE task.data_scope_key = p_data_scope_key
    AND task.operational_task_id = p_operational_task_id
  FOR SHARE;

  SELECT profile.*
  INTO STRICT profile_record
  FROM gowm_history.method_profile profile
  WHERE profile.profile_key = p_profile_key
    AND profile.profile_version = p_profile_version
    AND profile.profile_kind = 'TASK_INTERVAL';
  IF profile_record.content_hash IS DISTINCT FROM p_profile_hash THEN
    RAISE EXCEPTION 'task interval profile hash is not pinned exactly'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_data_scope_key || E'\u001f' || p_operational_task_id,
    0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_data_scope_key || E'\u001f' || p_operational_task_id || E'\u001f' || p_execution_no::text,
    0
  ));

  SELECT interval.*
  INTO interval_row
  FROM gowm_history.task_execution_interval interval
  WHERE interval.data_scope_key = p_data_scope_key
    AND interval.operational_task_id = p_operational_task_id
    AND interval.execution_no = p_execution_no;

  IF NOT FOUND THEN
    interval_row.interval_id := gen_random_uuid();
    INSERT INTO public.world_reference_identity(entity_kind, internal_id, data_scope_key)
    VALUES ('TASK_EXECUTION_INTERVAL', interval_row.interval_id::text, p_data_scope_key)
    RETURNING reference_key INTO new_reference;

    INSERT INTO gowm_history.task_execution_interval(
      interval_id, data_scope_key, operational_task_id, task_reference_key,
      execution_no, reference_key
    ) VALUES (
      interval_row.interval_id, p_data_scope_key, p_operational_task_id,
      task_reference, p_execution_no, new_reference
    ) RETURNING * INTO interval_row;
  ELSIF interval_row.task_reference_key IS DISTINCT FROM task_reference THEN
    RAISE EXCEPTION 'task interval identity conflicts with task reference'
      USING ERRCODE = '23514';
  END IF;

  SELECT revision.interval_revision_id
  INTO existing_revision
  FROM gowm_history.task_execution_interval_revision revision
  WHERE revision.interval_id = interval_row.interval_id
    AND revision.content_hash = p_content_hash;
  IF FOUND THEN
    RETURN existing_revision;
  END IF;

  SELECT head.current_revision_id
  INTO current_revision
  FROM gowm_history.task_execution_interval_head head
  WHERE head.interval_id = interval_row.interval_id
  FOR UPDATE;
  IF FOUND AND p_supersedes_revision_id IS DISTINCT FROM current_revision THEN
    RAISE EXCEPTION 'task interval revision must supersede the current head'
      USING ERRCODE = '40001';
  ELSIF NOT FOUND AND p_supersedes_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'first task interval revision cannot supersede another revision'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(max(revision.revision_no), 0) + 1
  INTO next_revision
  FROM gowm_history.task_execution_interval_revision revision
  WHERE revision.interval_id = interval_row.interval_id;

  INSERT INTO gowm_history.task_execution_interval_revision(
    interval_revision_id, interval_id, revision_no, execution_range,
    lifecycle_state, derivation_kind, stability_state, start_event_id,
    terminal_event_id, input_event_set_hash, profile_key, profile_version,
    profile_hash, confidence, reason_codes, world_version, content_hash,
    supersedes_revision_id
  ) VALUES (
    new_revision, interval_row.interval_id, next_revision, p_execution_range,
    p_lifecycle_state, p_derivation_kind, p_stability_state, p_start_event_id,
    p_terminal_event_id, p_input_event_set_hash, p_profile_key, p_profile_version,
    p_profile_hash, p_confidence, COALESCE(p_reason_codes, '{}'), new_world_version,
    p_content_hash, p_supersedes_revision_id
  );

  FOR phase_row IN SELECT value FROM jsonb_array_elements(p_phases)
  LOOP
    INSERT INTO gowm_history.task_execution_phase(
      interval_revision_id, phase_no, phase_kind, phase_range,
      start_event_id, end_event_id, confidence, reason_codes
    ) VALUES (
      new_revision,
      (phase_row->>'phaseNo')::integer,
      phase_row->>'phaseKind',
      (phase_row->>'phaseRange')::tstzrange,
      NULLIF(phase_row->>'startEventId', ''),
      NULLIF(phase_row->>'endEventId', ''),
      NULLIF(phase_row->>'confidence', '')::double precision,
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(phase_row->'reasonCodes')), '{}')
    );
  END LOOP;

  FOR input_row IN SELECT value FROM jsonb_array_elements(p_inputs)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM public.operational_task_event event
      WHERE event.data_scope_key = p_data_scope_key
        AND event.operational_task_id = p_operational_task_id
        AND event.event_id = input_row->>'eventId'
        AND event.content_hash = input_row->>'eventContentHash'
    ) THEN
      RAISE EXCEPTION 'task interval input is absent, cross-scope, or hash-mismatched'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO gowm_history.task_execution_interval_input(
      interval_revision_id, event_no, data_scope_key, operational_event_id,
      event_content_hash, input_role
    ) VALUES (
      new_revision,
      (input_row->>'eventNo')::integer,
      p_data_scope_key,
      input_row->>'eventId',
      input_row->>'eventContentHash',
      input_row->>'inputRole'
    );
    input_count := input_count + 1;
  END LOOP;

  SELECT count(*) INTO total_event_count
  FROM public.operational_task_event event
  WHERE event.data_scope_key = p_data_scope_key
    AND event.operational_task_id = p_operational_task_id;

  SELECT public.grounding_sha256(COALESCE(jsonb_agg(jsonb_build_array(
    event.event_time,
    event.received_time,
    event.source_authority,
    event.source_event_key,
    event.source_revision_no,
    event.event_id,
    event.content_hash
  ) ORDER BY
    event.event_time,
    event.received_time,
    event.source_authority,
    event.source_event_key,
    event.source_revision_no,
    event.event_id
  )::text, '[]'))
  INTO computed_input_hash
  FROM gowm_history.task_execution_interval_input input
  JOIN public.operational_task_event event
    ON event.data_scope_key = input.data_scope_key
   AND event.event_id = input.operational_event_id
  WHERE input.interval_revision_id = new_revision;

  IF input_count <> total_event_count
     OR computed_input_hash IS DISTINCT FROM p_input_event_set_hash
     OR (p_start_event_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM gowm_history.task_execution_interval_input input
       WHERE input.interval_revision_id = new_revision
         AND input.operational_event_id = p_start_event_id
     ))
     OR (p_terminal_event_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM gowm_history.task_execution_interval_input input
       WHERE input.interval_revision_id = new_revision
         AND input.operational_event_id = p_terminal_event_id
     )) THEN
    RAISE EXCEPTION 'task interval input event set hash mismatch'
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('gowm.history_projection_write', 'on', true);
  INSERT INTO gowm_history.task_execution_interval_head(interval_id, current_revision_id)
  VALUES (interval_row.interval_id, new_revision)
  ON CONFLICT (interval_id) DO UPDATE
    SET current_revision_id = EXCLUDED.current_revision_id,
        updated_at = clock_timestamp();
  PERFORM set_config('gowm.history_projection_write', 'off', true);

  INSERT INTO public.world_reference_descriptor_version(
    reference_key, data_scope_key, reference_type, display_name,
    object_version, world_version, provenance, content_hash
  ) VALUES (
    interval_row.reference_key,
    p_data_scope_key,
    'TASK_EXECUTION_INTERVAL',
    'Task execution ' || p_execution_no::text || ' for ' || p_operational_task_id,
    next_revision::text,
    new_world_version,
    jsonb_build_array(jsonb_build_object(
      'authority', 'gowm.history',
      'intervalRevisionId', new_revision,
      'inputEventSetHash', p_input_event_set_hash
    )),
    public.grounding_sha256(
      interval_row.reference_key || ':' || next_revision::text || ':' || p_content_hash
    )
  );

  RETURN new_revision;
END
$fn$;

CREATE SCHEMA gowm_history_v1;

CREATE FUNCTION gowm_history_v1.current_data_scope_key()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('gowm.data_scope_key', true), '')
$$;

CREATE FUNCTION gowm_history_v1.set_data_scope(p_scope_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_scope_key IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.data_scope scope WHERE scope.scope_key = p_scope_key
  ) THEN
    RAISE EXCEPTION 'history scope is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('gowm.data_scope_key', p_scope_key, true);
END
$fn$;

CREATE VIEW gowm_history_v1.task_execution_interval_effective
WITH (security_barrier = true)
AS
SELECT
  interval.interval_id,
  interval.data_scope_key,
  interval.operational_task_id,
  interval.task_reference_key,
  interval.execution_no,
  interval.reference_key,
  revision.interval_revision_id,
  revision.revision_no,
  revision.execution_range,
  revision.lifecycle_state,
  revision.derivation_kind,
  revision.stability_state,
  revision.start_event_id,
  revision.terminal_event_id,
  revision.input_event_set_hash,
  revision.profile_key,
  revision.profile_version,
  revision.profile_hash,
  revision.confidence,
  revision.reason_codes,
  revision.world_version,
  revision.content_hash,
  revision.created_at
FROM gowm_history.task_execution_interval interval
JOIN gowm_history.task_execution_interval_head head USING (interval_id)
JOIN gowm_history.task_execution_interval_revision revision
  ON revision.interval_revision_id = head.current_revision_id
WHERE interval.data_scope_key = gowm_history_v1.current_data_scope_key();

CREATE VIEW gowm_history_v1.task_execution_phase
WITH (security_barrier = true)
AS
SELECT
  phase.interval_revision_id,
  phase.phase_no,
  phase.phase_kind,
  phase.phase_range,
  phase.start_event_id,
  phase.end_event_id,
  phase.confidence,
  phase.reason_codes
FROM gowm_history.task_execution_phase phase
JOIN gowm_history.task_execution_interval_revision revision USING (interval_revision_id)
JOIN gowm_history.task_execution_interval interval USING (interval_id)
WHERE interval.data_scope_key = gowm_history_v1.current_data_scope_key();

CREATE FUNCTION gowm_history_v1.task_execution_intervals_as_of(
  p_task_reference_key text,
  p_captured_at timestamptz
)
RETURNS SETOF gowm_history_v1.task_execution_interval_effective
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history, gowm_history_v1
AS $fn$
  SELECT DISTINCT ON (interval.interval_id)
    interval.interval_id,
    interval.data_scope_key,
    interval.operational_task_id,
    interval.task_reference_key,
    interval.execution_no,
    interval.reference_key,
    revision.interval_revision_id,
    revision.revision_no,
    revision.execution_range,
    revision.lifecycle_state,
    revision.derivation_kind,
    revision.stability_state,
    revision.start_event_id,
    revision.terminal_event_id,
    revision.input_event_set_hash,
    revision.profile_key,
    revision.profile_version,
    revision.profile_hash,
    revision.confidence,
    revision.reason_codes,
    revision.world_version,
    revision.content_hash,
    revision.created_at
  FROM gowm_history.task_execution_interval interval
  JOIN gowm_history.task_execution_interval_revision revision USING (interval_id)
  WHERE interval.data_scope_key = gowm_history_v1.current_data_scope_key()
    AND interval.task_reference_key = p_task_reference_key
    AND revision.created_at <= p_captured_at
  ORDER BY interval.interval_id, revision.created_at DESC, revision.revision_no DESC
$fn$;

CREATE FUNCTION gowm_history_v1.task_execution_interval_revision_by_reference_as_of(
  p_interval_reference_key text,
  p_exact_revision_no integer,
  p_captured_at timestamptz
)
RETURNS SETOF gowm_history_v1.task_execution_interval_effective
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history, gowm_history_v1
AS $fn$
  SELECT
    interval.interval_id,
    interval.data_scope_key,
    interval.operational_task_id,
    interval.task_reference_key,
    interval.execution_no,
    interval.reference_key,
    revision.interval_revision_id,
    revision.revision_no,
    revision.execution_range,
    revision.lifecycle_state,
    revision.derivation_kind,
    revision.stability_state,
    revision.start_event_id,
    revision.terminal_event_id,
    revision.input_event_set_hash,
    revision.profile_key,
    revision.profile_version,
    revision.profile_hash,
    revision.confidence,
    revision.reason_codes,
    revision.world_version,
    revision.content_hash,
    revision.created_at
  FROM gowm_history.task_execution_interval interval
  JOIN gowm_history.task_execution_interval_revision revision USING (interval_id)
  WHERE interval.data_scope_key = gowm_history_v1.current_data_scope_key()
    AND interval.reference_key = p_interval_reference_key
    AND revision.revision_no = p_exact_revision_no
    AND revision.created_at <= p_captured_at
$fn$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_history_reader') THEN
    CREATE ROLE gowm_history_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_history_writer') THEN
    CREATE ROLE gowm_history_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_history_worker') THEN
    CREATE ROLE gowm_history_worker NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_history_service') THEN
    CREATE ROLE gowm_history_service NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_history_worker_service') THEN
    CREATE ROLE gowm_history_worker_service NOLOGIN INHERIT;
  END IF;
END
$roles$;

REVOKE ALL ON SCHEMA gowm_history, gowm_history_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_history, gowm_history_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_history, gowm_history_v1 FROM PUBLIC;

GRANT USAGE ON SCHEMA gowm_history_v1 TO gowm_history_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA gowm_history_v1 TO gowm_history_reader;
GRANT EXECUTE ON FUNCTION gowm_history_v1.current_data_scope_key() TO gowm_history_reader;
GRANT EXECUTE ON FUNCTION gowm_history_v1.set_data_scope(text) TO gowm_history_reader;
GRANT EXECUTE ON FUNCTION gowm_history_v1.task_execution_intervals_as_of(text, timestamptz)
  TO gowm_history_reader;
GRANT EXECUTE ON FUNCTION gowm_history_v1.task_execution_interval_revision_by_reference_as_of(
  text, integer, timestamptz
) TO gowm_history_reader;

GRANT USAGE ON SCHEMA gowm_history TO gowm_history_writer, gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.register_task_execution_interval_revision(
  text, text, integer, tstzrange, text, text, text, text, text, text,
  text, text, text, double precision, text[], text, uuid, jsonb, jsonb
) TO gowm_history_writer;
GRANT EXECUTE ON FUNCTION gowm_history.enqueue_task_interval_projection(text, text)
  TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.claim_task_interval_projection(text, integer, interval)
  TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.complete_task_interval_projection(uuid, text, bigint)
  TO gowm_history_worker;
GRANT EXECUTE ON FUNCTION gowm_history.fail_task_interval_projection(uuid, text, bigint, text, timestamptz)
  TO gowm_history_worker;

-- The dedicated worker assembles MobilityDB/PostGIS values in client-issued SQL
-- before calling the SECURITY DEFINER registration functions.  Schema USAGE is
-- required to resolve those public extension types without granting table DML.
GRANT USAGE ON SCHEMA public TO gowm_history_reader, gowm_history_worker;
GRANT gowm_history_writer TO gowm_history_worker;
GRANT gowm_history_worker TO gowm_history_worker_service;
GRANT gowm_history_reader TO gowm_history_service;
GRANT gowm_history_reader TO gowm_operational_service;
ALTER ROLE gowm_history_service SET statement_timeout = '30s';
ALTER ROLE gowm_history_worker SET statement_timeout = '30s';
ALTER ROLE gowm_history_worker_service SET statement_timeout = '30s';
ALTER ROLE gowm_history_worker_service SET lock_timeout = '5s';

COMMENT ON SCHEMA gowm_history IS
  'Append-only task interval, tracklet finalization, and historical trajectory evidence.';
COMMENT ON TABLE gowm_history.task_execution_interval_revision IS
  'Phenomenon-time execution interval revisions. OPEN ranges retain an infinite upper bound.';
COMMENT ON TABLE gowm_history.task_interval_projection_queue IS
  'Deterministic event-set work queue; event triggers enqueue only and never execute the interval FSM.';
COMMENT ON FUNCTION gowm_history_v1.task_execution_intervals_as_of(text, timestamptz) IS
  'Returns only revisions created at or before capturedAt; current heads are deliberately ignored.';
COMMENT ON FUNCTION gowm_history_v1.task_execution_interval_revision_by_reference_as_of(
  text, integer, timestamptz
) IS
  'Head-free exact TASK_EXECUTION_INTERVAL reference pin lookup, scope-filtered and bounded by capturedAt.';

COMMIT;
