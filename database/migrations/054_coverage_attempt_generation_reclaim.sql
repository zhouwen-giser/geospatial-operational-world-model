BEGIN;

CREATE FUNCTION coverage_planner.claim_coverage_request(
  p_coverage_request_id uuid,
  p_lease_owner text,
  p_lease_seconds integer
)
RETURNS TABLE(coverage_run_id uuid, attempt integer, generation bigint, reclaimed boolean, lease_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  request_row coverage_planner.coverage_request%ROWTYPE;
  prior_run coverage_planner.coverage_run%ROWTYPE;
  next_attempt integer;
  next_generation bigint;
  new_run_id uuid;
  new_lease_until timestamptz;
  was_reclaimed boolean := false;
BEGIN
  IF p_lease_owner IS NULL OR length(p_lease_owner) NOT BETWEEN 1 AND 256
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

  SELECT COALESCE(max(run.attempt), 0) + 1 INTO next_attempt
  FROM coverage_planner.coverage_run run
  WHERE run.gateway_job_id = request_row.gateway_job_id;
  next_generation := request_row.generation + 1;
  new_lease_until := clock_timestamp() + make_interval(secs => p_lease_seconds);

  INSERT INTO coverage_planner.coverage_run(
    coverage_request_id, data_scope_key, dataset_scope_key, gateway_job_id,
    attempt, generation, status, lease_owner, lease_until
  ) VALUES (
    request_row.coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
    request_row.gateway_job_id, next_attempt, next_generation, 'RUNNING', p_lease_owner, new_lease_until
  ) RETURNING coverage_planner.coverage_run.coverage_run_id INTO new_run_id;

  UPDATE coverage_planner.coverage_request
  SET status = 'RUNNING', generation = next_generation, updated_at = clock_timestamp()
  WHERE coverage_planner.coverage_request.coverage_request_id = p_coverage_request_id;

  INSERT INTO coverage_planner.coverage_progress_event(
    coverage_request_id, data_scope_key, dataset_scope_key, generation, sequence, stage, progress_ppm, details
  ) VALUES (
    request_row.coverage_request_id, request_row.data_scope_key, request_row.dataset_scope_key,
    next_generation, 1, CASE WHEN was_reclaimed THEN 'RECLAIMED' ELSE 'CLAIMED' END, 0,
    jsonb_build_object('leaseOwner', p_lease_owner, 'attempt', next_attempt)
  );

  RETURN QUERY SELECT new_run_id, next_attempt, next_generation, was_reclaimed, new_lease_until;
END
$fn$;

CREATE FUNCTION coverage_planner.claim_next_coverage_request(
  p_lease_owner text,
  p_lease_seconds integer,
  p_max_scope_running integer
)
RETURNS TABLE(coverage_request_id uuid, coverage_run_id uuid, attempt integer, generation bigint, lease_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  request_row coverage_planner.coverage_request%ROWTYPE;
  active_count integer;
BEGIN
  IF p_lease_owner IS NULL OR length(p_lease_owner) NOT BETWEEN 1 AND 256
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

  RETURN QUERY
  SELECT request_row.coverage_request_id, claimed.coverage_run_id, claimed.attempt,
         claimed.generation, claimed.lease_until
  FROM coverage_planner.claim_coverage_request(
    request_row.coverage_request_id, p_lease_owner, p_lease_seconds
  ) claimed;
END
$fn$;

-- Deprecated compatibility overloads ignore the caller-supplied attempt. Attempt
-- allocation remains database-authoritative for upgraded runtimes.
CREATE OR REPLACE FUNCTION coverage_planner.claim_coverage_request(
  p_coverage_request_id uuid, p_attempt integer, p_lease_owner text, p_lease_seconds integer
)
RETURNS TABLE(coverage_run_id uuid, generation bigint, reclaimed boolean, lease_until timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
  SELECT claimed.coverage_run_id, claimed.generation, claimed.reclaimed, claimed.lease_until
  FROM coverage_planner.claim_coverage_request(p_coverage_request_id, p_lease_owner, p_lease_seconds) claimed
$fn$;

CREATE OR REPLACE FUNCTION coverage_planner.claim_next_coverage_request(
  p_attempt integer, p_lease_owner text, p_lease_seconds integer, p_max_scope_running integer
)
RETURNS TABLE(coverage_request_id uuid, coverage_run_id uuid, generation bigint, lease_until timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
  SELECT claimed.coverage_request_id, claimed.coverage_run_id, claimed.generation, claimed.lease_until
  FROM coverage_planner.claim_next_coverage_request(p_lease_owner, p_lease_seconds, p_max_scope_running) claimed
$fn$;

REVOKE ALL ON FUNCTION coverage_planner.claim_coverage_request(uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION coverage_planner.claim_next_coverage_request(text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coverage_planner.claim_coverage_request(uuid,text,integer) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.claim_next_coverage_request(text,integer,integer) TO coverage_planner_provider;

COMMIT;
