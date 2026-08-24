\set ON_ERROR_STOP on

BEGIN;

DO $assert_contract_catalog$
DECLARE
  contract_columns integer;
BEGIN
  IF to_regnamespace('gowm_spatial_v1') IS NULL OR
     to_regclass('gowm_spatial_v1.current_object') IS NULL OR
     to_regclass('gowm_spatial_v1.current_geometry') IS NULL OR
     to_regclass('gowm_spatial_v1.layer_feature') IS NULL OR
     to_regclass('gowm_spatial_v1.dataset_descriptor') IS NULL THEN
    RAISE EXCEPTION 'gowm_spatial_v1 contract is incomplete';
  END IF;
  IF to_regprocedure('gowm_spatial_v1.set_data_scope(text)') IS NULL OR
     to_regprocedure('gowm_spatial_v1.current_data_scope_key()') IS NULL THEN
    RAISE EXCEPTION 'trusted data-scope context API is missing';
  END IF;

  SELECT count(*) INTO contract_columns
  FROM information_schema.columns
  WHERE table_schema = 'gowm_spatial_v1'
    AND table_name = 'current_object'
    AND column_name IN (
      'data_scope_key','reference_key','object_type','subtype','geometry_wgs84',
      'geography_wgs84','status','source','properties','observed_at','received_at',
      'updated_at','world_version','confidence','freshness_ms',
      'source_observation_id','provenance_summary'
    );
  IF contract_columns <> 17 THEN
    RAISE EXCEPTION 'current_object contract columns incomplete: % of 17', contract_columns;
  END IF;

  IF has_table_privilege('spatial_provider', 'public.world_object', 'SELECT') OR
     has_table_privilege('spatial_provider', 'public.world_object_state', 'SELECT') OR
     has_table_privilege('spatial_provider', 'public.world_object_geometry', 'SELECT') OR
     has_table_privilege('spatial_provider', 'public.spatial_object', 'SELECT') OR
     has_table_privilege('spatial_provider', 'public.world_reference_identity', 'SELECT') OR
     has_table_privilege('spatial_provider', 'public.world_object', 'INSERT') THEN
    RAISE EXCEPTION 'spatial_provider can access a Foundation base table';
  END IF;
  IF NOT has_table_privilege('spatial_provider', 'gowm_spatial_v1.current_object', 'SELECT') OR
     NOT has_table_privilege('spatial_provider', 'gowm_spatial_v1.layer_feature', 'SELECT') OR
     NOT has_function_privilege('spatial_provider', 'gowm_spatial_v1.set_data_scope(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'spatial_provider contract grants are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'world_reference_identity'
      AND t.tgname = 'world_reference_identity_immutable'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'world reference append-only guard is missing';
  END IF;
END
$assert_contract_catalog$;

INSERT INTO data_scope(scope_key, operational_domain, description)
VALUES
  ('spatial-contract-scope-a', 'TEST', 'gowm_spatial_v1 assertion A'),
  ('spatial-contract-scope-b', 'TEST', 'gowm_spatial_v1 assertion B');

INSERT INTO world_object(id, data_scope_key, object_type, subtype, properties)
VALUES
  ('spatial-contract-object-a', 'spatial-contract-scope-a', 'vehicle', 'test', '{"label":"A"}'),
  ('spatial-contract-object-b', 'spatial-contract-scope-b', 'vehicle', 'test', '{"label":"B"}');

INSERT INTO world_object_state(
  object_id, state, confidence, observed_at, received_at, source,
  source_observation_id, projection_policy_version, evidence_kind
)
VALUES
  (
    'spatial-contract-object-a', '{"status":"ACTIVE"}', 0.9,
    clock_timestamp() - interval '1 second', clock_timestamp(), 'database-test',
    'observation-a', 'spatial-contract-policy-v1', 'OBSERVED'
  ),
  (
    'spatial-contract-object-b', '{"status":"ACTIVE"}', 0.8,
    clock_timestamp() - interval '2 seconds', clock_timestamp(), 'database-test',
    'observation-b', 'spatial-contract-policy-v1', 'OBSERVED'
  );

INSERT INTO world_object_geometry(object_id, geometry, observed_at)
VALUES
  ('spatial-contract-object-a', ST_SetSRID(ST_MakePoint(116.3, 39.9), 4326), clock_timestamp()),
  ('spatial-contract-object-b', ST_SetSRID(ST_MakePoint(117.3, 40.1), 4326), clock_timestamp());

WITH inserted AS (
  INSERT INTO spatial_object(data_scope_key, object_type, stable_name)
  VALUES ('spatial-contract-scope-a', 'test-layer', 'scope-a-feature')
  RETURNING spatial_object_id
)
INSERT INTO spatial_object_version(
  spatial_object_id, version_no, analysis_space_key, valid_time, geometry,
  boundary_accuracy_m, attributes
)
SELECT
  spatial_object_id, 1, 'default',
  tstzrange(clock_timestamp() - interval '1 hour', NULL, '[)'),
  ST_Transform(ST_SetSRID(ST_MakePoint(116.4, 39.95), 4326), gowm_analysis_srid()),
  1.5, '{"kind":"test"}'::jsonb
FROM inserted;

SET LOCAL ROLE spatial_provider;
SELECT gowm_spatial_v1.set_data_scope('spatial-contract-scope-a');

DO $assert_scope_a$
DECLARE
  object_count integer;
  geometry_count integer;
  layer_count integer;
  dataset_count integer;
  visible_reference jsonb;
BEGIN
  SELECT count(*) INTO object_count FROM gowm_spatial_v1.current_object;
  SELECT reference_key INTO STRICT visible_reference
  FROM gowm_spatial_v1.current_object LIMIT 1;
  SELECT count(*) INTO geometry_count FROM gowm_spatial_v1.current_geometry;
  SELECT count(*) INTO layer_count FROM gowm_spatial_v1.layer_feature;
  SELECT count(*) INTO dataset_count FROM gowm_spatial_v1.dataset_descriptor;

  IF object_count <> 1 OR geometry_count <> 1 OR layer_count <> 1 OR dataset_count <> 1 THEN
    RAISE EXCEPTION 'scope A contract counts unexpected: object %, geometry %, layer %, dataset %',
      object_count, geometry_count, layer_count, dataset_count;
  END IF;
  IF visible_reference->>'namespace' <> 'gowm' OR
     visible_reference->>'kind' <> 'WORLD_OBJECT' OR
     visible_reference->>'id' !~ '^wrf_[0-9a-f]{32}$' OR
     visible_reference->>'id' IN ('spatial-contract-object-a', 'spatial-contract-object-b') OR
     length(visible_reference->>'version') = 0 THEN
    RAISE EXCEPTION 'public reference is not opaque: %', visible_reference;
  END IF;
  IF EXISTS (
    SELECT 1 FROM gowm_spatial_v1.current_object
    WHERE properties->>'label' = 'B'
  ) THEN
    RAISE EXCEPTION 'cross-scope object leaked into scope A';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gowm_spatial_v1.layer_feature
    WHERE ST_SRID(geometry_wgs84) <> 4326
  ) THEN
    RAISE EXCEPTION 'layer_feature is not normalized to EPSG:4326';
  END IF;

  BEGIN
    PERFORM count(*) FROM public.world_object;
    RAISE EXCEPTION 'spatial_provider directly selected Foundation base data';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM gowm_spatial_v1.set_data_scope('spatial-contract-scope-missing');
    RAISE EXCEPTION 'unknown data scope was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_scope_a$;

