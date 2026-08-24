BEGIN;

CREATE TABLE network_graph (
  graph_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  dataset_scope_key text NOT NULL CHECK (length(dataset_scope_key) BETWEEN 1 AND 128),
  dataset_id uuid NOT NULL,
  graph_key text NOT NULL CHECK (length(graph_key) BETWEEN 1 AND 256),
  description text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (dataset_id, data_scope_key, dataset_scope_key)
    REFERENCES spatial_dataset(dataset_id, data_scope_key, dataset_scope_key),
  UNIQUE (data_scope_key, dataset_scope_key, graph_key),
  UNIQUE (graph_id, dataset_id),
  UNIQUE (graph_id, data_scope_key),
  UNIQUE (graph_id, data_scope_key, dataset_scope_key)
);

CREATE TABLE network_graph_version (
  graph_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  graph_version text NOT NULL CHECK (length(graph_version) BETWEEN 1 AND 128),
  build_policy_version text NOT NULL CHECK (length(build_policy_version) BETWEEN 1 AND 128),
  source_content_hash text NOT NULL CHECK (source_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  topology_hash text NOT NULL CHECK (topology_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  node_count bigint NOT NULL CHECK (node_count >= 0),
  edge_count bigint NOT NULL CHECK (edge_count >= 0),
  arc_count bigint NOT NULL CHECK (arc_count >= 0),
  turn_rule_count bigint NOT NULL CHECK (turn_rule_count >= 0),
  status text NOT NULL CHECK (status IN ('BUILDING','VALIDATED','ACTIVE','RETIRED','FAILED')),
  build_receipt_id text CHECK (build_receipt_id IS NULL OR build_receipt_id ~ '^[A-Za-z][A-Za-z0-9._:-]{0,255}$'),
  build_receipt jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(build_receipt) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_id, dataset_id) REFERENCES network_graph(graph_id, dataset_id),
  FOREIGN KEY (graph_id, data_scope_key, dataset_scope_key)
    REFERENCES network_graph(graph_id, data_scope_key, dataset_scope_key),
  FOREIGN KEY (dataset_version_id, dataset_id)
    REFERENCES spatial_dataset_version(dataset_version_id, dataset_id),
  UNIQUE (graph_id, graph_version),
  UNIQUE (graph_id, source_content_hash, build_policy_version),
  UNIQUE (graph_version_id, data_scope_key),
  UNIQUE (graph_version_id, data_scope_key, dataset_scope_key)
);

CREATE INDEX network_graph_scope_idx
  ON network_graph(data_scope_key, dataset_scope_key, graph_key);
CREATE INDEX network_graph_version_scope_status_idx
  ON network_graph_version(data_scope_key, dataset_scope_key, status, created_at DESC);
CREATE INDEX network_graph_version_dataset_idx
  ON network_graph_version(dataset_version_id, build_policy_version);

CREATE FUNCTION validate_network_graph_version_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  source_kind text;
  source_scope text;
  source_dataset_scope text;
BEGIN
  SELECT version.dataset_kind, dataset.data_scope_key, dataset.dataset_scope_key
  INTO source_kind, source_scope, source_dataset_scope
  FROM public.spatial_dataset_version version
  JOIN public.spatial_dataset dataset USING (dataset_id)
  WHERE version.dataset_version_id = NEW.dataset_version_id
    AND version.dataset_id = NEW.dataset_id;

  IF NOT FOUND OR source_kind <> 'NETWORK' OR source_scope <> NEW.data_scope_key OR
     source_dataset_scope <> NEW.dataset_scope_key THEN
    RAISE EXCEPTION 'network graph source is unavailable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION reject_network_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'network foundation identities and versions are append-only'
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER network_graph_version_source_guard
  BEFORE INSERT ON network_graph_version
  FOR EACH ROW EXECUTE FUNCTION validate_network_graph_version_source();
CREATE TRIGGER network_graph_immutable
  BEFORE UPDATE OR DELETE ON network_graph
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_graph_version_immutable
  BEFORE UPDATE OR DELETE ON network_graph_version
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();

REVOKE ALL ON FUNCTION validate_network_graph_version_source() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_network_immutable_mutation() FROM PUBLIC;

COMMIT;
