\set ON_ERROR_STOP on
BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description)
VALUES('coverage-async-test','TEST','Coverage async lifecycle assertions');

DO $assert$
DECLARE
  first_request uuid;
  second_request uuid;
  claimed_request uuid;
  first_generation bigint;
  second_generation bigint;
  cancelled_generation bigint;
  replayed boolean;
  conflict_seen boolean := false;
BEGIN
  SELECT coverage_request_id INTO first_request FROM coverage_planner.submit_coverage_request(
    'coverage-async-test','dataset-a','coverage-async-request-1','coverage-async-idem-1',
    '10000000-0000-0000-0000-000000000001','sha256:'||repeat('1',64),'sha256:'||repeat('a',64),'{}','{}'
  );
  SELECT coverage_request_id INTO second_request FROM coverage_planner.submit_coverage_request(
    'coverage-async-test','dataset-a','coverage-async-request-2','coverage-async-idem-2',
    '10000000-0000-0000-0000-000000000002','sha256:'||repeat('2',64),'sha256:'||repeat('a',64),'{}','{}'
  );
  SELECT submit.coverage_request_id, submit.replayed INTO claimed_request, replayed
  FROM coverage_planner.submit_coverage_request(
    'coverage-async-test','dataset-a','coverage-async-request-1','coverage-async-idem-1',
    '10000000-0000-0000-0000-000000000001','sha256:'||repeat('1',64),'sha256:'||repeat('a',64),'{}','{}'
  ) submit;
  IF claimed_request <> first_request OR NOT replayed THEN RAISE EXCEPTION 'idempotent replay failed'; END IF;
  BEGIN
    PERFORM coverage_planner.submit_coverage_request(
      'coverage-async-test','dataset-a','coverage-async-request-1','coverage-async-idem-1',
      '10000000-0000-0000-0000-000000000001','sha256:'||repeat('9',64),'sha256:'||repeat('a',64),'{}','{}'
    );
  EXCEPTION WHEN unique_violation THEN conflict_seen := true; END;
  IF NOT conflict_seen THEN RAISE EXCEPTION 'idempotency conflict was accepted'; END IF;

  SELECT coverage_request_id,generation INTO claimed_request,first_generation
  FROM coverage_planner.claim_next_coverage_request(1,'worker-a',30,1);
  IF claimed_request <> first_request OR first_generation <> 1 THEN RAISE EXCEPTION 'ordered SKIP LOCKED claim failed'; END IF;
  IF EXISTS (SELECT 1 FROM coverage_planner.claim_next_coverage_request(1,'worker-b',30,1)) THEN
    RAISE EXCEPTION 'scope concurrency admission was exceeded';
  END IF;
  IF NOT coverage_planner.heartbeat_coverage_run(first_request,first_generation,'worker-a',30,'SOLVING',500000,'{"cpuMs":10}') THEN
    RAISE EXCEPTION 'bounded heartbeat failed';
  END IF;
  IF coverage_planner.heartbeat_coverage_run(first_request,first_generation,'worker-a',30,'REGRESSED',400000,'{}') THEN
    RAISE EXCEPTION 'regressing progress was accepted';
  END IF;
  UPDATE coverage_planner.coverage_run SET lease_until=clock_timestamp()-interval '1 second'
  WHERE coverage_request_id=first_request AND generation=first_generation;
  IF coverage_planner.reap_expired_coverage_runs(10) <> 1 THEN RAISE EXCEPTION 'expired lease was not reaped'; END IF;
  IF (SELECT status FROM coverage_planner.coverage_request WHERE coverage_request_id=first_request) <> 'QUEUED' THEN
    RAISE EXCEPTION 'expired request was not requeued';
  END IF;
  SELECT coverage_request_id,generation INTO claimed_request,second_generation
  FROM coverage_planner.claim_next_coverage_request(2,'worker-restart',30,1);
  IF claimed_request <> first_request OR second_generation <> first_generation+1 THEN
    RAISE EXCEPTION 'worker restart did not create a fenced generation';
  END IF;
  IF NOT coverage_planner.cancel_coverage_request(first_request,'operator cancellation') THEN
    RAISE EXCEPTION 'generation cancellation failed';
  END IF;
  SELECT generation INTO cancelled_generation FROM coverage_planner.coverage_request WHERE coverage_request_id=first_request;
  IF cancelled_generation <> second_generation+1 THEN RAISE EXCEPTION 'cancel did not increment generation'; END IF;
  IF coverage_planner.heartbeat_coverage_run(first_request,second_generation,'worker-restart',30,'LATE',900000,'{}') THEN
    RAISE EXCEPTION 'late generation heartbeat was accepted';
  END IF;
  IF (SELECT status FROM coverage_planner.coverage_request WHERE coverage_request_id=second_request) <> 'QUEUED' THEN
    RAISE EXCEPTION 'unclaimed request was not preserved';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT generation,progress_ppm,lag(progress_ppm) OVER (PARTITION BY coverage_request_id,generation ORDER BY sequence) AS prior
      FROM coverage_planner.coverage_progress_event
      WHERE coverage_request_id=first_request
    ) progress WHERE prior IS NOT NULL AND progress_ppm < prior
  ) THEN RAISE EXCEPTION 'progress timeline regressed'; END IF;
END
$assert$;

DO $architecture$
DECLARE
  claim_definition text;
  compatibility_claim_definition text;
  reaper_definition text;
BEGIN
  SELECT pg_get_functiondef('coverage_planner.claim_next_coverage_request(text,integer,integer)'::regprocedure) INTO claim_definition;
  SELECT pg_get_functiondef('coverage_planner.claim_next_coverage_request(integer,text,integer,integer)'::regprocedure) INTO compatibility_claim_definition;
  SELECT pg_get_functiondef('coverage_planner.reap_expired_coverage_runs(integer)'::regprocedure) INTO reaper_definition;
  IF position('SKIP LOCKED' in upper(claim_definition)) = 0 OR position('PG_ADVISORY_XACT_LOCK' in upper(claim_definition)) = 0 THEN
    RAISE EXCEPTION 'queue claim lacks SKIP LOCKED or scope admission lock';
  END IF;
  IF position('CLAIM_NEXT_COVERAGE_REQUEST(P_LEASE_OWNER, P_LEASE_SECONDS, P_MAX_SCOPE_RUNNING)' in upper(compatibility_claim_definition)) = 0 THEN
    RAISE EXCEPTION 'compatibility queue claim bypasses the authoritative allocator';
  END IF;
  IF position('SKIP LOCKED' in upper(reaper_definition)) = 0 THEN RAISE EXCEPTION 'reaper lacks SKIP LOCKED'; END IF;
  IF NOT has_function_privilege('coverage_planner_provider','coverage_planner.claim_next_coverage_request(integer,text,integer,integer)','EXECUTE')
     OR NOT has_function_privilege('coverage_planner_provider','coverage_planner.reap_expired_coverage_runs(integer)','EXECUTE') THEN
    RAISE EXCEPTION 'Provider lacks controlled async lifecycle functions';
  END IF;
END
$architecture$;

ROLLBACK;
SELECT 'COVERAGE_ASYNC_JOB_ASSERTIONS_PASS' AS result;