SELECT gowm_spatial_v1.set_data_scope('spatial-contract-scope-b');

DO $assert_scope_b$
BEGIN
  IF (SELECT count(*) FROM gowm_spatial_v1.current_object) <> 1 OR
     NOT EXISTS (
       SELECT 1 FROM gowm_spatial_v1.current_object
       WHERE properties->>'label' = 'B'
     ) OR
     EXISTS (
       SELECT 1 FROM gowm_spatial_v1.current_object
       WHERE properties->>'label' = 'A'
     ) THEN
    RAISE EXCEPTION 'scope switch did not isolate scope B';
  END IF;
  IF EXISTS (SELECT 1 FROM gowm_spatial_v1.layer_feature) THEN
    RAISE EXCEPTION 'scope A layer leaked into scope B';
  END IF;
END
$assert_scope_b$;

RESET ROLE;

DO $assert_reference_immutability$
DECLARE
  target_reference text;
BEGIN
  SELECT reference_key INTO STRICT target_reference
  FROM world_reference_identity
  WHERE entity_kind = 'WORLD_OBJECT' AND internal_id = 'spatial-contract-object-a';

  BEGIN
    UPDATE world_reference_identity
    SET internal_id = 'spatial-contract-object-rewritten'
    WHERE reference_key = target_reference;
    RAISE EXCEPTION 'world reference mutation was accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END
$assert_reference_immutability$;

ROLLBACK;

SELECT 'GOWM spatial v1 read-contract assertions PASS' AS result;
