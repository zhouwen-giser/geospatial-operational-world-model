BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS world_relation_active_unique_idx
  ON world_relation (relation_type, from_object_id, to_object_id)
  WHERE valid_to IS NULL;

COMMIT;
