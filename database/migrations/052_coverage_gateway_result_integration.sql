BEGIN;

CREATE FUNCTION coverage_planner.persist_coverage_candidate(
  p_coverage_request_id uuid,
  p_generation bigint,
  p_lease_owner text,
  p_problem_hash text,
  p_objective_profile text,
  p_candidate_hash text,
  p_route jsonb,
  p_solver_diagnostics jsonb,
  p_verification jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner
AS $fn$
DECLARE
  request_row coverage_planner.coverage_request%ROWTYPE;
  problem_row coverage_planner.coverage_problem%ROWTYPE;
  candidate_id uuid;
  route_id uuid;
  segment jsonb;
  obligation_key text;
  obligation_row coverage_planner.coverage_service_obligation%ROWTYPE;
BEGIN
  IF p_problem_hash !~ '^sha256:[0-9a-f]{64}$' OR p_candidate_hash !~ '^sha256:[0-9a-f]{64}$'
     OR p_objective_profile IS NULL OR length(p_objective_profile) NOT BETWEEN 1 AND 128
     OR jsonb_typeof(p_route) <> 'object' OR jsonb_typeof(p_solver_diagnostics) <> 'object'
     OR jsonb_typeof(p_verification) <> 'object' THEN
    RAISE EXCEPTION 'invalid coverage candidate persistence' USING ERRCODE='22023';
  END IF;
  SELECT request.* INTO STRICT request_row
  FROM coverage_planner.coverage_request request
  JOIN coverage_planner.coverage_run run
    ON run.coverage_request_id=request.coverage_request_id AND run.generation=p_generation
  WHERE request.coverage_request_id=p_coverage_request_id AND request.generation=p_generation
    AND request.status='RUNNING' AND run.status='RUNNING' AND run.lease_owner=p_lease_owner
    AND run.lease_until>clock_timestamp();
  SELECT * INTO STRICT problem_row FROM coverage_planner.coverage_problem
  WHERE coverage_request_id=p_coverage_request_id AND problem_hash=p_problem_hash;
  SELECT coverage_candidate_id INTO candidate_id FROM coverage_planner.coverage_candidate
  WHERE coverage_problem_id=problem_row.coverage_problem_id AND candidate_hash=p_candidate_hash;
  IF candidate_id IS NOT NULL THEN RETURN candidate_id; END IF;

  INSERT INTO coverage_planner.coverage_candidate(
    coverage_problem_id,coverage_request_id,data_scope_key,dataset_scope_key,generation,
    candidate_hash,objective_profile,solver_diagnostics
  ) VALUES (
    problem_row.coverage_problem_id,p_coverage_request_id,request_row.data_scope_key,
    request_row.dataset_scope_key,p_generation,p_candidate_hash,p_objective_profile,p_solver_diagnostics
  ) RETURNING coverage_candidate_id INTO candidate_id;
  INSERT INTO coverage_planner.coverage_candidate_route(
    coverage_candidate_id,data_scope_key,dataset_scope_key,route_index,route_signature,
    start_state,end_state,metrics
  ) VALUES (
    candidate_id,request_row.data_scope_key,request_row.dataset_scope_key,1,p_route->>'routeSignature',
    p_route->'startState',p_route->'endState',p_route->'metrics'
  ) RETURNING coverage_candidate_route_id INTO route_id;
  FOR segment IN SELECT value FROM jsonb_array_elements(p_route->'segments')
  LOOP
    INSERT INTO coverage_planner.coverage_route_segment(
      coverage_candidate_route_id,data_scope_key,dataset_scope_key,sequence,graph_version,
      arc_key,start_fraction_ppm,end_fraction_ppm,phase,service_role,metrics,source_feature_reference_key
    ) VALUES (
      route_id,request_row.data_scope_key,request_row.dataset_scope_key,(segment->>'sequence')::integer,
      segment->>'graphVersion',segment->>'arcKey',(segment->>'startFractionPpm')::integer,
      (segment->>'endFractionPpm')::integer,segment->>'phase',segment->>'serviceRole',segment->'metrics',
      segment#>>'{sourceFeatureReferenceKey,id}'
    );
    FOR obligation_key IN SELECT value FROM jsonb_array_elements_text(COALESCE(segment->'obligationIds','[]'::jsonb))
    LOOP
      SELECT * INTO STRICT obligation_row FROM coverage_planner.coverage_service_obligation
      WHERE coverage_problem_id=problem_row.coverage_problem_id AND obligation_id=obligation_key;
      INSERT INTO coverage_planner.coverage_obligation_traversal_evidence(
        coverage_candidate_id,coverage_service_obligation_id,data_scope_key,dataset_scope_key,
        segment_sequence,covered_start_fraction_ppm,covered_end_fraction_ppm,credited_pass
      ) VALUES (
        candidate_id,obligation_row.coverage_service_obligation_id,request_row.data_scope_key,
        request_row.dataset_scope_key,(segment->>'sequence')::integer,
        GREATEST((segment->>'startFractionPpm')::integer,obligation_row.start_fraction_ppm),
        LEAST((segment->>'endFractionPpm')::integer,obligation_row.end_fraction_ppm),1
      );
    END LOOP;
  END LOOP;
  INSERT INTO coverage_planner.coverage_verification_report(
    coverage_candidate_id,data_scope_key,dataset_scope_key,status,coverage_ratio_ppm,
    length_weighted_coverage_ratio_ppm,verifier_version,report_hash,report
  ) VALUES (
    candidate_id,request_row.data_scope_key,request_row.dataset_scope_key,p_verification->>'status',
    (p_verification->>'coverageRatioPpm')::integer,(p_verification->>'lengthWeightedCoverageRatioPpm')::integer,
    p_verification->>'verifierVersion',p_verification->>'reportHash',p_verification
  );
  RETURN candidate_id;
END
$fn$;

CREATE FUNCTION coverage_planner.register_coverage_result_references()
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
  IF source_query_id IS NOT NULL THEN
    result_kind := CASE NEW.status WHEN 'SUCCEEDED' THEN 'COMPLETED' WHEN 'PARTIAL' THEN 'PARTIAL' ELSE 'NO_DATA' END;
    INSERT INTO public.world_query_result_reference(
      reference_key,query_id,data_scope_key,result_hash,status,data_snapshot_hash,
      compute_snapshot_hash,result_record,valid_until
    ) VALUES (
      NEW.reference_key,source_query_id,NEW.data_scope_key,NEW.result_hash,result_kind,
      NEW.routing_snapshot_hash,NEW.problem_hash,NEW.result_record,NEW.valid_until
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
        source_node_id,'[]'::jsonb,NEW.routing_snapshot_hash,NEW.problem_hash,'1.0',NULL,NULL,
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

CREATE TRIGGER coverage_result_registry_register
AFTER INSERT ON coverage_planner.coverage_result_set
FOR EACH ROW EXECUTE FUNCTION coverage_planner.register_coverage_result_references();

CREATE FUNCTION coverage_planner.get_coverage_artifact(
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
    'problem',problem.canonical_problem,'result',result.result_record,
    'validUntil',result.valid_until,'expired',result.valid_until<=clock_timestamp()
  )
  FROM coverage_planner.coverage_result_set result
  JOIN coverage_planner.coverage_problem problem USING(coverage_problem_id,data_scope_key,dataset_scope_key)
  WHERE result.reference_key=p_reference_key AND result.data_scope_key=p_data_scope_key
    AND result.dataset_scope_key=p_dataset_scope_key
$fn$;

CREATE FUNCTION coverage_planner.expand_coverage_alternative_geojson(
  p_reference_key text,
  p_alternative_id text,
  p_data_scope_key text,
  p_dataset_scope_key text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner, public
AS $fn$
DECLARE
  result_row coverage_planner.coverage_result_set%ROWTYPE;
  alternative jsonb;
  features jsonb;
BEGIN
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
    'geometry',public.ST_AsGeoJSON(public.ST_LineSubstring(
      arc.oriented_geometry,(segment.value->>'startFractionPpm')::float8/1000000.0,
      (segment.value->>'endFractionPpm')::float8/1000000.0
    ))::jsonb,
    'properties',jsonb_build_object(
      'sequence',(segment.value->>'sequence')::integer,'arcKey',segment.value->>'arcKey',
      'phase',segment.value->>'phase','serviceRole',segment.value->>'serviceRole',
      'metrics',segment.value->'metrics'
    )
  ) ORDER BY segment.ordinality),'[]'::jsonb) INTO features
  FROM jsonb_array_elements(alternative#>'{route,segments}') WITH ORDINALITY segment(value,ordinality)
  JOIN public.network_graph_version version
    ON version.data_scope_key=p_data_scope_key AND version.dataset_scope_key=p_dataset_scope_key
   AND version.graph_version=result_row.result_record#>>'{routingSnapshot,graphVersion}'
  JOIN public.network_arc arc ON arc.graph_version_id=version.graph_version_id
   AND ('arc_' || substring(arc.arc_key from 4))=segment.value->>'arcKey';
  RETURN jsonb_build_object(
    'type','FeatureCollection','features',features,'crs','EPSG:4326',
    'resultSetReferenceKey',result_row.result_record->'referenceKey','alternativeId',p_alternative_id,
    'truncated',false
  );
END
$fn$;

REVOKE ALL ON FUNCTION coverage_planner.persist_coverage_candidate(uuid,bigint,text,text,text,text,jsonb,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION coverage_planner.register_coverage_result_references() FROM PUBLIC;
REVOKE ALL ON FUNCTION coverage_planner.get_coverage_artifact(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION coverage_planner.expand_coverage_alternative_geojson(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coverage_planner.persist_coverage_candidate(uuid,bigint,text,text,text,text,jsonb,jsonb,jsonb) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.get_coverage_artifact(text,text,text) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION coverage_planner.expand_coverage_alternative_geojson(text,text,text,text) TO coverage_planner_provider;

COMMIT;
