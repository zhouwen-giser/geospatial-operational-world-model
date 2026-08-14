-- EXACT KNOWN PAIR. $1 scope,$2 A,$3 B,$4 span,$5 proximity metres.
-- Shared defined coverage is explicit; all kinematics/proximity are nominal.
WITH p AS (
 SELECT atTime(a.trajectory,$4::tstzspan) ta,atTime(b.trajectory,$4::tstzspan) tb,
        a.max_accuracy_radius_m radius_a,b.max_accuracy_radius_m radius_b
 FROM gowm_stas_v1.tracklet_version a JOIN gowm_stas_v1.tracklet tra ON tra.tracklet_id=a.tracklet_id,
      gowm_stas_v1.tracklet_version b JOIN gowm_stas_v1.tracklet trb ON trb.tracklet_id=b.tracklet_id
 WHERE tra.data_scope_id=$1::uuid AND trb.data_scope_id=$1::uuid
   AND tra.analysis_space_id=trb.analysis_space_id
   AND a.tracklet_version_id=$2::uuid AND b.tracklet_version_id=$3::uuid
)
SELECT ta |=| tb min_distance_m,nearestApproachInstant(ta,tb) nearest_instant,
       whenTrue(tDwithin(ta,tb,$5::double precision)) proximity_times,
       getTime(ta) coverage_a,getTime(tb) coverage_b,radius_a,radius_b,
       'PER_SEQUENCE_KINEMATICS_REQUIRED' kinematic_aggregation_policy
FROM p WHERE ta IS NOT NULL AND tb IS NOT NULL
  AND (getTime(ta) * getTime(tb)) IS NOT NULL;
