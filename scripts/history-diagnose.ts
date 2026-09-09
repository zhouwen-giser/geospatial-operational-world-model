import pg from 'pg';
const scope=process.argv[2];
if(!scope||!process.env.GOWM_DATABASE_URL)throw Error('Usage: GOWM_DATABASE_URL=... node --import tsx scripts/history-diagnose.ts <data-scope>');
const pool=new pg.Pool({connectionString:process.env.GOWM_DATABASE_URL,max:1,statement_timeout:15000});
const c=await pool.connect();
try{
 await c.query('BEGIN READ ONLY');await c.query('SELECT gowm_history_v1.set_data_scope($1)',[scope]);
 const result=await c.query(`SELECT (SELECT count(DISTINCT tracklet_id) FROM gowm_history_v1.tracklet_version_effective) tracklet_identities,
 (SELECT count(*) FROM gowm_history_v1.tracklet_version_effective) tracklet_versions,
 (SELECT count(*) FROM gowm_history_v1.historical_trajectory_effective) historical_trajectories`);
 const states=await c.query('SELECT finalization_state,count(*) FROM gowm_history_v1.tracklet_version_effective GROUP BY 1');
 const queues=await c.query('SELECT state,attempts,last_error IS NOT NULL AS has_error,count(*) FROM gowm_history.historical_trajectory_projection_queue WHERE data_scope_key=$1 GROUP BY 1,2,3',[scope]);
 const resets=await c.query('SELECT state,reason,count(*) FROM gowm_history_v1.reset_ack_status GROUP BY 1,2');
 const active=await c.query(`SELECT lane,count(*) AS active_count FROM (
 SELECT 'HISTORY' lane FROM gowm_history.historical_trajectory_projection_queue WHERE data_scope_key=$1 AND state='RUNNING' AND lease_until>clock_timestamp()
 UNION ALL SELECT 'TRACKLET' FROM gowm_history.tracklet_projection_queue WHERE data_scope_key=$1 AND state='RUNNING' AND lease_until>clock_timestamp()
 UNION ALL SELECT 'FINALIZATION' FROM gowm_history.tracklet_finalization_queue q JOIN mobility_tracklet_version v USING(tracklet_version_id)
 JOIN mobility_tracklet t USING(tracklet_id) WHERE t.data_scope_key=$1 AND q.state='RUNNING' AND q.lease_until>clock_timestamp()) active GROUP BY 1`,[scope]);
 const evaluated=await c.query(`SELECT count(*) evaluations,count(*) FILTER(WHERE e.reused) reused,
 percentile_cont(.95) WITHIN GROUP(ORDER BY extract(epoch FROM(e.claimed_at-q.created_at))*1000) claim_wait_p95_ms,
 percentile_cont(.95) WITHIN GROUP(ORDER BY extract(epoch FROM(q.processed_at-e.claimed_at))*1000) compute_p95_ms
 FROM gowm_history.historical_request_evaluation e JOIN gowm_history.historical_trajectory_projection_queue q USING(queue_id)
 WHERE q.data_scope_key=$1 AND q.processed_at>=clock_timestamp()-interval '15 minutes'`,[scope]);
 console.log(JSON.stringify({scope,...result.rows[0],states:states.rows,queues:queues.rows,resets:resets.rows,active:active.rows,evaluated:evaluated.rows[0]},null,2));await c.query('COMMIT');
}finally{c.release();await pool.end();}
