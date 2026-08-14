-- EXACT KNOWN PAIR. $1 scope,$2 A,$3 B,$4 span.
-- MobilityDB evaluates only common defined temporal domain; no gap interpolation.
-- Distance is nominal planar metres; radii are returned for sensitivity.
WITH p AS (
 SELECT atTime(a.trajectory,$4::tstzspan) ta,atTime(b.trajectory,$4::tstzspan) tb,
        a.max_accuracy_radius_m radius_a,b.max_accuracy_radius_m radius_b
 FROM gowm_stas_v1.tracklet_version a JOIN gowm_stas_v1.tracklet tra ON tra.tracklet_id=a.tracklet_id,
      gowm_stas_v1.tracklet_version b JOIN gowm_stas_v1.tracklet trb ON trb.tracklet_id=b.tracklet_id
 WHERE tra.data_scope_id=$1::uuid AND trb.data_scope_id=$1::uuid
   AND tra.analysis_space_id=trb.analysis_space_id
   AND a.tracklet_version_id=$2::uuid AND b.tracklet_version_id=$3::uuid
)
SELECT ta |=| tb minimum_distance_m,nearestApproachInstant(ta,tb) nearest_instant,
       shortestLine(ta,tb) shortest_line,getTime(ta) coverage_a,getTime(tb) coverage_b,
       radius_a,radius_b
FROM p WHERE ta IS NOT NULL AND tb IS NOT NULL
  AND (getTime(ta) * getTime(tb)) IS NOT NULL;
