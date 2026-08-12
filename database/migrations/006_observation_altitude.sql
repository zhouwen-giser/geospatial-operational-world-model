BEGIN;

ALTER TABLE world_observation
  ADD COLUMN IF NOT EXISTS altitude double precision;

COMMIT;
