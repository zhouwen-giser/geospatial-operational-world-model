\set ON_ERROR_STOP on
BEGIN;

DO $assert$
DECLARE
  expected_tables text[] := ARRAY[
    'coverage_request','coverage_problem','coverage_start_state','coverage_boundary_state',
    'coverage_service_obligation','coverage_run','coverage_candidate','coverage_candidate_route',
    'coverage_route_segment','coverage_verification_report','coverage_obligation_traversal_evidence',
    'coverage_result_set','coverage_alternative','coverage_pairwise_similarity',
    'coverage_progress_event','coverage_outbox_event'
  ];
  table_name_value text;
  missing_scope_columns integer;
  fraction_constraints integer;
BEGIN
  FOREACH table_name_value IN ARRAY expected_tables LOOP
    IF to_regclass('coverage_planner.' || table_name_value) IS NULL THEN
      RAISE EXCEPTION 'missing coverage table %', table_name_value;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      WHERE namespace.nspname='coverage_planner' AND class.relkind='r') <> cardinality(expected_tables) THEN
    RAISE EXCEPTION 'coverage schema owns an unexpected table count';
  END IF;
  IF to_regclass('coverage_planner.graph_version') IS NOT NULL
     OR to_regclass('coverage_planner.road_arc') IS NOT NULL
     OR to_regclass('coverage_planner.turn_transition') IS NOT NULL
     OR to_regclass('coverage_planner.turn_sequence_restriction') IS NOT NULL THEN
    RAISE EXCEPTION 'coverage schema created a second network authority';
  END IF;

  SELECT count(*) INTO missing_scope_columns
  FROM unnest(expected_tables) AS expected(table_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='coverage_planner' AND information_schema.columns.table_name=expected.table_name
      AND column_name='data_scope_key'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='coverage_planner' AND information_schema.columns.table_name=expected.table_name
      AND column_name='dataset_scope_key'
  );
  IF missing_scope_columns <> 0 THEN RAISE EXCEPTION 'coverage tables without complete scope columns: %', missing_scope_columns; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='coverage_planner_provider') THEN RAISE EXCEPTION 'coverage role missing'; END IF;
  IF NOT has_schema_privilege('coverage_planner_provider','coverage_planner','USAGE') THEN RAISE EXCEPTION 'coverage role lacks private schema usage'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(expected_tables) expected(table_name)
    WHERE has_table_privilege('coverage_planner_provider','coverage_planner.'||expected.table_name,'INSERT,UPDATE,DELETE')
  ) THEN RAISE EXCEPTION 'coverage role has direct private table mutation'; END IF;
  IF NOT has_table_privilege('coverage_planner_provider','gowm_network_v1.arc','SELECT') THEN RAISE EXCEPTION 'coverage role lacks network read contract'; END IF;
  IF has_table_privilege('coverage_planner_provider','public.network_arc','INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'coverage role can mutate Network Foundation'; END IF;
  IF NOT has_function_privilege('coverage_planner_provider','coverage_planner.submit_coverage_request(text,text,text,text,uuid,text,text,jsonb,jsonb)','EXECUTE')
     OR NOT has_function_privilege('coverage_planner_provider','coverage_planner.claim_coverage_request(uuid,integer,text,integer)','EXECUTE')
     OR NOT has_function_privilege('coverage_planner_provider','coverage_planner.persist_coverage_problem(uuid,bigint,text,text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('coverage_planner_provider','coverage_planner.publish_coverage_result(uuid,bigint,text,text,text,text,timestamptz,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'coverage role lacks a controlled write function';
  END IF;

  IF to_regclass('coverage_planner.coverage_request_scope_status_idx') IS NULL
     OR to_regclass('coverage_planner.coverage_request_gateway_job_idx') IS NULL
     OR to_regclass('coverage_planner.coverage_problem_scope_hash_idx') IS NULL
     OR to_regclass('coverage_planner.coverage_run_lease_idx') IS NULL
     OR to_regclass('coverage_planner.coverage_result_scope_ttl_idx') IS NULL
     OR to_regclass('coverage_planner.coverage_progress_timeline_idx') IS NULL
     OR to_regclass('coverage_planner.coverage_outbox_unpublished_idx') IS NULL THEN
    RAISE EXCEPTION 'coverage performance index missing';
  END IF;

  IF (SELECT count(*) FROM pg_trigger trigger
      JOIN pg_class class ON class.oid=trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      WHERE namespace.nspname='coverage_planner' AND NOT trigger.tgisinternal
        AND trigger.tgname LIKE '%immutable%') < 14 THEN
    RAISE EXCEPTION 'coverage immutable trigger set is incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint constraint_record
    WHERE constraint_record.conrelid='coverage_planner.coverage_candidate_route'::regclass
      AND constraint_record.contype='c'
      AND pg_get_constraintdef(constraint_record.oid) ~ 'route_index = 1'
  ) THEN RAISE EXCEPTION 'stable route_index=1 constraint missing'; END IF;

  SELECT count(*) INTO fraction_constraints
  FROM pg_constraint constraint_record
  JOIN pg_class class ON class.oid=constraint_record.conrelid
  JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
  WHERE namespace.nspname='coverage_planner' AND constraint_record.contype='c'
    AND pg_get_constraintdef(constraint_record.oid) LIKE '%1000000%';
  IF fraction_constraints < 10 THEN RAISE EXCEPTION 'fraction/ratio bounds are incomplete: %', fraction_constraints; END IF;
END
$assert$;

ROLLBACK;
SELECT 'COVERAGE_PLANNER_SCHEMA_ASSERTIONS_PASS' AS result;
