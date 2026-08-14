-- EXACT EXPLICIT GAP ROWS. $1 scope, $2 version, $3 tstzrange.
-- Reasons come from builder/status evidence, never inferred from interpolation.
SELECT g.gap_no,g.gap_time,g.primary_reason,g.reason_codes,g.observability_state,
       g.left_measurement_id,g.right_measurement_id,g.reason_confidence,g.details
FROM gowm_stas_v1.tracklet_gap g
JOIN gowm_stas_v1.tracklet_version tv USING(tracklet_version_id)
JOIN gowm_stas_v1.tracklet t USING(tracklet_id)
WHERE t.data_scope_id=$1::uuid AND g.tracklet_version_id=$2::uuid
  AND g.gap_time && $3::tstzrange
ORDER BY lower(g.gap_time),g.gap_no;
