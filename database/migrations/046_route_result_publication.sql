BEGIN;

ALTER TABLE route_planner_runtime.route_request
  ADD COLUMN result_payload jsonb CHECK (result_payload IS NULL OR jsonb_typeof(result_payload)='object'),
  ADD COLUMN published_at timestamptz;

CREATE TABLE route_planner_runtime.route_query_result_reference (
  route_result_reference_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_key text NOT NULL UNIQUE REFERENCES world_reference_identity(reference_key),
  route_request_id uuid NOT NULL UNIQUE REFERENCES route_planner_runtime.route_request(route_request_id),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  dataset_scope_key text NOT NULL,
  result_hash text NOT NULL CHECK (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  routing_snapshot_hash text NOT NULL CHECK (routing_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  solver_version text NOT NULL CHECK (length(solver_version) BETWEEN 1 AND 128),
  verifier_version text NOT NULL CHECK (length(verifier_version) BETWEEN 1 AND 128),
  result_record jsonb NOT NULL CHECK (jsonb_typeof(result_record)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz NOT NULL,
  revalidation_required boolean NOT NULL DEFAULT true,
  CHECK (valid_until > created_at)
);

CREATE INDEX route_query_result_scope_idx ON route_planner_runtime.route_query_result_reference(data_scope_key,dataset_scope_key,reference_key);

CREATE FUNCTION route_planner_runtime.publish_route_result(
  p_route_request_id uuid, p_generation integer, p_lease_owner text,
  p_result_payload jsonb, p_result_hash text, p_routing_snapshot_hash text,
  p_solver_version text, p_verifier_version text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,route_planner_runtime
AS $fn$
DECLARE request_row route_planner_runtime.route_request%ROWTYPE; candidate jsonb; segment jsonb; candidate_id uuid; candidate_ordinal integer; segment_ordinal integer; terminal_status text; changed integer;
BEGIN
  IF jsonb_typeof(p_result_payload)<>'object' OR p_result_hash !~ '^sha256:[0-9a-f]{64}$' OR p_routing_snapshot_hash !~ '^sha256:[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid route result publication' USING ERRCODE='22023'; END IF;
  terminal_status:=p_result_payload->>'status';
  IF terminal_status NOT IN ('COMPLETED','NO_PATH') OR (p_result_payload->>'validUntil')::timestamptz<=clock_timestamp() OR COALESCE((p_result_payload->>'revalidationRequired')::boolean,false)<>true THEN RAISE EXCEPTION 'invalid route terminal result' USING ERRCODE='22023'; END IF;
  SELECT * INTO STRICT request_row FROM route_planner_runtime.route_request WHERE route_request_id=p_route_request_id FOR UPDATE;
  IF request_row.status<>'RUNNING' OR request_row.generation<>p_generation OR EXISTS (SELECT 1 FROM route_planner_runtime.route_query_result_reference WHERE route_request_id=p_route_request_id) THEN RETURN false; END IF;
  UPDATE route_planner_runtime.route_run SET status=terminal_status,finished_at=clock_timestamp() WHERE route_request_id=p_route_request_id AND generation=p_generation AND lease_owner=p_lease_owner AND status='RUNNING';
  GET DIAGNOSTICS changed=ROW_COUNT; IF changed<>1 THEN RETURN false; END IF;

  FOR candidate,candidate_ordinal IN SELECT value,ordinality::integer FROM jsonb_array_elements(COALESCE(p_result_payload->'candidates','[]'::jsonb)) WITH ORDINALITY LOOP
    INSERT INTO route_planner_runtime.route_candidate(route_request_id,generation,rank,route_signature,metrics) VALUES(p_route_request_id,p_generation,(candidate->>'rank')::integer,candidate->>'routeSignature',candidate->'metrics') RETURNING route_candidate_id INTO candidate_id;
    FOR segment,segment_ordinal IN SELECT value,(ordinality-1)::integer FROM jsonb_array_elements(COALESCE(candidate->'segments','[]'::jsonb)) WITH ORDINALITY LOOP
      INSERT INTO route_planner_runtime.route_segment(route_candidate_id,ordinal,graph_version,arc_key,start_fraction_ppm,end_fraction_ppm,segment_role,source_feature_reference_key,metrics)
      VALUES(candidate_id,segment_ordinal,segment->>'graphVersion',segment->>'arcKey',(segment->>'startFractionPpm')::integer,(segment->>'endFractionPpm')::integer,COALESCE(segment->>'segmentRole','ROUTE'),segment#>>'{sourceFeatureReferenceKey,id}',jsonb_strip_nulls(jsonb_build_object('distanceMm',segment->'distanceMm','durationMs',segment->'durationMs','riskMicroUnits',segment->'riskMicroUnits','energyMwh',segment->'energyMwh','turnPenaltyUnits',segment->'turnPenaltyUnits')));
    END LOOP;
    INSERT INTO route_planner_runtime.route_verification_report(route_candidate_id,status,verifier_version,verified_result_hash,report) VALUES(candidate_id,candidate#>>'{verification,status}',candidate#>>'{verification,verifierVersion}',candidate#>>'{verification,verifiedResultHash}',candidate->'verification');
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.world_reference_identity WHERE reference_key=request_row.query_result_reference_key) THEN
    PERFORM public.register_result_registry_identity(request_row.query_result_reference_key,'QUERY_RESULT',p_route_request_id::text,request_row.data_scope_key,'Route plan '||request_row.external_request_id);
  END IF;
  INSERT INTO route_planner_runtime.route_query_result_reference(reference_key,route_request_id,data_scope_key,dataset_scope_key,result_hash,routing_snapshot_hash,solver_version,verifier_version,result_record,valid_until)
  VALUES(request_row.query_result_reference_key,p_route_request_id,request_row.data_scope_key,request_row.dataset_scope_key,p_result_hash,p_routing_snapshot_hash,p_solver_version,p_verifier_version,p_result_payload,(p_result_payload->>'validUntil')::timestamptz);
  UPDATE route_planner_runtime.route_request SET status=terminal_status,result_hash=p_result_hash,result_payload=p_result_payload,published_at=clock_timestamp(),updated_at=clock_timestamp(),completed_at=clock_timestamp() WHERE route_request_id=p_route_request_id AND generation=p_generation AND status='RUNNING';
  GET DIAGNOSTICS changed=ROW_COUNT; IF changed<>1 THEN RAISE EXCEPTION 'late route publication rejected' USING ERRCODE='40001'; END IF;
  INSERT INTO route_planner_runtime.route_progress_event(route_request_id,generation,event_type) VALUES(p_route_request_id,p_generation,terminal_status);
  RETURN true;
END
$fn$;

CREATE FUNCTION route_planner_runtime.get_route_result(p_route_request_id uuid,p_data_scope_key text,p_dataset_scope_key text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,route_planner_runtime
AS $fn$ SELECT result_payload FROM route_planner_runtime.route_request WHERE route_request_id=p_route_request_id AND data_scope_key=p_data_scope_key AND dataset_scope_key=p_dataset_scope_key AND status IN ('COMPLETED','NO_PATH') $fn$;

CREATE FUNCTION route_planner_runtime.reject_route_terminal_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN IF OLD.status IN ('COMPLETED','NO_PATH','FAILED','CANCELLED') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'terminal route request is immutable' USING ERRCODE='55000'; END IF; RETURN NEW; END $fn$;
CREATE TRIGGER route_request_terminal_immutable BEFORE UPDATE ON route_planner_runtime.route_request FOR EACH ROW EXECUTE FUNCTION route_planner_runtime.reject_route_terminal_mutation();
CREATE TRIGGER route_query_result_immutable BEFORE UPDATE OR DELETE ON route_planner_runtime.route_query_result_reference FOR EACH ROW EXECUTE FUNCTION route_planner_runtime.reject_route_result_mutation();

CREATE VIEW gowm_result_v1.route_query_result AS
SELECT result.reference_key,jsonb_build_object('namespace','gowm','kind','QUERY_RESULT','id',result.reference_key,'version','1') AS reference_key_value,
       result.route_request_id::text AS query_id,result.result_hash,'COMPLETED'::text AS status,result.routing_snapshot_hash AS data_snapshot_hash,
       'sha256:'||encode(digest(convert_to(result.solver_version||':'||result.verifier_version,'UTF8'),'sha256'),'hex') AS compute_snapshot_hash,
       result.created_at,result.valid_until,'[]'::jsonb AS artifact_refs,result.result_record,result.revalidation_required
FROM route_planner_runtime.route_query_result_reference result
WHERE result.data_scope_key=gowm_result_v1.current_data_scope_key();

REVOKE ALL ON FUNCTION route_planner_runtime.publish_route_result(uuid,integer,text,jsonb,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION route_planner_runtime.get_route_result(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA route_planner_runtime FROM route_planner_provider;
GRANT EXECUTE ON FUNCTION route_planner_runtime.publish_route_result(uuid,integer,text,jsonb,text,text,text,text) TO route_planner_provider;
GRANT EXECUTE ON FUNCTION route_planner_runtime.get_route_result(uuid,text,text) TO route_planner_provider;
GRANT SELECT ON gowm_result_v1.route_query_result TO gowm_result_reader;

COMMIT;
