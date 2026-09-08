ALTER TABLE ugv_sdar.governed_control_confirmation 
  ALTER COLUMN authority_kind SET DEFAULT 'physical_control';

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0177_v14_control_authority_kind_default');
