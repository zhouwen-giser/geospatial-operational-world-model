-- PURE BBOX COARSE CAP+1. $1 scope,$2 region version,$3 span,$4 cap.
-- cap+1 means TOO_MANY/async. Freeze the entire <=cap id set, then run 09b.
WITH r AS (
 SELECT sv.geometry,sv.analysis_space_id FROM gowm_stas_v1.spatial_object_version sv
 JOIN gowm_stas_v1.spatial_object so USING(spatial_object_id)
 WHERE so.data_scope_id=$1::uuid AND sv.spatial_object_version_id=$2::uuid
)
SELECT tv.tracklet_version_id,tv.tracklet_id,tv.version_no
FROM r JOIN gowm_stas_v1.tracklet tr ON tr.data_scope_id=$1::uuid
  AND tr.analysis_space_id=r.analysis_space_id
JOIN gowm_stas_v1.tracklet_head h USING(tracklet_id)
JOIN gowm_stas_v1.tracklet_version tv ON tv.tracklet_version_id=h.current_version_id
WHERE tv.trajectory && $3::tstzspan AND tv.trajectory && stbox(r.geometry)
ORDER BY tv.tracklet_version_id LIMIT ($4::integer+1);
