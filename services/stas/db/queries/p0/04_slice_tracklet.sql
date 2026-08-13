-- ROW LOCATE -> EXACT atTime/atGeometry. $1 scope, $2 version, $3 tstzspan,
-- $4 optional spatial_object_version_id.
-- SequenceSet gaps remain undefined. Geometry is nominal; caller reports
-- tracklet max radius and region boundary_accuracy_m as sensitivity inputs.
WITH x AS (
 SELECT tv.tracklet_version_id,atTime(tv.trajectory,$3::tstzspan) AS t,
        tv.max_accuracy_radius_m,tr.analysis_space_id
 FROM gowm_stas_v1.tracklet_version tv JOIN gowm_stas_v1.tracklet tr USING(tracklet_id)
 WHERE tr.data_scope_id=$1::uuid AND tv.tracklet_version_id=$2::uuid
   AND tv.trajectory && $3::tstzspan
), r AS (
 SELECT sv.geometry,sv.boundary_accuracy_m,sv.analysis_space_id
 FROM gowm_stas_v1.spatial_object_version sv JOIN gowm_stas_v1.spatial_object so USING(spatial_object_id)
 WHERE sv.spatial_object_version_id=$4::uuid AND so.data_scope_id=$1::uuid
)
SELECT x.tracklet_version_id,
       asMFJSON(CASE WHEN $4::uuid IS NULL THEN x.t ELSE atGeometry(x.t,r.geometry) END)::jsonb fragment,
       x.max_accuracy_radius_m,r.boundary_accuracy_m
FROM x LEFT JOIN r ON r.analysis_space_id=x.analysis_space_id
WHERE x.t IS NOT NULL AND ($4::uuid IS NULL OR atGeometry(x.t,r.geometry) IS NOT NULL);
