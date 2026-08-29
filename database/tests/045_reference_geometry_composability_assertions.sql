\set ON_ERROR_STOP on

BEGIN;

DO $structure$
BEGIN
  IF to_regprocedure('gowm_evidence_v1.current_dataset_scope_key()') IS NULL OR
     to_regclass('gowm_evidence_v1.catalog_feature_geometry') IS NULL OR
     to_regclass('gowm_evidence_v1.current_feature_geometry') IS NULL OR
     to_regclass('gowm_spatial_v1.catalog_feature_reference') IS NULL OR
     to_regclass('gowm_spatial_v1.catalog_feature') IS NULL OR
     to_regclass('gowm_spatial_v1.catalog_snapshot') IS NULL THEN
    RAISE EXCEPTION 'catalog feature geometry read contract is incomplete';
  END IF;

  IF EXISTS (
    (SELECT ordinal_position, column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema='gowm_spatial_v1' AND table_name='current_object')
    EXCEPT
    (SELECT ordinal_position, column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema='gowm_spatial_v1' AND table_name='catalog_feature_reference')
  ) OR EXISTS (
    (SELECT ordinal_position, column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema='gowm_spatial_v1' AND table_name='catalog_feature_reference')
    EXCEPT
    (SELECT ordinal_position, column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema='gowm_spatial_v1' AND table_name='current_object')
  ) OR EXISTS (
    (SELECT ordinal_position, column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema='gowm_spatial_v1' AND table_name='current_object')
    EXCEPT
    (SELECT ordinal_position, column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema='gowm_spatial_v1' AND table_name='catalog_feature')
  ) OR EXISTS (
    (SELECT ordinal_position, column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema='gowm_spatial_v1' AND table_name='catalog_feature')
    EXCEPT
    (SELECT ordinal_position, column_name, data_type, udt_name
       FROM information_schema.columns
      WHERE table_schema='gowm_spatial_v1' AND table_name='current_object')
  ) THEN
    RAISE EXCEPTION 'catalog feature spatial views do not match the current_object shape';
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='gowm_evidence_v1' AND table_name='catalog_feature_geometry') <> 12 OR
     (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='gowm_evidence_v1' AND table_name='current_feature_geometry') <> 12 OR
     (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='gowm_evidence_v1' AND table_name='current_geometry') <> 9 OR
     NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='gowm_evidence_v1' AND table_name='catalog_feature_geometry'
         AND column_name='geometry' AND data_type='jsonb') OR
     NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='gowm_evidence_v1' AND table_name='catalog_feature_geometry'
         AND column_name='world_version' AND data_type='bigint') THEN
    RAISE EXCEPTION 'catalog feature evidence view shape is invalid';
  END IF;

  IF NOT has_table_privilege('gowm_evidence_reader','gowm_evidence_v1.catalog_feature_geometry','SELECT') OR
     NOT has_table_privilege('gowm_evidence_reader','gowm_evidence_v1.current_feature_geometry','SELECT') OR
     NOT has_table_privilege('gowm_evidence_reader','gowm_evidence_v1.current_geometry','SELECT') OR
     NOT has_table_privilege('spatial_provider','gowm_spatial_v1.catalog_feature_reference','SELECT') OR
     NOT has_table_privilege('spatial_provider','gowm_spatial_v1.catalog_feature','SELECT') OR
     NOT has_table_privilege('spatial_provider','gowm_spatial_v1.catalog_snapshot','SELECT') OR
     NOT has_function_privilege('gowm_evidence_reader','gowm_evidence_v1.current_dataset_scope_key()','EXECUTE') OR
     has_table_privilege('gowm_evidence_reader','public.spatial_feature_identity','SELECT') OR
     has_table_privilege('gowm_evidence_reader','public.spatial_feature_version','SELECT') OR
     has_table_privilege('gowm_evidence_reader','public.world_reference_descriptor_version','SELECT') OR
     has_table_privilege('spatial_provider','public.spatial_feature_identity','SELECT') OR
     has_table_privilege('spatial_provider','public.spatial_feature_version','SELECT') OR
     has_table_privilege('spatial_provider','public.spatial_layer','SELECT') OR
     has_table_privilege('spatial_provider','public.spatial_layer_version','SELECT') OR
     has_table_privilege('spatial_provider','public.world_reference_descriptor_version','SELECT') THEN
    RAISE EXCEPTION 'catalog feature provider privilege boundary is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL aclexplode(relation.relacl) privilege
    WHERE namespace.nspname IN ('gowm_evidence_v1','gowm_spatial_v1')
      AND relation.relname IN (
        'catalog_feature_geometry','current_feature_geometry','current_geometry',
        'catalog_feature_reference','catalog_feature','catalog_snapshot'
      )
      AND privilege.grantee=0
      AND privilege.privilege_type='SELECT'
  ) OR EXISTS (
    SELECT 1
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid=function.pronamespace
    CROSS JOIN LATERAL aclexplode(function.proacl) privilege
    WHERE namespace.nspname='gowm_evidence_v1'
      AND function.proname='current_dataset_scope_key'
      AND privilege.grantee=0
      AND privilege.privilege_type='EXECUTE'
  ) THEN
    RAISE EXCEPTION 'PUBLIC can read or execute the catalog feature contract';
  END IF;
