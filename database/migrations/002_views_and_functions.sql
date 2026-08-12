BEGIN;

CREATE OR REPLACE FUNCTION gowm_next_world_version()
RETURNS bigint
LANGUAGE sql
VOLATILE
AS $$ SELECT nextval('world_version_seq') $$;

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

CREATE OR REPLACE FUNCTION claim_projection_batch(worker_name text, batch_size integer)
RETURNS TABLE (observation_id text)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT q.observation_id
    FROM projection_queue q
    WHERE q.processed_at IS NULL
      AND q.available_at <= clock_timestamp()
      AND (q.locked_at IS NULL OR q.locked_at < clock_timestamp() - interval '5 minutes')
    ORDER BY q.available_at, q.observation_id
    FOR UPDATE SKIP LOCKED
    LIMIT batch_size
  )
  UPDATE projection_queue q
  SET locked_at = clock_timestamp(), locked_by = worker_name, attempts = attempts + 1
  FROM candidates c
  WHERE q.observation_id = c.observation_id
  RETURNING q.observation_id;
END;
$$;

COMMIT;
