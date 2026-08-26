BEGIN;

CREATE TABLE platform_data_snapshot (
  snapshot_id text NOT NULL,
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  dataset_scope_key text NOT NULL CHECK (length(dataset_scope_key) BETWEEN 1 AND 128),
  consistency text NOT NULL CHECK (consistency IN ('PINNED','CONSISTENT_AT_START','BEST_EFFORT')),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_scope_key,dataset_scope_key,snapshot_id),
  CHECK (manifest->>'schemaVersion'='1.0'),
  CHECK (manifest->>'snapshotId'=snapshot_id),
  CHECK (manifest->>'consistency'=consistency),
  CHECK (manifest->>'snapshotHash'=snapshot_hash),
  CHECK (jsonb_typeof(manifest->'resources')='array'),
  CHECK (jsonb_array_length(manifest->'resources') BETWEEN 1 AND 512)
);

CREATE INDEX platform_data_snapshot_scope_created_idx
  ON platform_data_snapshot(data_scope_key,dataset_scope_key,captured_at DESC,snapshot_id);

CREATE FUNCTION reject_platform_data_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'platform data snapshots are immutable' USING ERRCODE='55000';
END
$fn$;

CREATE TRIGGER platform_data_snapshot_immutable
  BEFORE UPDATE OR DELETE ON platform_data_snapshot
  FOR EACH ROW EXECUTE FUNCTION reject_platform_data_snapshot_mutation();

CREATE FUNCTION register_platform_data_snapshot(
  p_data_scope_key text,
  p_dataset_scope_key text,
  p_manifest jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public
AS $fn$
DECLARE registered_id text;
BEGIN
  IF p_data_scope_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.data_scope WHERE scope_key=p_data_scope_key)
     OR p_dataset_scope_key IS NULL OR length(p_dataset_scope_key) NOT BETWEEN 1 AND 128
     OR jsonb_typeof(p_manifest)<>'object'
     OR p_manifest->>'schemaVersion'<>'1.0'
     OR p_manifest->>'snapshotId' IS NULL
     OR p_manifest->>'snapshotHash' !~ '^sha256:[0-9a-f]{64}$'
     OR p_manifest->>'consistency' NOT IN ('PINNED','CONSISTENT_AT_START','BEST_EFFORT')
     OR jsonb_typeof(p_manifest->'resources')<>'array'
     OR jsonb_array_length(p_manifest->'resources') NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'invalid platform data snapshot' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.platform_data_snapshot(
    snapshot_id,data_scope_key,dataset_scope_key,consistency,manifest,snapshot_hash,
    captured_at
  ) VALUES (
    p_manifest->>'snapshotId',p_data_scope_key,p_dataset_scope_key,p_manifest->>'consistency',
    p_manifest,p_manifest->>'snapshotHash',COALESCE((p_manifest->>'capturedAt')::timestamptz,clock_timestamp())
  )
  ON CONFLICT (data_scope_key,dataset_scope_key,snapshot_id) DO NOTHING
  RETURNING snapshot_id INTO registered_id;
  IF registered_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.platform_data_snapshot stored
    WHERE stored.data_scope_key=p_data_scope_key AND stored.dataset_scope_key=p_dataset_scope_key
      AND stored.snapshot_id=p_manifest->>'snapshotId' AND stored.manifest=p_manifest
  ) THEN
    RAISE EXCEPTION 'snapshot identity collision' USING ERRCODE='23505';
  END IF;
  RETURN p_manifest->>'snapshotId';
END
$fn$;

CREATE SCHEMA gowm_platform_validation_v1;

CREATE FUNCTION gowm_platform_validation_v1.current_data_scope_key()
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('gowm.data_scope_key',true),'') $$;

CREATE FUNCTION gowm_platform_validation_v1.current_dataset_scope_key()
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('gowm.dataset_scope_key',true),'') $$;

CREATE FUNCTION gowm_platform_validation_v1.set_scope(p_data_scope_key text,p_dataset_scope_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF p_data_scope_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.data_scope WHERE scope_key=p_data_scope_key)
     OR p_dataset_scope_key IS NULL OR length(p_dataset_scope_key) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'platform validation scope is unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('gowm.data_scope_key',p_data_scope_key,true);
  PERFORM set_config('gowm.dataset_scope_key',p_dataset_scope_key,true);
