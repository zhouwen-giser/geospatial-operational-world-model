\set ON_ERROR_STOP on
BEGIN;

DO $architecture$
DECLARE
  register_definition text;
  expand_definition text;
BEGIN
  SELECT pg_get_functiondef('coverage_planner.register_coverage_result_references()'::regprocedure) INTO register_definition;
  SELECT pg_get_functiondef('coverage_planner.expand_coverage_alternative_geojson(text,text,text,text)'::regprocedure) INTO expand_definition;
  IF position('WORLD_QUERY_RESULT_REFERENCE' in upper(register_definition))=0
     OR position('DERIVED_REFERENCE' in upper(register_definition))=0 THEN
    RAISE EXCEPTION 'coverage result registry integration is incomplete';
  END IF;
  IF position('ST_LINESUBSTRING' in upper(expand_definition))=0
     OR position('ORDER BY SEGMENT.ORDINALITY' in upper(expand_definition))=0 THEN
    RAISE EXCEPTION 'coverage expansion does not preserve ordered partial segments';
  END IF;
  IF NOT has_function_privilege('coverage_planner_provider','coverage_planner.persist_coverage_candidate(uuid,bigint,text,text,text,text,jsonb,jsonb,jsonb)','EXECUTE')
     OR NOT has_function_privilege('coverage_planner_provider','coverage_planner.get_coverage_artifact(text,text,text)','EXECUTE')
     OR NOT has_function_privilege('coverage_planner_provider','coverage_planner.expand_coverage_alternative_geojson(text,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Provider lacks controlled Gateway/result functions';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid='coverage_planner.register_coverage_result_references()'::regprocedure
      AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
  ) THEN
    RAISE EXCEPTION 'result-registry trigger function is executable by PUBLIC';
  END IF;
  IF has_table_privilege('coverage_planner_provider','public.world_query_result_reference','INSERT')
     OR has_table_privilege('coverage_planner_provider','public.derived_reference','INSERT') THEN
    RAISE EXCEPTION 'Provider gained direct Result Registry mutation';
  END IF;
END
$architecture$;

ROLLBACK;
SELECT 'COVERAGE_GATEWAY_RESULT_ASSERTIONS_PASS' AS result;
