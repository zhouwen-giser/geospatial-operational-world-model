\set ON_ERROR_STOP on
BEGIN;

DO $identity$
DECLARE
  global_hash_uniques integer;
BEGIN
  SELECT count(*)
    INTO global_hash_uniques
  FROM pg_constraint candidate
  WHERE candidate.contype = 'u'
    AND (
      (
        candidate.conrelid = 'coverage_planner.coverage_problem'::regclass
        AND ARRAY(
          SELECT attribute.attname::text
          FROM unnest(candidate.conkey) WITH ORDINALITY AS key_column(attnum, ordinal)
          JOIN pg_attribute attribute
            ON attribute.attrelid = candidate.conrelid
           AND attribute.attnum = key_column.attnum
          ORDER BY key_column.ordinal
        ) = ARRAY['data_scope_key', 'dataset_scope_key', 'problem_hash']::text[]
      )
      OR
      (
        candidate.conrelid = 'coverage_planner.coverage_verification_report'::regclass
        AND ARRAY(
          SELECT attribute.attname::text
          FROM unnest(candidate.conkey) WITH ORDINALITY AS key_column(attnum, ordinal)
          JOIN pg_attribute attribute
            ON attribute.attrelid = candidate.conrelid
           AND attribute.attnum = key_column.attnum
          ORDER BY key_column.ordinal
        ) = ARRAY['data_scope_key', 'dataset_scope_key', 'report_hash']::text[]
      )
    );
  IF global_hash_uniques <> 0 THEN
    RAISE EXCEPTION 'request-owned Coverage hashes remain globally unique';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'coverage_planner'
      AND tablename = 'coverage_problem'
      AND indexname = 'coverage_problem_scope_hash_idx'
      AND indexdef NOT LIKE 'CREATE UNIQUE INDEX%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'coverage_planner'
      AND tablename = 'coverage_verification_report'
      AND indexname = 'coverage_verification_report_scope_hash_idx'
      AND indexdef NOT LIKE 'CREATE UNIQUE INDEX%'
  ) THEN
    RAISE EXCEPTION 'request-owned Coverage hash lookup indexes are missing or unique';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint candidate
    WHERE candidate.conrelid = 'coverage_planner.coverage_problem'::regclass
      AND candidate.contype = 'u'
      AND ARRAY(
        SELECT attribute.attname::text
        FROM unnest(candidate.conkey) WITH ORDINALITY AS key_column(attnum, ordinal)
        JOIN pg_attribute attribute
          ON attribute.attrelid = candidate.conrelid
         AND attribute.attnum = key_column.attnum
        ORDER BY key_column.ordinal
      ) = ARRAY['coverage_request_id']::text[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint candidate
    WHERE candidate.conrelid = 'coverage_planner.coverage_verification_report'::regclass
      AND candidate.contype = 'u'
      AND ARRAY(
        SELECT attribute.attname::text
        FROM unnest(candidate.conkey) WITH ORDINALITY AS key_column(attnum, ordinal)
        JOIN pg_attribute attribute
          ON attribute.attrelid = candidate.conrelid
         AND attribute.attnum = key_column.attnum
        ORDER BY key_column.ordinal
      ) = ARRAY['coverage_candidate_id']::text[]
  ) THEN
    RAISE EXCEPTION 'request/candidate ownership uniqueness was weakened';
  END IF;
END
$identity$;

ROLLBACK;
SELECT 'COVERAGE_REQUEST_OWNED_HASH_IDENTITY_ASSERTIONS_PASS' AS result;
