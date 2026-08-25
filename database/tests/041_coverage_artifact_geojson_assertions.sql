BEGIN;

DO $assert$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef('coverage_planner.expand_coverage_alternative_geojson(text,text,text,text)'::regprocedure) INTO definition;
  IF definition !~ 'gowm_network_v1\.graph_version' OR definition !~ 'gowm_network_v1\.arc' THEN
    RAISE EXCEPTION 'coverage GeoJSON expansion does not use the versioned network read contract';
  END IF;
  IF definition ~ 'public\.network_(arc|graph_version)' THEN
    RAISE EXCEPTION 'coverage GeoJSON expansion reads private public network tables';
  END IF;
  IF definition !~ 'coverageCredit' OR definition !~ 'traversalRole' THEN
    RAISE EXCEPTION 'coverage GeoJSON expansion omits traversal credit evidence';
  END IF;
  SELECT pg_get_functiondef('coverage_planner.get_coverage_artifact(text,text,text)'::regprocedure) INTO definition;
  IF definition !~ '''request''' OR definition !~ 'request_json' THEN
    RAISE EXCEPTION 'coverage artifact does not retain the authoritative request';
  END IF;
END
$assert$;

ROLLBACK;
