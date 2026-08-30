\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.data_scope(scope_key, operational_domain, description) VALUES
  ('analysis-input-a', 'TEST', 'Analysis input assertion scope A'),
  ('analysis-input-b', 'TEST', 'Analysis input assertion scope B');

INSERT INTO public.analysis_record(
  analysis_id,
  data_scope_key,
  service_name,
  tool_name,
  tool_version,
  algorithm,
  algorithm_version,
  status,
  analysis_as_of,
  query_payload,
  result_payload,
  method_snapshot,
  snapshot_hash
) VALUES
  (
    '70000000-0000-0000-0000-000000000001',
    'analysis-input-a',
    'analysis-input-assertion',
    'input-register',
    '1.0',
    'assertion',
    '1.0',
    'COMPLETE',
    '2026-01-01T00:00:00Z',
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ),
  (
    '70000000-0000-0000-0000-000000000002',
    'analysis-input-b',
    'analysis-input-assertion',
    'input-register',
    '1.0',
    'assertion',
    '1.0',
    'COMPLETE',
    '2026-01-01T00:00:00Z',
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  );

INSERT INTO public.world_reference_identity(
  reference_key,
  entity_kind,
  internal_id,
  data_scope_key
) VALUES
  ('wrf_70000000000000000000000000000001', 'WORLD_OBJECT', 'analysis-input-object-a', 'analysis-input-a'),
  ('wrf_70000000000000000000000000000002', 'WORLD_OBJECT', 'analysis-input-object-b', 'analysis-input-b');

INSERT INTO public.world_reference_descriptor_version(
  reference_key,
  data_scope_key,
  reference_type,
  display_name,
  object_version,
  provenance,
  content_hash
) VALUES
  (
    'wrf_70000000000000000000000000000001',
    'analysis-input-a',
    'WORLD_OBJECT',
    'Analysis input object A',
    'v1',
    '[]'::jsonb,
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  ),
  (
    'wrf_70000000000000000000000000000002',
    'analysis-input-b',
    'WORLD_OBJECT',
    'Analysis input object B',
    'v1',
    '[]'::jsonb,
    'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
  );

SET LOCAL ROLE gowm_analysis_writer;

DO $controlled_writes$
BEGIN
  IF NOT public.register_analysis_resource_input(
    '70000000-0000-0000-0000-000000000001',
    1,
    'SUBJECT',
    'gowm',
    'WORLD_OBJECT',
    'wrf_70000000000000000000000000000001',
    'v1',
    'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    42,
    'PINNED',
    'analysis-input-assertion',
    'wrf_70000000000000000000000000000001',
    NULL
  ) THEN
    RAISE EXCEPTION 'first analysis resource registration was not inserted';
  END IF;

  IF public.register_analysis_resource_input(
    '70000000-0000-0000-0000-000000000001',
    1,
    'SUBJECT',
    'gowm',
    'WORLD_OBJECT',
    'wrf_70000000000000000000000000000001',
    'v1',
    'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    42,
    'PINNED',
    'analysis-input-assertion',
    'wrf_70000000000000000000000000000001',
    NULL
  ) THEN
    RAISE EXCEPTION 'identical analysis resource registration was not idempotent';
  END IF;

  BEGIN
    PERFORM public.register_analysis_resource_input(
      '70000000-0000-0000-0000-000000000001',
      1,
      'SUBJECT',
      'gowm',
      'WORLD_OBJECT',
      'wrf_70000000000000000000000000000001',
      'v1',
      'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      42,
      'PINNED',
      'analysis-input-assertion',
      'wrf_70000000000000000000000000000001',
      NULL
    );
    RAISE EXCEPTION 'analysis resource idempotency conflict was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    PERFORM public.register_analysis_resource_input(
      '70000000-0000-0000-0000-000000000001',
      2,
      'CROSS_SCOPE',
      'gowm',
      'WORLD_OBJECT',
      'wrf_70000000000000000000000000000002',
      'v1',
      NULL,
      NULL,
      'PINNED',
      'analysis-input-assertion',
      'wrf_70000000000000000000000000000002',
      NULL
    );
    RAISE EXCEPTION 'cross-scope world reference was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.register_analysis_resource_input(
      '70000000-0000-0000-0000-000000000001',
      3,
      'CROSS_SCOPE_ANALYSIS',
      'gowm',
      'WORLD_OBJECT',
      'wrf_70000000000000000000000000000001',
      'v1',
      NULL,
      NULL,
      'PINNED',
      'analysis-input-assertion',
      'wrf_70000000000000000000000000000001',
      '70000000-0000-0000-0000-000000000002'
    );
    RAISE EXCEPTION 'cross-scope source analysis was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.register_analysis_resource_input(
      '70000000-0000-0000-0000-000000000001',
      4,
      'VERSION_CONFLICT',
      'gowm',
      'WORLD_OBJECT',
      'wrf_70000000000000000000000000000001',
      'v2',
      NULL,
      NULL,
      'PINNED',
      'analysis-input-assertion',
      'wrf_70000000000000000000000000000001',
      NULL
    );
    RAISE EXCEPTION 'world reference descriptor version conflict was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF NOT public.register_analysis_input_set(
    '70000000-0000-0000-0000-000000000001',
    'HISTORY_INPUT_SET',
    10000,
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'artifact:analysis-input-a',
    'analysis-input-assertion'
  ) THEN
    RAISE EXCEPTION 'first analysis input set registration was not inserted';
  END IF;

  IF public.register_analysis_input_set(
    '70000000-0000-0000-0000-000000000001',
    'HISTORY_INPUT_SET',
    10000,
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    'artifact:analysis-input-a',
    'analysis-input-assertion'
  ) THEN
    RAISE EXCEPTION 'identical analysis input set registration was not idempotent';
  END IF;

  BEGIN
    PERFORM public.register_analysis_input_set(
      '70000000-0000-0000-0000-000000000001',
      'HISTORY_INPUT_SET',
      10001,
      'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      'artifact:analysis-input-a',
      'analysis-input-assertion'
    );
    RAISE EXCEPTION 'analysis input set idempotency conflict was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.analysis_input_set(
      analysis_id,
      input_set_kind,
      item_count,
      item_set_digest,
      authority
    ) VALUES (
      '70000000-0000-0000-0000-000000000001',
      'DIRECT_INSERT',
      0,
      'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      'analysis-input-assertion'
    );
    RAISE EXCEPTION 'analysis writer received direct base-table insert privilege';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$controlled_writes$;

