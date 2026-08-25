BEGIN;

DO $constraints$
DECLARE
  constraint_name name;
BEGIN
  SELECT candidate.conname
    INTO STRICT constraint_name
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
    ) = ARRAY['data_scope_key', 'dataset_scope_key', 'problem_hash']::text[];
  EXECUTE format(
    'ALTER TABLE coverage_planner.coverage_problem DROP CONSTRAINT %I',
    constraint_name
  );

  SELECT candidate.conname
    INTO STRICT constraint_name
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
    ) = ARRAY['data_scope_key', 'dataset_scope_key', 'report_hash']::text[];
  EXECUTE format(
    'ALTER TABLE coverage_planner.coverage_verification_report DROP CONSTRAINT %I',
    constraint_name
  );
END
$constraints$;

CREATE INDEX coverage_verification_report_scope_hash_idx
  ON coverage_planner.coverage_verification_report(data_scope_key, dataset_scope_key, report_hash);

COMMIT;
