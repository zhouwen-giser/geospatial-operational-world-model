\set ON_ERROR_STOP on

BEGIN;

DO $assert_catalog$
DECLARE
  append_only_triggers integer;
  foundation_fk_count integer;
BEGIN
  IF to_regnamespace('gowm_capability') IS NULL THEN
    RAISE EXCEPTION 'gowm_capability schema is missing';
  END IF;
  IF to_regclass('gowm_capability.provider_registry') IS NULL OR
     to_regclass('gowm_capability.provider_operation') IS NULL OR
     to_regclass('gowm_capability.gateway_job') IS NULL OR
     to_regclass('gowm_capability.execution_receipt') IS NULL OR
     to_regclass('gowm_capability.idempotency_record') IS NULL OR
     to_regclass('gowm_capability.circuit_state') IS NULL OR
     to_regclass('gowm_capability.gateway_audit_event') IS NULL THEN
    RAISE EXCEPTION 'gateway persistence catalog is incomplete';
  END IF;
  IF to_regprocedure('gowm_capability.valid_capability_ports(jsonb)') IS NULL OR
     (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'gowm_capability'
        AND table_name = 'provider_operation'
        AND column_name IN ('ports','deprecation')) <> 2 OR
     (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'gowm_capability'
        AND table_name = 'provider_registry'
        AND column_name IN ('display_name','endpoint_bindings','implementation_digest')) <> 3 THEN
    RAISE EXCEPTION 'approved provider descriptor persistence is incomplete';
  END IF;

  SELECT count(*) INTO append_only_triggers
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'gowm_capability'
    AND NOT t.tgisinternal
    AND t.tgname LIKE '%_immutable';
  -- Migration 013 adds the immutable World Query node transition guard to the
  -- six Gateway persistence guards introduced by migration 011.
  IF append_only_triggers <> 7 THEN
    RAISE EXCEPTION 'expected seven gateway append-only guards, found %', append_only_triggers;
  END IF;

  -- Gateway persistence must never own or mutate Foundation facts through an
  -- accidental foreign-key dependency.
  SELECT count(*) INTO foundation_fk_count
  FROM pg_constraint fk
  JOIN pg_class child ON child.oid = fk.conrelid
  JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
  JOIN pg_class parent ON parent.oid = fk.confrelid
  JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
  WHERE fk.contype = 'f'
    AND child_ns.nspname = 'gowm_capability'
    AND parent_ns.nspname = 'public';
  IF foundation_fk_count <> 0 THEN
    RAISE EXCEPTION 'gateway schema has % forbidden Foundation foreign keys', foundation_fk_count;
  END IF;

  IF has_table_privilege('gowm_gateway_runtime', 'public.world_object', 'SELECT') OR
     has_table_privilege('gowm_gateway_runtime', 'public.world_object', 'INSERT') OR
     has_table_privilege('gowm_gateway_runtime', 'gowm_capability.provider_registry', 'UPDATE') OR
     has_table_privilege('gowm_gateway_runtime', 'gowm_capability.execution_receipt', 'DELETE') OR
     has_table_privilege('gowm_gateway_runtime', 'gowm_capability.gateway_audit_event', 'UPDATE') THEN
    RAISE EXCEPTION 'gateway runtime privilege boundary is too broad';
  END IF;
  IF NOT has_table_privilege('gowm_gateway_runtime', 'gowm_capability.provider_operation', 'SELECT') OR
     NOT has_table_privilege('gowm_gateway_runtime', 'gowm_capability.execution_receipt', 'INSERT') OR
     NOT has_function_privilege(
       'gowm_gateway_runtime',
       'gowm_capability.claim_idempotency(text,text,text,text,text,text,interval,interval)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'gateway runtime required privileges are missing';
  END IF;
  IF NOT has_table_privilege(
       'gowm_gateway_registry_admin', 'gowm_capability.provider_registry', 'UPDATE'
     ) OR NOT has_function_privilege(
       'gowm_gateway_registry_admin',
       'gowm_capability.valid_capability_ports(jsonb)',
       'EXECUTE'
     ) OR has_table_privilege(
       'gowm_gateway_registry_admin', 'gowm_capability.execution_receipt', 'INSERT'
     ) THEN
    RAISE EXCEPTION 'controlled registry administration boundary is incorrect';
  END IF;

  IF NOT gowm_capability.valid_capability_ports(
    '{"inputs":[],"outputs":[{"name":"references","path":"/references/0","schemaUri":"urn:test:reference","schemaHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","valueKind":"REFERENCE_KEY","unitSemantics":"DISCRETE"}]}'::jsonb
  ) OR gowm_capability.valid_capability_ports(
    '{"inputs":[],"outputs":[{"name":"references","path":"references/0","schemaUri":"urn:test:reference","schemaHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","valueKind":"REFERENCE_KEY","unitSemantics":"DISCRETE"}]}'::jsonb
  ) THEN
    RAISE EXCEPTION 'capability port JSON Pointer contract is not enforced';
  END IF;
END
$assert_catalog$;

INSERT INTO gowm_capability.provider_registry(
  provider_id, provider_version, display_name, owner_name, endpoint,
  manifest_uri, endpoint_bindings, manifest_hash, implementation_digest,
  approval_state, approved_by, approved_at, enabled
)
VALUES (
  'test.gateway-provider', '1.0.0', 'Gateway DB test provider', 'GOWM test',
  'http://gateway-db-test.invalid:8080', 'urn:test:gateway-provider',
  '{"manifest":"/v1/manifest","liveness":"/healthz","readiness":"/readyz","execute":"/v1/operations/{operationId}:execute","job":"/v1/jobs/{jobId}"}'::jsonb,
  'sha256:' || repeat('1', 64), 'sha256:' || repeat('0', 64),
  'APPROVED', 'database-test', clock_timestamp(), true
);

INSERT INTO gowm_capability.provider_health_observation(
  provider_id, health_state, readiness_state, latency_ms
)
VALUES ('test.gateway-provider', 'HEALTHY', 'READY', 1);

INSERT INTO gowm_capability.capability(
  operation_id, semantic_role, data_binding, result_semantics, description
)
VALUES (
  'test.gateway.execute', 'GENERIC_ANALYSIS', 'CALLER_DATA_BOUND',
  'DERIVED_ANALYSIS', 'transactional database assertion operation'
);

INSERT INTO gowm_capability.provider_operation(
  operation_id, operation_version, provider_id,
  input_schema_uri, input_schema_hash, output_schema_uri, output_schema_hash,
  maturity, scope_policy, execution_mode, execution_bindings,
  critical_path_policy, default_timeout_ms, maximum_timeout_ms, cost_class,
  limits, ports, data_snapshot_policy, policy_version, enabled
)
VALUES (
  'test.gateway.execute', '1.0', 'test.gateway-provider',
  'urn:test:input', 'sha256:' || repeat('2', 64),
  'urn:test:output', 'sha256:' || repeat('3', 64),
  'PREVIEW', 'REQUEST_CONTEXT', 'SYNC_OR_ASYNC', ARRAY['SYNC_HTTP','ASYNC_JOB'],
  'REMOTE_ALLOWED', 100, 1000, 'LOW',
  '{"maximumInputBytes":1024,"maximumOutputBytes":2048}'::jsonb,
  '{"inputs":[],"outputs":[{"name":"result","schemaUri":"urn:test:output","schemaHash":"sha256:3333333333333333333333333333333333333333333333333333333333333333","valueKind":"ANY","unitSemantics":"UNSPECIFIED"}]}'::jsonb,
  'NONE', 'test-policy-v1', true
);

DO $assert_registry_guards$
BEGIN
  BEGIN
    INSERT INTO gowm_capability.provider_operation(
      operation_id, operation_version, provider_id,
      input_schema_uri, input_schema_hash, output_schema_uri, output_schema_hash,
      maturity, scope_policy, execution_mode, execution_bindings,
      critical_path_policy, default_timeout_ms, maximum_timeout_ms, cost_class,
      limits, ports, data_snapshot_policy, policy_version
    ) VALUES (
      'test.gateway.execute', '1.0', 'test.gateway-provider',
      'urn:test:other-input', 'sha256:' || repeat('4', 64),
      'urn:test:other-output', 'sha256:' || repeat('5', 64),
      'PREVIEW', 'REQUEST_CONTEXT', 'SYNC', ARRAY['SYNC_HTTP'],
      'REMOTE_ALLOWED', 100, 100, 'LOW', '{"maximumInputBytes":1}'::jsonb,
      '{"inputs":[],"outputs":[{"name":"result","schemaUri":"urn:test:other-output","schemaHash":"sha256:5555555555555555555555555555555555555555555555555555555555555555","valueKind":"ANY","unitSemantics":"UNSPECIFIED"}]}'::jsonb,
      'NONE', 'test-policy-v1'
    );
    RAISE EXCEPTION 'duplicate operation/version was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE gowm_capability.provider_operation
    SET execution_bindings = ARRAY['SYNC_HTTP','SYNC_HTTP']
    WHERE operation_id = 'test.gateway.execute' AND operation_version = '1.0';
    RAISE EXCEPTION 'duplicate execution bindings were accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO gowm_capability.provider_operation(
      operation_id, operation_version, provider_id,
      input_schema_uri, input_schema_hash, output_schema_uri, output_schema_hash,
      maturity, scope_policy, execution_mode, execution_bindings,
      critical_path_policy, default_timeout_ms, maximum_timeout_ms, cost_class,
      limits, ports, data_snapshot_policy, policy_version
    ) VALUES (
      'test.gateway.execute', '1.1', 'test.gateway-provider',
      'urn:test:input', 'sha256:' || repeat('2', 64),
      'urn:test:output', 'sha256:' || repeat('3', 64),
      'PREVIEW', 'REQUEST_CONTEXT', 'SYNC', ARRAY['SYNC_HTTP'],
      'REMOTE_ALLOWED', 100, 100, 'LOW', '{"maximumInputBytes":1}'::jsonb,
      '{"inputs":[],"outputs":[{"name":"result"}]}'::jsonb,
      'NONE', 'test-policy-v1'
    );
    RAISE EXCEPTION 'structurally incomplete typed ports were accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$assert_registry_guards$;

