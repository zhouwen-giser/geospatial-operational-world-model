-- EXACT PER SEQUENCE. $1 scope, $2 version, $3 tstzspan.
-- No speed/direction aggregation crosses an UNKNOWN gap. Nominal kinematics.
WITH x AS (
 SELECT atTime(tv.trajectory,$3::tstzspan) t,tv.max_accuracy_radius_m
 FROM gowm_stas_v1.tracklet_version tv JOIN gowm_stas_v1.tracklet tr USING(tracklet_id)
 WHERE tr.data_scope_id=$1::uuid AND tv.tracklet_version_id=$2::uuid
), s AS (
 SELECT q.ordinality::integer sequence_no,q.seq t,x.max_accuracy_radius_m
 FROM x CROSS JOIN LATERAL unnest(sequences(x.t)) WITH ORDINALITY q(seq,ordinality)
 WHERE x.t IS NOT NULL
), m AS (SELECT s.*,speed(t) sp FROM s)
SELECT sequence_no,length(t) distance_m,extract(epoch FROM duration(t,false)) duration_seconds,
       minValue(sp) min_speed_mps,maxValue(sp) max_speed_mps,twAvg(sp) avg_speed_mps,
       direction(t) direction_rad,max_accuracy_radius_m
FROM m ORDER BY sequence_no;
