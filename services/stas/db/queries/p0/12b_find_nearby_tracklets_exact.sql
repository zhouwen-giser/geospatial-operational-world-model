-- EXACT-EVER over frozen complete coarse ids. $1 subject,$2 span,$3 ids,$4 nominal metres.
-- eDwithin respects gaps. If $4 omitted uncertainty radii, output is nominal-only.
WITH s AS (
 SELECT atTime(trajectory,$2::tstzspan) t FROM gowm_stas_v1.tracklet_version
 WHERE tracklet_version_id=$1::uuid
), c AS (
 SELECT tv.tracklet_version_id,atTime(tv.trajectory,$2::tstzspan) t,s.t subject_t,
        tv.max_accuracy_radius_m
 FROM unnest($3::uuid[]) id(tracklet_version_id)
 JOIN gowm_stas_v1.tracklet_version tv USING(tracklet_version_id) CROSS JOIN s
)
SELECT tracklet_version_id,eDwithin(t,subject_t,$4::double precision) exact_ever,
       max_accuracy_radius_m
FROM c WHERE t IS NOT NULL AND subject_t IS NOT NULL
  AND eDwithin(t,subject_t,$4::double precision)
ORDER BY tracklet_version_id;
