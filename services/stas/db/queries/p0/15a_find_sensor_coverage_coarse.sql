-- SCOPE/TIME/BBOX COARSE CAP+1. $1 scope,$2 range,$3 optional point geometry,
-- $4 optional sensor,$5 class,$6 cap. cap+1 is failure/async, not pagination.
SELECT cs.coverage_slice_id
FROM gowm_stas_v1.sensor_coverage_slice cs JOIN gowm_stas_v1.sensor_deployment sd USING(sensor_deployment_id)
WHERE cs.data_scope_id=$1::uuid AND cs.valid_time && $2::tstzrange
  AND ($4::uuid IS NULL OR sd.sensor_id=$4::uuid)
  AND ($5::text IS NULL OR cs.detectable_object_class=$5::text)
  AND ($3::geometry IS NULL OR cs.coverage_geometry && $3::geometry)
ORDER BY cs.coverage_slice_id LIMIT ($6::integer+1);
