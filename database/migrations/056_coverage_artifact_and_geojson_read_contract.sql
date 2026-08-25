BEGIN;

CREATE OR REPLACE FUNCTION coverage_planner.get_coverage_artifact(
  p_reference_key text,
  p_data_scope_key text,
  p_dataset_scope_key text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
  SELECT jsonb_build_object(
    'problem',problem.canonical_problem,
    'request',request.request_json,
    'result',result.result_record,
    'validUntil',result.valid_until,
    'expired',result.valid_until<=clock_timestamp()
  )
  FROM coverage_planner.coverage_result_set result
  JOIN coverage_planner.coverage_problem problem USING(coverage_problem_id,data_scope_key,dataset_scope_key)
  JOIN coverage_planner.coverage_request request USING(coverage_request_id,data_scope_key,dataset_scope_key)
  WHERE result.reference_key=p_reference_key AND result.data_scope_key=p_data_scope_key
    AND result.dataset_scope_key=p_dataset_scope_key
$fn$;

CREATE OR REPLACE FUNCTION coverage_planner.expand_coverage_alternative_geojson(
  p_reference_key text,
  p_alternative_id text,
  p_data_scope_key text,
  p_dataset_scope_key text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner, gowm_network_v1, public
AS $fn$
DECLARE
  result_row coverage_planner.coverage_result_set%ROWTYPE;
  alternative jsonb;
  features jsonb;
BEGIN
  PERFORM gowm_network_v1.set_scope(p_data_scope_key,p_dataset_scope_key);
  SELECT * INTO STRICT result_row FROM coverage_planner.coverage_result_set
  WHERE reference_key=p_reference_key AND data_scope_key=p_data_scope_key AND dataset_scope_key=p_dataset_scope_key;
  IF result_row.valid_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'coverage result is expired' USING ERRCODE='22023';
  END IF;
  SELECT value INTO STRICT alternative
  FROM jsonb_array_elements(result_row.result_record->'alternatives')
  WHERE value->>'alternativeId'=p_alternative_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'type','Feature','id',p_alternative_id || ':' || segment.ordinality,
    'geometry',public.ST_AsGeoJSON(public.ST_Transform(public.ST_LineSubstring(
      arc.oriented_geometry,(segment.value->>'startFractionPpm')::float8/1000000.0,
      (segment.value->>'endFractionPpm')::float8/1000000.0
    ),4326))::jsonb,
    'properties',jsonb_build_object(
      'sequence',(segment.value->>'sequence')::integer,'arcKey',segment.value->>'arcKey',
      'phase',segment.value->>'phase','serviceRole',segment.value->>'serviceRole',
      'traversalRole',segment.value->>'serviceRole',
      'coverageCredit',(segment.value->>'serviceRole')='SERVICE',
      'metrics',segment.value->'metrics'
    )
  ) ORDER BY segment.ordinality),'[]'::jsonb) INTO features
  FROM jsonb_array_elements(alternative#>'{route,segments}') WITH ORDINALITY segment(value,ordinality)
  JOIN gowm_network_v1.graph_version version
    ON version.graph_version=result_row.result_record#>>'{routingSnapshot,graphVersion}'
  JOIN gowm_network_v1.arc arc ON arc.graph_version_id=version.graph_version_id
   AND ('arc_' || substring(arc.arc_key from 4))=segment.value->>'arcKey';
  RETURN jsonb_build_object(
    'type','FeatureCollection','features',features,'crs','EPSG:4326',
    'resultSetReferenceKey',result_row.result_record->'referenceKey','alternativeId',p_alternative_id,
    'truncated',false
  );
END
$fn$;

REVOKE ALL ON FUNCTION coverage_planner.get_coverage_artifact(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION coverage_planner.expand_coverage_alternative_geojson(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coverage_planner.get_coverage_artifact(text,text,text) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.expand_coverage_alternative_geojson(text,text,text,text) TO coverage_planner_provider;

COMMIT;