WITH inserted_job AS (
  INSERT INTO gowm_capability.gateway_job(
    job_kind, operation_id, operation_version, principal_hash, request_hash
  ) VALUES (
    'DIRECT_OPERATION', 'test.gateway.execute', '1.0',
    'sha256:' || repeat('6', 64), 'sha256:' || repeat('7', 64)
  ) RETURNING job_id
)
INSERT INTO gowm_capability.gateway_job_state_transition(job_id, from_state, to_state, actor_kind)
SELECT job_id, NULL, 'QUEUED', 'GATEWAY' FROM inserted_job;

WITH target_job AS (
  SELECT job_id FROM gowm_capability.gateway_job
  WHERE operation_id = 'test.gateway.execute' ORDER BY created_at DESC LIMIT 1
), inserted_receipt AS (
  INSERT INTO gowm_capability.execution_receipt(
    job_id, operation_id, operation_version, provider_id, provider_version,
    input_hash, output_hash, engine_name, engine_version, method_id, method_version,
    policy_version, input_schema_hash, output_schema_hash, compute_snapshot_hash,
    duration_ms, outcome, compute_snapshot,
    data_snapshot, details
  )
  SELECT
    job_id, 'test.gateway.execute', '1.0', 'test.gateway-provider', '1.0.0',
    'sha256:' || repeat('7', 64), 'sha256:' || repeat('8', 64),
    'test-engine', '1.0.0', 'execute', '1.0.0', 'test-policy-v1',
    'sha256:' || repeat('2', 64), 'sha256:' || repeat('3', 64),
    'sha256:' || repeat('9', 64), 2, 'SUCCEEDED',
    jsonb_build_object(
      'provider', jsonb_build_object('providerId', 'test.gateway-provider', 'providerVersion', '1.0.0'),
      'operation', jsonb_build_object('operationId', 'test.gateway.execute', 'operationVersion', '1.0'),
      'engine', jsonb_build_object('name', 'test-engine', 'version', '1.0.0'),
      'policy', jsonb_build_object('version', 'test-policy-v1', 'digest', 'sha256:' || repeat('4', 64)),
      'schemas', jsonb_build_object(
        'inputSchemaHash', 'sha256:' || repeat('2', 64),
        'outputSchemaHash', 'sha256:' || repeat('3', 64)
      )
    ),
    NULL, '{"test":true}'::jsonb
  FROM target_job
  RETURNING receipt_id, job_id
)
INSERT INTO gowm_capability.receipt_evidence_reference(
  receipt_id, evidence_ordinal, evidence_id, authority, evidence_type, reference_key,
  schema_uri, schema_hash
)
SELECT receipt_id, 0, 'analysis:test', 'test-authority', 'ANALYSIS_RECORD',
       '{"namespace":"gowm","kind":"ANALYSIS_RECORD","id":"analysis-test","version":"1"}'::jsonb,
       'urn:test:evidence', 'sha256:' || repeat('a', 64)
