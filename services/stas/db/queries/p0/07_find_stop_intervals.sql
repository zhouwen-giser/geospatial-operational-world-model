-- EXACT PER SEQUENCE. $1 scope, $2 version, $3 tstzspan,
-- $4 max diameter metres, $5 min duration.
-- Stops cannot bridge gaps. Results are nominal when measurement uncertainty is
-- material relative to max diameter; max_accuracy_radius_m is returned.
WITH x AS (
 SELECT atTime(tv.trajectory,$3::tstzspan) t,tv.max_accuracy_radius_m
 FROM gowm_stas_v1.tracklet_version tv JOIN gowm_stas_v1.tracklet tr USING(tracklet_id)
 WHERE tr.data_scope_id=$1::uuid AND tv.tracklet_version_id=$2::uuid
), s AS (
 SELECT q.ordinality::integer sequence_no,q.seq,x.max_accuracy_radius_m
 FROM x CROSS JOIN LATERAL unnest(sequences(x.t)) WITH ORDINALITY q(seq,ordinality)
 WHERE x.t IS NOT NULL
), z AS (
 SELECT sequence_no,stops(seq,$4::double precision,$5::interval) stop_t,max_accuracy_radius_m FROM s
)
SELECT sequence_no,asMFJSON(stop_t)::jsonb stop_fragment,getTime(stop_t) stop_times,
       max_accuracy_radius_m,(max_accuracy_radius_m*2>$4::double precision) uncertainty_material
FROM z WHERE stop_t IS NOT NULL ORDER BY sequence_no;
