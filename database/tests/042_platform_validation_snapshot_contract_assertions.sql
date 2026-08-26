DO $assert$
DECLARE public_privileges integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='platform_validation_provider') THEN
    RAISE EXCEPTION 'platform validation provider role is missing';
  END IF;
  IF NOT has_schema_privilege('platform_validation_provider','gowm_platform_validation_v1','USAGE')
     OR NOT has_table_privilege('platform_validation_provider','gowm_platform_validation_v1.snapshot','SELECT')
     OR has_table_privilege('platform_validation_provider','public.platform_data_snapshot','SELECT')
     OR has_table_privilege('platform_validation_provider','public.platform_data_snapshot','INSERT')
     OR has_table_privilege('platform_validation_provider','public.platform_data_snapshot','UPDATE')
     OR has_table_privilege('platform_validation_provider','public.platform_data_snapshot','DELETE') THEN
    RAISE EXCEPTION 'platform snapshot read-contract privilege invariant failed';
  END IF;
  SELECT count(*) INTO public_privileges
  FROM information_schema.role_table_grants
  WHERE grantee='PUBLIC' AND table_schema='gowm_platform_validation_v1';
  IF public_privileges<>0 THEN RAISE EXCEPTION 'platform validation contract leaked to PUBLIC'; END IF;
  IF NOT has_table_privilege('gowm_catalog_reader','gowm_catalog_v1.active_capability','SELECT')
     OR EXISTS (SELECT 1 FROM information_schema.role_table_grants
                WHERE grantee='PUBLIC' AND table_schema='gowm_catalog_v1' AND table_name='active_capability') THEN
    RAISE EXCEPTION 'data product capability projection privilege invariant failed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gowm_catalog_v1.active_capability projected
    WHERE NOT EXISTS (
      SELECT 1 FROM gowm_capability.capability capability
      JOIN gowm_capability.provider_operation operation USING(operation_id)
      JOIN gowm_capability.provider_registry provider USING(provider_id)
      WHERE capability.operation_id=projected.operation_id
        AND capability.data_binding=projected.data_binding
        AND capability.retired_at IS NULL AND operation.enabled
        AND provider.enabled AND provider.approval_state='APPROVED'
    )
  ) THEN RAISE EXCEPTION 'active capability projection does not reflect the registry'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='platform_data_snapshot_immutable' AND tgenabled='O'
  ) THEN RAISE EXCEPTION 'platform data snapshot immutability trigger is missing'; END IF;
END
$assert$;
