BEGIN;

CREATE SCHEMA route_planner_runtime;

CREATE TABLE route_planner_runtime.route_request (
  route_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  external_request_id text NOT NULL CHECK (length(external_request_id) BETWEEN 1 AND 256),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  query_result_reference_key text NOT NULL CHECK (query_result_reference_key ~ '^wrf_[0-9a-f]{32}$'),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','NO_PATH','FAILED','CANCELLED')),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  result_hash text CHECK (result_hash IS NULL OR result_hash ~ '^sha256:[0-9a-f]{64}$'),
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (data_scope_key, dataset_scope_key, idempotency_key),
  UNIQUE (data_scope_key, dataset_scope_key, external_request_id),
  UNIQUE (query_result_reference_key)
);

CREATE TABLE route_planner_runtime.route_run (
  route_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_request_id uuid NOT NULL REFERENCES route_planner_runtime.route_request(route_request_id),
  generation integer NOT NULL CHECK (generation >= 1),
  status text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','NO_PATH','FAILED','CANCELLED','EXPIRED')),
  lease_owner text NOT NULL CHECK (length(lease_owner) BETWEEN 1 AND 256),
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  error jsonb,
  UNIQUE (route_request_id, generation)
);
CREATE UNIQUE INDEX route_run_one_active_idx ON route_planner_runtime.route_run(route_request_id) WHERE status='RUNNING';

CREATE TABLE route_planner_runtime.route_candidate (
  route_candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_request_id uuid NOT NULL REFERENCES route_planner_runtime.route_request(route_request_id),
  generation integer NOT NULL,
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 5),
  route_signature text NOT NULL CHECK (route_signature ~ '^sha256:[0-9a-f]{64}$'),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (route_request_id, rank),
  UNIQUE (route_request_id, route_signature),
  FOREIGN KEY (route_request_id, generation) REFERENCES route_planner_runtime.route_run(route_request_id, generation)
);