FROM inserted_receipt;

INSERT INTO gowm_capability.idempotency_record(
  principal_hash, operation_id, operation_version, idempotency_key,
  request_hash, job_id, receipt_id, result_envelope, status, expires_at
)
SELECT
  'sha256:' || repeat('6', 64), 'test.gateway.execute', '1.0', 'db-test-key',
  'sha256:' || repeat('7', 64), j.job_id, r.receipt_id,
  jsonb_build_object('status', 'SUCCEEDED', 'receiptId', r.receipt_id), 'COMPLETED',
  clock_timestamp() + interval '1 hour'
FROM gowm_capability.gateway_job j
JOIN gowm_capability.execution_receipt r ON r.job_id = j.job_id
WHERE j.operation_id = 'test.gateway.execute';

INSERT INTO gowm_capability.circuit_state(
  provider_id, operation_id, operation_version, state
)
VALUES ('test.gateway-provider', 'test.gateway.execute', '1.0', 'CLOSED');

INSERT INTO gowm_capability.circuit_transition(
  provider_id, operation_id, operation_version, from_state, to_state
)
VALUES ('test.gateway-provider', 'test.gateway.execute', '1.0', NULL, 'CLOSED');

INSERT INTO gowm_capability.gateway_audit_event(
  event_type, outcome, principal_hash, operation_id, operation_version,
  provider_id, job_id, receipt_id, request_hash, response_hash, trace_id, metrics
)
SELECT
  'DIRECT_EXECUTION', 'SUCCEEDED', 'sha256:' || repeat('6', 64),
  'test.gateway.execute', '1.0', 'test.gateway-provider', j.job_id, r.receipt_id,
  'sha256:' || repeat('7', 64), 'sha256:' || repeat('8', 64),
  'trace-db-test', '{"durationMs":2}'::jsonb