END
$structure$;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
  ('catalog-feature-read-a','TEST','Catalog feature read contract A'),
  ('catalog-feature-read-b','TEST','Catalog feature read contract B');

INSERT INTO spatial_dataset(data_scope_key,dataset_scope_key,dataset_key,name) VALUES
  ('catalog-feature-read-a','tenant-a','roads-a','Roads A'),
  ('catalog-feature-read-a','tenant-b','roads-b','Roads B'),
  ('catalog-feature-read-b','tenant-a','roads-c','Roads C');

INSERT INTO spatial_dataset_version(
  dataset_id,version,dataset_kind,source_ref,source_version,schema_version,crs,
  content_hash,published_at
)
SELECT dataset_id,'dataset-v1','VECTOR','urn:test:catalog-feature-read','1','1.0','EPSG:4326',
       'sha256:' || encode(digest(reference_key || ':dataset-v1','sha256'),'hex'),
       '2026-01-01T00:00:00Z'
FROM spatial_dataset
WHERE data_scope_key IN ('catalog-feature-read-a','catalog-feature-read-b');

INSERT INTO spatial_layer(dataset_id,data_scope_key,dataset_scope_key,layer_key,name)
SELECT dataset_id,data_scope_key,dataset_scope_key,'roads','Road centerlines'
FROM spatial_dataset
WHERE data_scope_key IN ('catalog-feature-read-a','catalog-feature-read-b');

INSERT INTO spatial_layer_version(
  layer_id,dataset_id,dataset_version_id,version,layer_type,geometry_type,
  schema_version,crs,source_ref,source_version,content_hash,published_at
)
SELECT layer.layer_id,layer.dataset_id,dataset_version.dataset_version_id,
       'layer-v1','VECTOR_FEATURE','LineString','1.0','EPSG:4326',
       'urn:test:catalog-feature-read','1',
       'sha256:' || encode(digest(layer.reference_key || ':layer-v1','sha256'),'hex'),
       '2026-01-01T00:00:00Z'
FROM spatial_layer layer
JOIN spatial_dataset_version dataset_version USING (dataset_id)
WHERE layer.data_scope_key IN ('catalog-feature-read-a','catalog-feature-read-b');

INSERT INTO spatial_feature_identity(
  layer_id,data_scope_key,dataset_scope_key,feature_key,feature_type,display_name
)
SELECT layer_id,data_scope_key,dataset_scope_key,
       CASE
         WHEN data_scope_key='catalog-feature-read-a' AND dataset_scope_key='tenant-a' THEN 'road-primary'
         WHEN data_scope_key='catalog-feature-read-a' THEN 'road-other-dataset'
         ELSE 'road-other-data'
       END,
       'ROAD','Test road'
FROM spatial_layer
WHERE data_scope_key IN ('catalog-feature-read-a','catalog-feature-read-b');

WITH primary_feature AS (
  SELECT feature.feature_id,feature.layer_id,layer_version.layer_version_id,feature.reference_key
  FROM spatial_feature_identity feature
  JOIN spatial_layer_version layer_version USING (layer_id)
  WHERE feature.data_scope_key='catalog-feature-read-a'
    AND feature.dataset_scope_key='tenant-a'
)
INSERT INTO spatial_feature_version(
  feature_id,layer_id,layer_version_id,version,geometry,properties,
  source_feature_id,content_hash,published_at,retired_at
)
SELECT primary_feature.feature_id,primary_feature.layer_id,primary_feature.layer_version_id,
       feature_values.version,ST_GeomFromText(feature_values.wkt,4326),
       jsonb_build_object('class','primary','version',feature_values.version),
       'road-primary','sha256:' || encode(digest(primary_feature.reference_key || ':' || feature_values.version,'sha256'),'hex'),
       feature_values.published_at,feature_values.retired_at
FROM primary_feature
CROSS JOIN (VALUES
  ('feature-v1','LINESTRING(116.30 39.80,116.40 39.90)','2026-01-01T00:00:00Z'::timestamptz,NULL::timestamptz),
  ('feature-v2','LINESTRING(116.30 39.80,116.50 40.00)','2026-02-01T00:00:00Z'::timestamptz,NULL::timestamptz),
  ('feature-retired','LINESTRING(116.30 39.80,116.60 40.10)','2026-03-01T00:00:00Z'::timestamptz,'2026-04-01T00:00:00Z'::timestamptz)
) feature_values(version,wkt,published_at,retired_at);

