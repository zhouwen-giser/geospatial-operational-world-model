\set ON_ERROR_STOP on

BEGIN;

INSERT INTO data_scope(scope_key, operational_domain, description) VALUES
  ('reference-search-test', 'TEST', 'Reference search projection test'),
  ('reference-search-other', 'TEST', 'Reference search other scope');

INSERT INTO world_reference_identity(reference_key, entity_kind, internal_id, data_scope_key)
SELECT 'wrf_' || lpad(to_hex(candidate), 32, '0'), 'DATASET',
       'reference-search-' || candidate, 'reference-search-test'
FROM generate_series(1, 120) candidate;

INSERT INTO world_reference_descriptor_version(
  reference_key, data_scope_key, reference_type, display_name, state_confidence,
  content_hash
)
SELECT identity.reference_key, identity.data_scope_key, 'ROAD',
       CASE WHEN row_number() OVER (ORDER BY identity.reference_key) <= 2
            THEN '中央路' ELSE 'Budget Road ' || row_number() OVER (ORDER BY identity.reference_key) END,
       0.5,
       'sha256:' || md5(identity.reference_key) || md5('descriptor:' || identity.reference_key)
FROM world_reference_identity identity
WHERE identity.data_scope_key='reference-search-test'
  AND identity.entity_kind='DATASET';

INSERT INTO world_reference_name(
  reference_key, data_scope_key, name_kind, language_tag, name_text,
  normalized_text, source_ref, confidence
)
SELECT descriptor.reference_key, descriptor.data_scope_key, 'CANONICAL_NAME', 'und',
       descriptor.display_name, normalize_reference_text(descriptor.display_name),
       'reference-search-assertion', 1
FROM world_reference_descriptor_version descriptor
WHERE descriptor.data_scope_key='reference-search-test';

DO $projection$
DECLARE
  first_count integer;
  second_count integer;
  ambiguous_count integer;
  budget_count integer;
  first_order text[];
  second_order text[];
BEGIN
  first_count := rebuild_reference_search_projection('reference-search-test');
  second_count := rebuild_reference_search_projection('reference-search-test');
  -- 120 Dataset reference/name rows plus the DataScope identity itself.
  IF first_count <> second_count OR first_count <> 241 THEN
    RAISE EXCEPTION 'search projection rebuild is not deterministic: %, %', first_count, second_count;
  END IF;

  PERFORM gowm_reference_v1.set_data_scope('reference-search-test');
  SELECT count(*) INTO ambiguous_count
  FROM gowm_reference_v1.resolve('中央路', ARRAY['DATASET'], 20, 0.3, 1000);
  IF ambiguous_count <> 2 THEN
    RAISE EXCEPTION 'same-scope ambiguous road did not retain both candidates: %', ambiguous_count;
  END IF;

  SELECT count(*) INTO budget_count
  FROM gowm_reference_v1.resolve('budget road', ARRAY['DATASET'], 100, 0, 25);
  IF budget_count > 25 THEN
    RAISE EXCEPTION 'candidate budget was exceeded: %', budget_count;
  END IF;

  SELECT array_agg(reference_key ORDER BY ordinal) INTO first_order
  FROM gowm_reference_v1.resolve('budget road', ARRAY['DATASET'], 100, 0, 25)
  WITH ORDINALITY AS resolved(reference_key, entity_kind, matched_by, match_score, state_confidence, descriptor_version, display_name, ordinal);
  SELECT array_agg(reference_key ORDER BY ordinal) INTO second_order
  FROM gowm_reference_v1.resolve('budget road', ARRAY['DATASET'], 100, 0, 25)
  WITH ORDINALITY AS resolved(reference_key, entity_kind, matched_by, match_score, state_confidence, descriptor_version, display_name, ordinal);
  IF first_order IS DISTINCT FROM second_order THEN
    RAISE EXCEPTION 'bounded search ordering is not stable';
  END IF;

  PERFORM gowm_reference_v1.set_data_scope('reference-search-other');
  IF EXISTS (
    SELECT 1 FROM gowm_reference_v1.resolve('中央路', ARRAY['DATASET'], 20, 0.3, 1000)
  ) THEN
    RAISE EXCEPTION 'search candidates leaked across DataScope';
  END IF;
END
$projection$;

ROLLBACK;

SELECT 'REFERENCE_SEARCH_PROJECTION_ASSERTIONS_PASS' AS result;
