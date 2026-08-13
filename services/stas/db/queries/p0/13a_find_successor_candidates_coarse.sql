-- UNCERTAINTY-CONSERVATIVE ENDPOINT COARSE + CAP+1 BUDGET CHECK.
-- $1 scope,$2 predecessor,$3 max gap,$4 max reach radius,$5 cap.
-- Time lower/upper tests retain any possibly positive Δt. cap+1 is failure/async,
-- never a complete result page. Candidate means evidence only, not same entity.
WITH p AS (
 SELECT tv.tracklet_id,tr.analysis_space_id,tv.end_time_lower,tv.end_time_upper,
        tv.end_position
 FROM gowm_stas_v1.tracklet_version tv JOIN gowm_stas_v1.tracklet tr USING(tracklet_id)
 WHERE tr.data_scope_id=$1::uuid AND tv.tracklet_version_id=$2::uuid
), c AS (
 SELECT tv.tracklet_version_id,tv.tracklet_id,tv.version_no
 FROM p JOIN gowm_stas_v1.tracklet tr ON tr.data_scope_id=$1::uuid
   AND tr.analysis_space_id=p.analysis_space_id AND tr.tracklet_id<>p.tracklet_id
 JOIN gowm_stas_v1.tracklet_head h ON h.tracklet_id=tr.tracklet_id
 JOIN gowm_stas_v1.tracklet_version tv ON tv.tracklet_version_id=h.current_version_id
 WHERE tv.start_time_upper>p.end_time_lower
   AND tv.start_time_lower<=p.end_time_upper+$3::interval
   AND tv.start_position && ST_Expand(p.end_position,$4::double precision)
 ORDER BY tv.tracklet_version_id LIMIT ($5::integer+1)
)
SELECT * FROM c ORDER BY tracklet_version_id;
