BEGIN;

CREATE TABLE network_travel_profile (
  travel_profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  profile_key text NOT NULL CHECK (length(profile_key) BETWEEN 1 AND 128),
  description text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (data_scope_key, profile_key),
  UNIQUE (travel_profile_id, data_scope_key)
);

CREATE TABLE network_travel_profile_version (
  travel_profile_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  travel_profile_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
  mode text NOT NULL CHECK (mode IN ('WALK','BICYCLE','CAR','TRUCK','TRANSIT','SERVICE')),
  required_access_mask bigint NOT NULL DEFAULT 0 CHECK (required_access_mask >= 0),
  maximum_speed_mm_per_s bigint CHECK (maximum_speed_mm_per_s IS NULL OR maximum_speed_mm_per_s > 0),
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(constraints) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (travel_profile_id, data_scope_key)
    REFERENCES network_travel_profile(travel_profile_id, data_scope_key),
  UNIQUE (travel_profile_id, version),
  UNIQUE (travel_profile_version_id, data_scope_key)
);

CREATE TABLE network_cost_profile (
  cost_profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  travel_profile_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  profile_key text NOT NULL CHECK (length(profile_key) BETWEEN 1 AND 128),
  description text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (travel_profile_id, data_scope_key)
    REFERENCES network_travel_profile(travel_profile_id, data_scope_key),
  UNIQUE (data_scope_key, profile_key),
  UNIQUE (cost_profile_id, travel_profile_id, data_scope_key),
  UNIQUE (cost_profile_id, data_scope_key)
);

CREATE TABLE network_cost_profile_version (
  cost_profile_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_profile_id uuid NOT NULL,
  travel_profile_id uuid NOT NULL,
  travel_profile_version_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
  distance_weight_ppm integer NOT NULL CHECK (distance_weight_ppm BETWEEN 0 AND 1000000),
  duration_weight_ppm integer NOT NULL CHECK (duration_weight_ppm BETWEEN 0 AND 1000000),
  risk_weight_ppm integer NOT NULL CHECK (risk_weight_ppm BETWEEN 0 AND 1000000),
  energy_weight_ppm integer NOT NULL CHECK (energy_weight_ppm BETWEEN 0 AND 1000000),
  formula jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(formula) = 'object'),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (cost_profile_id, travel_profile_id, data_scope_key)
    REFERENCES network_cost_profile(cost_profile_id, travel_profile_id, data_scope_key),
  FOREIGN KEY (travel_profile_version_id, data_scope_key)
    REFERENCES network_travel_profile_version(travel_profile_version_id, data_scope_key),
  UNIQUE (cost_profile_id, version),
  UNIQUE (cost_profile_version_id, travel_profile_version_id, data_scope_key),
  UNIQUE (cost_profile_version_id, data_scope_key),
  CHECK (distance_weight_ppm + duration_weight_ppm + risk_weight_ppm + energy_weight_ppm = 1000000)
);

CREATE TABLE network_arc_cost (
  arc_cost_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  graph_version_id uuid NOT NULL,
  arc_id bigint NOT NULL,
  travel_profile_version_id uuid NOT NULL,
  cost_profile_version_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  distance_mm bigint NOT NULL CHECK (distance_mm >= 0),
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
  risk_microunits bigint NOT NULL DEFAULT 0 CHECK (risk_microunits >= 0),
  energy_millijoules bigint NOT NULL DEFAULT 0 CHECK (energy_millijoules >= 0),
  combined_cost_units bigint NOT NULL CHECK (combined_cost_units >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (graph_version_id, arc_id, data_scope_key)
    REFERENCES network_arc(graph_version_id, arc_id, data_scope_key),
  FOREIGN KEY (travel_profile_version_id, data_scope_key)
    REFERENCES network_travel_profile_version(travel_profile_version_id, data_scope_key),
  FOREIGN KEY (cost_profile_version_id, travel_profile_version_id, data_scope_key)
    REFERENCES network_cost_profile_version(cost_profile_version_id, travel_profile_version_id, data_scope_key),
  UNIQUE (graph_version_id, arc_id, travel_profile_version_id, cost_profile_version_id)
);

CREATE INDEX network_travel_profile_version_lookup_idx
  ON network_travel_profile_version(data_scope_key, travel_profile_id, version);
CREATE INDEX network_cost_profile_version_lookup_idx
  ON network_cost_profile_version(data_scope_key, cost_profile_id, version);
CREATE INDEX network_arc_cost_routing_idx
  ON network_arc_cost(graph_version_id, travel_profile_version_id, cost_profile_version_id, arc_id);

CREATE FUNCTION validate_network_cost_profile_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  version_profile_id uuid;
BEGIN
  SELECT travel_profile_id INTO STRICT version_profile_id
  FROM public.network_travel_profile_version
  WHERE travel_profile_version_id = NEW.travel_profile_version_id
    AND data_scope_key = NEW.data_scope_key;
  IF version_profile_id <> NEW.travel_profile_id THEN
    RAISE EXCEPTION 'cost profile version references an unrelated travel profile version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER network_cost_profile_version_guard BEFORE INSERT ON network_cost_profile_version
  FOR EACH ROW EXECUTE FUNCTION validate_network_cost_profile_version();

CREATE TRIGGER network_travel_profile_immutable BEFORE UPDATE OR DELETE ON network_travel_profile
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_travel_profile_version_immutable BEFORE UPDATE OR DELETE ON network_travel_profile_version
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_cost_profile_immutable BEFORE UPDATE OR DELETE ON network_cost_profile
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_cost_profile_version_immutable BEFORE UPDATE OR DELETE ON network_cost_profile_version
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();
CREATE TRIGGER network_arc_cost_immutable BEFORE UPDATE OR DELETE ON network_arc_cost
  FOR EACH ROW EXECUTE FUNCTION reject_network_immutable_mutation();

REVOKE ALL ON FUNCTION validate_network_cost_profile_version() FROM PUBLIC;

COMMIT;
