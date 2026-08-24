\set ON_ERROR_STOP on

DO $assert$
BEGIN
  IF NOT pg_has_role('gowm_gateway_service', 'gowm_gateway_runtime', 'MEMBER') THEN
    RAISE EXCEPTION 'gateway service must inherit runtime privileges';
  END IF;
  IF pg_has_role('gowm_gateway_service', 'gowm_gateway_registry_admin', 'MEMBER') THEN
    RAISE EXCEPTION 'long-lived gateway service must not inherit registry admin';
  END IF;
  IF NOT pg_has_role('gowm_gateway_registry_service', 'gowm_gateway_registry_admin', 'MEMBER') THEN
    RAISE EXCEPTION 'registry bootstrap service must inherit registry admin';
  END IF;
  IF has_table_privilege('gowm_gateway_registry_service', 'gowm_capability.execution_receipt', 'INSERT') THEN
    RAISE EXCEPTION 'registry bootstrap service must not write runtime receipts';
  END IF;
  IF NOT has_function_privilege(
       'gowm_gateway_service',
       'gowm_capability.claim_world_query_job(text, integer)',
       'EXECUTE'
     ) OR has_function_privilege(
       'gowm_situation_service',
       'gowm_capability.claim_world_query_job(text, integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'world-query claim function must be executable only through the gateway runtime role';
  END IF;
  IF NOT has_table_privilege('gowm_spatial_service', 'gowm_spatial_v1.current_object', 'SELECT') OR
     has_table_privilege('gowm_spatial_service', 'public.world_object', 'INSERT') THEN
    RAISE EXCEPTION 'spatial service privilege boundary is invalid';
  END IF;
  IF NOT has_table_privilege('gowm_situation_service', 'public.situation_cell_scored', 'SELECT') OR
     NOT has_table_privilege('gowm_situation_service', 'public.world_reference_identity', 'SELECT') OR
     has_table_privilege('gowm_situation_service', 'public.world_object', 'INSERT') THEN
    RAISE EXCEPTION 'situation service privilege boundary is invalid';
  END IF;
END
$assert$;

SELECT 'CAPABILITY_RUNTIME_PRINCIPAL_ASSERTIONS_PASS' AS result;