FROM gowm_capability.gateway_job j
JOIN gowm_capability.execution_receipt r ON r.job_id = j.job_id
WHERE j.operation_id = 'test.gateway.execute';

DO $assert_runtime_semantics$
DECLARE
  test_receipt text;
  test_audit uuid;
  claim_disposition text;
  claimed_record_id uuid;
  replay_envelope jsonb;
BEGIN
  SELECT receipt_id INTO STRICT test_receipt
  FROM gowm_capability.execution_receipt
  WHERE operation_id = 'test.gateway.execute';
  SELECT audit_event_id INTO STRICT test_audit
  FROM gowm_capability.gateway_audit_event
  WHERE trace_id = 'trace-db-test';

  BEGIN
    UPDATE gowm_capability.idempotency_record
    SET result_envelope = NULL
    WHERE principal_hash = 'sha256:' || repeat('6', 64)
      AND idempotency_key = 'db-test-key';
    RAISE EXCEPTION 'COMPLETED idempotency row accepted a null result envelope';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO gowm_capability.idempotency_record(
      principal_hash, operation_id, operation_version, idempotency_key,
      request_hash, result_envelope, status, lease_owner, lease_until, expires_at
    ) VALUES (
      'sha256:' || repeat('0', 64), 'test.gateway.execute', '1.0', 'invalid-in-progress-result',
      'sha256:' || repeat('1', 64), '{"status":"SUCCEEDED"}'::jsonb,
      'IN_PROGRESS', 'invalid-owner', clock_timestamp() + interval '30 seconds',
      clock_timestamp() + interval '1 hour'
    );
    RAISE EXCEPTION 'IN_PROGRESS idempotency row accepted a result envelope';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE gowm_capability.execution_receipt
    SET outcome = 'FAILED'
    WHERE receipt_id = test_receipt;
    RAISE EXCEPTION 'receipt update was accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    DELETE FROM gowm_capability.gateway_audit_event
    WHERE audit_event_id = test_audit;
    RAISE EXCEPTION 'audit delete was accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    INSERT INTO gowm_capability.idempotency_record(
      principal_hash, operation_id, operation_version, idempotency_key,
      request_hash, result_envelope, status, expires_at
    ) VALUES (
      'sha256:' || repeat('6', 64), 'test.gateway.execute', '1.0', 'db-test-key',
      'sha256:' || repeat('f', 64), '{"status":"FAILED"}'::jsonb,
      'FAILED', clock_timestamp() + interval '1 hour'
    );
    RAISE EXCEPTION 'conflicting idempotency key was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  IF (SELECT health_state FROM gowm_capability.provider_health_current
      WHERE provider_id = 'test.gateway-provider') <> 'HEALTHY' THEN
    RAISE EXCEPTION 'provider current-health view did not resolve latest observation';
  END IF;

  SELECT disposition, out_result_envelope
  INTO STRICT claim_disposition, replay_envelope
  FROM gowm_capability.claim_idempotency(
    'sha256:' || repeat('6', 64), 'test.gateway.execute', '1.0', 'db-test-key',
    'sha256:' || repeat('7', 64), 'gateway-after-restart'
  );
  IF claim_disposition <> 'REPLAY' OR replay_envelope->>'status' <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'completed idempotency result was not replayable: %, %',
      claim_disposition, replay_envelope;
  END IF;

  SELECT disposition, out_idempotency_record_id
  INTO STRICT claim_disposition, claimed_record_id
  FROM gowm_capability.claim_idempotency(
    'sha256:' || repeat('b', 64), 'test.gateway.execute', '1.0', 'db-recovery-key',
    'sha256:' || repeat('c', 64), 'gateway-before-restart'
  );
  IF claim_disposition <> 'CLAIMED_NEW' THEN
    RAISE EXCEPTION 'new idempotency lease was not claimed: %', claim_disposition;
  END IF;

  SELECT disposition INTO STRICT claim_disposition
  FROM gowm_capability.claim_idempotency(
    'sha256:' || repeat('b', 64), 'test.gateway.execute', '1.0', 'db-recovery-key',
    'sha256:' || repeat('c', 64), 'gateway-concurrent'
  );
  IF claim_disposition <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'active idempotency lease was not protected: %', claim_disposition;
  END IF;

  -- Simulate elapsed wall time without sleeping. The row remains constraint
  -- valid because its synthetic creation time precedes the expired lease.
  UPDATE gowm_capability.idempotency_record
  SET created_at = clock_timestamp() - interval '2 minutes',
      lease_until = clock_timestamp() - interval '1 minute'
  WHERE idempotency_record_id = claimed_record_id;

  SELECT disposition INTO STRICT claim_disposition
  FROM gowm_capability.claim_idempotency(
    'sha256:' || repeat('b', 64), 'test.gateway.execute', '1.0', 'db-recovery-key',
    'sha256:' || repeat('c', 64), 'gateway-after-restart'
  );
  IF claim_disposition <> 'CLAIMED_RECOVERED' OR NOT EXISTS (
    SELECT 1 FROM gowm_capability.idempotency_record
    WHERE idempotency_record_id = claimed_record_id
      AND lease_owner = 'gateway-after-restart'
      AND lease_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'expired idempotency lease was not atomically recovered: %', claim_disposition;
  END IF;

  BEGIN
    PERFORM disposition
    FROM gowm_capability.claim_idempotency(
      'sha256:' || repeat('b', 64), 'test.gateway.execute', '1.0', 'db-recovery-key',
      'sha256:' || repeat('d', 64), 'gateway-conflict'
    );
    RAISE EXCEPTION 'idempotency key accepted a different request hash';
  EXCEPTION WHEN SQLSTATE '22000' THEN
    NULL;
  END;
END
$assert_runtime_semantics$;

SET LOCAL ROLE gowm_gateway_runtime;

DO $assert_runtime_claim$
DECLARE
  claim_disposition text;
BEGIN
  SELECT disposition INTO STRICT claim_disposition
  FROM gowm_capability.claim_idempotency(
    'sha256:' || repeat('e', 64), 'test.gateway.execute', '1.0', 'runtime-recovery-key',
    'sha256:' || repeat('f', 64), 'runtime-before-restart'
  );
  IF claim_disposition <> 'CLAIMED_NEW' THEN
    RAISE EXCEPTION 'gateway runtime could not claim a new idempotency lease: %', claim_disposition;
  END IF;

  SELECT disposition INTO STRICT claim_disposition
  FROM gowm_capability.claim_idempotency(
    'sha256:' || repeat('e', 64), 'test.gateway.execute', '1.0', 'runtime-recovery-key',
    'sha256:' || repeat('f', 64), 'runtime-concurrent'
  );
  IF claim_disposition <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'gateway runtime did not observe the active lease: %', claim_disposition;
  END IF;
END
$assert_runtime_claim$;

RESET ROLE;

UPDATE gowm_capability.idempotency_record
SET created_at = clock_timestamp() - interval '2 minutes',
    lease_until = clock_timestamp() - interval '1 minute'
WHERE principal_hash = 'sha256:' || repeat('e', 64)
  AND idempotency_key = 'runtime-recovery-key';

SET LOCAL ROLE gowm_gateway_runtime;

DO $assert_runtime_recovery$
DECLARE
  claim_disposition text;
  replay_envelope jsonb;
BEGIN
  SELECT disposition INTO STRICT claim_disposition
  FROM gowm_capability.claim_idempotency(
    'sha256:' || repeat('e', 64), 'test.gateway.execute', '1.0', 'runtime-recovery-key',
    'sha256:' || repeat('f', 64), 'runtime-after-restart'
  );
  IF claim_disposition <> 'CLAIMED_RECOVERED' OR NOT EXISTS (
    SELECT 1 FROM gowm_capability.idempotency_record
    WHERE principal_hash = 'sha256:' || repeat('e', 64)
      AND idempotency_key = 'runtime-recovery-key'
      AND lease_owner = 'runtime-after-restart'
      AND lease_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'gateway runtime could not recover an expired lease: %', claim_disposition;
  END IF;

  SELECT disposition, out_result_envelope
  INTO STRICT claim_disposition, replay_envelope
  FROM gowm_capability.claim_idempotency(
    'sha256:' || repeat('6', 64), 'test.gateway.execute', '1.0', 'db-test-key',
    'sha256:' || repeat('7', 64), 'runtime-after-restart'
  );
  IF claim_disposition <> 'REPLAY' OR replay_envelope->>'status' <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'gateway runtime could not replay persisted result: %, %',
      claim_disposition, replay_envelope;
  END IF;
END
$assert_runtime_recovery$;

RESET ROLE;

ROLLBACK;

SELECT 'GOWM capability gateway database assertions PASS' AS result;
