BEGIN;

CREATE TABLE IF NOT EXISTS situation_cell_observer (
  h3_index text NOT NULL,
  resolution smallint NOT NULL,
  observer_id text NOT NULL,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  observation_count bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (h3_index, resolution, observer_id),
  FOREIGN KEY (h3_index, resolution) REFERENCES situation_cell(h3_index, resolution) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS situation_cell_observer_recent_idx
  ON situation_cell_observer (h3_index, resolution, last_observed_at DESC);

COMMIT;
