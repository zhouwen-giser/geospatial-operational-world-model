BEGIN;

-- Stable, opaque identities cross the Foundation/provider boundary. Internal
-- object keys remain private and can evolve without breaking capability APIs.
CREATE TABLE world_reference_identity (
  reference_key text PRIMARY KEY DEFAULT ('wrf_' || replace(gen_random_uuid()::text, '-', '')),
  entity_kind text NOT NULL,
  internal_id text NOT NULL,
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT world_reference_key_format CHECK (reference_key ~ '^wrf_[0-9a-f]{32}$'),
  CONSTRAINT world_reference_entity_kind CHECK (entity_kind IN ('WORLD_OBJECT','SPATIAL_OBJECT','DATA_SCOPE')),
  CONSTRAINT world_reference_internal_id_nonempty CHECK (length(internal_id) > 0),
  UNIQUE (entity_kind, internal_id)
);

CREATE INDEX world_reference_scope_kind_idx
  ON world_reference_identity(data_scope_key, entity_kind, reference_key);

-- Foundation-local processing receipts are deliberately independent from the
-- Gateway provider registry. Ingest and projection remain available when all
-- remote providers and the Gateway are offline.
CREATE TABLE foundation_processing_receipt (
  receipt_id text PRIMARY KEY DEFAULT ('foundation:' || gen_random_uuid()::text),
  processing_stage text NOT NULL,
  operation_id text NOT NULL,
  operation_version text NOT NULL,
  provider_id text NOT NULL DEFAULT 'gowm.foundation-local',
  provider_version text NOT NULL,
  adapter_kind text NOT NULL,
  engine_name text NOT NULL,
  engine_version text NOT NULL,
  method_id text NOT NULL,
  method_version text NOT NULL,
  policy_version text NOT NULL,
  input_schema_hash text NOT NULL,
  output_schema_hash text NOT NULL,
  compute_snapshot_hash text NOT NULL,
  input_hash text NOT NULL,
  output_hash text NOT NULL,
  status text NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  observation_id text REFERENCES world_observation(observation_id),
  projection_run_id uuid REFERENCES projection_run(run_id),
  world_version bigint CHECK (world_version IS NULL OR world_version >= 0),
  compute_snapshot jsonb NOT NULL,
  changes jsonb NOT NULL DEFAULT '{"repairApplied":false,"typeChanged":false}'::jsonb,
  warnings text[] NOT NULL DEFAULT '{}',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT foundation_receipt_stage CHECK (processing_stage IN (
    'INGEST_VALIDATION','CRS_NORMALIZATION','GEOMETRY_VALIDATION','H3_INDEXING','PROJECTION'
  )),
  CONSTRAINT foundation_receipt_id_format CHECK (receipt_id ~ '^[A-Za-z][A-Za-z0-9._:-]{0,255}$'),
  CONSTRAINT foundation_receipt_operation_id_format CHECK (operation_id ~ '^[a-z][a-z0-9.-]{2,127}$'),
  CONSTRAINT foundation_receipt_operation_version_format CHECK (operation_version ~ '^[0-9]+\.[0-9]+$'),
  CONSTRAINT foundation_receipt_provider CHECK (provider_id = 'gowm.foundation-local'),
  CONSTRAINT foundation_receipt_adapter_kind CHECK (adapter_kind IN ('EMBEDDED_SDK','LOCAL_ADAPTER')),
  CONSTRAINT foundation_receipt_input_schema_hash_format CHECK (input_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT foundation_receipt_output_schema_hash_format CHECK (output_schema_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT foundation_receipt_compute_snapshot_hash_format CHECK (compute_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT foundation_receipt_input_hash_format CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT foundation_receipt_output_hash_format CHECK (output_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT foundation_receipt_status CHECK (status IN ('SUCCEEDED','REJECTED','FAILED','SKIPPED')),
  CONSTRAINT foundation_receipt_compute_snapshot CHECK (
    COALESCE(
      jsonb_typeof(compute_snapshot) = 'object'
      AND jsonb_typeof(compute_snapshot->'provider') = 'object'
      AND compute_snapshot#>>'{provider,providerId}' = provider_id
      AND compute_snapshot#>>'{provider,providerVersion}' = provider_version
      AND jsonb_typeof(compute_snapshot->'operation') = 'object'
      AND compute_snapshot#>>'{operation,operationId}' = operation_id
      AND compute_snapshot#>>'{operation,operationVersion}' = operation_version
      AND jsonb_typeof(compute_snapshot->'engine') = 'object'
      AND compute_snapshot#>>'{engine,name}' = engine_name
      AND compute_snapshot#>>'{engine,version}' = engine_version
      AND jsonb_typeof(compute_snapshot->'policy') = 'object'
      AND compute_snapshot#>>'{policy,version}' = policy_version
      AND compute_snapshot#>>'{policy,digest}' ~ '^sha256:[0-9a-f]{64}$'
      AND jsonb_typeof(compute_snapshot->'schemas') = 'object'
      AND compute_snapshot#>>'{schemas,inputSchemaHash}' = input_schema_hash
      AND compute_snapshot#>>'{schemas,outputSchemaHash}' = output_schema_hash,
      false
    )
  ),
  CONSTRAINT foundation_receipt_changes CHECK (
    COALESCE(
      jsonb_typeof(changes) = 'object'
      AND jsonb_typeof(changes->'repairApplied') = 'boolean'
      AND jsonb_typeof(changes->'typeChanged') = 'boolean',
      false
    )
  ),
  CONSTRAINT foundation_receipt_warnings CHECK (
    cardinality(warnings) <= 128 AND array_position(warnings, NULL) IS NULL
  ),
  CONSTRAINT foundation_receipt_details_object CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX foundation_processing_receipt_observation_idx
  ON foundation_processing_receipt(observation_id, generated_at, receipt_id)
  WHERE observation_id IS NOT NULL;
CREATE INDEX foundation_processing_receipt_projection_idx
  ON foundation_processing_receipt(projection_run_id, generated_at, receipt_id)
  WHERE projection_run_id IS NOT NULL;
CREATE INDEX foundation_processing_receipt_stage_time_idx
  ON foundation_processing_receipt(processing_stage, generated_at DESC);

CREATE FUNCTION reject_world_reference_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'world_reference_identity is append-only'
    USING ERRCODE = '55000';
END
$fn$;

CREATE FUNCTION reject_foundation_processing_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'foundation_processing_receipt is append-only'
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER world_reference_identity_immutable
  BEFORE UPDATE OR DELETE ON world_reference_identity
  FOR EACH ROW EXECUTE FUNCTION reject_world_reference_mutation();
CREATE TRIGGER foundation_processing_receipt_immutable
  BEFORE UPDATE OR DELETE ON foundation_processing_receipt
  FOR EACH ROW EXECUTE FUNCTION reject_foundation_processing_receipt_mutation();

CREATE FUNCTION register_world_object_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  INSERT INTO world_reference_identity(entity_kind, internal_id, data_scope_key)
  VALUES ('WORLD_OBJECT', NEW.id, NEW.data_scope_key)
  ON CONFLICT (entity_kind, internal_id) DO NOTHING;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION register_spatial_object_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  INSERT INTO world_reference_identity(entity_kind, internal_id, data_scope_key)
  VALUES ('SPATIAL_OBJECT', NEW.spatial_object_id::text, NEW.data_scope_key)
  ON CONFLICT (entity_kind, internal_id) DO NOTHING;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION register_data_scope_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  INSERT INTO world_reference_identity(entity_kind, internal_id, data_scope_key)
  VALUES ('DATA_SCOPE', NEW.scope_key, NEW.scope_key)
  ON CONFLICT (entity_kind, internal_id) DO NOTHING;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION register_world_object_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION register_spatial_object_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION register_data_scope_reference() FROM PUBLIC;

INSERT INTO world_reference_identity(entity_kind, internal_id, data_scope_key)
SELECT 'DATA_SCOPE', scope_key, scope_key FROM data_scope
ON CONFLICT (entity_kind, internal_id) DO NOTHING;

INSERT INTO world_reference_identity(entity_kind, internal_id, data_scope_key)
SELECT 'WORLD_OBJECT', id, data_scope_key FROM world_object
ON CONFLICT (entity_kind, internal_id) DO NOTHING;

INSERT INTO world_reference_identity(entity_kind, internal_id, data_scope_key)
SELECT 'SPATIAL_OBJECT', spatial_object_id::text, data_scope_key FROM spatial_object
ON CONFLICT (entity_kind, internal_id) DO NOTHING;

CREATE TRIGGER world_object_reference_register
  AFTER INSERT ON world_object
  FOR EACH ROW EXECUTE FUNCTION register_world_object_reference();
CREATE TRIGGER spatial_object_reference_register
  AFTER INSERT ON spatial_object
  FOR EACH ROW EXECUTE FUNCTION register_spatial_object_reference();
CREATE TRIGGER data_scope_reference_register
  AFTER INSERT ON data_scope
  FOR EACH ROW EXECUTE FUNCTION register_data_scope_reference();

CREATE INDEX spatial_object_scope_idx
  ON spatial_object(data_scope_key, spatial_object_id);

CREATE SCHEMA gowm_spatial_v1;

CREATE FUNCTION gowm_spatial_v1.current_data_scope_key()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('gowm.data_scope_key', true), '')
$$;

-- The provider must call this after BEGIN and before reading any contract view.
-- Gateway/provider authentication is performed before this trusted context is
-- established; the database independently verifies that the scope exists.
CREATE FUNCTION gowm_spatial_v1.set_data_scope(p_scope_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_scope_key IS NULL OR length(p_scope_key) = 0 THEN
    RAISE EXCEPTION 'data scope is required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.data_scope WHERE scope_key = p_scope_key) THEN
    -- The message intentionally does not reveal any other scope identity.
    RAISE EXCEPTION 'data scope is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('gowm.data_scope_key', p_scope_key, true);
END
$fn$;

REVOKE ALL ON FUNCTION gowm_spatial_v1.set_data_scope(text) FROM PUBLIC;

CREATE VIEW gowm_spatial_v1.current_object
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  o.data_scope_key,
  jsonb_build_object(
    'namespace', 'gowm',
    'kind', 'WORLD_OBJECT',
    'id', r.reference_key,
    'version', s.version::text
  ) AS reference_key,
  o.object_type,
  o.subtype,
  g.geometry AS geometry_wgs84,
  CASE WHEN g.geometry IS NULL THEN NULL ELSE g.geometry::geography END AS geography_wgs84,
  COALESCE(NULLIF(s.state->>'status', ''), 'ACTIVE') AS status,
  s.source,
  o.properties,
  s.observed_at,
  s.received_at,
  GREATEST(o.updated_at, s.updated_at, COALESCE(g.updated_at, '-infinity'::timestamptz)) AS updated_at,
  s.version AS world_version,
  s.confidence,
  CASE
    WHEN s.observed_at IS NULL THEN NULL
    ELSE GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - s.observed_at)) * 1000))::bigint
  END AS freshness_ms,
  s.source_observation_id,
  jsonb_strip_nulls(jsonb_build_object(
    'evidenceKind', s.evidence_kind,
    'projectionPolicyVersion', s.projection_policy_version,
    'timeSolutionId', s.time_solution_id,
    'positionMeasurementId', s.position_measurement_id,
    'uncertainty', s.uncertainty_summary
  )) AS provenance_summary
FROM world_object o
JOIN world_object_state s ON s.object_id = o.id
LEFT JOIN world_object_geometry g ON g.object_id = o.id
JOIN world_reference_identity r
  ON r.entity_kind = 'WORLD_OBJECT' AND r.internal_id = o.id
WHERE o.deleted_at IS NULL
  AND o.data_scope_key = gowm_spatial_v1.current_data_scope_key();

CREATE VIEW gowm_spatial_v1.current_geometry
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  o.data_scope_key,
  jsonb_build_object(
    'namespace', 'gowm',
    'kind', 'WORLD_OBJECT',
    'id', r.reference_key,
    'version', s.version::text
  ) AS reference_key,
  g.geometry AS geometry_wgs84,
  g.geometry::geography AS geography_wgs84,
  ST_Envelope(g.geometry) AS bounding_geometry_wgs84,
  ST_Centroid(g.geometry) AS centroid_wgs84,
  s.version AS world_version,
  g.observed_at,
  g.updated_at
FROM world_object o
JOIN world_object_state s ON s.object_id = o.id
JOIN world_object_geometry g ON g.object_id = o.id
JOIN world_reference_identity r
  ON r.entity_kind = 'WORLD_OBJECT' AND r.internal_id = o.id
WHERE o.deleted_at IS NULL
  AND o.data_scope_key = gowm_spatial_v1.current_data_scope_key();

CREATE VIEW gowm_spatial_v1.layer_feature
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  so.data_scope_key,
  jsonb_build_object(
    'namespace', 'gowm',
    'kind', 'LAYER_FEATURE',
    'id', r.reference_key,
    'version', sv.version_no::text
  ) AS reference_key,
  so.object_type AS layer_key,
  so.stable_name,
  sv.version_no AS layer_version,
  CASE
    WHEN ST_SRID(sv.geometry) = 4326 THEN sv.geometry
    WHEN ST_SRID(sv.geometry) = 0 THEN ST_Transform(ST_SetSRID(sv.geometry, a.canonical_srid), 4326)
    ELSE ST_Transform(sv.geometry, 4326)
  END AS geometry_wgs84,
  (
    CASE
      WHEN ST_SRID(sv.geometry) = 4326 THEN sv.geometry
      WHEN ST_SRID(sv.geometry) = 0 THEN ST_Transform(ST_SetSRID(sv.geometry, a.canonical_srid), 4326)
      ELSE ST_Transform(sv.geometry, 4326)
    END
  )::geography AS geography_wgs84,
  sv.valid_time,
  sv.boundary_accuracy_m,
  sv.attributes AS properties,
  sv.created_at AS updated_at,
  jsonb_build_object(
    'authority', 'GOWM Foundation',
    'sourceKind', 'SpatialObjectVersion',
    'version', sv.version_no,
    'analysisSpace', sv.analysis_space_key
  ) AS provenance_summary
FROM spatial_object so
JOIN LATERAL (
  SELECT candidate.*
  FROM spatial_object_version candidate
  WHERE candidate.spatial_object_id = so.spatial_object_id
  ORDER BY candidate.version_no DESC
  LIMIT 1
) sv ON true
JOIN analysis_space a ON a.analysis_space_key = sv.analysis_space_key
JOIN world_reference_identity r
  ON r.entity_kind = 'SPATIAL_OBJECT' AND r.internal_id = so.spatial_object_id::text
WHERE so.data_scope_key = gowm_spatial_v1.current_data_scope_key();

CREATE VIEW gowm_spatial_v1.dataset_descriptor
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  d.scope_key AS data_scope_key,
  jsonb_build_object(
    'namespace', 'gowm',
    'kind', 'DATASET',
    'id', r.reference_key,
    'version', snapshot.current_world_version::text
  ) AS dataset_reference_key,
  'gowm-current-projection'::text AS dataset_key,
  'CURRENT_PROJECTION'::text AS dataset_kind,
  d.operational_domain,
  'CONSISTENT_AT_START'::text AS snapshot_consistency,
  snapshot.current_world_version,
  d.created_at,
  clock_timestamp() AS described_at
FROM data_scope d
JOIN world_reference_identity r
  ON r.entity_kind = 'DATA_SCOPE' AND r.internal_id = d.scope_key
JOIN LATERAL (
  SELECT COALESCE(max(s.version), 0) AS current_world_version
  FROM world_object o
  JOIN world_object_state s ON s.object_id = o.id
  WHERE o.data_scope_key = d.scope_key AND o.deleted_at IS NULL
) snapshot ON true
WHERE d.scope_key = gowm_spatial_v1.current_data_scope_key();

COMMENT ON SCHEMA gowm_spatial_v1 IS
  'Versioned, SQL-scope-filtered, read-only contract for Spatial capability providers.';
COMMENT ON VIEW gowm_spatial_v1.current_object IS
  'Current GOWM object projection; opaque reference keys replace internal object identifiers.';
COMMENT ON VIEW gowm_spatial_v1.layer_feature IS
  'Latest version of Foundation spatial features transformed to EPSG:4326.';

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spatial_provider') THEN
    CREATE ROLE spatial_provider NOLOGIN;
  END IF;
END
$roles$;

-- Connection roles assuming spatial_provider receive these conservative
-- defaults in addition to object-level read-only grants.
ALTER ROLE spatial_provider SET default_transaction_read_only = on;
ALTER ROLE spatial_provider SET statement_timeout = '5s';
ALTER ROLE spatial_provider SET lock_timeout = '1s';

REVOKE ALL ON SCHEMA gowm_spatial_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_spatial_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_spatial_v1 FROM PUBLIC;
REVOKE ALL ON TABLE
  world_object,
  world_object_state,
  world_object_geometry,
  world_observation,
  world_event,
  data_scope,
  analysis_space,
  spatial_object,
  spatial_object_version,
  world_reference_identity
FROM spatial_provider;

REVOKE ALL ON TABLE foundation_processing_receipt FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_foundation_processing_receipt_mutation() FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO gowm_ingestion_writer, gowm_projector;
GRANT SELECT, INSERT ON foundation_processing_receipt TO gowm_ingestion_writer, gowm_projector;

-- USAGE resolves PostGIS types/functions used by the contract views. It does
-- not grant access to any Foundation base table.
GRANT USAGE ON SCHEMA public, gowm_spatial_v1 TO spatial_provider;
GRANT SELECT ON
  gowm_spatial_v1.current_object,
  gowm_spatial_v1.current_geometry,
  gowm_spatial_v1.layer_feature,
  gowm_spatial_v1.dataset_descriptor
TO spatial_provider;
GRANT EXECUTE ON FUNCTION gowm_spatial_v1.current_data_scope_key() TO spatial_provider;
GRANT EXECUTE ON FUNCTION gowm_spatial_v1.set_data_scope(text) TO spatial_provider;

COMMIT;
