\set ON_ERROR_STOP on

BEGIN;

DO $structure$
BEGIN
  IF to_regnamespace('gowm_catalog_v1') IS NULL OR
     to_regclass('public.spatial_dataset') IS NULL OR
     to_regclass('public.spatial_dataset_version') IS NULL OR
     to_regclass('public.spatial_layer') IS NULL OR
     to_regclass('public.spatial_layer_version') IS NULL OR
     to_regclass('public.spatial_feature_identity') IS NULL OR
     to_regclass('public.spatial_feature_version') IS NULL OR
     to_regclass('public.spatial_feature_object_binding') IS NULL THEN
    RAISE EXCEPTION 'Dataset/Layer/Feature catalog is incomplete';
  END IF;
  IF has_table_privilege('gowm_catalog_service', 'public.spatial_dataset', 'SELECT') OR
     NOT has_table_privilege('gowm_catalog_service', 'gowm_catalog_v1.dataset', 'SELECT') THEN
    RAISE EXCEPTION 'catalog Provider privilege boundary is invalid';
  END IF;
END
$structure$;

INSERT INTO data_scope(scope_key, operational_domain, description)
VALUES ('catalog-test', 'TEST', 'Catalog test scope');

WITH dataset AS (
  INSERT INTO spatial_dataset(data_scope_key, dataset_scope_key, dataset_key, name)
  VALUES ('catalog-test', 'tenant-a', 'roads', 'Road network')
  RETURNING dataset_id
)
INSERT INTO spatial_dataset_version(
  dataset_id, version, dataset_kind, source_ref, source_version, schema_version,
  crs, quality, lineage, content_hash, published_at
)
SELECT dataset_id, '1', 'VECTOR', 'urn:test:roads', '2026-01', '1.0',
       'EPSG:4326', '{"completeness":0.9}'::jsonb, '["source:roads"]'::jsonb,
       'sha256:' || repeat('1',64), '2026-01-01T00:00:00Z'
FROM dataset;

WITH dataset AS (
  SELECT dataset_id FROM spatial_dataset WHERE data_scope_key='catalog-test' AND dataset_key='roads'
), dataset_version AS (
  SELECT version.dataset_version_id, version.dataset_id
  FROM spatial_dataset_version version JOIN dataset USING(dataset_id)
), layer AS (
  INSERT INTO spatial_layer(dataset_id, data_scope_key, dataset_scope_key, layer_key, name)
  SELECT dataset_id, 'catalog-test', 'tenant-a', 'road-centerline', 'Road centerlines' FROM dataset
  RETURNING layer_id, dataset_id
)
INSERT INTO spatial_layer_version(
  layer_id, dataset_id, dataset_version_id, version, layer_type, geometry_type,
  schema_version, crs, source_ref, source_version, lineage, content_hash, published_at
)
SELECT layer.layer_id, layer.dataset_id, dataset_version.dataset_version_id,
       version_label, 'VECTOR_FEATURE', 'LineString', '1.0', 'EPSG:4326',
       'urn:test:roads', '2026-01', '["dataset:roads:1"]'::jsonb,
       content_hash, published_at
FROM layer JOIN dataset_version USING(dataset_id)
CROSS JOIN (VALUES
  ('1', 'sha256:' || repeat('2',64), '2026-01-01T00:00:00Z'::timestamptz),
  ('2', 'sha256:' || repeat('3',64), '2026-02-01T00:00:00Z'::timestamptz)
) versions(version_label, content_hash, published_at);

WITH layer AS (
  SELECT layer_id FROM spatial_layer WHERE data_scope_key='catalog-test' AND layer_key='road-centerline'
), current_layer_version AS (
  SELECT version.layer_version_id, version.layer_id
  FROM spatial_layer_version version JOIN layer USING(layer_id)
  ORDER BY version.published_at DESC LIMIT 1
), feature AS (
  INSERT INTO spatial_feature_identity(
    layer_id, data_scope_key, dataset_scope_key, feature_key, feature_type, display_name
  )
  SELECT layer_id, 'catalog-test', 'tenant-a', 'road-001', 'ROAD', '复兴路' FROM layer
  RETURNING feature_id, layer_id
)
INSERT INTO spatial_feature_version(
  feature_id, layer_id, layer_version_id, version, geometry, properties,
  content_hash, published_at
)
SELECT feature.feature_id, feature.layer_id, current_layer_version.layer_version_id,
       version_label, ST_GeomFromText(wkt,4326), jsonb_build_object('class','primary'),
       content_hash, published_at
