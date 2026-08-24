BEGIN;

ALTER FUNCTION gowm_reference_v1.resolve(text,text[],integer,double precision,integer)
  SECURITY DEFINER;
ALTER FUNCTION gowm_reference_v1.resolve(text,text[],integer,double precision,integer)
  SET search_path = pg_catalog, public, gowm_reference_v1;

CREATE VIEW gowm_reference_v1.scope_resource AS
SELECT identity.reference_key,
       jsonb_build_object(
         'namespace','gowm','kind','DATA_SCOPE','id',identity.reference_key,'version','1'
       ) AS reference_key_value
FROM world_reference_identity identity
WHERE identity.entity_kind='DATA_SCOPE'
  AND identity.data_scope_key=gowm_reference_v1.current_data_scope_key();

CREATE VIEW gowm_catalog_v1.scope_resource AS
SELECT identity.reference_key,
       jsonb_build_object(
         'namespace','gowm','kind','DATA_SCOPE','id',identity.reference_key,'version','1'
       ) AS reference_key_value
FROM world_reference_identity identity
WHERE identity.entity_kind='DATA_SCOPE'
  AND identity.data_scope_key=gowm_catalog_v1.current_data_scope_key();

REVOKE ALL ON gowm_catalog_v1.scope_resource FROM PUBLIC;
REVOKE ALL ON gowm_reference_v1.scope_resource FROM PUBLIC;
GRANT SELECT ON gowm_catalog_v1.scope_resource TO gowm_catalog_reader;
GRANT SELECT ON gowm_reference_v1.scope_resource TO gowm_reference_reader;

COMMIT;
