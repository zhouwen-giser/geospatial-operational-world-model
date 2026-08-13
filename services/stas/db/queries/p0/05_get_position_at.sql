-- EXACT VALUE. $1 scope, $2 version, $3 timestamp.
-- NULL means outside defined domain (including gap). observed=false means a
-- nominal LINEAR interpolation inside one Sequence, never an Observation fact.
WITH v AS (
 SELECT tv.tracklet_version_id,tv.trajectory,tv.max_accuracy_radius_m
 FROM gowm_stas_v1.tracklet_version tv JOIN gowm_stas_v1.tracklet t USING(tracklet_id)
 WHERE t.data_scope_id=$1::uuid AND tv.tracklet_version_id=$2::uuid
), p AS (
 SELECT v.*,valueAtTimestamp(trajectory,$3::timestamptz) AS position FROM v
)
SELECT p.tracklet_version_id,p.position,
       EXISTS (
         SELECT 1 FROM gowm_stas_v1.tracklet_input ti
         JOIN gowm_stas_v1.observation_time_solution ts USING(time_solution_id)
         WHERE ti.tracklet_version_id=p.tracklet_version_id
           AND ti.inclusion_role='INCLUDED' AND ts.phenomenon_time_estimate=$3::timestamptz
       ) AS observed,
       p.max_accuracy_radius_m,
       CASE WHEN p.position IS NULL THEN 'OUTSIDE_DEFINED_DOMAIN'
            WHEN EXISTS (SELECT 1 FROM gowm_stas_v1.tracklet_input ti
                         JOIN gowm_stas_v1.observation_time_solution ts USING(time_solution_id)
                         WHERE ti.tracklet_version_id=p.tracklet_version_id
                           AND ti.inclusion_role='INCLUDED'
                           AND ts.phenomenon_time_estimate=$3::timestamptz)
            THEN 'OBSERVED_MEASUREMENT_TIME' ELSE 'INTERPOLATED_WITHIN_SEQUENCE' END AS value_kind
FROM p;