INSERT INTO spatial_feature_version(
  feature_id,layer_id,layer_version_id,version,geometry,properties,
  source_feature_id,content_hash,published_at
)
SELECT feature.feature_id,feature.layer_id,layer_version.layer_version_id,
       'feature-v1',ST_GeomFromText('LINESTRING(117 40,117.1 40.1)',4326),
       '{"class":"secondary"}'::jsonb,feature.feature_key,
       'sha256:' || encode(digest(feature.reference_key || ':feature-v1','sha256'),'hex'),
       '2026-01-01T00:00:00Z'
FROM spatial_feature_identity feature
JOIN spatial_layer_version layer_version USING (layer_id)
WHERE NOT (
  feature.data_scope_key='catalog-feature-read-a' AND feature.dataset_scope_key='tenant-a'
);

INSERT INTO world_reference_descriptor_version(
  reference_key,data_scope_key,reference_type,display_name,object_version,world_version,
  provenance,content_hash
)
SELECT feature.reference_key,feature.data_scope_key,'LAYER_FEATURE','Test road ' || version.version,
       version.version,
       CASE version.version WHEN 'feature-v1' THEN 101 ELSE 102 END,
       jsonb_build_array('database/tests/045_reference_geometry_composability_assertions.sql'),
       'sha256:' || encode(digest(feature.reference_key || ':descriptor:' || version.version,'sha256'),'hex')
FROM spatial_feature_identity feature
JOIN spatial_feature_version version USING (feature_id)
WHERE feature.data_scope_key='catalog-feature-read-a'
  AND feature.dataset_scope_key='tenant-a'
  AND version.version IN ('feature-v1','feature-v2');

SELECT gowm_evidence_v1.set_data_scope('catalog-feature-read-a');
SELECT set_config('gowm.dataset_scope_key','tenant-a',true);

DO $semantics$
DECLARE
  feature_reference text;
  descriptor_v1 text;
  descriptor_v2 text;
  snapshot_before text;
  snapshot_after text;
