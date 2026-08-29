BEGIN;

CREATE OR REPLACE FUNCTION gowm_evidence_v1.current_dataset_scope_key()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('gowm.dataset_scope_key', true), '')
$$;

CREATE OR REPLACE VIEW gowm_evidence_v1.catalog_feature_geometry
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  feature.reference_key,
  jsonb_build_object(
    'namespace', 'gowm',
    'kind', 'LAYER_FEATURE',
    'id', feature.reference_key,
    'version', pin.reference_version
  ) AS reference_key_value,
  pin.reference_version,
  version.version AS feature_version,
  ST_AsGeoJSON(version.geometry)::jsonb AS geometry,
  GeometryType(version.geometry) AS geometry_type,
  CASE
    WHEN version.geometry IS NULL THEN NULL
    ELSE jsonb_build_array(
      ST_XMin(Box2D(version.geometry)),
      ST_YMin(Box2D(version.geometry)),
      ST_XMax(Box2D(version.geometry)),
      ST_YMax(Box2D(version.geometry))
    )
  END AS bbox,
  'EPSG:4326'::text AS crs,
  COALESCE(descriptor.world_version, 0::bigint) AS world_version,
  version.published_at AS observed_at,
  GREATEST(feature.created_at, version.created_at) AS updated_at,
  version.content_hash
FROM spatial_feature_identity feature
JOIN spatial_feature_version version USING (feature_id)
JOIN LATERAL (
  SELECT version.version AS reference_version
  UNION
  SELECT candidate.descriptor_version::text
  FROM world_reference_descriptor_version candidate
  WHERE candidate.reference_key = feature.reference_key
    AND candidate.data_scope_key = feature.data_scope_key
    AND candidate.object_version = version.version
) pin ON true
LEFT JOIN LATERAL (
  SELECT candidate.world_version
  FROM world_reference_descriptor_version candidate
  WHERE candidate.reference_key = feature.reference_key
    AND candidate.object_version = version.version
  ORDER BY candidate.descriptor_version DESC
  LIMIT 1
) descriptor ON true
WHERE feature.data_scope_key = gowm_evidence_v1.current_data_scope_key()
  AND feature.dataset_scope_key = gowm_evidence_v1.current_dataset_scope_key()
  AND version.geometry IS NOT NULL
  AND (version.retired_at IS NULL OR version.retired_at > transaction_timestamp());

CREATE OR REPLACE VIEW gowm_evidence_v1.current_feature_geometry
WITH (security_barrier = true, security_invoker = false)
AS
SELECT DISTINCT ON (feature.reference_key)
  feature.reference_key,
  feature.reference_key_value,
  feature.reference_version,
  feature.feature_version,
  feature.geometry,
  feature.geometry_type,
  feature.bbox,
  feature.crs,
  feature.world_version,
  feature.observed_at,
  feature.updated_at,
  feature.content_hash
FROM gowm_evidence_v1.catalog_feature_geometry feature
WHERE feature.reference_version = feature.feature_version
ORDER BY feature.reference_key, feature.observed_at DESC,
         feature.feature_version DESC, feature.content_hash DESC;

CREATE OR REPLACE VIEW gowm_evidence_v1.current_geometry
WITH (security_barrier = true, security_invoker = false)
AS
SELECT identity.reference_key,
       jsonb_build_object(
         'namespace','gowm','kind','WORLD_OBJECT','id',identity.reference_key,
         'version',state.version::text
       ) AS reference_key_value,
       ST_AsGeoJSON(geometry.geometry)::jsonb AS geometry,
       GeometryType(geometry.geometry) AS geometry_type,
       jsonb_build_array(
         ST_XMin(Box2D(geometry.geometry)),ST_YMin(Box2D(geometry.geometry)),
         ST_XMax(Box2D(geometry.geometry)),ST_YMax(Box2D(geometry.geometry))
       ) AS bbox,
       'EPSG:4326'::text AS crs,
       state.version AS world_version,
       geometry.observed_at,
       geometry.updated_at
FROM world_object object
JOIN world_object_state state ON state.object_id=object.id
JOIN world_object_geometry geometry ON geometry.object_id=object.id
JOIN world_reference_identity identity
  ON identity.entity_kind='WORLD_OBJECT' AND identity.internal_id=object.id
WHERE object.deleted_at IS NULL
  AND object.data_scope_key=gowm_evidence_v1.current_data_scope_key()
UNION ALL
SELECT feature.reference_key,
       feature.reference_key_value,
       feature.geometry,
       feature.geometry_type,
       feature.bbox,
       feature.crs,
       feature.world_version,
       feature.observed_at,
       feature.updated_at
FROM gowm_evidence_v1.current_feature_geometry feature;

