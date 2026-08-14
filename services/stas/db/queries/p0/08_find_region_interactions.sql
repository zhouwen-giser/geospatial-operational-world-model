-- BBOX/EXISTENCE COARSE -> EXACT RESTRICTION. $1 scope,$2 version,$3 region version,$4 span.
-- Returned visit domain never bridges gaps. Event labels ENTER/EXIT vs
-- APPEARED/DISAPPEARED require checking defined state on each boundary.
WITH c AS (
 SELECT atTime(tv.trajectory,$4::tstzspan) t,sv.geometry,sv.boundary_accuracy_m,
        tv.max_accuracy_radius_m
 FROM gowm_stas_v1.tracklet_version tv JOIN gowm_stas_v1.tracklet tr USING(tracklet_id)
 JOIN gowm_stas_v1.spatial_object_version sv ON sv.spatial_object_version_id=$3::uuid
 JOIN gowm_stas_v1.spatial_object so USING(spatial_object_id)
 WHERE tr.data_scope_id=$1::uuid AND so.data_scope_id=$1::uuid
   AND tr.analysis_space_id=sv.analysis_space_id
   AND tv.tracklet_version_id=$2::uuid AND tv.trajectory && $4::tstzspan
   AND tv.trajectory && stbox(sv.geometry) AND eIntersects(tv.trajectory,sv.geometry)
), e AS (SELECT atGeometry(t,geometry) inside,boundary_accuracy_m,max_accuracy_radius_m FROM c)
SELECT getTime(inside) visit_times,asMFJSON(inside)::jsonb inside_fragment,
       boundary_accuracy_m,max_accuracy_radius_m
FROM e WHERE inside IS NOT NULL;
