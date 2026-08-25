BEGIN;

CREATE FUNCTION coverage_planner.submit_coverage_request(
  p_data_scope_key text,
  p_dataset_scope_key text,
  p_external_request_id text,
  p_idempotency_key text,
  p_gateway_job_id uuid,
  p_request_hash text,
  p_routing_snapshot_hash text,
  p_routing_snapshot jsonb,
  p_request_json jsonb
)
RETURNS TABLE(coverage_request_id uuid, status text, replayed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  existing coverage_planner.coverage_request%ROWTYPE;
BEGIN
  IF p_data_scope_key IS NULL OR p_dataset_scope_key IS NULL
     OR p_external_request_id IS NULL OR p_idempotency_key IS NULL OR p_gateway_job_id IS NULL
     OR p_request_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_routing_snapshot_hash !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(p_routing_snapshot) <> 'object' OR jsonb_typeof(p_request_json) <> 'object' THEN
    RAISE EXCEPTION 'invalid coverage submission' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO existing
  FROM coverage_planner.coverage_request request
  WHERE request.data_scope_key = p_data_scope_key
    AND request.dataset_scope_key = p_dataset_scope_key
    AND request.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF existing.request_hash <> p_request_hash
       OR existing.external_request_id <> p_external_request_id
       OR existing.gateway_job_id <> p_gateway_job_id
       OR existing.routing_snapshot_hash <> p_routing_snapshot_hash THEN
      RAISE EXCEPTION 'coverage idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing.coverage_request_id, existing.status, true;
    RETURN;
  END IF;

  INSERT INTO coverage_planner.coverage_request(
    data_scope_key, dataset_scope_key, external_request_id, idempotency_key, gateway_job_id,
    request_hash, routing_snapshot_hash, routing_snapshot, request_json
  ) VALUES (
    p_data_scope_key, p_dataset_scope_key, p_external_request_id, p_idempotency_key, p_gateway_job_id,
    p_request_hash, p_routing_snapshot_hash, p_routing_snapshot, p_request_json
  )
  RETURNING coverage_planner.coverage_request.coverage_request_id,
            coverage_planner.coverage_request.status
  INTO existing.coverage_request_id, existing.status;

  INSERT INTO coverage_planner.coverage_progress_event(
    coverage_request_id, data_scope_key, dataset_scope_key, generation, sequence, stage, progress_ppm
  ) VALUES (
    existing.coverage_request_id, p_data_scope_key, p_dataset_scope_key, 0, 1, 'SUBMITTED', 0
  );

  RETURN QUERY SELECT existing.coverage_request_id, existing.status, false;
END
$fn$;

CREATE FUNCTION coverage_planner.claim_coverage_request(
  p_coverage_request_id uuid,
  p_attempt integer,
  p_lease_owner text,
  p_lease_seconds integer
)
RETURNS TABLE(coverage_run_id uuid, generation bigint, reclaimed boolean, lease_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  request_row coverage_planner.coverage_request%ROWTYPE;
  prior_run coverage_planner.coverage_run%ROWTYPE;
  next_generation bigint;
  new_run_id uuid;
  new_lease_until timestamptz;
  was_reclaimed boolean := false;
BEGIN
  IF p_attempt < 1 OR p_lease_owner IS NULL OR length(p_lease_owner) NOT BETWEEN 1 AND 256
     OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid coverage lease' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO STRICT request_row
  FROM coverage_planner.coverage_request request
  WHERE request.coverage_request_id = p_coverage_request_id
  FOR UPDATE;

  IF request_row.status IN ('SUCCEEDED','PARTIAL','NO_FEASIBLE_PLAN','CANCELLED','FAILED') THEN
    RAISE EXCEPTION 'coverage request is terminal' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO prior_run
  FROM coverage_planner.coverage_run run
  WHERE run.coverage_request_id = p_coverage_request_id AND run.status = 'RUNNING'
  FOR UPDATE;

  IF FOUND THEN
    IF prior_run.lease_until > clock_timestamp() THEN
      RAISE EXCEPTION 'coverage request lease is active' USING ERRCODE = '55P03';
    END IF;
    UPDATE coverage_planner.coverage_run
    SET status = 'EXPIRED', finished_at = clock_timestamp()
    WHERE coverage_planner.coverage_run.coverage_run_id = prior_run.coverage_run_id;
    was_reclaimed := true;
  END IF;

  next_generation := request_row.generation + 1;
  new_lease_until := clock_timestamp() + make_interval(secs => p_lease_seconds);
  INSERT INTO coverage_planner.coverage_run(
    coverage_request_id, data_scope_key, dataset_scope_key, gateway_job_id,
    attempt, generation, status, lease_owner, lease_until
  ) VALUES (
    request_row.coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
    request_row.gateway_job_id, p_attempt, next_generation, 'RUNNING', p_lease_owner, new_lease_until
  ) RETURNING coverage_planner.coverage_run.coverage_run_id INTO new_run_id;

  UPDATE coverage_planner.coverage_request
  SET status = 'RUNNING', generation = next_generation, updated_at = clock_timestamp()
  WHERE coverage_planner.coverage_request.coverage_request_id = p_coverage_request_id;

  INSERT INTO coverage_planner.coverage_progress_event(
    coverage_request_id, data_scope_key, dataset_scope_key, generation, sequence, stage, progress_ppm,
    details
  ) VALUES (
    request_row.coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
    next_generation, 1, CASE WHEN was_reclaimed THEN 'RECLAIMED' ELSE 'CLAIMED' END, 0,
    jsonb_build_object('leaseOwner', p_lease_owner, 'attempt', p_attempt)
  );

  RETURN QUERY SELECT new_run_id, next_generation, was_reclaimed, new_lease_until;
END
$fn$;

CREATE FUNCTION coverage_planner.heartbeat_coverage_run(
  p_coverage_request_id uuid,
  p_generation bigint,
  p_lease_owner text,
  p_lease_seconds integer,
  p_stage text,
  p_progress_ppm integer,
  p_resource_metrics jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  changed integer;
  request_row coverage_planner.coverage_request%ROWTYPE;
  next_sequence bigint;
BEGIN
  IF p_lease_seconds NOT BETWEEN 1 AND 3600 OR p_progress_ppm NOT BETWEEN 0 AND 1000000
     OR p_stage IS NULL OR length(p_stage) NOT BETWEEN 1 AND 64
     OR jsonb_typeof(p_resource_metrics) <> 'object' THEN
    RAISE EXCEPTION 'invalid coverage heartbeat' USING ERRCODE = '22023';
  END IF;

  UPDATE coverage_planner.coverage_run
  SET lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_heartbeat_at = clock_timestamp(), stage = p_stage, resource_metrics = p_resource_metrics
  WHERE coverage_request_id = p_coverage_request_id
    AND generation = p_generation
    AND lease_owner = p_lease_owner
    AND status = 'RUNNING'
    AND lease_until > clock_timestamp();
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RETURN false; END IF;

  SELECT * INTO STRICT request_row FROM coverage_planner.coverage_request
  WHERE coverage_request_id = p_coverage_request_id AND generation = p_generation;
  SELECT COALESCE(max(sequence), 0) + 1 INTO next_sequence
  FROM coverage_planner.coverage_progress_event
  WHERE coverage_request_id = p_coverage_request_id AND generation = p_generation;
  INSERT INTO coverage_planner.coverage_progress_event(
    coverage_request_id, data_scope_key, dataset_scope_key, generation, sequence, stage, progress_ppm,
    details
  ) VALUES (
    p_coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
    p_generation, next_sequence, p_stage, p_progress_ppm, p_resource_metrics
  );
  RETURN true;
END
$fn$;

CREATE FUNCTION coverage_planner.persist_coverage_problem(
  p_coverage_request_id uuid,
  p_generation bigint,
  p_lease_owner text,
  p_problem_hash text,
  p_canonical_problem jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  request_row coverage_planner.coverage_request%ROWTYPE;
  problem_id uuid;
  state jsonb;
  obligation jsonb;
  ordinal integer;
BEGIN
  IF p_problem_hash !~ '^sha256:[0-9a-f]{64}$' OR jsonb_typeof(p_canonical_problem) <> 'object' THEN
    RAISE EXCEPTION 'invalid coverage problem' USING ERRCODE = '22023';
  END IF;
  SELECT request.* INTO STRICT request_row
  FROM coverage_planner.coverage_request request
  JOIN coverage_planner.coverage_run run
    ON run.coverage_request_id = request.coverage_request_id AND run.generation = p_generation
  WHERE request.coverage_request_id = p_coverage_request_id
    AND request.generation = p_generation AND request.status = 'RUNNING'
    AND run.lease_owner = p_lease_owner AND run.status = 'RUNNING' AND run.lease_until > clock_timestamp()
  FOR UPDATE OF request;

  SELECT problem.coverage_problem_id INTO problem_id
  FROM coverage_planner.coverage_problem problem
  WHERE problem.coverage_request_id = p_coverage_request_id;
  IF FOUND THEN
    IF (SELECT problem_hash FROM coverage_planner.coverage_problem WHERE coverage_problem_id = problem_id) <> p_problem_hash THEN
      RAISE EXCEPTION 'coverage problem conflict' USING ERRCODE = '23505';
    END IF;
    RETURN problem_id;
  END IF;

  INSERT INTO coverage_planner.coverage_problem(
    coverage_request_id, data_scope_key, dataset_scope_key, generation, problem_hash, canonical_problem
  ) VALUES (
    request_row.coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
    p_generation, p_problem_hash, p_canonical_problem
  ) RETURNING coverage_problem_id INTO problem_id;

  state := p_canonical_problem->'startState';
  INSERT INTO coverage_planner.coverage_start_state(
    coverage_problem_id, data_scope_key, dataset_scope_key, arc_key, fraction_ppm, direction,
    heading_microdegrees
  ) VALUES (
    problem_id, request_row.data_scope_key, request_row.dataset_scope_key,
    state->>'arcKey', (state->>'fractionPpm')::integer, state->>'direction',
    CASE WHEN state ? 'headingMicrodegrees' THEN (state->>'headingMicrodegrees')::integer END
  );

  FOR state, ordinal IN
    SELECT value, ordinality::integer - 1 FROM jsonb_array_elements(COALESCE(p_canonical_problem->'entryStates', '[]'::jsonb)) WITH ORDINALITY
  LOOP
    INSERT INTO coverage_planner.coverage_boundary_state(
      coverage_problem_id, data_scope_key, dataset_scope_key, state_kind, ordinal,
      arc_key, fraction_ppm, direction
    ) VALUES (
      problem_id, request_row.data_scope_key, request_row.dataset_scope_key, 'ENTRY', ordinal,
      state->>'arcKey', (state->>'fractionPpm')::integer, state->>'direction'
    );
  END LOOP;
  FOR state, ordinal IN
    SELECT value, ordinality::integer - 1 FROM jsonb_array_elements(COALESCE(p_canonical_problem->'exitStates', '[]'::jsonb)) WITH ORDINALITY
  LOOP
    INSERT INTO coverage_planner.coverage_boundary_state(
      coverage_problem_id, data_scope_key, dataset_scope_key, state_kind, ordinal,
      arc_key, fraction_ppm, direction
    ) VALUES (
      problem_id, request_row.data_scope_key, request_row.dataset_scope_key, 'EXIT', ordinal,
      state->>'arcKey', (state->>'fractionPpm')::integer, state->>'direction'
    );
  END LOOP;

  FOR obligation IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_canonical_problem#>'{obligationSet,obligations}', '[]'::jsonb))
  LOOP
    INSERT INTO coverage_planner.coverage_service_obligation(
      coverage_problem_id, data_scope_key, dataset_scope_key, obligation_id, graph_version,
      edge_key, arc_key, start_fraction_ppm, end_fraction_ppm, service_mode, required_passes,
      source_feature_reference_key, selection_policy_version, content_hash
    ) VALUES (
      problem_id, request_row.data_scope_key, request_row.dataset_scope_key,
      obligation->>'obligationId', obligation->>'graphVersion', obligation->>'edgeKey', obligation->>'arcKey',
      (obligation->>'startFractionPpm')::integer, (obligation->>'endFractionPpm')::integer,
      'FIXED_DIRECTION', (obligation->>'requiredPasses')::integer,
      obligation#>>'{sourceFeatureReferenceKey,id}', obligation->>'selectionPolicyVersion', obligation->>'contentHash'
    );
  END LOOP;
  RETURN problem_id;
END
$fn$;

CREATE FUNCTION coverage_planner.publish_coverage_result(
  p_coverage_request_id uuid,
  p_generation bigint,
  p_lease_owner text,
  p_reference_key text,
  p_status text,
  p_result_hash text,
  p_valid_until timestamptz,
  p_result_record jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  request_row coverage_planner.coverage_request%ROWTYPE;
  problem_row coverage_planner.coverage_problem%ROWTYPE;
  result_set_id uuid;
  changed integer;
BEGIN
  IF p_reference_key !~ '^wrf_[0-9a-f]{32}$'
     OR p_status NOT IN ('SUCCEEDED','PARTIAL','NO_FEASIBLE_PLAN')
     OR p_result_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_valid_until <= clock_timestamp()
     OR jsonb_typeof(p_result_record) <> 'object'
     OR COALESCE((p_result_record->>'revalidationRequired')::boolean, false) <> true THEN
    RAISE EXCEPTION 'invalid coverage result publication' USING ERRCODE = '22023';
  END IF;

  SELECT request.* INTO STRICT request_row
  FROM coverage_planner.coverage_request request
  JOIN coverage_planner.coverage_run run
    ON run.coverage_request_id = request.coverage_request_id AND run.generation = p_generation
  WHERE request.coverage_request_id = p_coverage_request_id
    AND request.generation = p_generation AND request.status = 'RUNNING'
    AND run.lease_owner = p_lease_owner AND run.status = 'RUNNING' AND run.lease_until > clock_timestamp()
  FOR UPDATE OF request;
  SELECT * INTO STRICT problem_row FROM coverage_planner.coverage_problem
  WHERE coverage_request_id = p_coverage_request_id;

  IF EXISTS (SELECT 1 FROM coverage_planner.coverage_result_set WHERE coverage_request_id = p_coverage_request_id) THEN
    RETURN false;
  END IF;

  INSERT INTO coverage_planner.coverage_result_set(
    coverage_request_id, coverage_problem_id, data_scope_key, dataset_scope_key, generation,
    reference_key, problem_hash, routing_snapshot_hash, status, result_hash, result_record, valid_until
  ) VALUES (
    request_row.coverage_request_id, problem_row.coverage_problem_id,
    request_row.data_scope_key, request_row.dataset_scope_key, p_generation,
    p_reference_key, problem_row.problem_hash, request_row.routing_snapshot_hash,
    p_status, p_result_hash, p_result_record, p_valid_until
  ) RETURNING coverage_result_set_id INTO result_set_id;

  INSERT INTO coverage_planner.coverage_outbox_event(
    coverage_request_id, data_scope_key, dataset_scope_key, generation,
    aggregate_type, aggregate_id, event_type, payload
  ) VALUES (
    request_row.coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
    p_generation, 'COVERAGE_RESULT_SET', result_set_id, 'COVERAGE_RESULT_PUBLISHED',
    jsonb_build_object('referenceKey', p_reference_key, 'resultHash', p_result_hash, 'status', p_status)
  );

  UPDATE coverage_planner.coverage_run
  SET status = p_status, finished_at = clock_timestamp(), stage = 'PUBLISHED'
  WHERE coverage_request_id = p_coverage_request_id AND generation = p_generation
    AND lease_owner = p_lease_owner AND status = 'RUNNING';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'late coverage result rejected' USING ERRCODE = '40001'; END IF;

  UPDATE coverage_planner.coverage_request
  SET status = p_status, updated_at = clock_timestamp(), completed_at = clock_timestamp()
  WHERE coverage_request_id = p_coverage_request_id AND generation = p_generation AND status = 'RUNNING';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'late coverage request completion rejected' USING ERRCODE = '40001'; END IF;

  INSERT INTO coverage_planner.coverage_progress_event(
    coverage_request_id, data_scope_key, dataset_scope_key, generation, sequence, stage, progress_ppm
  ) SELECT request_row.coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
           p_generation, COALESCE(max(sequence), 0) + 1, p_status, 1000000
    FROM coverage_planner.coverage_progress_event
    WHERE coverage_request_id = p_coverage_request_id AND generation = p_generation;
  RETURN true;
END
$fn$;

CREATE FUNCTION coverage_planner.cancel_coverage_request(p_coverage_request_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  request_row coverage_planner.coverage_request%ROWTYPE;
  changed integer;
BEGIN
  UPDATE coverage_planner.coverage_request
  SET status = 'CANCELLED', cancellation_reason = p_reason,
      updated_at = clock_timestamp(), completed_at = clock_timestamp()
  WHERE coverage_request_id = p_coverage_request_id AND status IN ('QUEUED','RUNNING')
  RETURNING * INTO request_row;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RETURN false; END IF;
  UPDATE coverage_planner.coverage_run SET status = 'CANCELLED', finished_at = clock_timestamp()
  WHERE coverage_request_id = p_coverage_request_id AND status = 'RUNNING';
  INSERT INTO coverage_planner.coverage_progress_event(
    coverage_request_id, data_scope_key, dataset_scope_key, generation, sequence, stage, progress_ppm,
    details
  ) SELECT request_row.coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
           request_row.generation, COALESCE(max(sequence), 0) + 1, 'CANCELLED', 0,
           jsonb_build_object('reason', p_reason)
    FROM coverage_planner.coverage_progress_event
    WHERE coverage_request_id = p_coverage_request_id AND generation = request_row.generation;
  RETURN true;
END
$fn$;

CREATE FUNCTION coverage_planner.get_coverage_result(
  p_coverage_request_id uuid,
  p_data_scope_key text,
  p_dataset_scope_key text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
  SELECT result.result_record
  FROM coverage_planner.coverage_result_set result
  WHERE result.coverage_request_id = p_coverage_request_id
    AND result.data_scope_key = p_data_scope_key
    AND result.dataset_scope_key = p_dataset_scope_key
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA coverage_planner FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA coverage_planner FROM coverage_planner_provider;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA coverage_planner FROM coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.submit_coverage_request(text,text,text,text,uuid,text,text,jsonb,jsonb) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.claim_coverage_request(uuid,integer,text,integer) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.heartbeat_coverage_run(uuid,bigint,text,integer,text,integer,jsonb) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.persist_coverage_problem(uuid,bigint,text,text,jsonb) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.publish_coverage_result(uuid,bigint,text,text,text,text,timestamptz,jsonb) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.cancel_coverage_request(uuid,text) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.get_coverage_result(uuid,text,text) TO coverage_planner_provider;

COMMIT;
