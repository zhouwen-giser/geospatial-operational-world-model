BEGIN;

CREATE SCHEMA coverage_planner;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coverage_planner_provider') THEN
    CREATE ROLE coverage_planner_provider NOLOGIN INHERIT;
  END IF;
END
$roles$;

CREATE TABLE coverage_planner.coverage_request (
  coverage_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  dataset_scope_key text NOT NULL,
  external_request_id text NOT NULL CHECK (length(external_request_id) BETWEEN 8 AND 256),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 256),
  gateway_job_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  routing_snapshot_hash text NOT NULL CHECK (routing_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  routing_snapshot jsonb NOT NULL CHECK (jsonb_typeof(routing_snapshot) = 'object'),
  request_json jsonb NOT NULL CHECK (jsonb_typeof(request_json) = 'object'),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','NO_FEASIBLE_PLAN','CANCELLED','FAILED')),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (coverage_request_id, data_scope_key, dataset_scope_key),
  UNIQUE (data_scope_key, dataset_scope_key, external_request_id),
  UNIQUE (data_scope_key, dataset_scope_key, idempotency_key),
  UNIQUE (gateway_job_id)
);

CREATE TABLE coverage_planner.coverage_problem (
  coverage_problem_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_request_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  problem_hash text NOT NULL CHECK (problem_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_problem jsonb NOT NULL CHECK (jsonb_typeof(canonical_problem) = 'object'),
  immutable boolean NOT NULL DEFAULT true CHECK (immutable),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coverage_problem_id, data_scope_key, dataset_scope_key),
  UNIQUE (data_scope_key, dataset_scope_key, problem_hash),
  UNIQUE (coverage_request_id),
  FOREIGN KEY (coverage_request_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_request(coverage_request_id, data_scope_key, dataset_scope_key)
);

CREATE TABLE coverage_planner.coverage_start_state (
  coverage_start_state_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_problem_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  arc_key text NOT NULL CHECK (arc_key ~ '^arc_[0-9a-f]{32,64}$'),
  fraction_ppm integer NOT NULL CHECK (fraction_ppm BETWEEN 0 AND 1000000),
  direction text NOT NULL CHECK (direction IN ('FORWARD','REVERSE')),
  heading_microdegrees integer CHECK (heading_microdegrees BETWEEN 0 AND 359999999),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coverage_problem_id),
  FOREIGN KEY (coverage_problem_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_problem(coverage_problem_id, data_scope_key, dataset_scope_key)
);

CREATE TABLE coverage_planner.coverage_boundary_state (
  coverage_boundary_state_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_problem_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  state_kind text NOT NULL CHECK (state_kind IN ('ENTRY','EXIT')),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  arc_key text NOT NULL CHECK (arc_key ~ '^arc_[0-9a-f]{32,64}$'),
  fraction_ppm integer NOT NULL CHECK (fraction_ppm BETWEEN 0 AND 1000000),
  direction text NOT NULL CHECK (direction IN ('FORWARD','REVERSE')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coverage_problem_id, state_kind, ordinal),
  FOREIGN KEY (coverage_problem_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_problem(coverage_problem_id, data_scope_key, dataset_scope_key)
);

CREATE TABLE coverage_planner.coverage_service_obligation (
  coverage_service_obligation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_problem_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  obligation_id text NOT NULL CHECK (length(obligation_id) BETWEEN 8 AND 128),
  graph_version text NOT NULL,
  edge_key text NOT NULL,
  arc_key text NOT NULL CHECK (arc_key ~ '^arc_[0-9a-f]{32,64}$'),
  start_fraction_ppm integer NOT NULL CHECK (start_fraction_ppm BETWEEN 0 AND 1000000),
  end_fraction_ppm integer NOT NULL CHECK (end_fraction_ppm BETWEEN 0 AND 1000000),
  service_mode text NOT NULL CHECK (service_mode = 'FIXED_DIRECTION'),
  required_passes integer NOT NULL CHECK (required_passes BETWEEN 1 AND 10),
  source_feature_reference_key text CHECK (source_feature_reference_key IS NULL OR source_feature_reference_key ~ '^wrf_[0-9a-f]{32}$'),
  selection_policy_version text NOT NULL CHECK (length(selection_policy_version) BETWEEN 1 AND 128),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coverage_service_obligation_id, data_scope_key, dataset_scope_key),
  UNIQUE (coverage_problem_id, obligation_id),
  UNIQUE (coverage_problem_id, content_hash),
  FOREIGN KEY (coverage_problem_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_problem(coverage_problem_id, data_scope_key, dataset_scope_key),
  CHECK (start_fraction_ppm <> end_fraction_ppm)
);

CREATE TABLE coverage_planner.coverage_run (
  coverage_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_request_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  gateway_job_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  generation bigint NOT NULL CHECK (generation >= 1),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','NO_FEASIBLE_PLAN','CANCELLED','FAILED','EXPIRED')),
  lease_owner text NOT NULL CHECK (length(lease_owner) BETWEEN 1 AND 256),
  lease_until timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stage text NOT NULL DEFAULT 'CLAIMED' CHECK (length(stage) BETWEEN 1 AND 64),
  resource_metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(resource_metrics) = 'object'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  error jsonb,
  UNIQUE (coverage_run_id, data_scope_key, dataset_scope_key),
  UNIQUE (coverage_request_id, generation),
  UNIQUE (gateway_job_id, attempt),
  FOREIGN KEY (coverage_request_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_request(coverage_request_id, data_scope_key, dataset_scope_key)
);
CREATE UNIQUE INDEX coverage_run_one_active_idx ON coverage_planner.coverage_run(coverage_request_id) WHERE status = 'RUNNING';

CREATE TABLE coverage_planner.coverage_candidate (
  coverage_candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_problem_id uuid NOT NULL,
  coverage_request_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  candidate_hash text NOT NULL CHECK (candidate_hash ~ '^sha256:[0-9a-f]{64}$'),
  objective_profile text NOT NULL,
  solver_diagnostics jsonb NOT NULL CHECK (jsonb_typeof(solver_diagnostics) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coverage_candidate_id, data_scope_key, dataset_scope_key),
  UNIQUE (coverage_problem_id, candidate_hash),
  FOREIGN KEY (coverage_problem_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_problem(coverage_problem_id, data_scope_key, dataset_scope_key),
  FOREIGN KEY (coverage_request_id, generation)
    REFERENCES coverage_planner.coverage_run(coverage_request_id, generation)
);

CREATE TABLE coverage_planner.coverage_candidate_route (
  coverage_candidate_route_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_candidate_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  route_index integer NOT NULL CHECK (route_index = 1),
  route_signature text NOT NULL CHECK (route_signature ~ '^sha256:[0-9a-f]{64}$'),
  start_state jsonb NOT NULL CHECK (jsonb_typeof(start_state) = 'object'),
  end_state jsonb NOT NULL CHECK (jsonb_typeof(end_state) = 'object'),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coverage_candidate_route_id, data_scope_key, dataset_scope_key),
  UNIQUE (coverage_candidate_id, route_index),
  FOREIGN KEY (coverage_candidate_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_candidate(coverage_candidate_id, data_scope_key, dataset_scope_key)
);

CREATE TABLE coverage_planner.coverage_route_segment (
  coverage_candidate_route_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  graph_version text NOT NULL,
  arc_key text NOT NULL CHECK (arc_key ~ '^arc_[0-9a-f]{32,64}$'),
  start_fraction_ppm integer NOT NULL CHECK (start_fraction_ppm BETWEEN 0 AND 1000000),
  end_fraction_ppm integer NOT NULL CHECK (end_fraction_ppm BETWEEN 0 AND 1000000),
  phase text NOT NULL CHECK (phase IN ('ACCESS','INSIDE','EXIT','RETURN')),
  service_role text NOT NULL CHECK (service_role IN ('SERVICE','DUPLICATE_SERVICE','TRANSIT','DEADHEAD','ACCESS','BOUNDARY_EXIT','RETURN')),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  source_feature_reference_key text CHECK (source_feature_reference_key IS NULL OR source_feature_reference_key ~ '^wrf_[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (coverage_candidate_route_id, sequence),
  FOREIGN KEY (coverage_candidate_route_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_candidate_route(coverage_candidate_route_id, data_scope_key, dataset_scope_key),
  CHECK (start_fraction_ppm <> end_fraction_ppm)
);

CREATE TABLE coverage_planner.coverage_verification_report (
  coverage_verification_report_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_candidate_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('VALID','INVALID','STALE','INDETERMINATE')),
  coverage_ratio_ppm integer NOT NULL CHECK (coverage_ratio_ppm BETWEEN 0 AND 1000000),
  length_weighted_coverage_ratio_ppm integer NOT NULL CHECK (length_weighted_coverage_ratio_ppm BETWEEN 0 AND 1000000),
  verifier_version text NOT NULL CHECK (length(verifier_version) BETWEEN 1 AND 128),
  report_hash text NOT NULL CHECK (report_hash ~ '^sha256:[0-9a-f]{64}$'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coverage_candidate_id),
  UNIQUE (data_scope_key, dataset_scope_key, report_hash),
  FOREIGN KEY (coverage_candidate_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_candidate(coverage_candidate_id, data_scope_key, dataset_scope_key)
);

CREATE TABLE coverage_planner.coverage_obligation_traversal_evidence (
  coverage_obligation_traversal_evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_candidate_id uuid NOT NULL,
  coverage_service_obligation_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  segment_sequence integer NOT NULL CHECK (segment_sequence >= 1),
  covered_start_fraction_ppm integer NOT NULL CHECK (covered_start_fraction_ppm BETWEEN 0 AND 1000000),
  covered_end_fraction_ppm integer NOT NULL CHECK (covered_end_fraction_ppm BETWEEN 0 AND 1000000),
  credited_pass integer NOT NULL CHECK (credited_pass BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coverage_candidate_id, coverage_service_obligation_id, segment_sequence, credited_pass),
  FOREIGN KEY (coverage_candidate_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_candidate(coverage_candidate_id, data_scope_key, dataset_scope_key),
  FOREIGN KEY (coverage_service_obligation_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_service_obligation(coverage_service_obligation_id, data_scope_key, dataset_scope_key),
  CHECK (covered_start_fraction_ppm <> covered_end_fraction_ppm)
);

CREATE TABLE coverage_planner.coverage_result_set (
  coverage_result_set_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_request_id uuid NOT NULL,
  coverage_problem_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  reference_key text NOT NULL CHECK (reference_key ~ '^wrf_[0-9a-f]{32}$'),
  problem_hash text NOT NULL CHECK (problem_hash ~ '^sha256:[0-9a-f]{64}$'),
  routing_snapshot_hash text NOT NULL CHECK (routing_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('SUCCEEDED','PARTIAL','NO_FEASIBLE_PLAN')),
  result_hash text NOT NULL CHECK (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  result_record jsonb NOT NULL CHECK (jsonb_typeof(result_record) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz NOT NULL,
  revalidation_required boolean NOT NULL DEFAULT true CHECK (revalidation_required),
  UNIQUE (coverage_result_set_id, data_scope_key, dataset_scope_key),
  UNIQUE (reference_key),
  UNIQUE (data_scope_key, dataset_scope_key, result_hash),
  UNIQUE (coverage_request_id),
  FOREIGN KEY (coverage_request_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_request(coverage_request_id, data_scope_key, dataset_scope_key),
  FOREIGN KEY (coverage_problem_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_problem(coverage_problem_id, data_scope_key, dataset_scope_key),
  CHECK (valid_until > created_at)
);

CREATE TABLE coverage_planner.coverage_alternative (
  coverage_alternative_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_result_set_id uuid NOT NULL,
  coverage_candidate_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  alternative_id text NOT NULL CHECK (length(alternative_id) BETWEEN 1 AND 128),
  rank integer NOT NULL CHECK (rank BETWEEN 1 AND 5),
  reference_key text NOT NULL CHECK (reference_key ~ '^wrf_[0-9a-f]{32}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coverage_result_set_id, alternative_id),
  UNIQUE (coverage_result_set_id, rank),
  UNIQUE (reference_key),
  FOREIGN KEY (coverage_result_set_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_result_set(coverage_result_set_id, data_scope_key, dataset_scope_key),
  FOREIGN KEY (coverage_candidate_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_candidate(coverage_candidate_id, data_scope_key, dataset_scope_key)
);

CREATE TABLE coverage_planner.coverage_pairwise_similarity (
  coverage_pairwise_similarity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coverage_result_set_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  left_alternative_id text NOT NULL,
  right_alternative_id text NOT NULL,
  weighted_arc_overlap_ppm integer NOT NULL CHECK (weighted_arc_overlap_ppm BETWEEN 0 AND 1000000),
  deadhead_jaccard_distance_ppm integer NOT NULL CHECK (deadhead_jaccard_distance_ppm BETWEEN 0 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coverage_result_set_id, left_alternative_id, right_alternative_id),
  FOREIGN KEY (coverage_result_set_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_result_set(coverage_result_set_id, data_scope_key, dataset_scope_key),
  CHECK (left_alternative_id < right_alternative_id)
);

CREATE TABLE coverage_planner.coverage_progress_event (
  coverage_progress_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coverage_request_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  stage text NOT NULL CHECK (length(stage) BETWEEN 1 AND 64),
  progress_ppm integer NOT NULL CHECK (progress_ppm BETWEEN 0 AND 1000000),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coverage_request_id, generation, sequence),
  FOREIGN KEY (coverage_request_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_request(coverage_request_id, data_scope_key, dataset_scope_key)
);

CREATE TABLE coverage_planner.coverage_outbox_event (
  coverage_outbox_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coverage_request_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1),
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('COVERAGE_RESULT_SET')),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('COVERAGE_RESULT_PUBLISHED')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  UNIQUE (coverage_request_id, generation, event_type),
  FOREIGN KEY (coverage_request_id, data_scope_key, dataset_scope_key)
    REFERENCES coverage_planner.coverage_request(coverage_request_id, data_scope_key, dataset_scope_key)
);

CREATE INDEX coverage_request_scope_status_idx ON coverage_planner.coverage_request(data_scope_key, dataset_scope_key, status, created_at);
CREATE INDEX coverage_request_gateway_job_idx ON coverage_planner.coverage_request(gateway_job_id, status);
CREATE INDEX coverage_problem_scope_hash_idx ON coverage_planner.coverage_problem(data_scope_key, dataset_scope_key, problem_hash);
CREATE INDEX coverage_obligation_problem_arc_idx ON coverage_planner.coverage_service_obligation(coverage_problem_id, arc_key);
CREATE INDEX coverage_run_lease_idx ON coverage_planner.coverage_run(status, lease_until);
CREATE INDEX coverage_candidate_problem_idx ON coverage_planner.coverage_candidate(coverage_problem_id, created_at);
CREATE INDEX coverage_result_scope_ttl_idx ON coverage_planner.coverage_result_set(data_scope_key, dataset_scope_key, valid_until);
CREATE INDEX coverage_progress_timeline_idx ON coverage_planner.coverage_progress_event(coverage_request_id, generation, sequence);
CREATE INDEX coverage_outbox_unpublished_idx ON coverage_planner.coverage_outbox_event(created_at) WHERE published_at IS NULL;

CREATE FUNCTION coverage_planner.reject_immutable_artifact_change()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'coverage artifact is immutable' USING ERRCODE = '55000';
END
$fn$;

CREATE FUNCTION coverage_planner.reject_terminal_request_change()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF OLD.status IN ('SUCCEEDED','PARTIAL','NO_FEASIBLE_PLAN','CANCELLED','FAILED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal coverage request is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER coverage_request_terminal_immutable BEFORE UPDATE ON coverage_planner.coverage_request FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_terminal_request_change();
CREATE TRIGGER coverage_problem_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_problem FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_start_state_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_start_state FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_boundary_state_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_boundary_state FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_obligation_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_service_obligation FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_candidate_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_candidate FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_candidate_route_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_candidate_route FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_route_segment_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_route_segment FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_verification_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_verification_report FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_traversal_evidence_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_obligation_traversal_evidence FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_result_set_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_result_set FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_alternative_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_alternative FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_similarity_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_pairwise_similarity FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();
CREATE TRIGGER coverage_progress_immutable BEFORE UPDATE OR DELETE ON coverage_planner.coverage_progress_event FOR EACH ROW EXECUTE FUNCTION coverage_planner.reject_immutable_artifact_change();

REVOKE ALL ON SCHEMA coverage_planner FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA coverage_planner FROM PUBLIC, coverage_planner_provider;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA coverage_planner FROM PUBLIC, coverage_planner_provider;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA coverage_planner FROM PUBLIC;
GRANT USAGE ON SCHEMA coverage_planner TO coverage_planner_provider;

GRANT USAGE ON SCHEMA gowm_network_v1 TO coverage_planner_provider;
GRANT SELECT ON ALL TABLES IN SCHEMA gowm_network_v1 TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.current_data_scope_key() TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.current_dataset_scope_key() TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.set_scope(text, text) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.resolve_active_graph(text) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.resolve_routing_snapshot(uuid, uuid, uuid, uuid) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.snap_candidates(uuid, geometry, integer) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.snap_candidates_wgs84(uuid, float8, float8, integer) TO coverage_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.routing_arc_projection(uuid, uuid, uuid, uuid) TO coverage_planner_provider;
ALTER ROLE coverage_planner_provider SET statement_timeout = '60s';

COMMIT;
