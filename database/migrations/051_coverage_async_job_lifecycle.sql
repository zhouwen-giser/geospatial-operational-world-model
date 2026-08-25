BEGIN;

CREATE OR REPLACE FUNCTION coverage_planner.heartbeat_coverage_run(
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
  prior_progress integer;
BEGIN
  IF p_lease_seconds NOT BETWEEN 1 AND 3600 OR p_progress_ppm NOT BETWEEN 0 AND 1000000
     OR p_stage IS NULL OR length(p_stage) NOT BETWEEN 1 AND 64
     OR jsonb_typeof(p_resource_metrics) <> 'object' THEN
    RAISE EXCEPTION 'invalid coverage heartbeat' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(max(progress_ppm), 0) INTO prior_progress
  FROM coverage_planner.coverage_progress_event
  WHERE coverage_request_id = p_coverage_request_id AND generation = p_generation;
  IF p_progress_ppm < prior_progress THEN RETURN false; END IF;

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
  WHERE coverage_request_id = p_coverage_request_id AND generation = p_generation AND status = 'RUNNING';
  SELECT COALESCE(max(sequence), 0) + 1 INTO next_sequence
  FROM coverage_planner.coverage_progress_event
  WHERE coverage_request_id = p_coverage_request_id AND generation = p_generation;
  INSERT INTO coverage_planner.coverage_progress_event(
    coverage_request_id, data_scope_key, dataset_scope_key, generation, sequence, stage, progress_ppm, details
  ) VALUES (
    p_coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
    p_generation, next_sequence, p_stage, p_progress_ppm, p_resource_metrics
  );
  RETURN true;
END
$fn$;

CREATE OR REPLACE FUNCTION coverage_planner.cancel_coverage_request(p_coverage_request_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  request_row coverage_planner.coverage_request%ROWTYPE;
  changed integer;
BEGIN
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 1024 THEN
    RAISE EXCEPTION 'invalid coverage cancellation reason' USING ERRCODE = '22023';
  END IF;
  UPDATE coverage_planner.coverage_request
  SET status = 'CANCELLED', cancellation_reason = p_reason, generation = generation + 1,
      updated_at = clock_timestamp(), completed_at = clock_timestamp()
  WHERE coverage_request_id = p_coverage_request_id AND status IN ('QUEUED','RUNNING')
  RETURNING * INTO request_row;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RETURN false; END IF;
  UPDATE coverage_planner.coverage_run SET status = 'CANCELLED', finished_at = clock_timestamp()
  WHERE coverage_request_id = p_coverage_request_id AND status = 'RUNNING';
  INSERT INTO coverage_planner.coverage_progress_event(
    coverage_request_id, data_scope_key, dataset_scope_key, generation, sequence, stage, progress_ppm, details
  ) VALUES (
    request_row.coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
    request_row.generation, 1, 'CANCELLED', 0, jsonb_build_object('reason', p_reason)
  );
  RETURN true;
END
$fn$;

CREATE FUNCTION coverage_planner.claim_next_coverage_request(
  p_attempt integer,
  p_lease_owner text,
  p_lease_seconds integer,
  p_max_scope_running integer
)
RETURNS TABLE(coverage_request_id uuid, coverage_run_id uuid, generation bigint, lease_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  request_row coverage_planner.coverage_request%ROWTYPE;
  next_generation bigint;
  new_run_id uuid;
  new_lease_until timestamptz;
  active_count integer;
BEGIN
  IF p_attempt < 1 OR p_lease_owner IS NULL OR length(p_lease_owner) NOT BETWEEN 1 AND 256
     OR p_lease_seconds NOT BETWEEN 1 AND 3600 OR p_max_scope_running NOT BETWEEN 1 AND 1024 THEN
    RAISE EXCEPTION 'invalid coverage queue claim' USING ERRCODE = '22023';
  END IF;
  SELECT request.* INTO request_row
  FROM coverage_planner.coverage_request request
  WHERE request.status = 'QUEUED'
  ORDER BY request.created_at, request.coverage_request_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(request_row.data_scope_key || chr(31) || request_row.dataset_scope_key, 0));
  SELECT count(*) INTO active_count
  FROM coverage_planner.coverage_run run
  WHERE run.data_scope_key = request_row.data_scope_key
    AND run.dataset_scope_key = request_row.dataset_scope_key
    AND run.status = 'RUNNING' AND run.lease_until > clock_timestamp();
  IF active_count >= p_max_scope_running THEN RETURN; END IF;

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
  WHERE coverage_planner.coverage_request.coverage_request_id = request_row.coverage_request_id;
  INSERT INTO coverage_planner.coverage_progress_event(
    coverage_request_id, data_scope_key, dataset_scope_key, generation, sequence, stage, progress_ppm, details
  ) VALUES (
    request_row.coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
    next_generation, 1, 'CLAIMED', 0, jsonb_build_object('leaseOwner', p_lease_owner, 'attempt', p_attempt)
  );
  RETURN QUERY SELECT request_row.coverage_request_id, new_run_id, next_generation, new_lease_until;
END
$fn$;

CREATE FUNCTION coverage_planner.reap_expired_coverage_runs(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  expired coverage_planner.coverage_run%ROWTYPE;
  reaped integer := 0;
  next_sequence bigint;
  prior_progress integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid coverage reaper limit' USING ERRCODE = '22023';
  END IF;
  FOR expired IN
    SELECT run.* FROM coverage_planner.coverage_run run
    WHERE run.status = 'RUNNING' AND run.lease_until <= clock_timestamp()
    ORDER BY run.lease_until, run.coverage_run_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    UPDATE coverage_planner.coverage_run SET status='EXPIRED', finished_at=clock_timestamp()
    WHERE coverage_run_id=expired.coverage_run_id AND status='RUNNING';
    UPDATE coverage_planner.coverage_request SET status='QUEUED', updated_at=clock_timestamp()
    WHERE coverage_request_id=expired.coverage_request_id AND generation=expired.generation AND status='RUNNING';
    IF FOUND THEN
      SELECT COALESCE(max(sequence),0)+1, COALESCE(max(progress_ppm),0)
      INTO next_sequence, prior_progress FROM coverage_planner.coverage_progress_event
      WHERE coverage_request_id=expired.coverage_request_id AND generation=expired.generation;
      INSERT INTO coverage_planner.coverage_progress_event(
        coverage_request_id,data_scope_key,dataset_scope_key,generation,sequence,stage,progress_ppm,details
      ) VALUES (
        expired.coverage_request_id,expired.data_scope_key,expired.dataset_scope_key,
        expired.generation,next_sequence,'REQUEUED',prior_progress,jsonb_build_object('expiredLeaseOwner',expired.lease_owner)
      );
      reaped := reaped + 1;
    END IF;
  END LOOP;
  RETURN reaped;
END
$fn$;

REVOKE ALL ON FUNCTION coverage_planner.claim_next_coverage_request(integer,text,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION coverage_planner.reap_expired_coverage_runs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coverage_planner.claim_next_coverage_request(integer,text,integer,integer) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.reap_expired_coverage_runs(integer) TO coverage_planner_provider;

COMMIT;
