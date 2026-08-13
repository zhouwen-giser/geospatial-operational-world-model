-- EXACT over frozen complete coarse IDs. $1 scope,$2 region version,$3 span,$4 ids.
-- eIntersects/atGeometry preserve SequenceSet gaps. Nominal boundary only.
WITH r AS (
 SELECT sv.geometry,sv.boundary_accuracy_m,sv.analysis_space_id FROM gowm_stas_v1.spatial_object_version sv
 JOIN gowm_stas_v1.spatial_object so USING(spatial_object_id)
 WHERE so.data_scope_id=$1::uuid AND sv.spatial_object_version_id=$2::uuid
), c AS (
 SELECT tv.tracklet_version_id,tv.tracklet_id,tv.version_no,tv.trajectory,
        tv.max_accuracy_radius_m,r.geometry,r.boundary_accuracy_m
 FROM unnest($4::uuid[]) id(tracklet_version_id)
 JOIN gowm_stas_v1.tracklet_version tv USING(tracklet_version_id)
 JOIN gowm_stas_v1.tracklet tr USING(tracklet_id) CROSS JOIN r
 WHERE tr.data_scope_id=$1::uuid AND tr.analysis_space_id=r.analysis_space_id
)
SELECT tracklet_version_id,tracklet_id,version_no,
       getTime(atGeometry(atTime(trajectory,$3::tstzspan),geometry)) visit_times,
       max_accuracy_radius_m,boundary_accuracy_m
FROM c WHERE eIntersects(atTime(trajectory,$3::tstzspan),geometry)
ORDER BY tracklet_version_id;
