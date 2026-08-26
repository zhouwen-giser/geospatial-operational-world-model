\set ON_ERROR_STOP on
BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description)
VALUES('coverage-attempt-reclaim','TEST','v0.6.1 attempt reclaim assertions');

DO $assert$
DECLARE
  request_id uuid;
  run_one uuid;
  run_two uuid;
  attempt_one integer;
  attempt_two integer;
  generation_one bigint;
  generation_two bigint;
BEGIN
  SELECT coverage_request_id INTO request_id
  FROM coverage_planner.submit_coverage_request(
    'coverage-attempt-reclaim','dataset-a','coverage-reclaim-request','coverage-reclaim-idempotency',
    '61000000-0000-0000-0000-000000000001','sha256:'||repeat('1',64),
    'sha256:'||repeat('2',64),'{}','{}'
  );

  SELECT coverage_run_id, attempt, generation INTO run_one, attempt_one, generation_one
  FROM coverage_planner.claim_coverage_request(request_id,'worker-generation-one',30);
  IF attempt_one <> 1 OR generation_one <> 1 THEN
    RAISE EXCEPTION 'initial attempt/generation was not database allocated as 1/1';
  END IF;

  UPDATE coverage_planner.coverage_run SET lease_until=clock_timestamp()-interval '1 second'
  WHERE coverage_run_id=run_one;
  SELECT coverage_run_id, attempt, generation INTO run_two, attempt_two, generation_two
  FROM coverage_planner.claim_coverage_request(request_id,'worker-generation-two',30);
  IF run_two=run_one OR attempt_two <> 2 OR generation_two <> 2 THEN
    RAISE EXCEPTION 'reclaim did not allocate a fresh run with monotonic attempt/generation';
  END IF;
  IF coverage_planner.heartbeat_coverage_run(request_id,generation_one,'worker-generation-one',30,'LATE',1,'{}') THEN
    RAISE EXCEPTION 'old generation heartbeat was accepted';
  END IF;
  IF NOT coverage_planner.heartbeat_coverage_run(request_id,generation_two,'worker-generation-two',30,'ACTIVE',1,'{}') THEN
    RAISE EXCEPTION 'new generation heartbeat was rejected';
  END IF;
  IF (SELECT status FROM coverage_planner.coverage_run WHERE coverage_run_id=run_one) <> 'EXPIRED' THEN
    RAISE EXCEPTION 'reclaimed run was not retained as EXPIRED';
  END IF;
  PERFORM coverage_planner.cancel_coverage_request(request_id,'assertion complete');
END
$assert$;

DO $privilege$
BEGIN
  IF NOT has_function_privilege(
    'coverage_planner_provider','coverage_planner.claim_coverage_request(uuid,text,integer)','EXECUTE'
  ) THEN
    RAISE EXCEPTION 'provider cannot execute database-authoritative claim API';
  END IF;
END
$privilege$;

ROLLBACK;
