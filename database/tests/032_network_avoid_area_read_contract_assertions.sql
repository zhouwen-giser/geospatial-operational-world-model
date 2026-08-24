\set ON_ERROR_STOP on
BEGIN;
DO $assert$
BEGIN
  IF to_regprocedure('gowm_network_v1.arcs_intersecting_areas(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'avoid-area read function is missing';
  END IF;
  IF has_function_privilege('public', 'gowm_network_v1.arcs_intersecting_areas(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'avoid-area read function is executable by PUBLIC';
  END IF;
  IF NOT has_function_privilege('route_planner_provider', 'gowm_network_v1.arcs_intersecting_areas(uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'route planner cannot execute avoid-area read function';
  END IF;
END
$assert$;
ROLLBACK;
SELECT 'NETWORK_AVOID_AREA_READ_CONTRACT_ASSERTIONS_PASS' AS result;
