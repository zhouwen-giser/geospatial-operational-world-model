-- EXACT over frozen complete coverage ids. $1 scope,$2 point,$3 ids.
-- Coverage is not negative evidence by itself; status/detector/watermark pins are
-- returned so the evaluator can output EXPECTED_MISSING or INDETERMINATE.
WITH c AS (
 SELECT cs.*,sd.sensor_id,ds.producer_pipeline_id
 FROM unnest($3::uuid[]) id(coverage_slice_id)
 JOIN gowm_stas_v1.sensor_coverage_slice cs USING(coverage_slice_id)
 JOIN gowm_stas_v1.sensor_deployment sd USING(sensor_deployment_id)
 JOIN gowm_stas_v1.datastream ds USING(datastream_id)
 WHERE cs.data_scope_id=$1::uuid
   AND ($2::geometry IS NULL OR ST_Covers(cs.coverage_geometry,$2::geometry))
)
SELECT c.coverage_slice_id,c.sensor_deployment_id,c.datastream_id,c.sensor_id,c.valid_time,
       c.producer_pipeline_id,
       c.coverage_confidence,c.coverage_model_version,c.occlusion_model_version,
       c.detector_model_id,c.sensor_pose_version_id,c.sensor_extrinsic_version_id,
       ss.sensor_status_id,ss.capture_state,ss.analytic_state,ss.transport_state,
       ss.completeness_state,ss.calibration_state,ss.clock_health,
       wr.watermark_revision_id,wr.closed_through_event_time,wr.allowed_lateness
FROM c
LEFT JOIN LATERAL (
 SELECT s.* FROM gowm_stas_v1.sensor_status_interval s
 WHERE s.sensor_deployment_id=c.sensor_deployment_id AND s.valid_time && c.valid_time
   AND (s.producer_pipeline_id IS NULL OR s.producer_pipeline_id=c.producer_pipeline_id)
 ORDER BY lower(s.valid_time) DESC LIMIT 1
) ss ON true
LEFT JOIN LATERAL (
 SELECT w.* FROM gowm_stas_v1.pipeline_watermark_revision w
 WHERE w.datastream_id=c.datastream_id
 ORDER BY w.created_at DESC LIMIT 1
) wr ON true
ORDER BY c.coverage_slice_id;
