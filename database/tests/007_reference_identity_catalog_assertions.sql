\set ON_ERROR_STOP on

BEGIN;

DO $structure$
BEGIN
  IF to_regnamespace('gowm_reference_v1') IS NULL OR
     to_regclass('public.world_reference_descriptor_version') IS NULL OR
     to_regclass('public.world_reference_name') IS NULL OR
     to_regclass('public.world_reference_external_identifier') IS NULL OR
     to_regclass('public.reference_search_projection') IS NULL OR
     to_regprocedure('gowm_reference_v1.resolve(text,text[],integer,double precision,integer)') IS NULL THEN
    RAISE EXCEPTION 'reference identity/catalog contract is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'reference_search_projection_trgm_idx'
      AND indexdef LIKE '%gin_trgm_ops%'
  ) THEN
    RAISE EXCEPTION 'bounded fuzzy search projection lacks its trigram index';
  END IF;

  IF has_table_privilege('gowm_reference_service', 'public.world_reference_identity', 'SELECT') OR
     has_table_privilege('gowm_reference_service', 'public.world_reference_name', 'SELECT') OR
     NOT has_table_privilege('gowm_reference_service', 'gowm_reference_v1.current_descriptor', 'SELECT') THEN
    RAISE EXCEPTION 'reference Provider privilege boundary is invalid';
  END IF;
END
$structure$;

INSERT INTO data_scope(scope_key, operational_domain, description) VALUES
  ('reference-test-a', 'TEST', 'Reference test A'),
  ('reference-test-b', 'TEST', 'Reference test B');

INSERT INTO world_reference_identity(reference_key, entity_kind, internal_id, data_scope_key) VALUES
  ('wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'DATASET', 'reference-test-dataset-a', 'reference-test-a'),
  ('wrf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'DATASET', 'reference-test-dataset-b', 'reference-test-b');

INSERT INTO world_reference_descriptor_version(
  reference_key, data_scope_key, reference_type, display_name, state_confidence,
  content_hash
) VALUES
  ('wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'reference-test-a', 'ROAD', '复兴路', 0.65,
   'sha256:' || repeat('a', 64)),
  ('wrf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'reference-test-b', 'ROAD', '复兴路', 0.95,
   'sha256:' || repeat('b', 64));

INSERT INTO world_reference_name(
  reference_key, data_scope_key, name_kind, language_tag, name_text,
  normalized_text, source_ref, confidence
) VALUES
  ('wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'reference-test-a', 'CANONICAL_NAME', 'zh-Hans', '复兴路', '复兴路', 'assertion', 1),
  ('wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'reference-test-a', 'ALIAS', 'zh-Hans', '复兴大道', '复兴大道', 'assertion', 0.9),
  ('wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'reference-test-a', 'PINYIN', 'zh-Latn-pinyin', 'fuxing lu', 'fuxing lu', 'assertion', 0.85),
  ('wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'reference-test-a', 'CODE', 'und', 'ROAD-A-7', 'road-a-7', 'assertion', 1),
  ('wrf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'reference-test-b', 'CANONICAL_NAME', 'zh-Hans', '复兴路', '复兴路', 'assertion', 1);

INSERT INTO world_reference_external_identifier(
  reference_key, data_scope_key, authority, identifier_kind, identifier_value,
  normalized_value, confidence
) VALUES (
  'wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'reference-test-a', 'ROAD_AUTHORITY',
  'ROAD_CODE', 'AUTH-ROAD-A', 'auth-road-a', 1
);

SELECT rebuild_reference_search_projection('reference-test-a');
SELECT rebuild_reference_search_projection('reference-test-b');
SELECT gowm_reference_v1.set_data_scope('reference-test-a');

DO $semantics$
DECLARE
  resolved_key text;
  matched text;
  score double precision;
  confidence double precision;
  candidate_count integer;
BEGIN
  SELECT reference_key, matched_by, match_score, state_confidence
  INTO STRICT resolved_key, matched, score, confidence
  FROM gowm_reference_v1.resolve('复兴路', ARRAY['DATASET'], 20, 0.3, 1000);
  IF resolved_key <> 'wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' OR
     matched <> 'CANONICAL_NAME' OR score <> 1 OR confidence <> 0.65 THEN
    RAISE EXCEPTION 'exact canonical resolution or score separation failed';
  END IF;

  SELECT reference_key, matched_by INTO STRICT resolved_key, matched
  FROM gowm_reference_v1.resolve('AUTH-ROAD-A', ARRAY['DATASET'], 20, 0.3, 1000);
  IF resolved_key <> 'wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' OR matched <> 'EXTERNAL_ID' THEN
    RAISE EXCEPTION 'external identifier resolution failed';
  END IF;

  SELECT reference_key, matched_by INTO STRICT resolved_key, matched
  FROM gowm_reference_v1.resolve('fuxing lu', ARRAY['DATASET'], 20, 0.3, 1000);
  IF resolved_key <> 'wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' OR matched <> 'PINYIN' THEN
    RAISE EXCEPTION 'pinyin resolution failed';
  END IF;

  SELECT count(*) INTO candidate_count
  FROM gowm_reference_v1.resolve('复兴路', ARRAY['DATASET'], 100, 0.1, 5000);
  IF candidate_count <> 1 THEN
    RAISE EXCEPTION 'scope filtering did not occur before ranking/counting';
  END IF;

  BEGIN
    UPDATE world_reference_identity SET internal_id = 'mutated'
    WHERE reference_key = 'wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    RAISE EXCEPTION 'immutable ReferenceKey identity was updated';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  BEGIN
    UPDATE world_reference_descriptor_version SET display_name = 'mutated'
    WHERE reference_key = 'wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    RAISE EXCEPTION 'append-only descriptor was updated';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$semantics$;

ROLLBACK;

SELECT 'REFERENCE_IDENTITY_CATALOG_ASSERTIONS_PASS' AS result;
