BEGIN;

CREATE TABLE network_build_run (
  build_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  build_policy_version text NOT NULL CHECK (length(build_policy_version) BETWEEN 1 AND 128),
  adapter_kind text NOT NULL CHECK (adapter_kind IN ('CATALOG_VECTOR_LAYER','OSM_ARTIFACT_PREVIEW')),
  status text NOT NULL CHECK (status IN ('SUCCEEDED','REJECTED','FAILED')),
  input_hash text NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  output_hash text CHECK (output_hash IS NULL OR output_hash ~ '^sha256:[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_id, data_scope_key, dataset_scope_key)
    REFERENCES network_graph(graph_id, data_scope_key, dataset_scope_key),
  FOREIGN KEY (dataset_version_id) REFERENCES spatial_dataset_version(dataset_version_id),
  CHECK (started_at >= requested_at AND finished_at >= started_at),
  CHECK ((status = 'SUCCEEDED' AND output_hash IS NOT NULL) OR status <> 'SUCCEEDED')
);

CREATE TABLE network_validation_issue (
  validation_issue_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_run_id uuid NOT NULL REFERENCES network_build_run(build_run_id),
  graph_version_id uuid,
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  severity text NOT NULL CHECK (severity IN ('INFO','WARNING','ERROR','FATAL')),
  issue_code text NOT NULL CHECK (issue_code ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  activation_blocking boolean NOT NULL,
  entity_kind text CHECK (entity_kind IS NULL OR entity_kind IN ('GRAPH','NODE','EDGE','ARC','TURN_RULE','PROFILE','CONDITION')),
  entity_key_hash text CHECK (entity_key_hash IS NULL OR entity_key_hash ~ '^sha256:[0-9a-f]{64}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_version_id, data_scope_key)
    REFERENCES network_graph_version(graph_version_id, data_scope_key),
  CHECK (activation_blocking = (severity IN ('ERROR','FATAL')))
);

CREATE TABLE network_graph_activation_event (
  activation_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id uuid NOT NULL,
  graph_version_id uuid NOT NULL,
  previous_graph_version_id uuid,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('ACTIVATE','RETIRE')),
  activation_policy_version text NOT NULL CHECK (length(activation_policy_version) BETWEEN 1 AND 128),
  actor_reference_key text NOT NULL CHECK (length(actor_reference_key) BETWEEN 1 AND 256),
  event_hash text NOT NULL CHECK (event_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_id, data_scope_key, dataset_scope_key)
    REFERENCES network_graph(graph_id, data_scope_key, dataset_scope_key),
  FOREIGN KEY (graph_version_id, data_scope_key, dataset_scope_key)
    REFERENCES network_graph_version(graph_version_id, data_scope_key, dataset_scope_key),
  FOREIGN KEY (previous_graph_version_id, data_scope_key, dataset_scope_key)
    REFERENCES network_graph_version(graph_version_id, data_scope_key, dataset_scope_key),
  UNIQUE (graph_id, event_hash)
);

CREATE UNIQUE INDEX network_graph_single_activation_idx
  ON network_graph_activation_event(graph_version_id)
  WHERE event_type = 'ACTIVATE';
CREATE INDEX network_graph_activation_head_idx
  ON network_graph_activation_event(data_scope_key, dataset_scope_key, graph_id, created_at DESC, activation_event_id DESC);
CREATE INDEX network_validation_issue_blocking_idx
  ON network_validation_issue(graph_version_id, activation_blocking)
  WHERE activation_blocking;

CREATE FUNCTION validate_network_activation_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  version_status text;
  expected_nodes bigint;
  expected_edges bigint;
  expected_arcs bigint;
  expected_turns bigint;
BEGIN
  SELECT status, node_count, edge_count, arc_count, turn_rule_count
  INTO STRICT version_status, expected_nodes, expected_edges, expected_arcs, expected_turns
  FROM public.network_graph_version
  WHERE graph_version_id = NEW.graph_version_id
    AND graph_id = NEW.graph_id
    AND data_scope_key = NEW.data_scope_key
    AND dataset_scope_key = NEW.dataset_scope_key;

  IF NEW.event_type = 'ACTIVATE' THEN
    IF version_status NOT IN ('VALIDATED','ACTIVE') THEN
      RAISE EXCEPTION 'only validated graph versions can be activated' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.network_validation_issue
      WHERE graph_version_id = NEW.graph_version_id AND activation_blocking
    ) THEN
      RAISE EXCEPTION 'graph version has activation-blocking validation issues' USING ERRCODE = '23514';
    END IF;
    IF expected_nodes <> (SELECT count(*) FROM public.network_node WHERE graph_version_id = NEW.graph_version_id) OR
       expected_edges <> (SELECT count(*) FROM public.network_edge WHERE graph_version_id = NEW.graph_version_id) OR
       expected_arcs <> (SELECT count(*) FROM public.network_arc WHERE graph_version_id = NEW.graph_version_id) OR
       expected_turns <> (
         (SELECT count(*) FROM public.network_turn_rule WHERE graph_version_id = NEW.graph_version_id) +
         (SELECT count(*) FROM public.network_turn_sequence_rule WHERE graph_version_id = NEW.graph_version_id)
       ) THEN
      RAISE EXCEPTION 'graph version counts do not match immutable content' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.network_edge edge
      WHERE edge.graph_version_id = NEW.graph_version_id
        AND NOT EXISTS (
          SELECT 1 FROM public.network_feature_binding binding
          WHERE binding.graph_version_id = edge.graph_version_id AND binding.edge_id = edge.edge_id
        )
    ) THEN
      RAISE EXCEPTION 'graph version contains an edge without an authorized source binding' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER network_activation_event_guard BEFORE INSERT ON network_graph_activation_event
  FOR EACH ROW EXECUTE FUNCTION validate_network_activation_event();

CREATE TRIGGER network_build_run_immutable BEFORE UPDATE OR DELETE ON network_build_run
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_validation_issue_immutable BEFORE UPDATE OR DELETE ON network_validation_issue
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_graph_activation_event_immutable BEFORE UPDATE OR DELETE ON network_graph_activation_event
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'network_builder') THEN
    CREATE ROLE network_builder NOLOGIN INHERIT;
  END IF;
END
$roles$;

REVOKE ALL ON network_graph, network_graph_version, network_node, network_edge, network_arc,
  network_feature_binding, network_turn_rule, network_turn_sequence_rule,
  network_travel_profile, network_travel_profile_version, network_cost_profile,
  network_cost_profile_version, network_arc_cost, network_condition_snapshot,
  network_arc_condition, network_build_run, network_validation_issue,
  network_graph_activation_event FROM PUBLIC;
GRANT SELECT, INSERT ON network_graph, network_graph_version, network_node, network_edge, network_arc,
  network_feature_binding, network_turn_rule, network_turn_sequence_rule,
  network_travel_profile, network_travel_profile_version, network_cost_profile,
  network_cost_profile_version, network_arc_cost, network_condition_snapshot,
  network_arc_condition, network_build_run, network_validation_issue,
  network_graph_activation_event TO network_builder;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO network_builder;
GRANT gowm_catalog_reader TO network_builder;

REVOKE ALL ON FUNCTION validate_network_activation_event() FROM PUBLIC;

COMMIT;
