import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import pg from 'pg';
import {configureLocalExecutionBounds} from '../../packages/historical-trace-runtime/src/database.js';

const url=process.env.GOWM_V071_REUSE_DATABASE_URL;
if(!url||!new URL(url).pathname.startsWith('/gowm_v071_concurrency_scale_'))throw Error('Isolated populated concurrency scale database required');
const pool=new pg.Pool({connectionString:url,max:1});
const source=await readFile('packages/historical-trace-runtime/src/historical-trajectory-materializer.ts','utf8');
const sql=source.match(/const trackletInputRows = await connection.query<Record<string, unknown>>\(`([\s\S]*?)`, \[selectedIds/)?.[1];
assert.ok(sql);
const legacy=`SELECT input.tracklet_version_id,input.measurement_id,input.observation_id,input.time_solution_id,
 input.segment_no,input.ordinal_no,measurement.command_fingerprint,measurement.created_at AS measurement_created_at,
 solution.phenomenon_time_estimate,solution.solution_method,solution.created_at AS solution_created_at
 FROM public.mobility_tracklet_input input JOIN public.mobility_tracklet_version version USING(tracklet_version_id)
 JOIN public.mobility_tracklet tracklet USING(tracklet_id) JOIN public.measurement measurement USING(measurement_id)
 JOIN public.observation_time_solution solution ON solution.time_solution_id=input.time_solution_id
 WHERE input.tracklet_version_id=ANY($1::uuid[]) AND tracklet.data_scope_key=$2
 AND measurement.created_at<=$3::timestamptz AND solution.created_at<=$3::timestamptz
 ORDER BY input.tracklet_version_id,input.segment_no,input.ordinal_no,input.measurement_id`;
const client=await pool.connect();
try{
 await client.query('BEGIN READ ONLY');await configureLocalExecutionBounds(client);
 const head=(await client.query(`SELECT h.current_version_id id,t.data_scope_key scope,v.sample_count,v.created_at
 FROM mobility_tracklet_head h JOIN mobility_tracklet t USING(tracklet_id)
 JOIN mobility_tracklet_version v ON v.tracklet_version_id=h.current_version_id
 WHERE t.world_object_id IS NOT NULL ORDER BY v.sample_count DESC LIMIT 1`)).rows[0];
 assert.ok(head.sample_count>=20000);
 await client.query('SET LOCAL ROLE gowm_history_worker_service');
 await client.query('SELECT gowm_history_v1.set_data_scope($1)',[head.scope]);
 const parameters=[[head.id],head.scope,new Date().toISOString()];
 const plan=(await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,parameters)).rows[0]['QUERY PLAN'];
 assert.ok(plan[0]['Execution Time']<30000);
 for(const args of [parameters,[[head.id],head.scope,'2000-01-01T00:00:00Z'],[[head.id],'wrong-scope',parameters[2]],[[],head.scope,parameters[2]]]){
  assert.deepEqual((await client.query(sql,args)).rows,(await client.query(legacy,args)).rows);
 }
 await writeFile('reports/history-concurrency-2026-09-09/prefetch-plan.json',JSON.stringify(plan,null,2)+'\n');
 const result={status:'PASS',gate:'HISTORY_PREFETCH',samples:head.sample_count,executionMs:plan[0]['Execution Time'],legacyParity:true,frozenBoundary:true,crossScope:true,emptySelection:true};
 await writeFile('reports/history-concurrency-2026-09-09/prefetch-result.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));await client.query('COMMIT');
}finally{client.release();await pool.end();}
