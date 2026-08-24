BEGIN;

CREATE TABLE network_condition_snapshot (
  condition_snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_version_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  condition_snapshot_key text NOT NULL CHECK (condition_snapshot_key ~ '^cs_[0-9a-f]{64}$'),
  source_snapshot_version text NOT NULL CHECK (length(source_snapshot_version) BETWEEN 1 AND 128),
  observed_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  completeness text NOT NULL CHECK (completeness IN ('COMPLETE','PARTIAL')),
  source_content_hash text NOT NULL CHECK (source_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_version_id, data_scope_key)
    REFERENCES network_graph_version(graph_version_id, data_scope_key),
  UNIQUE (graph_version_id, condition_snapshot_key),
  UNIQUE (condition_snapshot_id, graph_version_id, data_scope_key),
  CHECK (valid_until > observed_at)
);

CREATE TABLE network_arc_condition (
  arc_condition_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condition_snapshot_id uuid NOT NULL,
  graph_version_id uuid NOT NULL,
  arc_id bigint NOT NULL,
  data_scope_key text NOT NULL,
  traversal_allowed boolean NOT NULL,
  speed_override_mm_per_s bigint CHECK (speed_override_mm_per_s IS NULL OR speed_override_mm_per_s > 0),
  penalty_units bigint NOT NULL DEFAULT 0 CHECK (penalty_units >= 0),
  reason_codes text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (condition_snapshot_id, graph_version_id, data_scope_key)
    REFERENCES network_condition_snapshot(condition_snapshot_id, graph_version_id, data_scope_key),
  FOREIGN KEY (graph_version_id, arc_id, data_scope_key)
    REFERENCES network_arc(graph_version_id, arc_id, data_scope_key),
  UNIQUE (condition_snapshot_id, arc_id),
  CHECK (traversal_allowed OR speed_override_mm_per_s IS NULL)
);

CREATE INDEX network_condition_snapshot_scope_time_idx
  ON network_condition_snapshot(data_scope_key, graph_version_id, observed_at DESC);
CREATE INDEX network_arc_condition_lookup_idx
  ON network_arc_condition(condition_snapshot_id, graph_version_id, arc_id);

CREATE TRIGGER network_condition_snapshot_immutable BEFORE UPDATE OR DELETE ON network_condition_snapshot
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_arc_condition_immutable BEFORE UPDATE OR DELETE ON network_arc_condition
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();

COMMIT;
