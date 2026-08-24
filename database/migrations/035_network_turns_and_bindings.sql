BEGIN;

CREATE TABLE network_feature_binding (
  binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_version_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  edge_id bigint NOT NULL,
  arc_id bigint,
  source_feature_id uuid NOT NULL,
  source_feature_version_id uuid NOT NULL REFERENCES spatial_feature_version(feature_version_id),
  source_feature_reference_key text NOT NULL CHECK (source_feature_reference_key ~ '^wrf_[0-9a-f]{32}$'),
  binding_kind text NOT NULL CHECK (binding_kind IN ('DERIVED_FROM','SPLIT_FROM','IDENTICAL')),
  split_start_ppm integer NOT NULL DEFAULT 0 CHECK (split_start_ppm BETWEEN 0 AND 1000000),
  split_end_ppm integer NOT NULL DEFAULT 1000000 CHECK (split_end_ppm BETWEEN 0 AND 1000000),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_version_id, edge_id, data_scope_key)
    REFERENCES network_edge(graph_version_id, edge_id, data_scope_key),
  FOREIGN KEY (graph_version_id, arc_id, data_scope_key)
    REFERENCES network_arc(graph_version_id, arc_id, data_scope_key),
  FOREIGN KEY (source_feature_id, data_scope_key)
    REFERENCES spatial_feature_identity(feature_id, data_scope_key),
  UNIQUE (graph_version_id, edge_id, arc_id, source_feature_version_id, binding_kind),
  CHECK (split_end_ppm > split_start_ppm)
);

CREATE TABLE network_turn_rule (
  turn_rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_version_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  rule_key text NOT NULL CHECK (rule_key ~ '^tr_[0-9a-f]{64}$'),
  from_arc_id bigint NOT NULL,
  via_node_id bigint NOT NULL,
  to_arc_id bigint NOT NULL,
  rule_type text NOT NULL CHECK (rule_type IN ('FORBIDDEN','ALLOWED_ONLY','PENALTY')),
  penalty_units bigint NOT NULL DEFAULT 0 CHECK (penalty_units >= 0),
  profile_filter jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile_filter) = 'object'),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_version_id, from_arc_id, data_scope_key)
    REFERENCES network_arc(graph_version_id, arc_id, data_scope_key),
  FOREIGN KEY (graph_version_id, via_node_id, data_scope_key)
    REFERENCES network_node(graph_version_id, node_id, data_scope_key),
  FOREIGN KEY (graph_version_id, to_arc_id, data_scope_key)
    REFERENCES network_arc(graph_version_id, arc_id, data_scope_key),
  UNIQUE (graph_version_id, rule_key),
  CHECK (from_arc_id <> to_arc_id),
  CHECK ((rule_type = 'PENALTY' AND penalty_units > 0) OR (rule_type <> 'PENALTY' AND penalty_units = 0))
);

CREATE TABLE network_turn_sequence_rule (
  turn_sequence_rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_version_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  rule_key text NOT NULL CHECK (rule_key ~ '^ts_[0-9a-f]{64}$'),
  arc_sequence bigint[] NOT NULL,
  rule_type text NOT NULL CHECK (rule_type IN ('FORBIDDEN','PENALTY')),
  penalty_units bigint NOT NULL DEFAULT 0 CHECK (penalty_units >= 0),
  profile_filter jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile_filter) = 'object'),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  automaton_hash text NOT NULL CHECK (automaton_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_version_id, data_scope_key)
    REFERENCES network_graph_version(graph_version_id, data_scope_key),
  UNIQUE (graph_version_id, rule_key),
  CHECK (array_ndims(arc_sequence) = 1 AND cardinality(arc_sequence) >= 2),
  CHECK ((rule_type = 'PENALTY' AND penalty_units > 0) OR (rule_type = 'FORBIDDEN' AND penalty_units = 0))
);

CREATE INDEX network_feature_binding_edge_idx
  ON network_feature_binding(graph_version_id, edge_id);
CREATE INDEX network_feature_binding_source_idx
  ON network_feature_binding(data_scope_key, source_feature_id, source_feature_version_id);
CREATE INDEX network_turn_rule_lookup_idx
  ON network_turn_rule(graph_version_id, from_arc_id, via_node_id, to_arc_id);
CREATE INDEX network_turn_sequence_rule_arcs_idx
  ON network_turn_sequence_rule USING gin(arc_sequence);

CREATE FUNCTION validate_network_feature_binding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  edge_reference_key text;
  feature_reference_key text;
  feature_id_for_version uuid;
  arc_edge_id bigint;
