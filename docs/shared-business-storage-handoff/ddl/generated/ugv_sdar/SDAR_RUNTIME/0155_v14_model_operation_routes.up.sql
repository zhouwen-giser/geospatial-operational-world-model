ALTER TABLE ugv_sdar.stage_model_route 
  DROP CONSTRAINT stage_model_route_pkey RESTRICT;

ALTER TABLE ugv_sdar.stage_model_route 
  ADD COLUMN operation text
    NOT NULL
    DEFAULT 'structured_generation'
    CONSTRAINT stage_model_route_operation_check CHECK (operation IN ('structured_generation', 'embedding'));

ALTER TABLE ugv_sdar.stage_model_route 
  ALTER COLUMN operation DROP DEFAULT;

ALTER TABLE ugv_sdar.stage_model_route 
  ADD PRIMARY KEY (stage, operation);

INSERT INTO ugv_sdar.schema_migration (
  version
) VALUES
  ('0155_v14_model_operation_routes');