CREATE OR REPLACE VIEW gowm_platform_validation_v1.world_reference_version
WITH (security_barrier = true)
AS
SELECT identity.reference_key,identity.entity_kind,descriptor.descriptor_version,
       CASE
         WHEN identity.entity_kind IN ('WORLD_OBJECT','SPATIAL_OBJECT')
          AND descriptor.object_version IS NOT NULL
          AND descriptor.object_version=COALESCE(state.version::text,spatial.version_no::text)
         THEN descriptor.descriptor_version::text
         ELSE COALESCE(state.version::text,spatial.version_no::text,descriptor.object_version,
                       CASE WHEN identity.entity_kind IN ('DATA_SCOPE','OPERATIONAL_TASK') THEN '1' END)
       END AS current_version,
       COALESCE(state.version::text,spatial.version_no::text,descriptor.object_version) AS object_version,
       COALESCE(state.version,descriptor.world_version) AS world_version,
       COALESCE(descriptor.valid_to,upper(spatial.valid_time),'infinity'::timestamptz) AS valid_to,
       COALESCE(state.updated_at,spatial.created_at,descriptor.created_at,identity.created_at) AS created_at,
       descriptor.stale,descriptor.revalidation_required,
       COALESCE(descriptor.content_hash,CASE WHEN state.object_id IS NOT NULL THEN
         'sha256:'||encode(digest(convert_to(state.state::text||':'||state.version::text,'UTF8'),'sha256'),'hex') END) AS content_hash,
       LEAST(retirement.retired_at,object.deleted_at) <= statement_timestamp() AS retired,
       descriptor.object_version AS descriptor_object_version
FROM public.world_reference_identity identity
LEFT JOIN public.world_reference_retirement retirement USING(reference_key)
LEFT JOIN public.world_object object ON identity.entity_kind='WORLD_OBJECT'
  AND object.id=identity.internal_id AND object.data_scope_key=identity.data_scope_key
LEFT JOIN public.world_object_state state ON state.object_id=object.id
LEFT JOIN LATERAL (
  SELECT version.* FROM public.spatial_object_version version
  JOIN public.spatial_object source USING(spatial_object_id)
  WHERE identity.entity_kind='SPATIAL_OBJECT' AND source.spatial_object_id::text=identity.internal_id
    AND source.data_scope_key=identity.data_scope_key
  ORDER BY version.version_no DESC LIMIT 1
) spatial ON true
LEFT JOIN LATERAL (
  SELECT version.* FROM public.world_reference_descriptor_version version
  WHERE version.reference_key=identity.reference_key AND version.data_scope_key=identity.data_scope_key
  ORDER BY version.descriptor_version DESC LIMIT 1
) descriptor ON true
WHERE identity.data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
  AND identity.entity_kind IN ('WORLD_OBJECT','SPATIAL_OBJECT','DATA_SCOPE','OPERATIONAL_TASK');

CREATE OR REPLACE VIEW gowm_spatial_v1.catalog_feature_reference
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  feature.data_scope_key,
  jsonb_build_object(
    'namespace', 'gowm',
    'kind', 'LAYER_FEATURE',
    'id', feature.reference_key,
    'version', pin.reference_version
  ) AS reference_key,
  feature.feature_type AS object_type,
  feature.display_name AS subtype,
  version.geometry AS geometry_wgs84,
  CASE WHEN version.geometry IS NULL THEN NULL ELSE version.geometry::geography END AS geography_wgs84,
  'ACTIVE'::text AS status,
  version.source_feature_id AS source,
  version.properties,
  version.published_at AS observed_at,
  NULL::timestamptz AS received_at,
  GREATEST(feature.created_at, version.created_at) AS updated_at,
  COALESCE(descriptor.world_version, 0::bigint) AS world_version,
  NULL::real AS confidence,
  GREATEST(
    0,
    floor(extract(epoch FROM (clock_timestamp() - version.published_at)) * 1000)
  )::bigint AS freshness_ms,
  NULL::text AS source_observation_id,
  jsonb_strip_nulls(jsonb_build_object(
    'authority', 'GOWM Foundation',
    'sourceKind', 'SpatialFeatureVersion',
    'featureVersion', version.version,
    'layerReferenceKey', layer.reference_key,
    'layerVersion', layer_version.version,
    'contentHash', version.content_hash,
    'validFrom', version.valid_from,
    'validTo', version.valid_to
  )) AS provenance_summary
FROM spatial_feature_identity feature
JOIN spatial_layer layer USING (layer_id)
JOIN spatial_feature_version version USING (feature_id)
JOIN spatial_layer_version layer_version
  ON layer_version.layer_version_id = version.layer_version_id
