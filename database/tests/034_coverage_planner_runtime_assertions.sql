\set ON_ERROR_STOP on
BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description)
VALUES('coverage-runtime-test','TEST','Coverage planner runtime assertions');

DO $assert$
DECLARE
  request_id uuid;
  replay_id uuid;
  generation_one bigint;
  generation_two bigint;
  problem_id uuid;
  candidate_id uuid;
  route_id uuid;
  result_id uuid;
  alternative_one uuid;
  alternative_two uuid;
  published boolean;
  canonical_problem jsonb;
BEGIN
  canonical_problem := jsonb_build_object(
    'startState',jsonb_build_object('arcKey','arc_'||repeat('1',32),'fractionPpm',100000,'direction','FORWARD'),
    'entryStates',jsonb_build_array(),
    'exitStates',jsonb_build_array(),
    'obligationSet',jsonb_build_object('obligations',jsonb_build_array(jsonb_build_object(
      'obligationId','obligation-0001','graphVersion','graph-v1','edgeKey','edge-1',
      'arcKey','arc_'||repeat('2',32),'startFractionPpm',250000,'endFractionPpm',750000,
      'requiredPasses',1,'selectionPolicyVersion','coverage-selection/1.0',
      'contentHash','sha256:'||repeat('2',64)
    )))
  );

  SELECT coverage_request_id INTO request_id FROM coverage_planner.submit_coverage_request(
    'coverage-runtime-test','dataset-a','coverage-request-a','coverage-idem-a',
    '00000000-0000-0000-0000-000000000001','sha256:'||repeat('1',64),
    'sha256:'||repeat('a',64),'{}','{}'
  );
  SELECT coverage_request_id INTO replay_id FROM coverage_planner.submit_coverage_request(
    'coverage-runtime-test','dataset-a','coverage-request-a','coverage-idem-a',
    '00000000-0000-0000-0000-000000000001','sha256:'||repeat('1',64),
    'sha256:'||repeat('a',64),'{}','{}'
  );
  IF replay_id <> request_id THEN RAISE EXCEPTION 'coverage idempotent replay changed identity'; END IF;

  SELECT generation INTO generation_one FROM coverage_planner.claim_coverage_request(request_id,1,'worker-a',30);
  IF NOT coverage_planner.heartbeat_coverage_run(request_id,generation_one,'worker-a',30,'BUILD_PROBLEM',100000,'{}') THEN
    RAISE EXCEPTION 'coverage heartbeat failed';
  END IF;
  problem_id := coverage_planner.persist_coverage_problem(
    request_id,generation_one,'worker-a','sha256:'||repeat('b',64),canonical_problem
  );
  IF problem_id IS NULL OR (SELECT count(*) FROM coverage_planner.coverage_service_obligation WHERE coverage_problem_id=problem_id) <> 1 THEN
    RAISE EXCEPTION 'canonical problem persistence failed';
  END IF;

  BEGIN
    UPDATE coverage_planner.coverage_problem SET canonical_problem='{}' WHERE coverage_problem_id=problem_id;
    RAISE EXCEPTION 'problem mutation accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE coverage_planner.coverage_service_obligation SET required_passes=2 WHERE coverage_problem_id=problem_id;
    RAISE EXCEPTION 'obligation mutation accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    INSERT INTO coverage_planner.coverage_service_obligation(
      coverage_problem_id,data_scope_key,dataset_scope_key,obligation_id,graph_version,edge_key,arc_key,
      start_fraction_ppm,end_fraction_ppm,service_mode,required_passes,selection_policy_version,content_hash
    ) VALUES (
      problem_id,'coverage-runtime-test','dataset-a','obligation-invalid','graph-v1','edge-2','arc_'||repeat('3',32),
      -1,100000,'FIXED_DIRECTION',1,'coverage-selection/1.0','sha256:'||repeat('3',64)
    );
    RAISE EXCEPTION 'invalid fraction accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO coverage_planner.coverage_candidate(
    coverage_problem_id,coverage_request_id,data_scope_key,dataset_scope_key,generation,
    candidate_hash,objective_profile,solver_diagnostics
  ) VALUES (
    problem_id,request_id,'coverage-runtime-test','dataset-a',generation_one,
    'sha256:'||repeat('c',64),'LEAST_DEADHEAD','{}'
  ) RETURNING coverage_candidate_id INTO candidate_id;
  INSERT INTO coverage_planner.coverage_candidate_route(
    coverage_candidate_id,data_scope_key,dataset_scope_key,route_index,route_signature,start_state,end_state,metrics
  ) VALUES (
    candidate_id,'coverage-runtime-test','dataset-a',1,'sha256:'||repeat('d',64),'{}','{}','{}'
  ) RETURNING coverage_candidate_route_id INTO route_id;
  BEGIN
    INSERT INTO coverage_planner.coverage_candidate_route(
      coverage_candidate_id,data_scope_key,dataset_scope_key,route_index,route_signature,start_state,end_state,metrics
    ) VALUES (candidate_id,'coverage-runtime-test','dataset-a',2,'sha256:'||repeat('e',64),'{}','{}','{}');
    RAISE EXCEPTION 'route_index > 1 accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO coverage_planner.coverage_route_segment(
    coverage_candidate_route_id,data_scope_key,dataset_scope_key,sequence,graph_version,arc_key,
    start_fraction_ppm,end_fraction_ppm,phase,service_role,metrics
  ) VALUES (
    route_id,'coverage-runtime-test','dataset-a',1,'graph-v1','arc_'||repeat('2',32),
    250000,750000,'INSIDE','SERVICE','{}'
  );
  INSERT INTO coverage_planner.coverage_verification_report(
    coverage_candidate_id,data_scope_key,dataset_scope_key,status,coverage_ratio_ppm,
    length_weighted_coverage_ratio_ppm,verifier_version,report_hash,report
  ) VALUES (
    candidate_id,'coverage-runtime-test','dataset-a','VALID',1000000,1000000,
    'coverage-verifier/1.0','sha256:'||repeat('f',64),'{}'
  );
  BEGIN
    UPDATE coverage_planner.coverage_verification_report SET status='INVALID' WHERE coverage_candidate_id=candidate_id;
    RAISE EXCEPTION 'verification mutation accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;

  published := coverage_planner.publish_coverage_result(
    request_id,generation_one,'worker-a','wrf_'||repeat('1',32),'SUCCEEDED',
    'sha256:'||repeat('4',64),clock_timestamp()+interval '1 hour',
    jsonb_build_object('revalidationRequired',true)
  );
  IF NOT published THEN RAISE EXCEPTION 'coverage publication failed'; END IF;
  SELECT coverage_result_set_id INTO STRICT result_id FROM coverage_planner.coverage_result_set WHERE coverage_request_id=request_id;
  IF (SELECT count(*) FROM coverage_planner.coverage_outbox_event WHERE coverage_request_id=request_id) <> 1 THEN
    RAISE EXCEPTION 'coverage publication/outbox atomicity missing';
  END IF;

  INSERT INTO coverage_planner.coverage_alternative(
    coverage_result_set_id,coverage_candidate_id,data_scope_key,dataset_scope_key,
    alternative_id,rank,reference_key,content_hash
  ) VALUES (result_id,candidate_id,'coverage-runtime-test','dataset-a','alt-1',1,'wrf_'||repeat('2',32),'sha256:'||repeat('5',64))
  RETURNING coverage_alternative_id INTO alternative_one;
  INSERT INTO coverage_planner.coverage_alternative(
    coverage_result_set_id,coverage_candidate_id,data_scope_key,dataset_scope_key,
    alternative_id,rank,reference_key,content_hash
  ) VALUES (result_id,candidate_id,'coverage-runtime-test','dataset-a','alt-2',2,'wrf_'||repeat('3',32),'sha256:'||repeat('6',64))
  RETURNING coverage_alternative_id INTO alternative_two;
  INSERT INTO coverage_planner.coverage_pairwise_similarity(
    coverage_result_set_id,data_scope_key,dataset_scope_key,left_alternative_id,right_alternative_id,
    weighted_arc_overlap_ppm,deadhead_jaccard_distance_ppm
  ) VALUES (result_id,'coverage-runtime-test','dataset-a','alt-1','alt-2',800000,200000);
  BEGIN UPDATE coverage_planner.coverage_result_set SET status='PARTIAL' WHERE coverage_result_set_id=result_id;
    RAISE EXCEPTION 'result mutation accepted'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN UPDATE coverage_planner.coverage_alternative SET rank=3 WHERE coverage_alternative_id=alternative_one;
    RAISE EXCEPTION 'alternative mutation accepted'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN UPDATE coverage_planner.coverage_route_segment SET phase='RETURN' WHERE coverage_candidate_route_id=route_id AND sequence=1;
    RAISE EXCEPTION 'segment mutation accepted'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;

  SELECT coverage_request_id INTO request_id FROM coverage_planner.submit_coverage_request(
    'coverage-runtime-test','dataset-a','coverage-request-race','coverage-idem-race',
    '00000000-0000-0000-0000-000000000002','sha256:'||repeat('7',64),
    'sha256:'||repeat('a',64),'{}','{}'
  );
  SELECT generation INTO generation_one FROM coverage_planner.claim_coverage_request(request_id,1,'worker-old',1);
  UPDATE coverage_planner.coverage_run SET lease_until=clock_timestamp()-interval '1 second'
  WHERE coverage_request_id=request_id AND generation=generation_one;
  SELECT generation INTO generation_two FROM coverage_planner.claim_coverage_request(request_id,2,'worker-new',30);
  IF generation_two <> generation_one + 1 THEN RAISE EXCEPTION 'coverage generation did not advance'; END IF;
  problem_id := coverage_planner.persist_coverage_problem(request_id,generation_two,'worker-new','sha256:'||repeat('8',64),canonical_problem);
  BEGIN
    PERFORM coverage_planner.publish_coverage_result(
      request_id,generation_one,'worker-old','wrf_'||repeat('4',32),'SUCCEEDED',
      'sha256:'||repeat('9',64),clock_timestamp()+interval '1 hour',jsonb_build_object('revalidationRequired',true)
    );
    RAISE EXCEPTION 'late generation publication accepted';
  EXCEPTION WHEN no_data_found THEN NULL; END;
  IF EXISTS (SELECT 1 FROM coverage_planner.coverage_result_set WHERE coverage_request_id=request_id) THEN
    RAISE EXCEPTION 'late generation created a result';
  END IF;
  PERFORM coverage_planner.cancel_coverage_request(request_id,'race complete');

  BEGIN
    CREATE SCHEMA coverage_failed_migration_probe;
    CREATE TABLE coverage_failed_migration_probe.partial(id integer);
    RAISE EXCEPTION 'deliberate migration failure';
  EXCEPTION WHEN raise_exception THEN NULL; END;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='coverage_failed_migration_probe') THEN
    RAISE EXCEPTION 'deliberate migration failure left a partial schema';
  END IF;

  IF has_table_privilege('coverage_planner_provider','coverage_planner.coverage_request','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'coverage Provider has direct table mutation';
  END IF;
  IF has_table_privilege('coverage_planner_provider','public.network_arc','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'coverage Provider can mutate network authority';
  END IF;
END
$assert$;

CREATE FUNCTION coverage_planner.test_reject_outbox() RETURNS trigger
LANGUAGE plpgsql
AS $trigger$
BEGIN
  RAISE EXCEPTION 'injected outbox failure';
END
$trigger$;
CREATE TRIGGER test_reject_outbox
BEFORE INSERT ON coverage_planner.coverage_outbox_event
FOR EACH ROW EXECUTE FUNCTION coverage_planner.test_reject_outbox();

DO $fault_assert$
DECLARE
  request_id uuid;
  generation_one bigint;
  problem_id uuid;
  fault_observed boolean := false;
  canonical_problem jsonb;
BEGIN
  canonical_problem := jsonb_build_object(
    'startState',jsonb_build_object('arcKey','arc_'||repeat('1',32),'fractionPpm',100000,'direction','FORWARD'),
    'entryStates',jsonb_build_array(),
    'exitStates',jsonb_build_array(),
    'obligationSet',jsonb_build_object('obligations',jsonb_build_array(jsonb_build_object(
      'obligationId','obligation-0001','graphVersion','graph-v1','edgeKey','edge-1',
      'arcKey','arc_'||repeat('2',32),'startFractionPpm',250000,'endFractionPpm',750000,
      'requiredPasses',1,'selectionPolicyVersion','coverage-selection/1.0',
      'contentHash','sha256:'||repeat('2',64)
    )))
  );

  SELECT coverage_request_id INTO request_id FROM coverage_planner.submit_coverage_request(
    'coverage-runtime-test','dataset-a','coverage-request-fault','coverage-idem-fault',
    '00000000-0000-0000-0000-000000000003','sha256:'||repeat('a',64),
    'sha256:'||repeat('a',64),'{}','{}'
  );
  SELECT generation INTO generation_one FROM coverage_planner.claim_coverage_request(request_id,1,'worker-fault',30);
  problem_id := coverage_planner.persist_coverage_problem(
    request_id,generation_one,'worker-fault','sha256:'||repeat('0',64),canonical_problem
  );
  IF problem_id IS NULL THEN RAISE EXCEPTION 'fault assertion problem persistence failed'; END IF;

  BEGIN
    PERFORM coverage_planner.publish_coverage_result(
      request_id,generation_one,'worker-fault','wrf_'||repeat('5',32),'SUCCEEDED',
      'sha256:'||repeat('b',64),clock_timestamp()+interval '1 hour',jsonb_build_object('revalidationRequired',true)
    );
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'injected outbox failure' THEN
      fault_observed := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT fault_observed THEN RAISE EXCEPTION 'injected outbox failure was not observed'; END IF;
  IF EXISTS (SELECT 1 FROM coverage_planner.coverage_result_set WHERE coverage_request_id=request_id)
     OR EXISTS (SELECT 1 FROM coverage_planner.coverage_outbox_event WHERE coverage_request_id=request_id)
     OR (SELECT status FROM coverage_planner.coverage_request WHERE coverage_request_id=request_id) <> 'RUNNING' THEN
    RAISE EXCEPTION 'outbox failure left ghost publication state';
  END IF;
  PERFORM coverage_planner.cancel_coverage_request(request_id,'fault assertion complete');
END
$fault_assert$;

DROP TRIGGER test_reject_outbox ON coverage_planner.coverage_outbox_event;
DROP FUNCTION coverage_planner.test_reject_outbox();

SET LOCAL ROLE coverage_planner_provider;
SELECT coverage_request_id, status, replayed
FROM coverage_planner.submit_coverage_request(
  'coverage-runtime-test','dataset-role','coverage-request-role','coverage-idem-role',
  '00000000-0000-0000-0000-000000000004','sha256:'||repeat('c',64),
  'sha256:'||repeat('d',64),'{}','{}'
);
RESET ROLE;

ROLLBACK;
SELECT 'COVERAGE_PLANNER_RUNTIME_ASSERTIONS_PASS' AS result;
