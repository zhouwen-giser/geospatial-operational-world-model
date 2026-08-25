BEGIN;

DO $assert$
BEGIN
  IF to_regprocedure('gowm_network_v1.segment_boundary_crossings(uuid,jsonb,text,integer,integer)') IS NULL OR
     to_regprocedure('gowm_network_v1.route_boundary_crossings(uuid,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'versioned boundary crossing functions are missing';
  END IF;
  IF has_function_privilege('public', 'gowm_network_v1.route_boundary_crossings(uuid,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute route boundary crossing authority';
  END IF;
  IF NOT has_function_privilege('coverage_planner_provider', 'gowm_network_v1.route_boundary_crossings(uuid,jsonb,jsonb)', 'EXECUTE') OR
     NOT has_function_privilege('route_planner_provider', 'gowm_network_v1.route_boundary_crossings(uuid,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'route/coverage providers cannot execute the boundary crossing authority';
  END IF;
END
$assert$;

ROLLBACK;
