-- DETERMINISTIC FEATURES over frozen complete coarse ids. $1 predecessor,$2 ids,$3 vmax.
-- Outputs Δt and required-speed intervals. A missing hard radius is never
-- coerced to zero: the bounded result is AMBIGUOUS_UNBOUNDED. This is evidence,
-- not identity.
WITH p AS (
 SELECT end_event_time,end_time_lower,end_time_upper,end_position,
        end_accuracy_radius_m end_r
 FROM gowm_stas_v1.tracklet_version WHERE tracklet_version_id=$1::uuid
), f AS (
 SELECT c.tracklet_version_id,c.tracklet_id,c.version_no,
   extract(epoch FROM c.start_event_time-p.end_event_time) dt_nominal_s,
   extract(epoch FROM c.start_time_lower-p.end_time_upper) dt_low_s,
   extract(epoch FROM c.start_time_upper-p.end_time_lower) dt_high_s,
   ST_Distance(c.start_position,p.end_position) distance_nominal_m,
   CASE WHEN p.end_r IS NOT NULL AND c.start_accuracy_radius_m IS NOT NULL
        THEN GREATEST(0,ST_Distance(c.start_position,p.end_position)-p.end_r-
                         c.start_accuracy_radius_m) END distance_low_m,
   CASE WHEN p.end_r IS NOT NULL AND c.start_accuracy_radius_m IS NOT NULL
        THEN ST_Distance(c.start_position,p.end_position)+p.end_r+
             c.start_accuracy_radius_m END distance_high_m,
   p.end_r,c.start_accuracy_radius_m start_r
 FROM unnest($2::uuid[]) id(tracklet_version_id)
 JOIN gowm_stas_v1.tracklet_version c USING(tracklet_version_id) CROSS JOIN p
)
SELECT f.*,
  distance_nominal_m/NULLIF(dt_nominal_s,0) required_speed_nominal_mps,
  distance_low_m/NULLIF(dt_high_s,0) required_speed_best_case_mps,
  CASE WHEN dt_low_s>0 THEN distance_high_m/dt_low_s END required_speed_worst_case_mps,
  CASE WHEN dt_high_s<=0 THEN 'UNREACHABLE'
       WHEN end_r IS NULL OR start_r IS NULL THEN 'AMBIGUOUS_UNBOUNDED'
       WHEN distance_low_m/NULLIF(dt_high_s,0)>$3::double precision THEN 'UNREACHABLE'
       WHEN dt_low_s>0 AND distance_high_m/dt_low_s<=$3::double precision THEN 'REACHABLE'
       ELSE 'AMBIGUOUS' END reachability
FROM f ORDER BY tracklet_version_id;
