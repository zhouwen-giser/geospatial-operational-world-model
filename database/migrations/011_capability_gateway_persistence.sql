BEGIN;

-- Gateway-owned persistence.  This schema contains routing and execution
-- metadata only; it has no foreign keys into Foundation fact tables.
CREATE SCHEMA gowm_capability;

CREATE TABLE gowm_capability.provider_registry (
  provider_id text PRIMARY KEY,
  provider_version text NOT NULL,
  display_name text NOT NULL,
  owner_name text NOT NULL,
  protocol_version text NOT NULL DEFAULT '1.0',
  endpoint text NOT NULL,
  manifest_uri text NOT NULL,
  endpoint_bindings jsonb NOT NULL,
  manifest_hash text NOT NULL,
  implementation_digest text NOT NULL,
  source_ref text,
  source_git_commit text,
  approval_state text NOT NULL DEFAULT 'PENDING',
  approved_by text,
  approved_at timestamptz,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_id_format CHECK (provider_id ~ '^[a-z][a-z0-9.-]{2,127}$'),
  CONSTRAINT provider_version_nonempty CHECK (length(provider_version) BETWEEN 1 AND 64),
  CONSTRAINT provider_protocol_supported CHECK (protocol_version = '1.0'),
  CONSTRAINT provider_endpoint_registry_uri CHECK (endpoint ~ '^https?://[^[:space:]]+$'),
  CONSTRAINT provider_manifest_hash_format CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT provider_implementation_digest_format CHECK (implementation_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT provider_source_git_commit_format CHECK (
    source_git_commit IS NULL OR source_git_commit ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT provider_endpoint_bindings CHECK (
    COALESCE(
      jsonb_typeof(endpoint_bindings) = 'object'
      AND endpoint_bindings->>'manifest' ~ '^/.{0,255}$'
      AND endpoint_bindings->>'liveness' ~ '^/.{0,255}$'
      AND endpoint_bindings->>'readiness' ~ '^/.{0,255}$'
      AND endpoint_bindings->>'execute' ~ '^/.*\{operationId\}'
      AND length(endpoint_bindings->>'execute') <= 256
      AND endpoint_bindings->>'job' ~ '^/.*\{jobId\}'
      AND length(endpoint_bindings->>'job') <= 256,
      false
    )
  ),
  CONSTRAINT provider_approval_state CHECK (approval_state IN ('PENDING','APPROVED','REJECTED','REVOKED')),
  CONSTRAINT provider_approval_complete CHECK (
    (approval_state = 'APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (approval_state <> 'APPROVED' AND enabled = false)
  ),
  CONSTRAINT provider_enabled_requires_approval CHECK (NOT enabled OR approval_state = 'APPROVED')
);

CREATE UNIQUE INDEX provider_registry_endpoint_idx
  ON gowm_capability.provider_registry(endpoint);
CREATE INDEX provider_registry_enabled_idx
  ON gowm_capability.provider_registry(provider_id)
  WHERE enabled AND approval_state = 'APPROVED';

COMMENT ON COLUMN gowm_capability.provider_registry.display_name IS
  'Controlled catalog label supplied by deployment configuration; never trusted from a provider manifest.';

CREATE TABLE gowm_capability.provider_health_observation (
  health_observation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL REFERENCES gowm_capability.provider_registry(provider_id),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  health_state text NOT NULL,
  readiness_state text NOT NULL,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  detail_code text,
  detail_hash text,
  CONSTRAINT provider_health_state CHECK (health_state IN ('HEALTHY','DEGRADED','UNHEALTHY','UNKNOWN')),
  CONSTRAINT provider_readiness_state CHECK (readiness_state IN ('READY','NOT_READY','UNKNOWN')),
  CONSTRAINT provider_health_detail_hash_format CHECK (
    detail_hash IS NULL OR detail_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  UNIQUE (provider_id, observed_at, health_observation_id)
);

CREATE INDEX provider_health_latest_idx
  ON gowm_capability.provider_health_observation(provider_id, observed_at DESC, health_observation_id DESC);

CREATE VIEW gowm_capability.provider_health_current AS
SELECT DISTINCT ON (provider_id)
  health_observation_id,
  provider_id,
  observed_at,
  health_state,
  readiness_state,
  latency_ms,
  consecutive_failures,
  detail_code,
  detail_hash
FROM gowm_capability.provider_health_observation
ORDER BY provider_id, observed_at DESC, health_observation_id DESC;

CREATE TABLE gowm_capability.capability (
  operation_id text PRIMARY KEY,
  semantic_role text NOT NULL,
  data_binding text NOT NULL,
  result_semantics text NOT NULL,
  description text,
  deprecated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT capability_operation_id_format CHECK (operation_id ~ '^[a-z][a-z0-9.-]{2,127}$'),
  CONSTRAINT capability_semantic_role CHECK (semantic_role IN (
    'FOUNDATION_PRIMITIVE','FOUNDATION_DATA_QUERY','GENERIC_ANALYSIS','DOMAIN_ANALYSIS','PROJECTION_QUERY'
  )),
  CONSTRAINT capability_data_binding CHECK (data_binding IN (
    'WORLD_INDEPENDENT','CALLER_DATA_BOUND','WORLD_SNAPSHOT_BOUND','DATASET_VERSION_BOUND'
  )),
  CONSTRAINT capability_result_semantics CHECK (result_semantics IN (
    'TRANSFORMATION','VALIDATION','DERIVED_INDEX','DATA_QUERY','DERIVED_ANALYSIS','WORLD_PROJECTION'
  )),
  CONSTRAINT capability_retirement_order CHECK (
    retired_at IS NULL OR (deprecated_at IS NOT NULL AND retired_at >= deprecated_at)
  )
);

CREATE FUNCTION gowm_capability.valid_capability_ports(p_ports jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $fn$
DECLARE
  port jsonb;
  port_count integer;
  distinct_port_count integer;
BEGIN
  IF jsonb_typeof(p_ports) <> 'object' OR
     jsonb_typeof(p_ports->'inputs') <> 'array' OR
     jsonb_typeof(p_ports->'outputs') <> 'array' OR
     jsonb_array_length(p_ports->'inputs') > 64 OR
     jsonb_array_length(p_ports->'outputs') NOT BETWEEN 1 AND 64 THEN
    RETURN false;
  END IF;

  FOR port IN
    SELECT value
    FROM jsonb_array_elements((p_ports->'inputs') || (p_ports->'outputs'))
  LOOP
    IF jsonb_typeof(port) <> 'object' OR
       NOT port ?& ARRAY['name','schemaUri','schemaHash','valueKind','unitSemantics'] OR
       port - ARRAY['name','schemaUri','schemaHash','valueKind','unitSemantics'] <> '{}'::jsonb OR
       port->>'name' !~ '^[a-z][A-Za-z0-9_]{0,63}$' OR
       length(port->>'schemaUri') NOT BETWEEN 1 AND 512 OR
       port->>'schemaHash' !~ '^sha256:[0-9a-f]{64}$' OR
       port->>'valueKind' NOT IN (
         'ANY','SCALAR','POSITION','POSITIONS','GEOMETRY','FEATURE','FEATURE_COLLECTION',
         'H3_CELL','H3_CELL_SET','REFERENCE_KEY','DATASET_VERSION','ROW_SET','ARTIFACT_REFERENCE'
       ) OR
       port->>'unitSemantics' NOT IN (
         'UNSPECIFIED','DIMENSIONLESS','ANGULAR_DEGREES','LINEAR_METERS','DISCRETE'
       ) THEN
      RETURN false;
    END IF;
  END LOOP;

  SELECT count(*), count(DISTINCT value->>'name')
  INTO port_count, distinct_port_count
  FROM jsonb_array_elements(p_ports->'inputs');
  IF port_count <> distinct_port_count THEN RETURN false; END IF;

  SELECT count(*), count(DISTINCT value->>'name')
  INTO port_count, distinct_port_count
  FROM jsonb_array_elements(p_ports->'outputs');
  IF port_count <> distinct_port_count THEN RETURN false; END IF;

  RETURN true;
END
$fn$;

CREATE TABLE gowm_capability.provider_operation (
  operation_id text NOT NULL REFERENCES gowm_capability.capability(operation_id),
  operation_version text NOT NULL,
  provider_id text NOT NULL REFERENCES gowm_capability.provider_registry(provider_id),
  input_schema_uri text NOT NULL,
  input_schema_hash text NOT NULL,
  output_schema_uri text NOT NULL,
  output_schema_hash text NOT NULL,
  maturity text NOT NULL,
  scope_policy text NOT NULL,
  execution_mode text NOT NULL,
  execution_bindings text[] NOT NULL,
  critical_path_policy text NOT NULL,
  default_timeout_ms integer NOT NULL,
  maximum_timeout_ms integer NOT NULL,
  cost_class text NOT NULL,
  limits jsonb NOT NULL,
  ports jsonb NOT NULL,
  deprecation jsonb,
  data_snapshot_policy text NOT NULL,
  compute_snapshot_policy text NOT NULL DEFAULT 'REQUIRED',
  policy_version text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operation_id, operation_version),
  UNIQUE (provider_id, operation_id, operation_version),
  CONSTRAINT provider_operation_version_format CHECK (operation_version ~ '^[0-9]+\.[0-9]+$'),
  CONSTRAINT provider_operation_input_hash_format CHECK (input_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT provider_operation_output_hash_format CHECK (output_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT provider_operation_maturity CHECK (maturity IN (
    'PLANNED','EXPERIMENTAL','PREVIEW','STABLE','DEPRECATED','RETIRED'
  )),
  CONSTRAINT provider_operation_scope_policy CHECK (scope_policy IN (
    'IDENTITY_ONLY','REQUEST_CONTEXT','DATA_SCOPE_REQUIRED','DATASET_SCOPE_REQUIRED'
  )),
  CONSTRAINT provider_operation_execution_mode CHECK (execution_mode IN ('SYNC','ASYNC','SYNC_OR_ASYNC')),
  CONSTRAINT provider_operation_bindings_nonempty CHECK (cardinality(execution_bindings) BETWEEN 1 AND 5),
  CONSTRAINT provider_operation_bindings_no_null CHECK (array_position(execution_bindings, NULL) IS NULL),
  CONSTRAINT provider_operation_bindings_known CHECK (execution_bindings <@ ARRAY[
    'EMBEDDED_SDK','LOCAL_SIDECAR','SYNC_HTTP','ASYNC_JOB','VERSIONED_SQL_CONTRACT'
  ]::text[]),
  CONSTRAINT provider_operation_bindings_unique CHECK (
    cardinality(execution_bindings) =
      CASE WHEN 'EMBEDDED_SDK' = ANY(execution_bindings) THEN 1 ELSE 0 END
      + CASE WHEN 'LOCAL_SIDECAR' = ANY(execution_bindings) THEN 1 ELSE 0 END
      + CASE WHEN 'SYNC_HTTP' = ANY(execution_bindings) THEN 1 ELSE 0 END
      + CASE WHEN 'ASYNC_JOB' = ANY(execution_bindings) THEN 1 ELSE 0 END
      + CASE WHEN 'VERSIONED_SQL_CONTRACT' = ANY(execution_bindings) THEN 1 ELSE 0 END
  ),
  CONSTRAINT provider_operation_critical_path CHECK (critical_path_policy IN (
    'EMBEDDED_REQUIRED','LOCAL_PREFERRED','REMOTE_ALLOWED','REMOTE_ONLY'
  )),
  CONSTRAINT provider_operation_timeouts CHECK (
    default_timeout_ms > 0 AND maximum_timeout_ms >= default_timeout_ms
  ),
  CONSTRAINT provider_operation_cost_class CHECK (cost_class IN ('LOW','MEDIUM','HIGH')),
  CONSTRAINT provider_operation_limits_object CHECK (
    jsonb_typeof(limits) = 'object' AND limits <> '{}'::jsonb
  ),
  CONSTRAINT provider_operation_ports CHECK (
    gowm_capability.valid_capability_ports(ports)
  ),
  CONSTRAINT provider_operation_deprecation CHECK (
    deprecation IS NULL OR COALESCE(
      jsonb_typeof(deprecation) = 'object'
      AND length(deprecation->>'message') BETWEEN 1 AND 512
      AND (deprecation->>'replacementOperationId' IS NULL OR
           deprecation->>'replacementOperationId' ~ '^[a-z][a-z0-9.-]{2,127}$')
      AND (deprecation->>'retireAfter' IS NULL OR
           deprecation->>'retireAfter' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      false
    )
  ),
  CONSTRAINT provider_operation_data_snapshot CHECK (data_snapshot_policy IN ('NONE','OPTIONAL','REQUIRED')),
  CONSTRAINT provider_operation_compute_snapshot CHECK (compute_snapshot_policy = 'REQUIRED'),
  CONSTRAINT provider_operation_data_binding_snapshot CHECK (
    (scope_policy IN ('DATA_SCOPE_REQUIRED','DATASET_SCOPE_REQUIRED') AND data_snapshot_policy <> 'NONE')
    OR (scope_policy NOT IN ('DATA_SCOPE_REQUIRED','DATASET_SCOPE_REQUIRED'))
  )
);

CREATE INDEX provider_operation_provider_idx
  ON gowm_capability.provider_operation(provider_id, enabled, operation_id, operation_version);
CREATE INDEX provider_operation_catalog_idx
  ON gowm_capability.provider_operation(maturity, operation_id, operation_version)
  WHERE enabled AND maturity NOT IN ('RETIRED','PLANNED');

CREATE TABLE gowm_capability.gateway_job (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_kind text NOT NULL,
  operation_id text,
  operation_version text,
  principal_hash text NOT NULL,
  data_scope_key text,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED',
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  deadline_at timestamptz,
  cancellation_requested_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failure_code text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (operation_id, operation_version)
    REFERENCES gowm_capability.provider_operation(operation_id, operation_version),
  CONSTRAINT gateway_job_kind CHECK (job_kind IN ('DIRECT_OPERATION','WORLD_QUERY')),
  CONSTRAINT gateway_job_operation_binding CHECK (
    (job_kind = 'DIRECT_OPERATION' AND operation_id IS NOT NULL AND operation_version IS NOT NULL)
    OR (job_kind = 'WORLD_QUERY' AND operation_id IS NULL AND operation_version IS NULL)
  ),
  CONSTRAINT gateway_job_principal_hash_format CHECK (principal_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT gateway_job_request_hash_format CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT gateway_job_state CHECK (state IN (
    'QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED','TIMED_OUT'
  )),
  CONSTRAINT gateway_job_terminal_time CHECK (
    (state IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','TIMED_OUT') AND completed_at IS NOT NULL)
    OR (state NOT IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','TIMED_OUT'))
  ),
  CONSTRAINT gateway_job_started_time CHECK (started_at IS NULL OR started_at >= created_at),
  CONSTRAINT gateway_job_completed_time CHECK (completed_at IS NULL OR completed_at >= COALESCE(started_at, created_at))
);

CREATE INDEX gateway_job_claim_idx
  ON gowm_capability.gateway_job(priority DESC, created_at, job_id)
  WHERE state = 'QUEUED';
CREATE INDEX gateway_job_scope_state_idx
  ON gowm_capability.gateway_job(data_scope_key, state, created_at DESC);

CREATE TABLE gowm_capability.gateway_job_state_transition (
  transition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES gowm_capability.gateway_job(job_id),
  from_state text,
  to_state text NOT NULL,
  reason_code text,
  actor_kind text NOT NULL,
  trace_id text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT gateway_job_transition_from_state CHECK (
    from_state IS NULL OR from_state IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED','TIMED_OUT')
  ),
  CONSTRAINT gateway_job_transition_to_state CHECK (
    to_state IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED','TIMED_OUT')
  ),
  CONSTRAINT gateway_job_transition_actor CHECK (actor_kind IN ('GATEWAY','PROVIDER','OPERATOR','SYSTEM'))
);

CREATE INDEX gateway_job_transition_job_idx
  ON gowm_capability.gateway_job_state_transition(job_id, occurred_at, transition_id);

CREATE TABLE gowm_capability.execution_receipt (
  receipt_id text PRIMARY KEY DEFAULT ('receipt_' || gen_random_uuid()::text),
  job_id uuid REFERENCES gowm_capability.gateway_job(job_id),
  operation_id text NOT NULL,
  operation_version text NOT NULL,
  provider_id text NOT NULL REFERENCES gowm_capability.provider_registry(provider_id),
  provider_version text NOT NULL,
  input_hash text NOT NULL,
  output_hash text NOT NULL,
  engine_name text NOT NULL,
  engine_version text NOT NULL,
  method_id text NOT NULL,
  method_version text NOT NULL,
  policy_version text NOT NULL,
  input_schema_hash text NOT NULL,
  output_schema_hash text NOT NULL,
  compute_snapshot_hash text NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  outcome text NOT NULL,
  compute_snapshot jsonb NOT NULL,
  data_snapshot jsonb,
  warnings text[] NOT NULL DEFAULT '{}',
  changes jsonb NOT NULL DEFAULT '{"repairApplied":false,"typeChanged":false}'::jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  previous_receipt_id text REFERENCES gowm_capability.execution_receipt(receipt_id),
  FOREIGN KEY (operation_id, operation_version)
    REFERENCES gowm_capability.provider_operation(operation_id, operation_version),
  FOREIGN KEY (provider_id, operation_id, operation_version)
    REFERENCES gowm_capability.provider_operation(provider_id, operation_id, operation_version),
  CONSTRAINT execution_receipt_id_format CHECK (receipt_id ~ '^[A-Za-z][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT execution_receipt_input_hash_format CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT execution_receipt_output_hash_format CHECK (output_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT execution_receipt_input_schema_hash_format CHECK (input_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT execution_receipt_output_schema_hash_format CHECK (output_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT execution_receipt_compute_snapshot_hash_format CHECK (compute_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT execution_receipt_outcome CHECK (outcome IN (
    'SUCCEEDED','PARTIAL','NO_DATA','INDETERMINATE','REJECTED','FAILED','TIMED_OUT','CANCELLED'
  )),
  CONSTRAINT execution_receipt_compute_snapshot CHECK (
    COALESCE(
      jsonb_typeof(compute_snapshot) = 'object'
      AND jsonb_typeof(compute_snapshot->'provider') = 'object'
      AND compute_snapshot#>>'{provider,providerId}' = provider_id
      AND compute_snapshot#>>'{provider,providerVersion}' = provider_version
      AND jsonb_typeof(compute_snapshot->'operation') = 'object'
      AND compute_snapshot#>>'{operation,operationId}' = operation_id
      AND compute_snapshot#>>'{operation,operationVersion}' = operation_version
      AND jsonb_typeof(compute_snapshot->'engine') = 'object'
      AND compute_snapshot#>>'{engine,name}' = engine_name
      AND compute_snapshot#>>'{engine,version}' = engine_version
      AND jsonb_typeof(compute_snapshot->'policy') = 'object'
      AND compute_snapshot#>>'{policy,version}' = policy_version
      AND compute_snapshot#>>'{policy,digest}' ~ '^sha256:[0-9a-f]{64}$'
      AND jsonb_typeof(compute_snapshot->'schemas') = 'object'
      AND compute_snapshot#>>'{schemas,inputSchemaHash}' = input_schema_hash
      AND compute_snapshot#>>'{schemas,outputSchemaHash}' = output_schema_hash,
      false
    )
  ),
  CONSTRAINT execution_receipt_data_snapshot CHECK (
    data_snapshot IS NULL OR (
      COALESCE(
        jsonb_typeof(data_snapshot) = 'object'
        AND data_snapshot->>'consistency' IN ('PINNED','CONSISTENT_AT_START','BEST_EFFORT')
        AND length(data_snapshot->>'capturedAt') > 0
        AND data_snapshot->>'scopeDigest' ~ '^sha256:[0-9a-f]{64}$'
        AND jsonb_typeof(data_snapshot->'resources') = 'array'
        AND jsonb_array_length(data_snapshot->'resources') > 0,
        false
      )
    )
  ),
  CONSTRAINT execution_receipt_changes CHECK (
    COALESCE(
      jsonb_typeof(changes) = 'object'
      AND jsonb_typeof(changes->'repairApplied') = 'boolean'
      AND jsonb_typeof(changes->'typeChanged') = 'boolean',
      false
    )
  ),
  CONSTRAINT execution_receipt_warnings CHECK (
    cardinality(warnings) <= 128 AND array_position(warnings, NULL) IS NULL
  ),
  CONSTRAINT execution_receipt_details_object CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX execution_receipt_job_idx
  ON gowm_capability.execution_receipt(job_id, generated_at, receipt_id);
CREATE INDEX execution_receipt_operation_idx
  ON gowm_capability.execution_receipt(operation_id, operation_version, generated_at DESC);

CREATE TABLE gowm_capability.receipt_evidence_reference (
  receipt_id text NOT NULL REFERENCES gowm_capability.execution_receipt(receipt_id),
  evidence_ordinal integer NOT NULL CHECK (evidence_ordinal >= 0),
  evidence_id text NOT NULL,
  authority text NOT NULL,
  evidence_type text NOT NULL,
  reference_key jsonb NOT NULL,
  schema_uri text NOT NULL,
  schema_hash text NOT NULL,
  payload_ref text,
  data_scope_key text,
  observed_at timestamptz,
  world_version bigint CHECK (world_version IS NULL OR world_version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (receipt_id, evidence_ordinal),
  CONSTRAINT receipt_evidence_type CHECK (evidence_type IN (
    'OBSERVATION','WORLD_EVENT','TRACKLET_VERSION','DATASET_VERSION','LAYER_VERSION','ANALYSIS_RECORD','CURRENT_PROJECTION_SOURCE'
  )),
  CONSTRAINT receipt_evidence_reference_key CHECK (
    COALESCE(
      jsonb_typeof(reference_key) = 'object'
      AND reference_key->>'namespace' ~ '^[a-z][a-z0-9_.-]{1,63}$'
      AND reference_key->>'kind' ~ '^[A-Z][A-Z0-9_]{1,63}$'
      AND length(reference_key->>'id') BETWEEN 1 AND 256
      AND length(reference_key->>'version') BETWEEN 1 AND 128,
      false
    )
  ),
  CONSTRAINT receipt_evidence_schema_hash_format CHECK (schema_hash ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX receipt_evidence_lookup_idx
  ON gowm_capability.receipt_evidence_reference(authority, evidence_type, evidence_id);

CREATE TABLE gowm_capability.idempotency_record (
  idempotency_record_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_hash text NOT NULL,
  operation_id text NOT NULL,
  operation_version text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  job_id uuid REFERENCES gowm_capability.gateway_job(job_id),
  receipt_id text REFERENCES gowm_capability.execution_receipt(receipt_id),
  result_envelope jsonb,
  status text NOT NULL DEFAULT 'IN_PROGRESS',
  lease_owner text,
  lease_until timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (operation_id, operation_version)
    REFERENCES gowm_capability.provider_operation(operation_id, operation_version),
  CONSTRAINT idempotency_principal_hash_format CHECK (principal_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT idempotency_request_hash_format CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT idempotency_key_nonempty CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  CONSTRAINT idempotency_status CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
  CONSTRAINT idempotency_result_envelope_object CHECK (
    result_envelope IS NULL OR jsonb_typeof(result_envelope) = 'object'
  ),
  CONSTRAINT idempotency_state_payload CHECK (
    (status = 'IN_PROGRESS'
      AND result_envelope IS NULL
      AND receipt_id IS NULL
      AND lease_owner IS NOT NULL
      AND lease_until IS NOT NULL)
    OR (status = 'COMPLETED'
      AND result_envelope IS NOT NULL
      AND receipt_id IS NOT NULL
      AND lease_owner IS NULL
      AND lease_until IS NULL)
    OR (status = 'FAILED'
      AND lease_owner IS NULL
      AND lease_until IS NULL)
  ),
  CONSTRAINT idempotency_lease_order CHECK (
    lease_until IS NULL OR lease_until > created_at
  ),
  CONSTRAINT idempotency_expiry_order CHECK (expires_at > created_at),
  UNIQUE (principal_hash, operation_id, operation_version, idempotency_key)
);

CREATE INDEX idempotency_expiry_idx
  ON gowm_capability.idempotency_record(expires_at);
CREATE INDEX idempotency_recovery_idx
  ON gowm_capability.idempotency_record(lease_until, idempotency_record_id)
  WHERE status = 'IN_PROGRESS';

-- One row lock serializes all callers for the same idempotency tuple. A caller
-- either creates the lease, observes an active owner, replays a completed
-- envelope, or recovers an expired in-progress lease after a process restart.
CREATE FUNCTION gowm_capability.claim_idempotency(
  p_principal_hash text,
  p_operation_id text,
  p_operation_version text,
  p_idempotency_key text,
  p_request_hash text,
  p_lease_owner text,
  p_lease_duration interval DEFAULT interval '30 seconds',
  p_retention interval DEFAULT interval '24 hours'
)
RETURNS TABLE (
  disposition text,
  out_idempotency_record_id uuid,
  out_job_id uuid,
  out_receipt_id text,
  out_result_envelope jsonb
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  claimed_id uuid;
  existing_record gowm_capability.idempotency_record%ROWTYPE;
  now_at timestamptz := clock_timestamp();
BEGIN
  IF p_principal_hash !~ '^sha256:[0-9a-f]{64}$' OR
     p_request_hash !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid idempotency hash' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 256 OR
     p_lease_owner IS NULL OR length(p_lease_owner) = 0 THEN
    RAISE EXCEPTION 'idempotency key and lease owner are required' USING ERRCODE = '22023';
  END IF;
  IF p_lease_duration <= interval '0 seconds' OR p_lease_duration > interval '5 minutes' OR
     p_retention <= p_lease_duration THEN
    RAISE EXCEPTION 'invalid idempotency lease or retention' USING ERRCODE = '22023';
  END IF;

  INSERT INTO gowm_capability.idempotency_record(
    principal_hash, operation_id, operation_version, idempotency_key,
    request_hash, status, lease_owner, lease_until, expires_at
  ) VALUES (
    p_principal_hash, p_operation_id, p_operation_version, p_idempotency_key,
    p_request_hash, 'IN_PROGRESS', p_lease_owner,
    now_at + p_lease_duration, now_at + p_retention
  )
  ON CONFLICT (principal_hash, operation_id, operation_version, idempotency_key) DO NOTHING
  RETURNING idempotency_record_id INTO claimed_id;

  IF claimed_id IS NOT NULL THEN
    RETURN QUERY SELECT 'CLAIMED_NEW'::text, claimed_id, NULL::uuid, NULL::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT record.* INTO STRICT existing_record
  FROM gowm_capability.idempotency_record record
  WHERE record.principal_hash = p_principal_hash
    AND record.operation_id = p_operation_id
    AND record.operation_version = p_operation_version
    AND record.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF existing_record.request_hash <> p_request_hash THEN
    RAISE EXCEPTION 'idempotency key reused with a different request hash'
      USING ERRCODE = '22000';
  END IF;

  IF existing_record.status = 'COMPLETED' THEN
    RETURN QUERY SELECT
      'REPLAY'::text,
      existing_record.idempotency_record_id,
      existing_record.job_id,
      existing_record.receipt_id,
      existing_record.result_envelope;
    RETURN;
  END IF;

  IF existing_record.status = 'FAILED' THEN
    RETURN QUERY SELECT
      'FAILED'::text,
      existing_record.idempotency_record_id,
      existing_record.job_id,
      existing_record.receipt_id,
      existing_record.result_envelope;
    RETURN;
  END IF;

  IF existing_record.lease_until <= now_at THEN
    UPDATE gowm_capability.idempotency_record record
    SET lease_owner = p_lease_owner,
        lease_until = now_at + p_lease_duration,
        expires_at = GREATEST(record.expires_at, now_at + p_retention),
        updated_at = now_at
    WHERE record.idempotency_record_id = existing_record.idempotency_record_id;
    RETURN QUERY SELECT
      'CLAIMED_RECOVERED'::text,
      existing_record.idempotency_record_id,
      existing_record.job_id,
      NULL::text,
      NULL::jsonb;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    'IN_PROGRESS'::text,
    existing_record.idempotency_record_id,
    existing_record.job_id,
    NULL::text,
    NULL::jsonb;
END
$fn$;

CREATE TABLE gowm_capability.circuit_state (
  provider_id text NOT NULL REFERENCES gowm_capability.provider_registry(provider_id),
  operation_id text NOT NULL,
  operation_version text NOT NULL,
  state text NOT NULL DEFAULT 'CLOSED',
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  opened_at timestamptz,
  retry_after timestamptz,
  probe_lease_until timestamptz,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider_id, operation_id, operation_version),
  FOREIGN KEY (operation_id, operation_version)
    REFERENCES gowm_capability.provider_operation(operation_id, operation_version),
  FOREIGN KEY (provider_id, operation_id, operation_version)
    REFERENCES gowm_capability.provider_operation(provider_id, operation_id, operation_version),
  CONSTRAINT circuit_state_value CHECK (state IN ('CLOSED','OPEN','HALF_OPEN')),
  CONSTRAINT circuit_open_time CHECK (state <> 'OPEN' OR opened_at IS NOT NULL)
);

CREATE INDEX circuit_retry_idx
  ON gowm_capability.circuit_state(retry_after, provider_id)
  WHERE state = 'OPEN';

CREATE TABLE gowm_capability.circuit_transition (
  circuit_transition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL,
  operation_id text NOT NULL,
  operation_version text NOT NULL,
  from_state text,
  to_state text NOT NULL,
  failure_code text,
  trace_id text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (provider_id, operation_id, operation_version)
    REFERENCES gowm_capability.circuit_state(provider_id, operation_id, operation_version),
  CONSTRAINT circuit_transition_from_state CHECK (from_state IS NULL OR from_state IN ('CLOSED','OPEN','HALF_OPEN')),
  CONSTRAINT circuit_transition_to_state CHECK (to_state IN ('CLOSED','OPEN','HALF_OPEN'))
);

CREATE INDEX circuit_transition_lookup_idx
  ON gowm_capability.circuit_transition(provider_id, operation_id, operation_version, occurred_at DESC);

CREATE TABLE gowm_capability.gateway_audit_event (
  audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  outcome text NOT NULL,
  principal_hash text NOT NULL,
  operation_id text,
  operation_version text,
  provider_id text REFERENCES gowm_capability.provider_registry(provider_id),
  job_id uuid REFERENCES gowm_capability.gateway_job(job_id),
  receipt_id text REFERENCES gowm_capability.execution_receipt(receipt_id),
  request_hash text,
  response_hash text,
  data_scope_hash text,
  trace_id text NOT NULL,
  reason_code text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT gateway_audit_principal_hash_format CHECK (principal_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT gateway_audit_request_hash_format CHECK (request_hash IS NULL OR request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT gateway_audit_response_hash_format CHECK (response_hash IS NULL OR response_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT gateway_audit_scope_hash_format CHECK (data_scope_hash IS NULL OR data_scope_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT gateway_audit_outcome CHECK (outcome IN ('ALLOWED','DENIED','SUCCEEDED','PARTIAL','FAILED','CANCELLED','TIMED_OUT')),
  CONSTRAINT gateway_audit_metrics_object CHECK (jsonb_typeof(metrics) = 'object')
);

CREATE INDEX gateway_audit_trace_idx
  ON gowm_capability.gateway_audit_event(trace_id, occurred_at, audit_event_id);
CREATE INDEX gateway_audit_operation_time_idx
  ON gowm_capability.gateway_audit_event(operation_id, operation_version, occurred_at DESC);

CREATE FUNCTION gowm_capability.reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER provider_health_observation_immutable
  BEFORE UPDATE OR DELETE ON gowm_capability.provider_health_observation
  FOR EACH ROW EXECUTE FUNCTION gowm_capability.reject_append_only_mutation();
CREATE TRIGGER gateway_job_state_transition_immutable
  BEFORE UPDATE OR DELETE ON gowm_capability.gateway_job_state_transition
  FOR EACH ROW EXECUTE FUNCTION gowm_capability.reject_append_only_mutation();
CREATE TRIGGER execution_receipt_immutable
  BEFORE UPDATE OR DELETE ON gowm_capability.execution_receipt
  FOR EACH ROW EXECUTE FUNCTION gowm_capability.reject_append_only_mutation();
CREATE TRIGGER receipt_evidence_reference_immutable
  BEFORE UPDATE OR DELETE ON gowm_capability.receipt_evidence_reference
  FOR EACH ROW EXECUTE FUNCTION gowm_capability.reject_append_only_mutation();
CREATE TRIGGER circuit_transition_immutable
  BEFORE UPDATE OR DELETE ON gowm_capability.circuit_transition
  FOR EACH ROW EXECUTE FUNCTION gowm_capability.reject_append_only_mutation();
CREATE TRIGGER gateway_audit_event_immutable
  BEFORE UPDATE OR DELETE ON gowm_capability.gateway_audit_event
  FOR EACH ROW EXECUTE FUNCTION gowm_capability.reject_append_only_mutation();

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_gateway_runtime') THEN
    CREATE ROLE gowm_gateway_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_gateway_registry_admin') THEN
    CREATE ROLE gowm_gateway_registry_admin NOLOGIN;
  END IF;
END
$roles$;

REVOKE ALL ON SCHEMA gowm_capability FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_capability FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_capability FROM PUBLIC;

GRANT USAGE ON SCHEMA gowm_capability TO gowm_gateway_runtime;
GRANT USAGE ON SCHEMA gowm_capability TO gowm_gateway_registry_admin;
GRANT SELECT ON
  gowm_capability.provider_registry,
  gowm_capability.provider_health_observation,
  gowm_capability.provider_health_current,
  gowm_capability.capability,
  gowm_capability.provider_operation
TO gowm_gateway_runtime;
GRANT SELECT, INSERT ON
  gowm_capability.gateway_job,
  gowm_capability.gateway_job_state_transition,
  gowm_capability.execution_receipt,
  gowm_capability.receipt_evidence_reference,
  gowm_capability.idempotency_record,
  gowm_capability.circuit_state,
  gowm_capability.circuit_transition,
  gowm_capability.gateway_audit_event,
  gowm_capability.provider_health_observation
TO gowm_gateway_runtime;
GRANT UPDATE (state, cancellation_requested_at, started_at, completed_at, failure_code, attempt_count, updated_at)
  ON gowm_capability.gateway_job TO gowm_gateway_runtime;
GRANT UPDATE (job_id, receipt_id, result_envelope, status, lease_owner, lease_until, expires_at, updated_at)
  ON gowm_capability.idempotency_record TO gowm_gateway_runtime;
GRANT UPDATE (state, consecutive_failures, opened_at, retry_after, probe_lease_until, revision, updated_at)
  ON gowm_capability.circuit_state TO gowm_gateway_runtime;
GRANT EXECUTE ON FUNCTION gowm_capability.claim_idempotency(
  text, text, text, text, text, text, interval, interval
) TO gowm_gateway_runtime;
GRANT SELECT, INSERT, UPDATE ON
  gowm_capability.provider_registry,
  gowm_capability.capability,
  gowm_capability.provider_operation
TO gowm_gateway_registry_admin;
GRANT EXECUTE ON FUNCTION gowm_capability.valid_capability_ports(jsonb)
  TO gowm_gateway_registry_admin;

COMMIT;
