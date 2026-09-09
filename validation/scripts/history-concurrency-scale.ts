import assert from 'node:assert/strict';
import pg from 'pg';
import {mkdir,writeFile} from 'node:fs/promises';
import type {SqlPool} from '../../packages/historical-trace-runtime/src/database.js';
import {randomUUID} from 'node:crypto';
import {withMigratedV071Database} from './gowm-v07-postgres-harness.js';
import {fixtureIdentity,seedFixtureFoundation,seedTaskEvents,seedPositions,seedCompleteWatermark,projectFixture,loadIntervalPin,historicalQuery,snapshotManifest,insertPosition} from './history-concurrency-fixture.js';
import {createPostgresHistoricalProjectionStages} from '../../services/projection-worker/src/historical-runtime-adapter.js';
import {ProjectionWorker,type ProjectionWorkerComponents} from '../../services/projection-worker/src/worker.js';
import {PostgresMobilityDbTrajectorySlicer} from '../../packages/historical-trace-runtime/src/trajectory-repository.js';
import {HISTORICAL_TRACE_SQL,historicalSemanticRequestHash} from '../../services/providers/historical-trace-provider/src/repository.js';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const idle:ProjectionWorkerComponents={observations:{claimBatch:async()=>[],markFailure:async()=>{}},events:{unpublished:async()=>[],markPublished:async()=>{}},processor:{process:async()=>({} as never)},operational:{projectPending:async()=>0},bus:{publishEvent:async()=>{},drain:async()=>{}}};
const p95=(items:number[])=>[...items].sort((a,b)=>a-b)[Math.ceil(items.length*.95)-1]!;
await withMigratedV071Database('concurrency_scale',async(url,versions,runId)=>{
 if(!new URL(url).pathname.startsWith('/gowm_v071_concurrency_scale_'))throw Error('Isolated concurrency scale database required');
 const admin=new pg.Pool({connectionString:url,max:8});
 const workerPool=new pg.Pool({connectionString:url,max:8,options:'-c role=gowm_history_worker_service'});
 const providerPool=new pg.Pool({connectionString:url,max:2,options:'-c role=gowm_history_service'});
 runId=process.env.GOWM_SCALE_RUN_ID??runId;
 const fixtureA=fixtureIdentity('a'+runId),fixtureB=fixtureIdentity('b'+runId);fixtureB.dataScopeKey=fixtureA.dataScopeKey;
 const fixtures=[fixtureA,fixtureB];const versionIds:string[]=[];
 try{
  if(process.env.GOWM_SCALE_RESUME) for(const f of fixtures){
   const row=(await admin.query(`SELECT o.subject_id,ts.clock_model_id,ts.processing_run_id,identity.reference_key FROM world_observation o
    JOIN observation_time_solution ts USING(observation_id) JOIN mobility_tracklet t ON t.source_key=o.source
    JOIN world_reference_identity identity ON identity.internal_id=t.world_object_id AND identity.entity_kind='WORLD_OBJECT' AND identity.data_scope_key=t.data_scope_key
    WHERE o.source=$1 AND t.world_object_id IS NOT NULL LIMIT 1`,[f.sourceKey])).rows[0];
   f.subjectReferenceKey=row.reference_key;f.clockModelId=row.clock_model_id;f.processingRunId=row.processing_run_id;
  }
  if(!process.env.GOWM_SCALE_RESUME) for(const f of fixtures){await seedFixtureFoundation(admin,f);await seedTaskEvents(admin,f);await seedPositions(admin,f);await seedCompleteWatermark(admin,f);await projectFixture(admin,workerPool,f,runId);}
  if(!process.env.GOWM_SCALE_LOAD_ONLY){
  const c=await admin.connect();
  try{
   if(!process.env.GOWM_SCALE_RESUME){
   await c.query('BEGIN');
   // Bulk fixture load only; re-enable before live measurements are exercised.
   await c.query('ALTER TABLE position_measurement DISABLE TRIGGER position_measurement_tracklet_dirty_queue');
   for(const [device,f] of fixtures.entries()){
    const seed=(await c.query(`SELECT to_jsonb(o) o,to_jsonb(m) m,to_jsonb(ts) ts,to_jsonb(pos) pos,to_jsonb(run) run
      FROM world_observation o JOIN measurement m USING(observation_id) JOIN position_measurement pos USING(measurement_id)
      JOIN observation_time_solution ts ON ts.time_solution_id=m.time_solution_id JOIN processing_run run ON run.processing_run_id=m.processing_run_id
      WHERE o.source=$1 LIMIT 1`,[f.sourceKey])).rows[0];
    await c.query(`CREATE TEMP TABLE scale_ids AS SELECT n,gen_random_uuid() m,gen_random_uuid() ts,gen_random_uuid() run,
      'scale-'||gen_random_uuid()::text obs,'2026-08-29 12:00:00Z'::timestamptz+n*interval '1 second' event FROM generate_series(1,$1::int)n`,[device===0?130000:20000]);
    await c.query(`INSERT INTO processing_run SELECT(jsonb_populate_record(NULL::processing_run,$1::jsonb||jsonb_build_object('processing_run_id',run))).* FROM scale_ids`,[seed.run]);
    await c.query(`INSERT INTO world_observation SELECT(jsonb_populate_record(NULL::world_observation,$1::jsonb||jsonb_build_object(
      'observation_id',obs,'source_record_key',obs,'observed_at',event,'received_at',clock_timestamp(),'payload_hash','sha256:'||md5(obs)||md5(obs)))).* FROM scale_ids WHERE n<=20000`,[seed.o]);
    await c.query(`INSERT INTO world_observation_head(source_key,source_record_key,current_observation_id) SELECT $1,obs,obs FROM scale_ids WHERE n<=20000`,[f.sourceKey]);
    await c.query(`INSERT INTO observation_time_solution SELECT(jsonb_populate_record(NULL::observation_time_solution,$1::jsonb||jsonb_build_object(
      'time_solution_id',ts,'processing_run_id',run,'observation_id',CASE WHEN n<=20000 THEN obs ELSE $2 END,
      'phenomenon_time_estimate',event,'phenomenon_time_window','['||event||','||(event+interval '1 millisecond')||')','supersedes_time_solution_id',NULL))).* FROM scale_ids`,[seed.ts,seed.o.observation_id]);
    await c.query(`INSERT INTO measurement SELECT(jsonb_populate_record(NULL::measurement,$1::jsonb||jsonb_build_object(
      'measurement_id',m,'observation_id',obs,'time_solution_id',ts,'processing_run_id',run,'command_fingerprint','sha256:'||md5(obs)||md5(obs)))).* FROM scale_ids WHERE n<=20000`,[seed.m]);
    await c.query(`INSERT INTO position_measurement SELECT(jsonb_populate_record(NULL::position_measurement,$1::jsonb||jsonb_build_object(
      'measurement_id',m,'position',ST_AsEWKT(ST_SetSRID(ST_MakePoint(448000+n*.1,4417000+n%2*.01),32650))))).* FROM scale_ids WHERE n<=20000`,[seed.pos]);
    await c.query('DROP TABLE scale_ids');
   }
   await c.query('ALTER TABLE position_measurement ENABLE TRIGGER position_measurement_tracklet_dirty_queue');await c.query('COMMIT');
   }
   for(const f of fixtures){const v=(await c.query('SELECT gowm_history.rebuild_mobility_tracklet_v2($1,$2,$3,$4,\'default\',\'source-local-default\',false) id',[f.dataScopeKey,f.sourceKey,f.targetKey,f.trackerSessionKey])).rows[0].id;versionIds.push(v);}
   const seed=(await c.query('SELECT to_jsonb(v) v,to_jsonb(t) t FROM mobility_tracklet_version v JOIN mobility_tracklet t USING(tracklet_id) WHERE v.tracklet_version_id=$1',[versionIds[0]])).rows[0];
   const unrelated=randomUUID();
   await c.query(`INSERT INTO mobility_tracklet SELECT(jsonb_populate_record(NULL::mobility_tracklet,$1::jsonb||jsonb_build_object('tracklet_id',$2::text,'source_local_target_id','unrelated-history-'||$2::text,'world_object_id',NULL))).*`,[seed.t,unrelated]);
   await c.query('CREATE TEMP TABLE scale_versions AS SELECT n,gen_random_uuid() id FROM generate_series(1,1000)n');
   const columns=(await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='mobility_tracklet_version' ORDER BY ordinal_position`)).rows.map(r=>r.column_name as string);
   const expressions=columns.map(name=>({tracklet_version_id:'copies.id',tracklet_id:'$2::uuid',version_no:'copies.n',content_hash:'md5(copies.id::text)||md5(copies.id::text)'} as Record<string,string>)[name]??`source.${name}`);
   await c.query(`INSERT INTO mobility_tracklet_version(${columns.join(',')}) SELECT ${expressions.join(',')} FROM scale_versions copies CROSS JOIN mobility_tracklet_version source WHERE source.tracklet_version_id=$1`,[versionIds[0],unrelated]);
   console.log(JSON.stringify({stage:'SCALE_INPUT_FILL',rows:20000000}));
   // Background cardinality fixture: copy already validated foreign-key tuples.
   // Suppress repeated FK trigger work only for this isolated seed transaction;
   // live evidence and every worker transaction retain all normal constraints.
   assert.equal(Number((await c.query(`SELECT count(*) n FROM (SELECT * FROM mobility_tracklet_input WHERE tracklet_version_id=$1 LIMIT 20000) i
    JOIN measurement m USING(measurement_id,observation_id,time_solution_id) JOIN position_measurement p USING(measurement_id)
    JOIN world_observation o USING(observation_id) JOIN observation_time_solution ts USING(time_solution_id)`,[versionIds[0]])).rows[0].n),20000);
   await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
   await c.query(`INSERT INTO mobility_tracklet_input(tracklet_version_id,measurement_id,observation_id,time_solution_id,segment_no,ordinal_no)
     SELECT v.id,i.measurement_id,i.observation_id,i.time_solution_id,i.segment_no,i.ordinal_no FROM scale_versions v
     CROSS JOIN (SELECT * FROM mobility_tracklet_input WHERE tracklet_version_id=$1 LIMIT 20000)i`,[versionIds[0]]);
   await c.query('COMMIT');assert.equal((await c.query('SHOW session_replication_role')).rows[0].session_replication_role,'origin');
   for(const table of ['observation_time_solution','mobility_tracklet_input','mobility_tracklet_version']) await c.query(`ANALYZE ${table}`);
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
  }else for(const f of fixtures) versionIds.push((await admin.query('SELECT current_version_id id FROM mobility_tracklet_head h JOIN mobility_tracklet t USING(tracklet_id) WHERE t.source_key=$1 AND t.world_object_id IS NOT NULL',[f.sourceKey])).rows[0].id);
  await admin.query(`DROP TRIGGER IF EXISTS scale_claim ON gowm_history.historical_trajectory_projection_queue; DROP TABLE IF EXISTS public.scale_claim_audit;
   CREATE TABLE public.scale_claim_audit(wait_ms double precision); CREATE OR REPLACE FUNCTION public.scale_record_claim() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $fn$
   BEGIN IF NEW.state='RUNNING' AND NEW.attempts=1 AND OLD.state<>'RUNNING' THEN INSERT INTO public.scale_claim_audit VALUES(extract(epoch FROM(NEW.locked_at-NEW.created_at))*1000); END IF; RETURN NEW; END $fn$;
   CREATE TRIGGER scale_claim AFTER UPDATE ON gowm_history.historical_trajectory_projection_queue FOR EACH ROW EXECUTE FUNCTION public.scale_record_claim()`);
  const fixtureCounts=(await admin.query(`SELECT (SELECT count(*) FROM observation_time_solution) time_solutions,
    (SELECT count(*) FROM mobility_tracklet_input i JOIN mobility_tracklet_version v USING(tracklet_version_id)
      JOIN mobility_tracklet t USING(tracklet_id) WHERE t.world_object_id IS NULL) unrelated_inputs`)).rows[0];
  assert.ok(Number(fixtureCounts.time_solutions)>=150000);assert.equal(Number(fixtureCounts.unrelated_inputs),20000000);
  let explain:unknown;
  const explainedPool={query:workerPool.query.bind(workerPool),connect:async()=>{
   const client=await workerPool.connect();return {release:()=>client.release(),query:async(sql:string,values?:unknown[])=>{
    if(sql.includes('WITH source AS MATERIALIZED')) explain=(await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'];
    return client.query(sql,values);
   }};
  }} as unknown as SqlPool;
  const slicer=new PostgresMobilityDbTrajectorySlicer(explainedPool);
  const segment=(await admin.query('SELECT segment_no,start_time,end_time,sample_count FROM mobility_tracklet_segment WHERE tracklet_version_id=$1 ORDER BY sample_count DESC LIMIT 1',[versionIds[0]])).rows[0];
  const started=performance.now();const slice=await slicer.slice({dataScopeKey:fixtureA.dataScopeKey,sourceTrackletVersionId:versionIds[0]!,sourceSegmentNo:segment.segment_no,
    period:{start:segment.start_time.toISOString(),end:new Date(segment.end_time.getTime()+1).toISOString(),bounds:'[)'},evidenceSamples:true});
  const sliceMs=performance.now()-started;assert.equal(slice?.sampleCount,segment.sample_count);assert.ok(sliceMs<30000);
  await mkdir('reports/history-concurrency-2026-09-09',{recursive:true});
  await writeFile('reports/history-concurrency-2026-09-09/scale-plan.json',JSON.stringify(explain,null,2)+'\n');
  const configurations=fixtures.map(()=>({leasePool:new pg.Pool({connectionString:url,max:2,options:'-c role=gowm_history_worker_service'}),
    requestPool:new pg.Pool({connectionString:url,max:2,options:'-c role=gowm_history_worker_service'}),
    trackletPool:new pg.Pool({connectionString:url,max:1,options:'-c role=gowm_history_worker_service'}),
    finalizationPool:new pg.Pool({connectionString:url,max:1,options:'-c role=gowm_history_worker_service'})}));
  const controller=new AbortController();let running=true;
  const workers=configurations.map((p,index)=>new ProjectionWorker(workerPool,{workerId:`scale-${index}`,components:idle,historical:createPostgresHistoricalProjectionStages(workerPool,{...p,signal:controller.signal})}));
  const queries=[];
  for(const f of fixtures){const pin=await loadIntervalPin(admin,f);const q=historicalQuery(f,pin.referenceKey);q.sourceSelectionProfileReferenceKey={...q.sourceSelectionProfileReferenceKey,id:'trajectory-single-authoritative-v2',version:'2.0'};queries.push(q);}
  const loops=workers.flatMap(w=>(['CORE','TRACKLET','FINALIZATION','HISTORY','HISTORY'] as const).map(async lane=>{while(running){await w.tick(lane);await sleep(100);}}));
  console.log(JSON.stringify({stage:'WARMUP_STARTED',seconds:35}));await sleep(35000);
  const latency:number[]=[];const failures:unknown[]=[];const watchers:Promise<void>[]=[];const startWall=Date.now();
  const ordinalBase=Date.now();
  const eventBase=new Date((await admin.query('SELECT max(v.end_event_time) end FROM mobility_tracklet_head h JOIN mobility_tracklet_version v ON v.tracklet_version_id=h.current_version_id JOIN mobility_tracklet t ON t.tracklet_id=h.tracklet_id WHERE t.source_key=ANY($1)',[fixtures.map(f=>f.sourceKey)])).rows[0].end).getTime()+1000;
  console.log(JSON.stringify({stage:'LOAD_STARTED',durationSeconds:600,sliceMs,migrationHead:versions.migrationHead}));
  try{
   for(let second=0;second<600;second++){
    await sleep(Math.max(0,startWall+second*1000-Date.now()));
    for(const [index,f]of fixtures.entries()){
     const event=new Date(eventBase+second*1000).toISOString();
     await insertPosition(admin,f,{ordinal:ordinalBase+second,phenomenonTime:event,x:448004+second*.1});const commit=Date.now();
     watchers.push((async()=>{for(let n=0;n<400;n++){const head=(await admin.query(`SELECT v.end_event_time FROM mobility_tracklet t JOIN mobility_tracklet_head h USING(tracklet_id)
       JOIN mobility_tracklet_version v ON v.tracklet_version_id=h.current_version_id WHERE t.data_scope_key=$1 AND t.source_local_target_id=$2`,[f.dataScopeKey,f.targetKey])).rows[0];
       if(head?.end_event_time.getTime()>=Date.parse(event)){latency.push(Date.now()-commit);return;}await sleep(100);}throw Error('real-time head visibility exceeded 40s');})().catch(error=>{failures.push(error);}));
     if(second%10===0){const snapshot=snapshotManifest(`scale-${index}-${second}`,new Date().toISOString());const q=queries[index]!;const enqueue=await providerPool.connect();try{await enqueue.query('BEGIN');await enqueue.query(HISTORICAL_TRACE_SQL.setScope,[f.dataScopeKey]);
       await enqueue.query(HISTORICAL_TRACE_SQL.enqueueProjection,[f.dataScopeKey,q.subjectReferenceKey.id,q.executionIntervalReferenceKey.id,Number(q.executionIntervalReferenceKey.version),q.phaseScope,historicalSemanticRequestHash(q),snapshot.manifestHash,snapshot.capturedAt,JSON.stringify(q),JSON.stringify(snapshot)]);await enqueue.query('COMMIT');}finally{enqueue.release();}}
    }
   }
   await Promise.all(watchers);
  }finally{running=false;await Promise.allSettled(loops);controller.abort();await Promise.all(configurations.flatMap(p=>Object.values(p).map(pool=>pool.end())));}
  const queues=await admin.query(`SELECT extract(epoch FROM(coalesce(processed_at,clock_timestamp())-created_at))*1000 elapsed_ms,
    state,attempts,trajectory_revision_id IS NOT NULL AS materialized FROM gowm_history.historical_trajectory_projection_queue WHERE data_scope_key=$1 AND created_at>=to_timestamp($2/1000.0)`,[fixtureA.dataScopeKey,startWall]);
  // locked_at is cleared on completion; request evaluations carry a durable claim timestamp in queue audit below.
  const waits=await admin.query(`SELECT wait_ms FROM public.scale_claim_audit`);
  const waitP95=p95(waits.rows.map(r=>Number(r.wait_ms)));
  const passed=failures.length===0&&latency.length===1200&&p95(latency)<=5000&&waitP95<=2000&&queues.rows.length===120&&queues.rows.every(r=>r.state==='COMPLETED')&&queues.rows.some(r=>r.materialized);
  const report={status:passed?'PASS':'FAIL',gate:'HISTORY_CONCURRENCY_SCALE',pointsPerDevice:20000,timeSolutions:150000,unrelatedInputs:20000000,durationSeconds:600,
    fixtureCounts,samples:latency.length,realtimeP95Ms:p95(latency),claimP95Ms:waitP95,sliceMs,queues:queues.rows.map(r=>({state:r.state,attempts:r.attempts,materialized:r.materialized}))};
  await mkdir('reports/history-concurrency-2026-09-09',{recursive:true});
  await writeFile('reports/history-concurrency-2026-09-09/scale-plan.json',JSON.stringify(explain,null,2)+'\n');
  await writeFile('reports/history-concurrency-2026-09-09/scale-result.json',JSON.stringify(report,null,2)+'\n');
  await writeFile('reports/history-concurrency-2026-09-09/scale-latencies.json',JSON.stringify({realtimeMs:latency,claimWaitMs:waits.rows.map(r=>Number(r.wait_ms))})+'\n');
  console.log(JSON.stringify(report));assert.equal(failures.length,0);assert.equal(latency.length,1200);assert.ok(report.realtimeP95Ms<=5000);assert.ok(waitP95<=2000);assert.equal(queues.rows.length,120);assert.ok(queues.rows.every(r=>r.state==='COMPLETED'));assert.ok(queues.rows.some(r=>r.materialized),'a complete trajectory projection must commit');
 }finally{await providerPool.end();await workerPool.end();await admin.end();}
},{currentSchema:true});
