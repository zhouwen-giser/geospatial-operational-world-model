BEGIN;

CREATE OR REPLACE FUNCTION coverage_planner.register_coverage_result_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner, public, gowm_capability
AS $fn$
DECLARE
  request_row coverage_planner.coverage_request%ROWTYPE;
  source_query_id text;
  source_node_id text;
  alternative jsonb;
  similarity jsonb;
  alternative_reference text;
  candidate_id uuid;
  result_kind text;
  integrity_receipt jsonb;
  data_digest text;
  compute_digest text;
BEGIN
  IF NEW.result_record->'referenceKey' IS NULL THEN RETURN NEW; END IF;
  IF NEW.result_record#>>'{referenceKey,kind}' <> 'QUERY_RESULT'
     OR NEW.result_record#>>'{referenceKey,id}' <> NEW.reference_key THEN
    RAISE EXCEPTION 'coverage result QUERY_RESULT identity mismatch' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT request_row FROM coverage_planner.coverage_request
  WHERE coverage_request_id=NEW.coverage_request_id;
  SELECT query_id INTO source_query_id FROM gowm_capability.world_query_job
  WHERE job_id=request_row.gateway_job_id;
  IF NOT EXISTS (SELECT 1 FROM public.world_reference_identity WHERE reference_key=NEW.reference_key) THEN
    PERFORM public.register_result_registry_identity(
      NEW.reference_key,'QUERY_RESULT',NEW.coverage_request_id::text,NEW.data_scope_key,
      'Road coverage plan set ' || request_row.external_request_id
    );
  END IF;
  SELECT value INTO integrity_receipt
  FROM jsonb_array_elements(COALESCE(NEW.result_record->'receipts','[]'::jsonb))
  WHERE value->>'kind'='SNAPSHOT_INTEGRITY' LIMIT 1;
  data_digest := COALESCE(integrity_receipt->>'dataSnapshotHash',NEW.routing_snapshot_hash);
  -- Legacy v1 publishers may omit the additive receipt: hash an explicitly UNKNOWN
  -- compute manifest, never reuse Problem Hash as computation identity.
  compute_digest := COALESCE(integrity_receipt->>'computeSnapshotHash',
    'sha256:'||encode(public.digest('{"availability":"UNKNOWN","provider":"legacy-coverage","reason":"NO_COMPUTE_MANIFEST","schemaVersion":"1.0"}','sha256'),'hex'));
  IF data_digest !~ '^sha256:[0-9a-f]{64}$' OR compute_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid coverage snapshot integrity receipt' USING ERRCODE='22023';
  END IF;
  IF source_query_id IS NOT NULL THEN
    result_kind := CASE NEW.status WHEN 'SUCCEEDED' THEN 'COMPLETED' WHEN 'PARTIAL' THEN 'PARTIAL' ELSE 'NO_DATA' END;
    INSERT INTO public.world_query_result_reference(
      reference_key,query_id,data_scope_key,result_hash,status,data_snapshot_hash,
      compute_snapshot_hash,result_record,valid_until
    ) VALUES (
      NEW.reference_key,source_query_id,NEW.data_scope_key,NEW.result_hash,result_kind,
      data_digest,compute_digest,NEW.result_record,NEW.valid_until
    ) ON CONFLICT (query_id) DO NOTHING;
    SELECT node_id INTO source_node_id FROM gowm_capability.world_query_node_execution
    WHERE job_id=request_row.gateway_job_id AND operation_id='coverage.road.plan'
    ORDER BY node_ordinal LIMIT 1;
  END IF;

  FOR alternative IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.result_record->'alternatives','[]'::jsonb))
  LOOP
    alternative_reference := alternative#>>'{referenceKey,id}';
    IF alternative#>>'{referenceKey,kind}' <> 'DERIVED_REFERENCE'
       OR alternative_reference !~ '^wrf_[0-9a-f]{32}$'
       OR alternative->>'contentHash' !~ '^sha256:[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'coverage alternative DERIVED_REFERENCE identity mismatch' USING ERRCODE='22023';
    END IF;
    SELECT candidate.coverage_candidate_id INTO STRICT candidate_id
    FROM coverage_planner.coverage_candidate candidate
    JOIN coverage_planner.coverage_candidate_route route USING(coverage_candidate_id,data_scope_key,dataset_scope_key)
    WHERE candidate.coverage_problem_id=NEW.coverage_problem_id
      AND route.route_signature=alternative#>>'{route,routeSignature}';
    INSERT INTO coverage_planner.coverage_alternative(
      coverage_result_set_id,coverage_candidate_id,data_scope_key,dataset_scope_key,
      alternative_id,rank,reference_key,content_hash
    ) VALUES (
      NEW.coverage_result_set_id,candidate_id,NEW.data_scope_key,NEW.dataset_scope_key,
      alternative->>'alternativeId',(alternative->>'rank')::integer,alternative_reference,alternative->>'contentHash'
    );
    IF NOT EXISTS (SELECT 1 FROM public.world_reference_identity WHERE reference_key=alternative_reference) THEN
      PERFORM public.register_result_registry_identity(
        alternative_reference,'DERIVED_REFERENCE',alternative->>'alternativeId',NEW.data_scope_key,
        'Road coverage alternative ' || (alternative->>'alternativeId')
      );
    END IF;
    IF source_query_id IS NOT NULL THEN
      INSERT INTO public.derived_reference(
        reference_key,data_scope_key,derived_type,operator,source_query_id,source_node_id,
        input_reference_keys,data_snapshot_hash,compute_snapshot_hash,method_version,
        geometry_summary,artifact_ref,content_hash,valid_until,revalidation_required
      ) VALUES (
        alternative_reference,NEW.data_scope_key,'ANALYSIS_RESULT','coverage.road.plan',source_query_id,
        source_node_id,'[]'::jsonb,data_digest,compute_digest,'1.0',NULL,NULL,
        alternative->>'contentHash',NEW.valid_until,true
      ) ON CONFLICT (data_scope_key,content_hash) DO NOTHING;
    END IF;
  END LOOP;
  FOR similarity IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.result_record->'pairwiseSimilarity','[]'::jsonb))
  LOOP
    INSERT INTO coverage_planner.coverage_pairwise_similarity(
      coverage_result_set_id,data_scope_key,dataset_scope_key,left_alternative_id,right_alternative_id,
      weighted_arc_overlap_ppm,deadhead_jaccard_distance_ppm
    ) VALUES (
      NEW.coverage_result_set_id,NEW.data_scope_key,NEW.dataset_scope_key,
      LEAST(similarity->>'leftAlternativeId',similarity->>'rightAlternativeId'),
      GREATEST(similarity->>'leftAlternativeId',similarity->>'rightAlternativeId'),
      (similarity->>'weightedArcOverlapPpm')::integer,(similarity->>'deadheadJaccardDistancePpm')::integer
    );
  END LOOP;
  RETURN NEW;
END
$fn$;

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
  JOIN coverage_planner.coverage_problem problem
    ON problem.coverage_problem_id=result.coverage_problem_id
   AND problem.data_scope_key=result.data_scope_key
   AND problem.dataset_scope_key=result.dataset_scope_key
  JOIN coverage_planner.coverage_request request
    ON request.coverage_request_id=result.coverage_request_id
   AND request.data_scope_key=result.data_scope_key
   AND request.dataset_scope_key=result.dataset_scope_key
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
