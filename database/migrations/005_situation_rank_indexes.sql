BEGIN;

CREATE INDEX IF NOT EXISTS situation_cell_observation_rank_idx
  ON situation_cell (resolution, observation_count DESC);

CREATE INDEX IF NOT EXISTS situation_cell_observer_rank_idx
  ON situation_cell (resolution, unique_observer_count DESC);

CREATE INDEX IF NOT EXISTS situation_cell_freshness_rank_idx
  ON situation_cell (resolution, last_observed_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS situation_cell_activity_expr_idx
  ON situation_cell (
    resolution,
    (LEAST(100, GREATEST(0, LN(1 + observation_count) * 12))) DESC
  );

CREATE INDEX IF NOT EXISTS situation_cell_risk_expr_idx
  ON situation_cell (
    resolution,
    (LEAST(100, GREATEST(0, incident_count * 20 + observation_count * 0.02))) DESC
  );

COMMIT;
