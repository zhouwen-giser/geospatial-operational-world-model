ALTER TABLE ugv_sdar.governed_control_confirmation 
  DROP CONSTRAINT governed_control_confirmation_tool_fk RESTRICT;

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0164_v14_governed_control_catalog_lineage');