FROM feature JOIN current_layer_version USING(layer_id)
CROSS JOIN (VALUES
  ('1', 'LINESTRING(116.3 39.8,116.4 39.9)', 'sha256:' || repeat('4',64), '2026-02-01T00:00:00Z'::timestamptz),
  ('2', 'LINESTRING(116.3 39.8,116.5 40.0)', 'sha256:' || repeat('5',64), '2026-03-01T00:00:00Z'::timestamptz)
) versions(version_label, wkt, content_hash, published_at);

WITH object AS (
  INSERT INTO spatial_object(data_scope_key, object_type, stable_name)
  VALUES ('catalog-test', 'ROAD', 'Existing spatial road')
  RETURNING spatial_object_id
), object_version AS (
  INSERT INTO spatial_object_version(
    spatial_object_id, version_no, analysis_space_key, valid_time, geometry
  )
  SELECT spatial_object_id, 1, 'default',
         tstzrange('2026-01-01','infinity','[)'),
         ST_Transform(ST_GeomFromText('LINESTRING(116.3 39.8,116.5 40.0)',4326),3857)
  FROM object
  RETURNING spatial_object_version_id, spatial_object_id
), feature_version AS (
  SELECT identity.feature_id, version.feature_version_id
  FROM spatial_feature_identity identity
  JOIN spatial_feature_version version USING(feature_id)
  WHERE identity.data_scope_key='catalog-test'
  ORDER BY version.published_at DESC LIMIT 1
)
INSERT INTO spatial_feature_object_binding(
  feature_id, feature_version_id, spatial_object_id, spatial_object_version_id,
  data_scope_key, binding_kind
)
SELECT feature_id, feature_version_id, spatial_object_id,
       spatial_object_version_id, 'catalog-test', 'REPRESENTS'
FROM feature_version CROSS JOIN object_version;

SELECT gowm_catalog_v1.set_scope('catalog-test','tenant-a');

DO $semantics$
DECLARE
  dataset_count integer;
  layer_head text;
  layer_versions integer;
  feature_head text;
  feature_versions integer;
  binding_count integer;
  identity_kinds text[];
BEGIN
  SELECT count(*) INTO dataset_count FROM gowm_catalog_v1.dataset;
  SELECT version INTO STRICT layer_head FROM gowm_catalog_v1.layer;
  SELECT count(*) INTO layer_versions FROM gowm_catalog_v1.layer_version;
  SELECT version INTO STRICT feature_head FROM gowm_catalog_v1.feature;
  SELECT count(*) INTO feature_versions FROM gowm_catalog_v1.feature_version;
  SELECT count(*) INTO binding_count FROM gowm_catalog_v1.feature_object_binding;
  SELECT array_agg(entity_kind ORDER BY entity_kind) INTO identity_kinds
  FROM world_reference_identity
  WHERE data_scope_key='catalog-test' AND entity_kind IN ('DATASET','LAYER','LAYER_FEATURE');

  IF dataset_count <> 1 OR layer_head <> '2' OR layer_versions <> 2 OR
     feature_head <> '2' OR feature_versions <> 2 OR binding_count <> 1 OR
     identity_kinds <> ARRAY['DATASET','LAYER','LAYER_FEATURE'] THEN
    RAISE EXCEPTION 'catalog current/history/binding/identity semantics failed';
  END IF;

  IF (SELECT count(*) FROM spatial_feature_version WHERE feature_id = (
    SELECT feature_id FROM spatial_feature_identity WHERE data_scope_key='catalog-test'
  )) <> 2 THEN
    RAISE EXCEPTION 'feature geometry history was overwritten';
  END IF;

  PERFORM gowm_catalog_v1.set_scope('catalog-test','tenant-b');
  IF EXISTS (SELECT 1 FROM gowm_catalog_v1.dataset) OR
     EXISTS (SELECT 1 FROM gowm_catalog_v1.layer) OR
     EXISTS (SELECT 1 FROM gowm_catalog_v1.feature) THEN
    RAISE EXCEPTION 'DatasetScope leaked catalog rows';
  END IF;

  BEGIN
    UPDATE spatial_layer_version SET version='mutated';
    RAISE EXCEPTION 'append-only layer version was updated';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$semantics$;

ROLLBACK;

SELECT 'DATASET_LAYER_FEATURE_CATALOG_ASSERTIONS_PASS' AS result;