JOIN LATERAL (
  SELECT version.version AS reference_version
  UNION
  SELECT candidate.descriptor_version::text
  FROM world_reference_descriptor_version candidate
  WHERE candidate.reference_key = feature.reference_key
    AND candidate.data_scope_key = feature.data_scope_key
    AND candidate.object_version = version.version
) pin ON true
LEFT JOIN LATERAL (
  SELECT candidate.descriptor_version, candidate.world_version
  FROM world_reference_descriptor_version candidate
  WHERE candidate.reference_key = feature.reference_key
    AND candidate.object_version = version.version
  ORDER BY candidate.descriptor_version DESC
  LIMIT 1
) descriptor ON true
WHERE feature.data_scope_key = gowm_spatial_v1.current_data_scope_key()
  AND feature.dataset_scope_key = NULLIF(current_setting('gowm.dataset_scope_key', true), '')
  AND (version.retired_at IS NULL OR version.retired_at > transaction_timestamp());

CREATE OR REPLACE VIEW gowm_spatial_v1.catalog_feature
WITH (security_barrier = true, security_invoker = false)
AS
SELECT DISTINCT ON (feature_row.reference_key->>'id')
  feature_row.data_scope_key,
  feature_row.reference_key,
  feature_row.object_type,
  feature_row.subtype,
  feature_row.geometry_wgs84,
  feature_row.geography_wgs84,
  feature_row.status,
  feature_row.source,
  feature_row.properties,
  feature_row.observed_at,
  feature_row.received_at,
  feature_row.updated_at,
  feature_row.world_version,
  feature_row.confidence,
  feature_row.freshness_ms,
  feature_row.source_observation_id,
  feature_row.provenance_summary
FROM gowm_spatial_v1.catalog_feature_reference feature_row
WHERE feature_row.reference_key->>'version' = feature_row.provenance_summary->>'featureVersion'
ORDER BY feature_row.reference_key->>'id', feature_row.observed_at DESC,
         feature_row.reference_key->>'version' DESC;

CREATE OR REPLACE VIEW gowm_spatial_v1.catalog_snapshot
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  'sha256:' || encode(digest(
    COALESCE(
      jsonb_agg(
        jsonb_build_array(
          feature_row.reference_key->>'id',
          feature_row.reference_key->>'version',
          feature_row.provenance_summary->>'featureVersion',
          feature_row.provenance_summary->>'contentHash',
          feature_row.world_version
        )
        ORDER BY feature_row.reference_key->>'id',
                 feature_row.reference_key->>'version',
                 feature_row.world_version
      )::text,
      '[]'
    ),
    'sha256'
  ), 'hex') AS catalog_snapshot_version
FROM gowm_spatial_v1.catalog_feature_reference feature_row;

COMMENT ON VIEW gowm_evidence_v1.catalog_feature_geometry IS
  'Exact-version active LAYER_FEATURE geometry read contract, requiring both data and dataset scope.';
COMMENT ON VIEW gowm_evidence_v1.current_feature_geometry IS
  'Deterministic current non-retired LAYER_FEATURE geometry projection for the authorized data and dataset scope.';
COMMENT ON VIEW gowm_evidence_v1.current_geometry IS
  'Current WORLD_OBJECT and LAYER_FEATURE geometry projection preserving stable ReferenceKey identity.';
COMMENT ON VIEW gowm_spatial_v1.catalog_feature IS
  'One current non-retired catalog LAYER_FEATURE row per feature, pinned to the immutable feature version.';
COMMENT ON VIEW gowm_spatial_v1.catalog_feature_reference IS
  'Active catalog LAYER_FEATURE versions addressable by immutable feature-version or matching descriptor-version pins.';
COMMENT ON VIEW gowm_spatial_v1.catalog_snapshot IS
  'Dataset-scoped append-only catalog snapshot marker used to invalidate spatial cursors when feature versions change.';

REVOKE ALL ON FUNCTION gowm_evidence_v1.current_dataset_scope_key() FROM PUBLIC;
REVOKE ALL ON TABLE
  spatial_feature_identity,
  spatial_feature_version,
  spatial_layer,
  spatial_layer_version,
  world_reference_descriptor_version
FROM gowm_evidence_reader, spatial_provider;
REVOKE ALL ON
  gowm_evidence_v1.catalog_feature_geometry,
  gowm_evidence_v1.current_feature_geometry,
  gowm_spatial_v1.catalog_feature_reference,
  gowm_spatial_v1.catalog_feature,
  gowm_spatial_v1.catalog_snapshot
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION gowm_evidence_v1.current_dataset_scope_key() TO gowm_evidence_reader;
GRANT SELECT ON
  gowm_evidence_v1.catalog_feature_geometry,
  gowm_evidence_v1.current_feature_geometry,
  gowm_evidence_v1.current_geometry
TO gowm_evidence_reader;
GRANT SELECT ON
  gowm_spatial_v1.catalog_feature,
  gowm_spatial_v1.catalog_feature_reference,
  gowm_spatial_v1.catalog_snapshot
TO spatial_provider;

COMMIT;
