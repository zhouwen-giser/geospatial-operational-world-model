CREATE OR REPLACE FUNCTION ugv_sdar.sdar_assign_node_event_outbox_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_type IN (
    'node.capability.readiness_changed',
    'node.task.capability_bound'
  ) AND NEW.outbox_sequence IS NULL THEN
    PERFORM pg_advisory_xact_lock(53444152,125);
    SELECT COALESCE(MAX(event.outbox_sequence),0)+1
      INTO NEW.outbox_sequence
      FROM cognitive_runtime_outbox event;
  END IF;
  RETURN NEW;
END;
$$ SET search_path TO ugv_sdar, public, pg_catalog;

CREATE TRIGGER cognitive_node_event_assign_sequence
  BEFORE INSERT
  ON ugv_sdar.cognitive_runtime_outbox
  FOR EACH ROW
  EXECUTE PROCEDURE sdar_assign_node_event_outbox_sequence();

WITH 
  sequenced AS (SELECT
    event_id,
    (COALESCE((SELECT max(outbox_sequence)
    FROM ugv_sdar.cognitive_runtime_outbox), 0)) + row_number() OVER (ORDER BY occurred_at, event_id) AS next_sequence
  FROM ugv_sdar.cognitive_runtime_outbox
  WHERE
    outbox_sequence IS NULL
    AND event_type = 'node.capability.readiness_changed') UPDATE ugv_sdar.cognitive_runtime_outbox AS event SET outbox_sequence = sequenced.next_sequence FROM sequenced WHERE event.event_id = sequenced.event_id;

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0143_v14_node_event_projection');