END
$fn$;

CREATE VIEW gowm_platform_validation_v1.snapshot WITH (security_barrier=true) AS
SELECT snapshot_id,consistency,manifest,snapshot_hash,captured_at
FROM public.platform_data_snapshot
WHERE data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
  AND dataset_scope_key=gowm_platform_validation_v1.current_dataset_scope_key();

CREATE VIEW gowm_catalog_v1.active_capability WITH (security_barrier=true) AS
SELECT DISTINCT capability.operation_id,capability.data_binding
FROM gowm_capability.capability capability
JOIN gowm_capability.provider_operation operation
  ON operation.operation_id=capability.operation_id AND operation.enabled
JOIN gowm_capability.provider_registry provider
  ON provider.provider_id=operation.provider_id
WHERE capability.retired_at IS NULL
  AND provider.enabled
  AND provider.approval_state='APPROVED';

CREATE FUNCTION gowm_catalog_v1.dataset_spatial_extent(p_reference_key text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,gowm_catalog_v1 AS $fn$
  SELECT public.ST_AsGeoJSON(public.ST_Envelope(public.ST_Collect(public.ST_GeomFromGeoJSON(feature.geometry::text))))::jsonb
  FROM gowm_catalog_v1.layer layer
  JOIN gowm_catalog_v1.feature feature ON feature.layer_reference_key=layer.reference_key
  WHERE layer.dataset_reference_key=p_reference_key AND feature.geometry IS NOT NULL
$fn$;

CREATE FUNCTION gowm_catalog_v1.dataset_intersects(p_reference_key text,p_area jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,gowm_catalog_v1 AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM gowm_catalog_v1.layer layer
    JOIN gowm_catalog_v1.feature feature ON feature.layer_reference_key=layer.reference_key
    WHERE layer.dataset_reference_key=p_reference_key AND feature.geometry IS NOT NULL
      AND public.ST_Intersects(public.ST_GeomFromGeoJSON(feature.geometry::text),public.ST_GeomFromGeoJSON(p_area::text))
  )
$fn$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='platform_validation_provider') THEN
    CREATE ROLE platform_validation_provider NOLOGIN INHERIT;
  END IF;
END
$roles$;

REVOKE ALL ON TABLE platform_data_snapshot FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_platform_data_snapshot_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION register_platform_data_snapshot(text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON SCHEMA gowm_platform_validation_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_platform_validation_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_platform_validation_v1 FROM PUBLIC;
REVOKE ALL ON gowm_catalog_v1.active_capability FROM PUBLIC;
REVOKE ALL ON FUNCTION gowm_catalog_v1.dataset_spatial_extent(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION gowm_catalog_v1.dataset_intersects(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_platform_data_snapshot(text,text,jsonb) TO gowm_gateway_runtime;
GRANT USAGE ON SCHEMA gowm_platform_validation_v1 TO platform_validation_provider;
GRANT SELECT ON gowm_platform_validation_v1.snapshot TO platform_validation_provider;
GRANT EXECUTE ON FUNCTION gowm_platform_validation_v1.current_data_scope_key() TO platform_validation_provider;
GRANT EXECUTE ON FUNCTION gowm_platform_validation_v1.current_dataset_scope_key() TO platform_validation_provider;
GRANT EXECUTE ON FUNCTION gowm_platform_validation_v1.set_scope(text,text) TO platform_validation_provider;
GRANT SELECT ON gowm_catalog_v1.active_capability TO gowm_catalog_reader;
GRANT EXECUTE ON FUNCTION gowm_catalog_v1.dataset_spatial_extent(text) TO gowm_catalog_reader;
GRANT EXECUTE ON FUNCTION gowm_catalog_v1.dataset_intersects(text,jsonb) TO gowm_catalog_reader;
GRANT gowm_reference_reader,gowm_result_reader,gowm_catalog_reader,network_provider TO platform_validation_provider;
ALTER ROLE platform_validation_provider SET default_transaction_read_only=on;
ALTER ROLE platform_validation_provider SET statement_timeout='5s';

COMMIT;
