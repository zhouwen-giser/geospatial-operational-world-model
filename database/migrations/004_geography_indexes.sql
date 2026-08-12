BEGIN;

-- ST_DWithin/ST_Distance in metres use geography. The expression indexes keep
-- those queries index-backed while geometry remains the authoritative column.
CREATE INDEX IF NOT EXISTS world_object_geometry_geography_gix
  ON world_object_geometry USING gist ((geometry::geography));

CREATE INDEX IF NOT EXISTS world_observation_geography_gix
  ON world_observation USING gist ((geometry::geography)) WHERE geometry IS NOT NULL;

CREATE INDEX IF NOT EXISTS trajectory_point_geography_gix
  ON trajectory_point USING gist ((geometry::geography));

COMMIT;
