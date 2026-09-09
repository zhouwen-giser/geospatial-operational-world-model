import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {PostgresMobilityDbTrajectorySlicer} from '../../packages/historical-trace-runtime/src/trajectory-repository.js';
import type {SqlPool} from '../../packages/historical-trace-runtime/src/database.js';
const url=process.env.DATABASE_URL;
if(!url||!new URL(url).pathname.startsWith('/gowm_history_repair_'))throw Error('isolated history repair database required');
const pool=new pg.Pool({connectionString:url,max:2});
const reader=new pg.Pool({connectionString:url,max:1,options:'-c role=gowm_history_worker_service'});
const c=await pool.connect();const version=randomUUID();
try {
 await c.query('BEGIN');
 const seed=(await c.query(`SELECT to_jsonb(v) v,to_jsonb(m) m,to_jsonb(ts) ts,to_jsonb(run) run,to_jsonb(pos) pos
 FROM mobility_tracklet_version v JOIN mobility_tracklet_input i USING(tracklet_version_id)
 JOIN measurement m USING(measurement_id) JOIN position_measurement pos USING(measurement_id) JOIN observation_time_solution ts ON ts.time_solution_id=m.time_solution_id
 JOIN processing_run run ON run.processing_run_id=ts.processing_run_id LIMIT 1`)).rows[0];assert.ok(seed);
 await c.query(`CREATE TEMP TABLE perf_ids AS SELECT n,gen_random_uuid() run,gen_random_uuid() ts,gen_random_uuid() m,
 '2026-09-07 07:00:00+00'::timestamptz+(n-1)*interval '1 second' event FROM generate_series(1,70000) n`);
 await c.query(`INSERT INTO processing_run SELECT (jsonb_populate_record(NULL::processing_run,$1::jsonb||jsonb_build_object('processing_run_id',run))).* FROM perf_ids`,[seed.run]);
 await c.query(`INSERT INTO observation_time_solution SELECT (jsonb_populate_record(NULL::observation_time_solution,$1::jsonb||
 jsonb_build_object('time_solution_id',ts,'processing_run_id',run,'phenomenon_time_estimate',event,
 'phenomenon_time_window','['||event||','||(event+interval '1 millisecond')||')','supersedes_time_solution_id',NULL))).* FROM perf_ids`,[seed.ts]);
 await c.query(`INSERT INTO measurement SELECT (jsonb_populate_record(NULL::measurement,$1::jsonb||
 jsonb_build_object('measurement_id',m,'processing_run_id',run,'time_solution_id',ts))).* FROM perf_ids WHERE n<=15000`,[seed.m]);
 await c.query(`INSERT INTO position_measurement SELECT (jsonb_populate_record(NULL::position_measurement,$1::jsonb||
 jsonb_build_object('measurement_id',m))).* FROM perf_ids WHERE n<=15000`,[seed.pos]);
 await c.query(`CREATE TEMP TABLE perf_geometry AS SELECT ('['||string_agg('POINT('||(500000+n)::text||' '||(3300000+n%2)::text||')@'||event,',' ORDER BY n)||']')::tgeompoint trajectory FROM perf_ids WHERE n<=15000`);
 await c.query(`INSERT INTO mobility_tracklet_version SELECT (jsonb_populate_record(NULL::mobility_tracklet_version,$1::jsonb||
 jsonb_build_object('tracklet_version_id',$2::text,'version_no',900001,'trajectory',trajectory::text,
 'extent_box',stbox(trajectory)::text,'start_event_time',startTimestamp(trajectory),'end_event_time',endTimestamp(trajectory),
 'start_position',startValue(trajectory)::text,'end_position',endValue(trajectory)::text,'sample_count',15000,'sequence_count',1,
 'content_hash',repeat('c',64)))).* FROM perf_geometry`,[seed.v,version]);
 await c.query(`INSERT INTO mobility_tracklet_segment SELECT $1::uuid,1,trajectory,15000,startTimestamp(trajectory),endTimestamp(trajectory) FROM perf_geometry`,[version]);
 await c.query(`INSERT INTO mobility_tracklet_input(tracklet_version_id,measurement_id,observation_id,time_solution_id,segment_no,ordinal_no)
 SELECT $1::uuid,m,$2,ts,1,n FROM perf_ids WHERE n<=15000`,[version,seed.m.observation_id]);
 await c.query('COMMIT');
 await c.query('ANALYZE observation_time_solution');await c.query('ANALYZE mobility_tracklet_input');
 const slicer=new PostgresMobilityDbTrajectorySlicer(reader as unknown as SqlPool);
 const base=Date.parse('2026-09-07T07:00:00Z');
 const request={dataScopeKey:'default',sourceTrackletVersionId:version,sourceSegmentNo:1,
  period:{start:new Date(base).toISOString(),end:new Date(base+15000*1000).toISOString(),bounds:'[)' as const},evidenceSamples:true};
 const began=performance.now();const sliced=await slicer.slice(request);const elapsedMs=performance.now()-began;
 assert.equal(sliced?.sampleCount,15000);assert.ok(elapsedMs<30000,`slice took ${elapsedMs} ms`);
 assert.equal((await slicer.slice({...request,dataScopeKey:'history-other-scope'})),undefined);
 const interior=await slicer.slice({...request,period:{...request.period,start:new Date(base+500).toISOString(),end:new Date(base+700).toISOString()}});
 assert.equal(interior?.sampleCount,0);
 const boundary=await slicer.slice({...request,period:{...request.period,end:new Date(base+1000).toISOString()}});assert.equal(boundary?.sampleCount,1);
 const inclusive=await slicer.slice({...request,requestedEnd:request.period.end,period:{...request.period,end:new Date(base+1000).toISOString()}});assert.equal(inclusive?.sampleCount,2);
 console.log(JSON.stringify({status:'PASS',gate:'LONG_TRACKLET_SLICER',points:15000,timeSolutions:70000,elapsedMs,version,
 zeroOriginalSamples:true,exclusiveBoundary:true,inclusiveInternalBoundary:true,scopeIsolation:true}));
}finally{await c.query('ROLLBACK').catch(()=>{});c.release();await reader.end();await pool.end();}
