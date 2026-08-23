BEGIN;

ALTER TABLE gowm_capability.gateway_job
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_until timestamptz,
  ADD CONSTRAINT gateway_job_lease_pair CHECK (
    (lease_owner IS NULL AND lease_until IS NULL)
    OR (lease_owner IS NOT NULL AND length(lease_owner) BETWEEN 1 AND 128 AND lease_until IS NOT NULL)
  );

-- Application timestamps can legitimately precede the database insert clock by
-- a few milliseconds. Preserve logical ordering without coupling event time to
-- the persistence clock.
ALTER TABLE gowm_capability.gateway_job
  DROP CONSTRAINT gateway_job_started_time,
  DROP CONSTRAINT gateway_job_completed_time,
  ADD CONSTRAINT gateway_job_time_order CHECK (
    completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at
  );

CREATE TABLE gowm_capability.world_query_job (
  query_id text PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES gowm_capability.gateway_job(job_id) ON DELETE CASCADE,
  public_job_id text NOT NULL UNIQUE,
  request_id text NOT NULL,
  principal_ref text NOT NULL,
  principal_hash text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  parameter_schema_hash text NOT NULL,
  plan_hash text NOT NULL,
  submission jsonb NOT NULL,
  authentication_method text NOT NULL,
  authenticated_at timestamptz NOT NULL,
  data_scope_claim text,
  dataset_scope_claim text,
  allow_experimental boolean NOT NULL DEFAULT false,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT world_query_job_query_id_format CHECK (query_id ~ '^[A-Za-z][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT world_query_job_public_job_id_format CHECK (public_job_id ~ '^[A-Za-z][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT world_query_job_request_id_format CHECK (request_id ~ '^[A-Za-z][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT world_query_job_principal_hash_format CHECK (principal_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT world_query_job_request_hash_format CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT world_query_job_parameter_hash_format CHECK (parameter_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT world_query_job_plan_hash_format CHECK (plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT world_query_job_idempotency_key CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  CONSTRAINT world_query_job_submission_object CHECK (
    jsonb_typeof(submission) = 'object'
    AND submission#>>'{plan,queryId}' = query_id
    AND submission->>'requestId' = request_id
    AND submission->>'idempotencyKey' = idempotency_key
    AND submission->>'parameterSchemaHash' = parameter_schema_hash
  ),
  CONSTRAINT world_query_job_result_object CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  UNIQUE (principal_hash, idempotency_key)
);

CREATE INDEX world_query_job_request_idx
  ON gowm_capability.world_query_job(request_id, created_at DESC);

CREATE TABLE gowm_capability.world_query_node_execution (
  job_id uuid NOT NULL REFERENCES gowm_capability.gateway_job(job_id) ON DELETE CASCADE,
  node_id text NOT NULL,
  node_ordinal smallint NOT NULL CHECK (node_ordinal BETWEEN 0 AND 63),
  operation_id text NOT NULL,
  operation_version text NOT NULL,
  provider_id text,
  state text NOT NULL,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  input_hash text,
  output_hash text,
  result_envelope jsonb,
  error jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  node_record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, node_id),
  UNIQUE (job_id, node_ordinal),
  FOREIGN KEY (operation_id, operation_version)
    REFERENCES gowm_capability.provider_operation(operation_id, operation_version),
  FOREIGN KEY (provider_id, operation_id, operation_version)
    REFERENCES gowm_capability.provider_operation(provider_id, operation_id, operation_version),
  CONSTRAINT world_query_node_id_format CHECK (node_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  CONSTRAINT world_query_node_state CHECK (state IN (
    'QUEUED','RUNNING','COMPLETED','PARTIAL','NO_DATA','SKIPPED','FAILED','CANCELLED'
  )),
  CONSTRAINT world_query_node_input_hash_format CHECK (input_hash IS NULL OR input_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT world_query_node_output_hash_format CHECK (output_hash IS NULL OR output_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT world_query_node_result_object CHECK (result_envelope IS NULL OR jsonb_typeof(result_envelope) = 'object'),
  CONSTRAINT world_query_node_error_object CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  CONSTRAINT world_query_node_record_object CHECK (
    jsonb_typeof(node_record) = 'object'
    AND node_record->>'nodeId' = node_id
    AND node_record->>'status' = state
    AND (node_record->>'attempt')::integer = attempt
  ),
  CONSTRAINT world_query_node_terminal_time CHECK (
    (state IN ('COMPLETED','PARTIAL','NO_DATA','SKIPPED','FAILED','CANCELLED') AND finished_at IS NOT NULL)
    OR state IN ('QUEUED','RUNNING')
  ),
  CONSTRAINT world_query_node_time_order CHECK (
    finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at
  )
);

CREATE INDEX world_query_node_resume_idx
  ON gowm_capability.world_query_node_execution(job_id, state, node_ordinal);

CREATE TABLE gowm_capability.world_query_node_transition (
  transition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  node_id text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 0),
  reason_code text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (job_id, node_id)
    REFERENCES gowm_capability.world_query_node_execution(job_id, node_id) ON DELETE CASCADE,
  CONSTRAINT world_query_node_transition_from CHECK (
    from_state IS NULL OR from_state IN ('QUEUED','RUNNING','COMPLETED','PARTIAL','NO_DATA','SKIPPED','FAILED','CANCELLED')
  ),
  CONSTRAINT world_query_node_transition_to CHECK (
    to_state IN ('QUEUED','RUNNING','COMPLETED','PARTIAL','NO_DATA','SKIPPED','FAILED','CANCELLED')
  )
);

CREATE INDEX world_query_node_transition_lookup_idx
  ON gowm_capability.world_query_node_transition(job_id, node_id, occurred_at, transition_id);

CREATE TRIGGER world_query_node_transition_immutable
  BEFORE UPDATE OR DELETE ON gowm_capability.world_query_node_transition
  FOR EACH ROW EXECUTE FUNCTION gowm_capability.reject_append_only_mutation();

CREATE FUNCTION gowm_capability.claim_world_query_job(
  p_worker text,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE(job_id uuid, query_id text)
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'worker identity is required' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'lease seconds must be between 1 and 3600' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT g.job_id, g.state AS from_state
    FROM gowm_capability.gateway_job g
    WHERE g.job_kind = 'WORLD_QUERY'
      AND g.state = 'QUEUED'
      AND g.cancellation_requested_at IS NULL
    ORDER BY g.priority DESC, g.created_at, g.job_id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  ), updated AS (
    UPDATE gowm_capability.gateway_job g
       SET state = 'RUNNING',
           lease_owner = p_worker,
           lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
           started_at = COALESCE(g.started_at, clock_timestamp()),
           attempt_count = g.attempt_count + 1,
           updated_at = clock_timestamp()
      FROM candidate c
     WHERE g.job_id = c.job_id
    RETURNING g.job_id, c.from_state
  ), transition AS (
    INSERT INTO gowm_capability.gateway_job_state_transition (
      job_id, from_state, to_state, reason_code, actor_kind
    )
    SELECT updated.job_id, updated.from_state, 'RUNNING', 'ASYNC_CLAIM', 'SYSTEM'
    FROM updated
    RETURNING job_id
  )
  SELECT updated.job_id, query_job.query_id
  FROM updated
  JOIN transition USING (job_id)
  JOIN gowm_capability.world_query_job query_job USING (job_id);
END
$fn$;

GRANT SELECT, INSERT ON gowm_capability.world_query_job TO gowm_gateway_runtime;
GRANT UPDATE (result, updated_at)
  ON gowm_capability.world_query_job TO gowm_gateway_runtime;
GRANT SELECT, INSERT ON gowm_capability.world_query_node_execution TO gowm_gateway_runtime;
GRANT UPDATE (
  provider_id, state, attempt, input_hash, output_hash, result_envelope,
  error, started_at, finished_at, node_record, updated_at
)
  ON gowm_capability.world_query_node_execution TO gowm_gateway_runtime;
GRANT SELECT, INSERT ON gowm_capability.world_query_node_transition TO gowm_gateway_runtime;
GRANT EXECUTE ON FUNCTION gowm_capability.claim_world_query_job(text, integer) TO gowm_gateway_runtime;
GRANT UPDATE (lease_owner, lease_until) ON gowm_capability.gateway_job TO gowm_gateway_runtime;

COMMIT;
