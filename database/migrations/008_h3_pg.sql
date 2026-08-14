BEGIN;

CREATE EXTENSION IF NOT EXISTS h3;
CREATE EXTENSION IF NOT EXISTS postgis_raster;
CREATE EXTENSION IF NOT EXISTS h3_postgis;

DROP VIEW IF EXISTS world_object_current;
DROP VIEW IF EXISTS situation_cell_scored;

ALTER TABLE situation_cell_observer
  DROP CONSTRAINT IF EXISTS situation_cell_observer_h3_index_resolution_fkey;

ALTER TABLE world_object_geometry
  ALTER COLUMN h3_r7 TYPE h3index USING h3_r7::h3index,
  ALTER COLUMN h3_r8 TYPE h3index USING h3_r8::h3index,
  ALTER COLUMN h3_r9 TYPE h3index USING h3_r9::h3index,
  ALTER COLUMN h3_r10 TYPE h3index USING h3_r10::h3index;

ALTER TABLE trajectory_point
  ALTER COLUMN h3_r7 TYPE h3index USING h3_r7::h3index,
  ALTER COLUMN h3_r8 TYPE h3index USING h3_r8::h3index,
  ALTER COLUMN h3_r9 TYPE h3index USING h3_r9::h3index,
  ALTER COLUMN h3_r10 TYPE h3index USING h3_r10::h3index;

ALTER TABLE situation_cell
  ALTER COLUMN h3_index TYPE h3index USING h3_index::h3index;

ALTER TABLE situation_cell_observer
  ALTER COLUMN h3_index TYPE h3index USING h3_index::h3index;

ALTER TABLE situation_cell
  ADD CONSTRAINT situation_cell_h3_resolution_match
  CHECK (h3_get_resolution(h3_index) = resolution);

ALTER TABLE situation_cell_observer
  ADD CONSTRAINT situation_cell_observer_h3_resolution_match
  CHECK (h3_get_resolution(h3_index) = resolution),
  ADD CONSTRAINT situation_cell_observer_h3_index_resolution_fkey
  FOREIGN KEY (h3_index, resolution)
  REFERENCES situation_cell(h3_index, resolution) ON DELETE CASCADE;

CREATE OR REPLACE VIEW world_object_current AS
SELECT
  o.id,
  o.object_type,
  o.subtype,
  o.properties,
  s.state,
  s.confidence,
  s.observed_at,
  s.received_at,
  s.source,
  s.source_observation_id,
  s.version,
  s.updated_at,
  g.geometry,
  g.h3_r7,
  g.h3_r8,
  g.h3_r9,
  g.h3_r10
FROM world_object o
JOIN world_object_state s ON s.object_id = o.id
LEFT JOIN world_object_geometry g ON g.object_id = o.id
WHERE o.deleted_at IS NULL;

CREATE OR REPLACE VIEW situation_cell_scored AS
SELECT
  h3_index,
  resolution,
  agent_count,
  vehicle_count,
  sensor_count,
  incident_count,
  observation_count,
  LEAST(100, GREATEST(0, incident_count * 20 + observation_count * 0.02))::double precision AS derived_risk_score,
  LEAST(100, GREATEST(0, unique_observer_count * 20))::double precision AS derived_coverage_score,
  LEAST(100, GREATEST(0, LN(1 + observation_count) * 12))::double precision AS derived_activity_score,
  CASE
    WHEN last_observed_at IS NULL THEN 0
    ELSE GREATEST(0, 100 - EXTRACT(EPOCH FROM (clock_timestamp() - last_observed_at)) / 3)
  END::double precision AS derived_freshness_score,
  last_observed_at,
  world_version,
  updated_at
FROM situation_cell;

COMMIT;
