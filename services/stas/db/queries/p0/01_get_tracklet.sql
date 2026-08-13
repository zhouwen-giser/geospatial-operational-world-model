-- EXACT ROW. $1 scope uuid, $2 version uuid.
-- Gap: segment/gap counts are explicit; MF-JSON is only the query projection.
-- Uncertainty: endpoint/max radii are metadata, not propagated probabilities.
SELECT tv.tracklet_version_id,tv.tracklet_id,tv.version_no,tv.version_state,
       tv.start_event_time,tv.end_event_time,tv.sample_count,tv.sequence_count,
       tv.quality_score,tv.start_accuracy_radius_m,tv.end_accuracy_radius_m,
       tv.max_accuracy_radius_m,asMFJSON(tv.trajectory)::jsonb AS trajectory,
       (SELECT count(*) FROM gowm_stas_v1.tracklet_gap g
        WHERE g.tracklet_version_id=tv.tracklet_version_id) AS gap_count
FROM gowm_stas_v1.tracklet_version tv JOIN gowm_stas_v1.tracklet t USING(tracklet_id)
WHERE t.data_scope_id=$1::uuid AND tv.tracklet_version_id=$2::uuid;
