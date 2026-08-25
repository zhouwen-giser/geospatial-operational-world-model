\set ON_ERROR_STOP on
BEGIN;

DO $assert$
BEGIN
  IF to_regprocedure('gowm_network_v1.coverage_selection_candidates(uuid,jsonb,text,text[],bigint,bigint,integer,text[])') IS NULL THEN
    RAISE EXCEPTION 'coverage selection read-contract function is missing';
  END IF;
  IF NOT has_function_privilege(
    'coverage_planner_provider',
    'gowm_network_v1.coverage_selection_candidates(uuid,jsonb,text,text[],bigint,bigint,integer,text[])',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Coverage Provider lacks the controlled selection read contract';
  END IF;
  IF has_schema_privilege('coverage_planner_provider','public','USAGE') THEN
    RAISE EXCEPTION 'Coverage Provider unexpectedly gained public schema usage';
  END IF;
  IF has_table_privilege('coverage_planner_provider','public.network_arc','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Coverage Provider can access the Network Foundation base arc table';
  END IF;
END
$assert$;

ROLLBACK;
SELECT 'NETWORK_COVERAGE_SELECTION_READ_CONTRACT_ASSERTIONS_PASS' AS result;
