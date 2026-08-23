\set ON_ERROR_STOP on

DO $assert$
DECLARE
  missing_tables text[];
BEGIN
  SELECT array_agg(name ORDER BY name)
  INTO missing_tables
  FROM unnest(ARRAY[
    'world_query_job',
    'world_query_node_execution',
    'world_query_node_transition'
  ]) AS expected(name)
  WHERE to_regclass('gowm_capability.' || name) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'missing world query persistence tables: %', missing_tables;
  END IF;

  IF to_regprocedure('gowm_capability.claim_world_query_job(text,integer)') IS NULL THEN
    RAISE EXCEPTION 'missing atomic world query claim function';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'gowm_capability'
      AND table_name = 'world_query_node_execution'
      AND column_name = 'input_hash'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'gowm_capability'
      AND table_name = 'world_query_node_execution'
      AND column_name = 'output_hash'
  ) THEN
    RAISE EXCEPTION 'node input/output hash persistence is missing';
  END IF;

  IF has_table_privilege('gowm_gateway_runtime', 'gowm_capability.world_query_job', 'DELETE')
     OR has_table_privilege('gowm_gateway_runtime', 'gowm_capability.world_query_job', 'UPDATE')
     OR has_column_privilege('gowm_gateway_runtime', 'gowm_capability.world_query_job', 'submission', 'UPDATE')
     OR has_table_privilege('gowm_gateway_runtime', 'gowm_capability.world_query_node_execution', 'UPDATE')
     OR has_column_privilege('gowm_gateway_runtime', 'gowm_capability.world_query_node_execution', 'node_id', 'UPDATE')
     OR has_table_privilege('gowm_gateway_runtime', 'gowm_capability.world_query_node_transition', 'UPDATE') THEN
    RAISE EXCEPTION 'gateway runtime has forbidden mutation privilege';
  END IF;
END
$assert$;
