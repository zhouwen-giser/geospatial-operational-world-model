\set ON_ERROR_STOP on

BEGIN;

DO $assert_foundation_receipt_catalog$
DECLARE
  provider_fk_count integer;
BEGIN
  IF to_regclass('public.foundation_processing_receipt') IS NULL THEN
    RAISE EXCEPTION 'foundation processing receipt table is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.oid = 'public.foundation_processing_receipt'::regclass
      AND t.tgname = 'foundation_processing_receipt_immutable'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'foundation processing receipt append-only guard is missing';
  END IF;

  SELECT count(*) INTO provider_fk_count
  FROM pg_constraint fk
  WHERE fk.contype = 'f'
    AND fk.conrelid = 'public.foundation_processing_receipt'::regclass
    AND fk.confrelid IN (
      'gowm_capability.provider_registry'::regclass,
      'gowm_capability.provider_operation'::regclass
    );
  IF provider_fk_count <> 0 THEN
    RAISE EXCEPTION 'Foundation processing receipt depends on Gateway provider registry';
  END IF;

  IF NOT has_table_privilege('gowm_ingestion_writer', 'public.foundation_processing_receipt', 'INSERT') OR
     NOT has_table_privilege('gowm_projector', 'public.foundation_processing_receipt', 'INSERT') OR
     has_table_privilege('gowm_ingestion_writer', 'public.foundation_processing_receipt', 'UPDATE') OR
     has_table_privilege('gowm_projector', 'public.foundation_processing_receipt', 'DELETE') THEN
    RAISE EXCEPTION 'Foundation receipt role grants are incorrect';
  END IF;
END
$assert_foundation_receipt_catalog$;

SET LOCAL ROLE gowm_ingestion_writer;

INSERT INTO foundation_processing_receipt(
  receipt_id, processing_stage, operation_id, operation_version, provider_version, adapter_kind,
  engine_name, engine_version, method_id, method_version, policy_version,
  input_schema_hash, output_schema_hash, compute_snapshot_hash,
  input_hash, output_hash, status, duration_ms, compute_snapshot, details, generated_at
)
VALUES (
  'foundation:geometry-validation:test',
  'GEOMETRY_VALIDATION', 'gowm.foundation.geometry.validate', '1.0', '0.2.0', 'LOCAL_ADAPTER',
  'gowm-geometry-local', '1.0.0', 'validate', '1.0.0', 'foundation-local-v1',
  'sha256:' || repeat('1', 64), 'sha256:' || repeat('2', 64),
  'sha256:' || repeat('3', 64), 'sha256:' || repeat('4', 64),
  'sha256:' || repeat('5', 64), 'SUCCEEDED', 1,
  jsonb_build_object(
    'provider', jsonb_build_object('providerId', 'gowm.foundation-local', 'providerVersion', '0.2.0'),
    'operation', jsonb_build_object('operationId', 'gowm.foundation.geometry.validate', 'operationVersion', '1.0'),
    'engine', jsonb_build_object('name', 'gowm-geometry-local', 'version', '1.0.0'),
    'policy', jsonb_build_object('version', 'foundation-local-v1', 'digest', 'sha256:' || repeat('6', 64)),
    'schemas', jsonb_build_object(
      'inputSchemaHash', 'sha256:' || repeat('1', 64),
      'outputSchemaHash', 'sha256:' || repeat('2', 64)
    )
  ),
  '{"criticalPath":"FOUNDATION_LOCAL"}'::jsonb, clock_timestamp()
);

DO $assert_writer_boundary$
BEGIN
  IF (SELECT count(*) FROM foundation_processing_receipt
      WHERE operation_id = 'gowm.foundation.geometry.validate') <> 1 THEN
    RAISE EXCEPTION 'ingestion writer could not persist or read Foundation receipt';
  END IF;

  BEGIN
    UPDATE foundation_processing_receipt
    SET status = 'FAILED'
    WHERE operation_id = 'gowm.foundation.geometry.validate';
    RAISE EXCEPTION 'ingestion writer unexpectedly updated a Foundation receipt';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_writer_boundary$;

RESET ROLE;

DO $assert_foundation_receipt_guards$
DECLARE
  target_receipt text;
BEGIN
  SELECT receipt_id INTO STRICT target_receipt
  FROM foundation_processing_receipt
  WHERE operation_id = 'gowm.foundation.geometry.validate';

  BEGIN
    UPDATE foundation_processing_receipt
    SET status = 'FAILED'
    WHERE receipt_id = target_receipt;
    RAISE EXCEPTION 'Foundation receipt append-only trigger accepted update';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    INSERT INTO foundation_processing_receipt(
      receipt_id, processing_stage, operation_id, operation_version, provider_version, adapter_kind,
      engine_name, engine_version, method_id, method_version, policy_version,
      input_schema_hash, output_schema_hash, compute_snapshot_hash,
      input_hash, output_hash, status, duration_ms, compute_snapshot, generated_at
    ) VALUES (
      'foundation:h3-index:test',
      'H3_INDEXING', 'gowm.foundation.h3.index', '1.0', '0.2.0', 'EMBEDDED_SDK',
      'h3', '4.5.0', 'index-points', '1.0.0', 'foundation-local-v1',
      'sha256:' || repeat('7', 64), 'sha256:' || repeat('8', 64),
      'sha256:' || repeat('9', 64), 'sha256:' || repeat('a', 64),
      'sha256:' || repeat('b', 64), 'SUCCEEDED', 0,
      '{}'::jsonb, clock_timestamp()
    );
    RAISE EXCEPTION 'empty compute snapshot was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$assert_foundation_receipt_guards$;

ROLLBACK;

SELECT 'GOWM Foundation processing receipt assertions PASS' AS result;
