BEGIN;

-- Additive, scoped read contracts only. Existing facts and planning algorithms
-- remain unchanged. A descriptor pin must name an immutable feature version.
CREATE VIEW gowm_network_v1.coverage_area_reference WITH (security_barrier=true) AS
SELECT feature.reference_key, pin.version AS reference_version,
       version.version AS feature_version, ST_AsGeoJSON(version.geometry)::jsonb AS geometry,
       version.content_hash
FROM public.spatial_feature_identity feature
JOIN public.spatial_feature_version version USING(feature_id)
JOIN LATERAL (
  SELECT version.version
  UNION
  SELECT descriptor.descriptor_version::text
  FROM public.world_reference_descriptor_version descriptor
  WHERE descriptor.reference_key=feature.reference_key
    AND descriptor.data_scope_key=feature.data_scope_key
    AND descriptor.object_version=version.version
) pin ON true
WHERE feature.data_scope_key=gowm_network_v1.current_data_scope_key()
  AND feature.dataset_scope_key=gowm_network_v1.current_dataset_scope_key()
  AND GeometryType(version.geometry) IN ('POLYGON','MULTIPOLYGON')
  AND (version.retired_at IS NULL OR version.retired_at>statement_timestamp());

REVOKE ALL ON gowm_network_v1.coverage_area_reference FROM PUBLIC;
GRANT SELECT ON gowm_network_v1.coverage_area_reference TO coverage_planner_provider;

CREATE VIEW gowm_platform_validation_v1.coverage_area_currentness WITH (security_barrier=true) AS
SELECT result.reference_key, request.request_json->'area' AS area_reference,
       pinned.feature_version AS pinned_version,
       latest.version AS current_version, pinned.content_hash AS pinned_hash,
       latest.content_hash AS current_hash
FROM coverage_planner.coverage_result_set result
JOIN coverage_planner.coverage_request request USING(coverage_request_id)
LEFT JOIN gowm_network_v1.coverage_area_reference pinned
  ON pinned.reference_key=request.request_json#>>'{area,id}'
 AND pinned.reference_version=request.request_json#>>'{area,version}'
LEFT JOIN public.spatial_feature_identity feature
  ON feature.reference_key=request.request_json#>>'{area,id}'
 AND feature.data_scope_key=request.data_scope_key
 AND feature.dataset_scope_key=request.dataset_scope_key
LEFT JOIN LATERAL (
  SELECT version.version,version.content_hash FROM public.spatial_feature_version version
  WHERE version.feature_id=feature.feature_id
    AND (version.retired_at IS NULL OR version.retired_at>statement_timestamp())
  ORDER BY version.published_at DESC,version.version DESC LIMIT 1
) latest ON true
WHERE result.data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
  AND result.dataset_scope_key=gowm_platform_validation_v1.current_dataset_scope_key()
  AND request.request_json->'area' ? 'kind';
REVOKE ALL ON gowm_platform_validation_v1.coverage_area_currentness FROM PUBLIC;
GRANT SELECT ON gowm_platform_validation_v1.coverage_area_currentness TO platform_validation_provider;

COMMIT;