BEGIN
  SELECT reference_key INTO STRICT feature_reference
  FROM spatial_feature_identity
  WHERE data_scope_key='catalog-feature-read-a' AND dataset_scope_key='tenant-a';
  SELECT descriptor_version::text INTO STRICT descriptor_v1
  FROM world_reference_descriptor_version
  WHERE reference_key=feature_reference AND object_version='feature-v1';
  SELECT descriptor_version::text INTO STRICT descriptor_v2
  FROM world_reference_descriptor_version
  WHERE reference_key=feature_reference AND object_version='feature-v2';

  IF (SELECT count(*) FROM gowm_evidence_v1.catalog_feature_geometry) <> 4 OR
     NOT EXISTS (SELECT 1 FROM gowm_evidence_v1.catalog_feature_geometry
       WHERE reference_key=feature_reference AND reference_version='feature-v1'
         AND feature_version='feature-v1' AND world_version=101) OR
     NOT EXISTS (SELECT 1 FROM gowm_evidence_v1.catalog_feature_geometry
       WHERE reference_key=feature_reference AND reference_version=descriptor_v1
         AND feature_version='feature-v1' AND world_version=101) OR
     NOT EXISTS (SELECT 1 FROM gowm_evidence_v1.catalog_feature_geometry
       WHERE reference_key=feature_reference AND reference_version='feature-v2'
         AND feature_version='feature-v2' AND world_version=102) OR
     NOT EXISTS (SELECT 1 FROM gowm_evidence_v1.catalog_feature_geometry
       WHERE reference_key=feature_reference AND reference_version=descriptor_v2
         AND feature_version='feature-v2' AND world_version=102) OR
     EXISTS (SELECT 1 FROM gowm_evidence_v1.catalog_feature_geometry
       WHERE reference_key=feature_reference AND reference_version='wrong-version') OR
     EXISTS (SELECT 1 FROM gowm_evidence_v1.catalog_feature_geometry
       WHERE reference_key=feature_reference AND feature_version='feature-retired') THEN
    RAISE EXCEPTION 'catalog feature evidence exact-version semantics failed';
  END IF;

  IF (SELECT count(*) FROM gowm_spatial_v1.catalog_feature_reference) <> 4 OR
     (SELECT count(*) FROM gowm_spatial_v1.catalog_feature) <> 1 OR
     (SELECT reference_key->>'version' FROM gowm_spatial_v1.catalog_feature) <> 'feature-v2' OR
     EXISTS (SELECT 1 FROM gowm_spatial_v1.catalog_feature_reference
       WHERE reference_key->>'version'='feature-retired') THEN
    RAISE EXCEPTION 'catalog feature spatial exact/current semantics failed';
  END IF;

  IF (SELECT count(*) FROM gowm_evidence_v1.current_feature_geometry) <> 1 OR
     (SELECT feature_version FROM gowm_evidence_v1.current_feature_geometry) <> 'feature-v2' OR
     (SELECT count(*) FROM gowm_evidence_v1.current_geometry) <> 1 OR
     NOT EXISTS (
       SELECT 1 FROM gowm_evidence_v1.current_geometry
       WHERE reference_key=feature_reference
         AND reference_key_value->>'kind'='LAYER_FEATURE'
         AND reference_key_value->>'version'='feature-v2'
         AND geometry_type='LINESTRING'
         AND crs='EPSG:4326'
     ) THEN
    RAISE EXCEPTION 'unified current geometry did not expose the deterministic LAYER_FEATURE head';
  END IF;

  SELECT catalog_snapshot_version INTO STRICT snapshot_before
  FROM gowm_spatial_v1.catalog_snapshot;

  INSERT INTO spatial_feature_version(
    feature_id,layer_id,layer_version_id,version,geometry,properties,
    source_feature_id,content_hash,published_at
  )
  SELECT feature.feature_id,feature.layer_id,layer_version.layer_version_id,
         'feature-v3',ST_GeomFromText('LINESTRING(116.30 39.80,116.70 40.20)',4326),
         '{"class":"primary","version":"feature-v3"}'::jsonb,
         'road-primary','sha256:' || encode(digest(feature.reference_key || ':feature-v3','sha256'),'hex'),
         '2026-05-01T00:00:00Z'
  FROM spatial_feature_identity feature
  JOIN spatial_layer_version layer_version USING (layer_id)
  WHERE feature.reference_key=feature_reference;

  SELECT catalog_snapshot_version INTO STRICT snapshot_after
  FROM gowm_spatial_v1.catalog_snapshot;
  IF snapshot_after=snapshot_before OR
     (SELECT reference_key->>'version' FROM gowm_spatial_v1.catalog_feature) <> 'feature-v3' OR
     (SELECT feature_version FROM gowm_evidence_v1.current_feature_geometry) <> 'feature-v3' OR
     NOT EXISTS (SELECT 1 FROM gowm_evidence_v1.current_geometry
       WHERE reference_key=feature_reference AND reference_key_value->>'version'='feature-v3') OR
     NOT EXISTS (SELECT 1 FROM gowm_spatial_v1.catalog_feature_reference
       WHERE reference_key->>'id'=feature_reference AND reference_key->>'version'='feature-v3') THEN
    RAISE EXCEPTION 'catalog feature current head or cursor snapshot did not advance';
  END IF;

  PERFORM set_config('gowm.dataset_scope_key','tenant-b',true);
  IF (SELECT count(*) FROM gowm_evidence_v1.catalog_feature_geometry) <> 1 OR
     EXISTS (SELECT 1 FROM gowm_evidence_v1.catalog_feature_geometry WHERE reference_key=feature_reference) OR
     (SELECT count(*) FROM gowm_spatial_v1.catalog_feature) <> 1 THEN
    RAISE EXCEPTION 'catalog feature leaked across dataset scopes';
  END IF;

  PERFORM gowm_evidence_v1.set_data_scope('catalog-feature-read-b');
  PERFORM set_config('gowm.dataset_scope_key','tenant-a',true);
  IF (SELECT count(*) FROM gowm_evidence_v1.catalog_feature_geometry) <> 1 OR
     EXISTS (SELECT 1 FROM gowm_evidence_v1.catalog_feature_geometry WHERE reference_key=feature_reference) OR
     (SELECT count(*) FROM gowm_spatial_v1.catalog_feature) <> 1 THEN
    RAISE EXCEPTION 'catalog feature leaked across data scopes';
  END IF;

  PERFORM set_config('gowm.dataset_scope_key','missing',true);
  IF EXISTS (SELECT 1 FROM gowm_evidence_v1.catalog_feature_geometry) OR
     EXISTS (SELECT 1 FROM gowm_spatial_v1.catalog_feature_reference) OR
     EXISTS (SELECT 1 FROM gowm_spatial_v1.catalog_feature) THEN
    RAISE EXCEPTION 'catalog feature returned rows for an unavailable dataset scope';
  END IF;
END
$semantics$;

ROLLBACK;

SELECT 'CATALOG_FEATURE_GEOMETRY_READ_CONTRACT_ASSERTIONS_PASS' AS result;
