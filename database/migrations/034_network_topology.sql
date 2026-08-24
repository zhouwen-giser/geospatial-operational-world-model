BEGIN;

CREATE TABLE network_node (
  node_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  graph_version_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  node_key text NOT NULL CHECK (node_key ~ '^nd_[0-9a-f]{64}$'),
  geometry geometry(PointZ, 4326) NOT NULL,
  elevation_mm bigint,
  topology_identity jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(topology_identity) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_version_id, data_scope_key)
    REFERENCES network_graph_version(graph_version_id, data_scope_key),
  UNIQUE (graph_version_id, node_key),
  UNIQUE (graph_version_id, node_id, data_scope_key),
  CHECK (NOT ST_IsEmpty(geometry) AND ST_IsValid(geometry) AND ST_NDims(geometry) = 3)
);

CREATE TABLE network_edge (
  edge_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  graph_version_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  edge_key text NOT NULL CHECK (edge_key ~ '^ed_[0-9a-f]{64}$'),
  source_node_id bigint NOT NULL,
  target_node_id bigint NOT NULL,
  source_feature_reference_key text NOT NULL CHECK (source_feature_reference_key ~ '^wrf_[0-9a-f]{32}$'),
  geometry geometry(LineStringZ, 4326) NOT NULL,
  length_mm bigint NOT NULL CHECK (length_mm > 0),
  road_class text NOT NULL CHECK (length(road_class) BETWEEN 1 AND 64),
  surface text CHECK (surface IS NULL OR length(surface) BETWEEN 1 AND 64),
  is_bridge boolean NOT NULL DEFAULT false,
  is_tunnel boolean NOT NULL DEFAULT false,
  layer_level integer NOT NULL DEFAULT 0 CHECK (layer_level BETWEEN -100 AND 100),
  width_mm bigint CHECK (width_mm IS NULL OR width_mm > 0),
  height_limit_mm bigint CHECK (height_limit_mm IS NULL OR height_limit_mm > 0),
  weight_limit_grams bigint CHECK (weight_limit_grams IS NULL OR weight_limit_grams > 0),
  lane_count integer CHECK (lane_count IS NULL OR lane_count > 0),
  oneway text NOT NULL CHECK (oneway IN ('BIDIRECTIONAL','FORWARD_ONLY','REVERSE_ONLY')),
  access_attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(access_attributes) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_version_id, data_scope_key)
    REFERENCES network_graph_version(graph_version_id, data_scope_key),
  FOREIGN KEY (graph_version_id, source_node_id, data_scope_key)
    REFERENCES network_node(graph_version_id, node_id, data_scope_key),
  FOREIGN KEY (graph_version_id, target_node_id, data_scope_key)
    REFERENCES network_node(graph_version_id, node_id, data_scope_key),
  UNIQUE (graph_version_id, edge_key),
  UNIQUE (graph_version_id, edge_id, data_scope_key),
  CHECK (source_node_id <> target_node_id),
  CHECK (NOT ST_IsEmpty(geometry) AND ST_IsValid(geometry) AND ST_NDims(geometry) = 3),
  CHECK (NOT (is_bridge AND is_tunnel))
);

CREATE TABLE network_arc (
  arc_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  graph_version_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  arc_key text NOT NULL CHECK (arc_key ~ '^ar_[0-9a-f]{64}$'),
  edge_id bigint NOT NULL,
  source_node_id bigint NOT NULL,
  target_node_id bigint NOT NULL,
  direction text NOT NULL CHECK (direction IN ('FORWARD','REVERSE')),
  oriented_geometry geometry(LineStringZ, 4326) NOT NULL,
  length_mm bigint NOT NULL CHECK (length_mm > 0),
  default_speed_mm_per_s bigint NOT NULL CHECK (default_speed_mm_per_s > 0),
  transit_eligible boolean NOT NULL DEFAULT false,
  service_eligible boolean NOT NULL DEFAULT false,
  access_mask bigint NOT NULL DEFAULT 0 CHECK (access_mask >= 0),
  profile_constraints jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile_constraints) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_version_id, edge_id, data_scope_key)
    REFERENCES network_edge(graph_version_id, edge_id, data_scope_key),
  FOREIGN KEY (graph_version_id, source_node_id, data_scope_key)
    REFERENCES network_node(graph_version_id, node_id, data_scope_key),
  FOREIGN KEY (graph_version_id, target_node_id, data_scope_key)
    REFERENCES network_node(graph_version_id, node_id, data_scope_key),
  UNIQUE (graph_version_id, arc_key),
  UNIQUE (graph_version_id, edge_id, direction),
  UNIQUE (graph_version_id, arc_id, data_scope_key),
  CHECK (source_node_id <> target_node_id),
  CHECK (NOT ST_IsEmpty(oriented_geometry) AND ST_IsValid(oriented_geometry) AND ST_NDims(oriented_geometry) = 3)
);

