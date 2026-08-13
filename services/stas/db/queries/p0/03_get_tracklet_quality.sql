-- EXACT ROW/AGGREGATE. $1 scope, $2 version, $3 optional tstzspan.
-- gap_seconds is bounding minus defined domain; uncertainty is summarized only.
WITH x AS (
 SELECT tv.tracklet_version_id,atTime(tv.trajectory,COALESCE($3::tstzspan,timeSpan(tv.trajectory))) t,
        tv.quality_score,tv.max_accuracy_radius_m
 FROM gowm_stas_v1.tracklet_version tv JOIN gowm_stas_v1.tracklet tr USING(tracklet_id)
 WHERE tr.data_scope_id=$1::uuid AND tv.tracklet_version_id=$2::uuid
), u AS (
 SELECT max(extract(epoch FROM upper(ts.phenomenon_time_window)-lower(ts.phenomenon_time_window)))
          AS max_clock_window_seconds,
        array_agg(DISTINCT pm.accuracy_model ORDER BY pm.accuracy_model) AS accuracy_models,
        max(pm.horizontal_stddev_m) AS max_horizontal_stddev_m,
        count(*) FILTER (WHERE pm.accuracy_model IN ('UNKNOWN','INTERVAL')) AS unbounded_sample_count
 FROM gowm_stas_v1.tracklet_input ti JOIN gowm_stas_v1.observation_time_solution ts USING(time_solution_id)
 JOIN gowm_stas_v1.position_measurement pm USING(measurement_id)
 WHERE ti.tracklet_version_id=$2::uuid AND ti.inclusion_role='INCLUDED'
)
SELECT x.tracklet_version_id,x.quality_score,x.max_accuracy_radius_m,u.max_clock_window_seconds,
       u.accuracy_models,u.max_horizontal_stddev_m,u.unbounded_sample_count,
       extract(epoch FROM duration(x.t,false)) AS defined_seconds,
       extract(epoch FROM duration(x.t,true)) AS bounding_seconds,
       extract(epoch FROM duration(x.t,true)-duration(x.t,false)) AS gap_seconds,
       numSequences(x.t) AS sequence_count,numInstants(x.t) AS projected_instant_count
FROM x CROSS JOIN u WHERE x.t IS NOT NULL;
