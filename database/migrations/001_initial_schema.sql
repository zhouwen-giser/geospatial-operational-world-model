BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migration (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE SEQUENCE IF NOT EXISTS world_version_seq AS bigint START WITH 1;

CREATE TABLE IF NOT EXISTS world_object (
  id text PRIMARY KEY,
  object_type text NOT NULL,
  subtype text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT world_object_id_nonempty CHECK (length(id) > 0),
  CONSTRAINT world_object_type_nonempty CHECK (length(object_type) > 0)
);

CREATE INDEX IF NOT EXISTS world_object_type_idx ON world_object (object_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS world_object_subtype_idx ON world_object (subtype) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS world_object_properties_gin_idx ON world_object USING gin (properties);

CREATE TABLE IF NOT EXISTS world_object_state (
  object_id text PRIMARY KEY REFERENCES world_object(id) ON DELETE CASCADE,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence real NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  observed_at timestamptz,
  received_at timestamptz,
  source text,
  source_observation_id text,
  version bigint NOT NULL DEFAULT nextval('world_version_seq'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS world_object_state_gin_idx ON world_object_state USING gin (state);
CREATE INDEX IF NOT EXISTS world_object_state_freshness_idx ON world_object_state (observed_at DESC);

CREATE TABLE IF NOT EXISTS world_object_geometry (
  object_id text PRIMARY KEY REFERENCES world_object(id) ON DELETE CASCADE,
  geometry geometry(Geometry, 4326) NOT NULL,
  h3_r7 text,
  h3_r8 text,
  h3_r9 text,
  h3_r10 text,
  observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT world_object_geometry_valid CHECK (ST_IsValid(geometry))
);

CREATE INDEX IF NOT EXISTS world_object_geometry_gist_idx ON world_object_geometry USING gist (geometry);
CREATE INDEX IF NOT EXISTS world_object_geometry_h3_r7_idx ON world_object_geometry (h3_r7);
CREATE INDEX IF NOT EXISTS world_object_geometry_h3_r8_idx ON world_object_geometry (h3_r8);
CREATE INDEX IF NOT EXISTS world_object_geometry_h3_r9_idx ON world_object_geometry (h3_r9);
CREATE INDEX IF NOT EXISTS world_object_geometry_h3_r10_idx ON world_object_geometry (h3_r10);

CREATE TABLE IF NOT EXISTS world_relation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_type text NOT NULL,
  from_object_id text NOT NULL REFERENCES world_object(id) ON DELETE CASCADE,
  to_object_id text NOT NULL REFERENCES world_object(id) ON DELETE CASCADE,
  persisted boolean NOT NULL DEFAULT true,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (relation_type, from_object_id, to_object_id, valid_from)
);

CREATE INDEX IF NOT EXISTS world_relation_from_idx ON world_relation (from_object_id, relation_type) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS world_relation_to_idx ON world_relation (to_object_id, relation_type) WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS world_observation (
  observation_id text PRIMARY KEY,
  observer_type text NOT NULL,
  observer_id text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  observation_type text NOT NULL,
  geometry geometry(Geometry, 4326),
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  processing_time timestamptz NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL,
  correlation_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version text NOT NULL DEFAULT '1.0',
  status text NOT NULL DEFAULT 'accepted',
  rejection_reason text,
  projected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS world_observation_subject_time_idx ON world_observation (subject_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS world_observation_observer_time_idx ON world_observation (observer_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS world_observation_type_time_idx ON world_observation (observation_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS world_observation_time_brin_idx ON world_observation USING brin (observed_at);
CREATE INDEX IF NOT EXISTS world_observation_geometry_gist_idx ON world_observation USING gist (geometry);

CREATE TABLE IF NOT EXISTS projection_queue (
  observation_id text PRIMARY KEY REFERENCES world_observation(observation_id) ON DELETE CASCADE,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  locked_at timestamptz,
  locked_by text,
  processed_at timestamptz,
  last_error text
);

CREATE INDEX IF NOT EXISTS projection_queue_pending_idx ON projection_queue (available_at, observation_id)
  WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS trajectory_point (
  entity_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  observation_id text NOT NULL UNIQUE REFERENCES world_observation(observation_id) ON DELETE CASCADE,
  geometry geometry(Point, 4326) NOT NULL,
  latitude double precision NOT NULL CHECK (latitude >= -90 AND latitude <= 90),
  longitude double precision NOT NULL CHECK (longitude >= -180 AND longitude <= 180),
  altitude double precision,
  heading double precision,
  speed double precision,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  h3_r7 text,
  h3_r8 text,
  h3_r9 text,
  h3_r10 text,
  PRIMARY KEY (entity_id, observed_at, observation_id)
);

CREATE INDEX IF NOT EXISTS trajectory_point_entity_time_idx ON trajectory_point (entity_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS trajectory_point_time_brin_idx ON trajectory_point USING brin (observed_at);
CREATE INDEX IF NOT EXISTS trajectory_point_geometry_gist_idx ON trajectory_point USING gist (geometry);
CREATE INDEX IF NOT EXISTS trajectory_point_h3_time_idx ON trajectory_point (h3_r9, observed_at DESC);

CREATE TABLE IF NOT EXISTS situation_cell (
  h3_index text NOT NULL,
  resolution smallint NOT NULL CHECK (resolution >= 0 AND resolution <= 15),
  agent_count bigint NOT NULL DEFAULT 0 CHECK (agent_count >= 0),
  vehicle_count bigint NOT NULL DEFAULT 0 CHECK (vehicle_count >= 0),
  sensor_count bigint NOT NULL DEFAULT 0 CHECK (sensor_count >= 0),
  incident_count bigint NOT NULL DEFAULT 0 CHECK (incident_count >= 0),
  observation_count bigint NOT NULL DEFAULT 0 CHECK (observation_count >= 0),
  unique_observer_count bigint NOT NULL DEFAULT 0 CHECK (unique_observer_count >= 0),
  risk_score double precision NOT NULL DEFAULT 0,
  coverage_score double precision NOT NULL DEFAULT 0,
  activity_score double precision NOT NULL DEFAULT 0,
  freshness_score double precision NOT NULL DEFAULT 0,
  last_observed_at timestamptz,
  world_version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (h3_index, resolution)
);

CREATE INDEX IF NOT EXISTS situation_cell_hotspot_idx ON situation_cell (resolution, activity_score DESC);
CREATE INDEX IF NOT EXISTS situation_cell_risk_idx ON situation_cell (resolution, risk_score DESC);
CREATE INDEX IF NOT EXISTS situation_cell_coverage_idx ON situation_cell (resolution, coverage_score ASC);

CREATE TABLE IF NOT EXISTS object_area_membership (
  object_id text NOT NULL REFERENCES world_object(id) ON DELETE CASCADE,
  area_id text NOT NULL REFERENCES world_object(id) ON DELETE CASCADE,
  entered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_observation_id text,
  PRIMARY KEY (object_id, area_id)
);

CREATE TABLE IF NOT EXISTS world_event (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  event_time timestamptz NOT NULL,
  geometry geometry(Geometry, 4326),
  world_version bigint NOT NULL,
  correlation_id text NOT NULL,
  causation_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version text NOT NULL DEFAULT '1.0',
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS world_event_subject_time_idx ON world_event (subject_id, event_time DESC);
CREATE INDEX IF NOT EXISTS world_event_type_version_idx ON world_event (event_type, world_version DESC);
CREATE INDEX IF NOT EXISTS world_event_unpublished_idx ON world_event (world_version) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS world_event_geometry_gist_idx ON world_event USING gist (geometry);

CREATE TABLE IF NOT EXISTS projection_run (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  observation_count bigint NOT NULL DEFAULT 0,
  final_world_version bigint,
  checksum text,
  status text NOT NULL DEFAULT 'running',
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMIT;
