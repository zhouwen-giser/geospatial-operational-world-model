\set ON_ERROR_STOP on

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'gowm_capability' AND table_name = 'world_query_job'
      AND column_name = 'query_snapshot_manifest' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'durable query snapshot manifest is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'gowm_capability' AND table_name = 'world_query_job'
      AND column_name = 'principal_context' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'durable effective principal context is missing';
  END IF;
  IF has_column_privilege('gowm_gateway_runtime', 'gowm_capability.world_query_job', 'query_snapshot_manifest', 'UPDATE')
     OR has_column_privilege('gowm_gateway_runtime', 'gowm_capability.world_query_job', 'principal_context', 'UPDATE') THEN
    RAISE EXCEPTION 'immutable query authority context is mutable by gateway runtime';
  END IF;
END
$assert$;