RESET ROLE;

DO $append_only$
BEGIN
  BEGIN
    UPDATE public.analysis_resource_input
    SET authority = 'mutated'
    WHERE analysis_id = '70000000-0000-0000-0000-000000000001'
      AND input_no = 1;
    RAISE EXCEPTION 'analysis resource input was mutable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;

  BEGIN
    DELETE FROM public.analysis_input_set
    WHERE analysis_id = '70000000-0000-0000-0000-000000000001'
      AND input_set_kind = 'HISTORY_INPUT_SET';
    RAISE EXCEPTION 'analysis input set was deletable';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
END
$append_only$;

SELECT set_config('gowm.data_scope_key', '', true);
SET LOCAL ROLE gowm_analysis_reader;

DO $scope_before_read$
BEGIN
  IF EXISTS (SELECT 1 FROM gowm_analysis_v1.analysis_resource_input)
     OR EXISTS (SELECT 1 FROM gowm_analysis_v1.analysis_input_set) THEN
    RAISE EXCEPTION 'analysis input rows were visible before scope selection';
  END IF;
END
$scope_before_read$;

SELECT gowm_analysis_v1.set_data_scope('analysis-input-a');

DO $scoped_read$
BEGIN
  IF (SELECT count(*) FROM gowm_analysis_v1.analysis_resource_input) <> 1
     OR (SELECT count(*) FROM gowm_analysis_v1.analysis_input_set) <> 1 THEN
    RAISE EXCEPTION 'scope-selected analysis input views are incomplete';
  END IF;

  BEGIN
    PERFORM count(*) FROM public.analysis_resource_input;
    RAISE EXCEPTION 'analysis reader accessed the resource input base table';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$scoped_read$;

SELECT gowm_analysis_v1.set_data_scope('analysis-input-b');

DO $cross_scope_read$
BEGIN
  IF EXISTS (SELECT 1 FROM gowm_analysis_v1.analysis_resource_input)
     OR EXISTS (SELECT 1 FROM gowm_analysis_v1.analysis_input_set) THEN
    RAISE EXCEPTION 'analysis input view leaked rows across data scopes';
  END IF;
END
$cross_scope_read$;

RESET ROLE;

ROLLBACK;
SELECT 'ANALYSIS_RESOURCE_INPUT_ASSERTIONS_PASS' AS result;
