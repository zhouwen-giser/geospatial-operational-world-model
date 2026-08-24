\set ON_ERROR_STOP on

BEGIN;

DO $structure$
BEGIN
  IF to_regclass('gowm_reference_v1.scope_resource') IS NULL OR
     to_regclass('gowm_catalog_v1.scope_resource') IS NULL THEN
    RAISE EXCEPTION 'grounding catalog scope snapshot views are missing';
  END IF;
  IF NOT has_table_privilege('gowm_reference_service','gowm_reference_v1.scope_resource','SELECT') OR
     NOT has_table_privilege('gowm_catalog_service','gowm_catalog_v1.scope_resource','SELECT') OR
     has_table_privilege('gowm_reference_service','public.world_reference_descriptor_version','SELECT') OR
     has_table_privilege('gowm_catalog_service','public.spatial_dataset','SELECT') THEN
    RAISE EXCEPTION 'grounding provider runtime privilege boundary is invalid';
  END IF;
END
$structure$;

INSERT INTO data_scope(scope_key, operational_domain, description) VALUES
  ('grounding-runtime-a','TEST','Grounding runtime A'),
  ('grounding-runtime-b','TEST','Grounding runtime B');

SELECT gowm_reference_v1.set_data_scope('grounding-runtime-a');
DO $reference_scope$
BEGIN
  IF (SELECT count(*) FROM gowm_reference_v1.scope_resource) <> 1 THEN
    RAISE EXCEPTION 'reference snapshot scope resource was not isolated';
  END IF;
  PERFORM gowm_reference_v1.set_data_scope('grounding-runtime-b');
  IF (SELECT count(*) FROM gowm_reference_v1.scope_resource) <> 1 THEN
    RAISE EXCEPTION 'reference snapshot scope changed cardinality';
  END IF;
END
$reference_scope$;

SELECT gowm_catalog_v1.set_scope('grounding-runtime-a','tenant-a');
DO $catalog_scope$
BEGIN
  IF (SELECT count(*) FROM gowm_catalog_v1.scope_resource) <> 1 OR
     EXISTS (SELECT 1 FROM gowm_catalog_v1.dataset) THEN
    RAISE EXCEPTION 'catalog snapshot scope resource was not isolated';
  END IF;
  PERFORM gowm_catalog_v1.set_scope('grounding-runtime-b','tenant-a');
  IF (SELECT count(*) FROM gowm_catalog_v1.scope_resource) <> 1 THEN
    RAISE EXCEPTION 'catalog snapshot scope changed cardinality';
  END IF;
END
$catalog_scope$;

ROLLBACK;

SELECT 'GROUNDING_CATALOG_PROVIDER_RUNTIME_ASSERTIONS_PASS' AS result;
