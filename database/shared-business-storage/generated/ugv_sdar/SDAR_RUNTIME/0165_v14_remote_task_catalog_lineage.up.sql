CREATE FUNCTION ugv_sdar.protect_active_remote_task_tool_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM remote_task_admission_intent AS intent
    WHERE intent.server_id = OLD.server_id
      AND intent.operation_name = OLD.tool_name
      AND intent.status IN ('prepared','dispatching','receipt_recorded')
  ) OR EXISTS (
    SELECT 1
    FROM remote_task_binding AS binding
    WHERE binding.server_id = OLD.server_id
      AND binding.operation_name = OLD.tool_name
      AND binding.local_state NOT IN ('reentered','closed','quarantined')
  ) THEN
    RAISE EXCEPTION 'MCP_TOOL_ACTIVE_REMOTE_TASK_CONFLICT';
  END IF;
  RETURN OLD;
END;
$$ SET search_path TO ugv_sdar, public, pg_catalog;

CREATE TRIGGER mcp_tool_active_remote_task_guard
  BEFORE DELETE
  ON ugv_sdar.mcp_tool
  FOR EACH ROW
  EXECUTE PROCEDURE protect_active_remote_task_tool_catalog();

ALTER TABLE ugv_sdar.remote_task_admission_intent 
  DROP CONSTRAINT remote_task_admission_tool_fk RESTRICT;

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0165_v14_remote_task_catalog_lineage');