BEGIN
  SELECT source_feature_reference_key INTO STRICT edge_reference_key
  FROM public.network_edge
  WHERE graph_version_id = NEW.graph_version_id AND edge_id = NEW.edge_id
    AND data_scope_key = NEW.data_scope_key;
  SELECT reference_key INTO STRICT feature_reference_key
  FROM public.spatial_feature_identity
  WHERE feature_id = NEW.source_feature_id AND data_scope_key = NEW.data_scope_key;
  SELECT feature_id INTO STRICT feature_id_for_version
  FROM public.spatial_feature_version
  WHERE feature_version_id = NEW.source_feature_version_id;

  IF edge_reference_key <> NEW.source_feature_reference_key OR
     feature_reference_key <> NEW.source_feature_reference_key OR
     feature_id_for_version <> NEW.source_feature_id THEN
    RAISE EXCEPTION 'network source feature binding is inconsistent' USING ERRCODE = '23514';
  END IF;
  IF NEW.arc_id IS NOT NULL THEN
    SELECT edge_id INTO STRICT arc_edge_id
    FROM public.network_arc
    WHERE graph_version_id = NEW.graph_version_id AND arc_id = NEW.arc_id
      AND data_scope_key = NEW.data_scope_key;
    IF arc_edge_id <> NEW.edge_id THEN
      RAISE EXCEPTION 'network arc binding does not belong to edge' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION validate_network_turn_rule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  from_target bigint;
  to_source bigint;
BEGIN
  SELECT target_node_id INTO STRICT from_target
  FROM public.network_arc
  WHERE graph_version_id = NEW.graph_version_id AND arc_id = NEW.from_arc_id
    AND data_scope_key = NEW.data_scope_key;
  SELECT source_node_id INTO STRICT to_source
  FROM public.network_arc
  WHERE graph_version_id = NEW.graph_version_id AND arc_id = NEW.to_arc_id
    AND data_scope_key = NEW.data_scope_key;
  IF from_target <> NEW.via_node_id OR to_source <> NEW.via_node_id THEN
    RAISE EXCEPTION 'turn rule arcs are not connected at via node' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION validate_network_turn_sequence_rule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.arc_sequence) WITH ORDINALITY sequence_arc(arc_id, ordinal)
    LEFT JOIN public.network_arc arc
      ON arc.graph_version_id = NEW.graph_version_id
     AND arc.arc_id = sequence_arc.arc_id
     AND arc.data_scope_key = NEW.data_scope_key
    WHERE arc.arc_id IS NULL
  ) THEN
    RAISE EXCEPTION 'turn sequence contains an unavailable arc' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.arc_sequence) WITH ORDINALITY current_item(arc_id, ordinal)
    JOIN unnest(NEW.arc_sequence) WITH ORDINALITY next_item(arc_id, ordinal)
      ON next_item.ordinal = current_item.ordinal + 1
    JOIN public.network_arc current_arc
      ON current_arc.graph_version_id = NEW.graph_version_id
     AND current_arc.arc_id = current_item.arc_id
     AND current_arc.data_scope_key = NEW.data_scope_key
    JOIN public.network_arc next_arc
      ON next_arc.graph_version_id = NEW.graph_version_id
     AND next_arc.arc_id = next_item.arc_id
     AND next_arc.data_scope_key = NEW.data_scope_key
    WHERE current_arc.target_node_id <> next_arc.source_node_id
  ) THEN
    RAISE EXCEPTION 'turn sequence arcs are not contiguous' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER network_feature_binding_guard BEFORE INSERT ON network_feature_binding
  FOR EACH ROW EXECUTE FUNCTION validate_network_feature_binding();
CREATE TRIGGER network_turn_rule_guard BEFORE INSERT ON network_turn_rule
  FOR EACH ROW EXECUTE FUNCTION validate_network_turn_rule();
CREATE TRIGGER network_turn_sequence_rule_guard BEFORE INSERT ON network_turn_sequence_rule
  FOR EACH ROW EXECUTE FUNCTION validate_network_turn_sequence_rule();

CREATE TRIGGER network_feature_binding_immutable BEFORE UPDATE OR DELETE ON network_feature_binding
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_turn_rule_immutable BEFORE UPDATE OR DELETE ON network_turn_rule
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_turn_sequence_rule_immutable BEFORE UPDATE OR DELETE ON network_turn_sequence_rule
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();

REVOKE ALL ON FUNCTION validate_network_feature_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_network_turn_rule() FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_network_turn_sequence_rule() FROM PUBLIC;

COMMIT;