CREATE INDEX network_node_geometry_idx ON network_node USING gist(geometry);
CREATE INDEX network_edge_geometry_idx ON network_edge USING gist(geometry);
CREATE INDEX network_arc_geometry_idx ON network_arc USING gist(oriented_geometry);
CREATE INDEX network_edge_graph_nodes_idx ON network_edge(graph_version_id, source_node_id, target_node_id);
CREATE INDEX network_arc_graph_nodes_idx ON network_arc(graph_version_id, source_node_id, target_node_id);

CREATE FUNCTION validate_network_topology_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  source_geometry geometry;
  target_geometry geometry;
  parent_edge public.network_edge%ROWTYPE;
BEGIN
  SELECT geometry INTO STRICT source_geometry
  FROM public.network_node
  WHERE graph_version_id = NEW.graph_version_id
    AND node_id = NEW.source_node_id
    AND data_scope_key = NEW.data_scope_key;
  SELECT geometry INTO STRICT target_geometry
  FROM public.network_node
  WHERE graph_version_id = NEW.graph_version_id
    AND node_id = NEW.target_node_id
    AND data_scope_key = NEW.data_scope_key;

  IF TG_TABLE_NAME = 'network_edge' THEN
    IF NOT ST_Equals(ST_Force2D(ST_StartPoint(NEW.geometry)), ST_Force2D(source_geometry)) OR
       NOT ST_Equals(ST_Force2D(ST_EndPoint(NEW.geometry)), ST_Force2D(target_geometry)) OR
       ST_Z(ST_StartPoint(NEW.geometry)) IS DISTINCT FROM ST_Z(source_geometry) OR
       ST_Z(ST_EndPoint(NEW.geometry)) IS DISTINCT FROM ST_Z(target_geometry) THEN
      RAISE EXCEPTION 'edge geometry endpoints do not match topology nodes' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO STRICT parent_edge
  FROM public.network_edge
  WHERE graph_version_id = NEW.graph_version_id
    AND edge_id = NEW.edge_id
    AND data_scope_key = NEW.data_scope_key;

  IF NEW.length_mm <> parent_edge.length_mm OR
     (NEW.direction = 'FORWARD' AND (
       parent_edge.oneway = 'REVERSE_ONLY' OR
       NEW.source_node_id <> parent_edge.source_node_id OR NEW.target_node_id <> parent_edge.target_node_id
     )) OR
     (NEW.direction = 'REVERSE' AND (
       parent_edge.oneway = 'FORWARD_ONLY' OR
       NEW.source_node_id <> parent_edge.target_node_id OR NEW.target_node_id <> parent_edge.source_node_id
     )) THEN
    RAISE EXCEPTION 'arc direction is inconsistent with its edge' USING ERRCODE = '23514';
  END IF;

  IF NOT ST_Equals(ST_Force2D(ST_StartPoint(NEW.oriented_geometry)), ST_Force2D(source_geometry)) OR
     NOT ST_Equals(ST_Force2D(ST_EndPoint(NEW.oriented_geometry)), ST_Force2D(target_geometry)) OR
     ST_Z(ST_StartPoint(NEW.oriented_geometry)) IS DISTINCT FROM ST_Z(source_geometry) OR
     ST_Z(ST_EndPoint(NEW.oriented_geometry)) IS DISTINCT FROM ST_Z(target_geometry) THEN
    RAISE EXCEPTION 'arc geometry orientation does not match topology nodes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER network_edge_topology_guard
  BEFORE INSERT ON network_edge
  FOR EACH ROW EXECUTE FUNCTION validate_network_topology_row();
CREATE TRIGGER network_arc_topology_guard
  BEFORE INSERT ON network_arc
  FOR EACH ROW EXECUTE FUNCTION validate_network_topology_row();

CREATE TRIGGER network_node_immutable BEFORE UPDATE OR DELETE ON network_node
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_edge_immutable BEFORE UPDATE OR DELETE ON network_edge
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_arc_immutable BEFORE UPDATE OR DELETE ON network_arc
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();

REVOKE ALL ON FUNCTION validate_network_topology_row() FROM PUBLIC;

COMMIT;