CREATE TABLE route_planner_runtime.route_segment (
  route_candidate_id uuid NOT NULL REFERENCES route_planner_runtime.route_candidate(route_candidate_id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  graph_version text NOT NULL,
  arc_key text NOT NULL CHECK (arc_key ~ '^arc_[0-9a-f]{32,64}$'),
  start_fraction_ppm integer NOT NULL CHECK (start_fraction_ppm BETWEEN 0 AND 1000000),
  end_fraction_ppm integer NOT NULL CHECK (end_fraction_ppm BETWEEN 0 AND 1000000),
  segment_role text NOT NULL CHECK (segment_role IN ('ROUTE','VIA','ACCESS','EXIT')),
  source_feature_reference_key text CHECK (source_feature_reference_key IS NULL OR source_feature_reference_key ~ '^wrf_[0-9a-f]{32}$'),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  PRIMARY KEY (route_candidate_id, ordinal)
);

CREATE TABLE route_planner_runtime.route_verification_report (
  route_candidate_id uuid PRIMARY KEY REFERENCES route_planner_runtime.route_candidate(route_candidate_id),
  status text NOT NULL CHECK (status IN ('VALID','STALE','INVALID','INDETERMINATE')),
  verifier_version text NOT NULL,
  verified_result_hash text NOT NULL CHECK (verified_result_hash ~ '^sha256:[0-9a-f]{64}$'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE route_planner_runtime.route_progress_event (
  progress_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route_request_id uuid NOT NULL REFERENCES route_planner_runtime.route_request(route_request_id),
  generation integer NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('SUBMITTED','CLAIMED','RECLAIMED','COMPLETED','NO_PATH','FAILED','CANCELLED')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION route_planner_runtime.submit_route_request(
  p_data_scope_key text, p_dataset_scope_key text, p_external_request_id text,
  p_idempotency_key text, p_request_hash text, p_request_payload jsonb,
  p_query_result_reference_key text
)
RETURNS TABLE(route_request_id uuid, status text, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, route_planner_runtime
AS $fn$
DECLARE existing route_planner_runtime.route_request%ROWTYPE;
BEGIN
  IF p_data_scope_key IS NULL OR p_dataset_scope_key IS NULL OR p_request_hash !~ '^sha256:[0-9a-f]{64}$' OR p_query_result_reference_key !~ '^wrf_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'invalid route submission' USING ERRCODE='22023';
  END IF;
  SELECT * INTO existing FROM route_planner_runtime.route_request
    WHERE data_scope_key=p_data_scope_key AND dataset_scope_key=p_dataset_scope_key AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF existing.request_hash <> p_request_hash OR existing.external_request_id <> p_external_request_id THEN
      RAISE EXCEPTION 'route idempotency conflict' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT existing.route_request_id,existing.status,true;
    RETURN;
  END IF;
  INSERT INTO route_planner_runtime.route_request(data_scope_key,dataset_scope_key,external_request_id,idempotency_key,request_hash,request_payload,query_result_reference_key)
  VALUES(p_data_scope_key,p_dataset_scope_key,p_external_request_id,p_idempotency_key,p_request_hash,p_request_payload,p_query_result_reference_key)
  RETURNING route_planner_runtime.route_request.route_request_id,route_planner_runtime.route_request.status INTO existing.route_request_id,existing.status;
  INSERT INTO route_planner_runtime.route_progress_event(route_request_id,generation,event_type) VALUES(existing.route_request_id,0,'SUBMITTED');
  RETURN QUERY SELECT existing.route_request_id,existing.status,false;
END
$fn$;

CREATE FUNCTION route_planner_runtime.claim_route_request(p_route_request_id uuid, p_lease_owner text, p_lease_seconds integer)
RETURNS TABLE(route_run_id uuid, generation integer, reclaimed boolean, lease_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, route_planner_runtime
AS $fn$
DECLARE request_row route_planner_runtime.route_request%ROWTYPE; prior route_planner_runtime.route_run%ROWTYPE; next_generation integer; new_run uuid; expiry timestamptz; was_reclaimed boolean := false;
BEGIN
  IF p_lease_owner IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN RAISE EXCEPTION 'invalid route lease' USING ERRCODE='22023'; END IF;
  SELECT * INTO STRICT request_row FROM route_planner_runtime.route_request WHERE route_request_id=p_route_request_id FOR UPDATE;
  IF request_row.status IN ('COMPLETED','NO_PATH','FAILED','CANCELLED') THEN RAISE EXCEPTION 'route request is terminal' USING ERRCODE='55000'; END IF;
  SELECT * INTO prior FROM route_planner_runtime.route_run WHERE route_request_id=p_route_request_id AND status='RUNNING' FOR UPDATE;
  IF FOUND THEN
    IF prior.lease_expires_at > clock_timestamp() THEN RAISE EXCEPTION 'route request lease is active' USING ERRCODE='55P03'; END IF;
    UPDATE route_planner_runtime.route_run SET status='EXPIRED',finished_at=clock_timestamp() WHERE route_planner_runtime.route_run.route_run_id=prior.route_run_id;
    was_reclaimed := true;
  END IF;
  next_generation := request_row.generation + 1; expiry := clock_timestamp() + make_interval(secs=>p_lease_seconds);
  INSERT INTO route_planner_runtime.route_run(route_request_id,generation,status,lease_owner,lease_expires_at) VALUES(p_route_request_id,next_generation,'RUNNING',p_lease_owner,expiry) RETURNING route_planner_runtime.route_run.route_run_id INTO new_run;
  UPDATE route_planner_runtime.route_request SET status='RUNNING',generation=next_generation,updated_at=clock_timestamp() WHERE route_request_id=p_route_request_id;
  INSERT INTO route_planner_runtime.route_progress_event(route_request_id,generation,event_type,details) VALUES(p_route_request_id,next_generation,CASE WHEN was_reclaimed THEN 'RECLAIMED' ELSE 'CLAIMED' END,jsonb_build_object('leaseOwner',p_lease_owner));
  RETURN QUERY SELECT new_run,next_generation,was_reclaimed,expiry;
END
$fn$;

CREATE FUNCTION route_planner_runtime.cancel_route_request(p_route_request_id uuid, p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, route_planner_runtime
AS $fn$
DECLARE changed integer; current_generation integer;
BEGIN
  UPDATE route_planner_runtime.route_request SET status='CANCELLED',cancellation_reason=p_reason,updated_at=clock_timestamp(),completed_at=clock_timestamp()
    WHERE route_request_id=p_route_request_id AND status IN ('QUEUED','RUNNING') RETURNING generation INTO current_generation;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed=1 THEN
    UPDATE route_planner_runtime.route_run SET status='CANCELLED',finished_at=clock_timestamp() WHERE route_request_id=p_route_request_id AND status='RUNNING';
    INSERT INTO route_planner_runtime.route_progress_event(route_request_id,generation,event_type,details) VALUES(p_route_request_id,current_generation,'CANCELLED',jsonb_build_object('reason',p_reason));
  END IF;
  RETURN changed=1;
END
$fn$;

CREATE FUNCTION route_planner_runtime.complete_route_request(p_route_request_id uuid, p_generation integer, p_lease_owner text, p_terminal_status text, p_result_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, route_planner_runtime
AS $fn$
DECLARE changed integer;
BEGIN
  IF p_terminal_status NOT IN ('COMPLETED','NO_PATH','FAILED') OR (p_terminal_status IN ('COMPLETED','NO_PATH') AND p_result_hash !~ '^sha256:[0-9a-f]{64}$') THEN RAISE EXCEPTION 'invalid route completion' USING ERRCODE='22023'; END IF;
  UPDATE route_planner_runtime.route_run SET status=p_terminal_status,finished_at=clock_timestamp()
    WHERE route_request_id=p_route_request_id AND generation=p_generation AND lease_owner=p_lease_owner AND status='RUNNING';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed<>1 THEN RETURN false; END IF;
  UPDATE route_planner_runtime.route_request SET status=p_terminal_status,result_hash=p_result_hash,updated_at=clock_timestamp(),completed_at=clock_timestamp()
    WHERE route_request_id=p_route_request_id AND generation=p_generation AND status='RUNNING';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'late route completion rejected' USING ERRCODE='40001'; END IF;
  INSERT INTO route_planner_runtime.route_progress_event(route_request_id,generation,event_type) VALUES(p_route_request_id,p_generation,p_terminal_status);
  RETURN true;
END
$fn$;

CREATE FUNCTION route_planner_runtime.reject_route_result_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'completed route artifacts are immutable' USING ERRCODE='55000'; END $fn$;
CREATE TRIGGER route_candidate_immutable BEFORE UPDATE OR DELETE ON route_planner_runtime.route_candidate FOR EACH ROW EXECUTE FUNCTION route_planner_runtime.reject_route_result_mutation();
CREATE TRIGGER route_segment_immutable BEFORE UPDATE OR DELETE ON route_planner_runtime.route_segment FOR EACH ROW EXECUTE FUNCTION route_planner_runtime.reject_route_result_mutation();
CREATE TRIGGER route_verification_immutable BEFORE UPDATE OR DELETE ON route_planner_runtime.route_verification_report FOR EACH ROW EXECUTE FUNCTION route_planner_runtime.reject_route_result_mutation();

REVOKE ALL ON SCHEMA route_planner_runtime FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA route_planner_runtime FROM PUBLIC, route_planner_provider;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA route_planner_runtime FROM PUBLIC;
GRANT USAGE ON SCHEMA route_planner_runtime TO route_planner_provider;
GRANT EXECUTE ON FUNCTION route_planner_runtime.submit_route_request(text,text,text,text,text,jsonb,text) TO route_planner_provider;
GRANT EXECUTE ON FUNCTION route_planner_runtime.claim_route_request(uuid,text,integer) TO route_planner_provider;
GRANT EXECUTE ON FUNCTION route_planner_runtime.cancel_route_request(uuid,text) TO route_planner_provider;
GRANT EXECUTE ON FUNCTION route_planner_runtime.complete_route_request(uuid,integer,text,text,text) TO route_planner_provider;

COMMIT;
