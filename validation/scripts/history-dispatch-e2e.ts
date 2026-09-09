import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {withMigratedV071Database} from './gowm-v07-postgres-harness.js';
import {fixtureIdentity,seedFixtureFoundation,seedTaskEvents,seedPositions,seedCompleteWatermark,projectFixture} from './history-concurrency-fixture.js';
import {PostgresTrackletProjectionRepository} from '../../packages/historical-trace-runtime/src/tracklet-projection-repository.js';
import {guardedProjectionPool} from '../../packages/historical-trace-runtime/src/projection-execution.js';
import {withProjectionTransaction,ProjectionFenceLostError} from '../../packages/historical-trace-runtime/src/database.js';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
await withMigratedV071Database('dispatch',async(url,versions,runId)=>{
 const admin=new pg.Pool({connectionString:url,max:2});
 const work=new pg.Pool({connectionString:url,max:2,options:'-c role=gowm_history_worker_service'});
 const lease=new pg.Pool({connectionString:url,max:2,options:'-c role=gowm_history_worker_service'});
 const repo=new PostgresTrackletProjectionRepository(work,{leasePool:lease});
 const a=fixtureIdentity('a'+runId),b=fixtureIdentity('b'+runId);
 try {
  for(const f of[a,b]){await seedFixtureFoundation(admin,f);await seedTaskEvents(admin,f);await seedPositions(admin,f);await seedCompleteWatermark(admin,f);await projectFixture(admin,work,f,runId);}
  // Replay the unmodified pre-085 function under a test-only name and compare the entire immutable version.
  const original=await readFile('database/migrations/009_gowm_plus_canonical_evidence_and_mobility.sql','utf8');
  const start=original.indexOf('CREATE FUNCTION gowm_rebuild_mobility_tracklet('),end=original.indexOf('$fn$;',start)+5;
  await admin.query(original.slice(start,end).replace('CREATE FUNCTION gowm_rebuild_mobility_tracklet(','CREATE FUNCTION test_legacy_rebuild('));
  for(const f of[a,b]){
   const args=[f.dataScopeKey,f.sourceKey,f.targetKey,f.trackerSessionKey,'default','source-local-default'];
   const before=(await admin.query('SELECT gowm_rebuild_mobility_tracklet($1,$2,$3,$4,$5,$6) id',args)).rows[0].id;
   const immutable=(await admin.query('SELECT to_jsonb(v) v FROM mobility_tracklet_version v WHERE tracklet_version_id=$1',[before])).rows[0].v;
   assert.equal((await admin.query('SELECT test_legacy_rebuild($1,$2,$3,$4,$5,$6) id',args)).rows[0].id,before);
  assert.deepEqual((await admin.query('SELECT to_jsonb(v) v FROM mobility_tracklet_version v WHERE tracklet_version_id=$1',[before])).rows[0].v,immutable);
  }
  // The retained composite FK still rejects orphan or mismatched evidence after
  // removing its two transitive, per-row duplicate checks.
  for(const bad of ['observation','time']){
   const client=await admin.connect();
   try{
    await client.query('BEGIN');
    const id=randomUUID();
    await client.query(`INSERT INTO mobility_tracklet_version SELECT (jsonb_populate_record(NULL::mobility_tracklet_version,
      to_jsonb(v)||jsonb_build_object('tracklet_version_id',$1::text,'version_no',100000,
        'content_hash',encode(digest($1::text,'sha256'),'hex')))).*
      FROM mobility_tracklet_version v JOIN mobility_tracklet_head h ON h.current_version_id=v.tracklet_version_id LIMIT 1`,[id]);
    await assert.rejects(client.query(`INSERT INTO mobility_tracklet_input
      SELECT $1,measurement_id,CASE WHEN $2='observation' THEN 'missing-observation' ELSE observation_id END,
        CASE WHEN $2='time' THEN gen_random_uuid() ELSE time_solution_id END,segment_no,ordinal_no
      FROM mobility_tracklet_input LIMIT 1`,[id,bad]),(e:unknown)=>(e as {code:string}).code==='23503');
   }finally{await client.query('ROLLBACK');client.release();}
  }
  const enqueue=async(f:typeof a)=>(await admin.query(`SELECT gowm_history.enqueue_tracklet_projection($1,$2,$3,$4,'default','source-local-default',grounding_sha256($5)) id`,[f.dataScopeKey,f.sourceKey,f.targetKey,f.trackerSessionKey,randomUUID()])).rows[0].id;
  const identityReader=await admin.connect();
  try{
   await identityReader.query('BEGIN');await identityReader.query('SELECT * FROM mobility_tracklet WHERE source_key=$1 FOR SHARE',[a.sourceKey]);
   const args=[a.dataScopeKey,a.sourceKey,a.targetKey,a.trackerSessionKey,'default','source-local-default'];
   await work.query("SET statement_timeout='1s'");
   await work.query('SELECT gowm_history.rebuild_mobility_tracklet_v2($1,$2,$3,$4,$5,$6,false)',args);
  }finally{await identityReader.query('ROLLBACK');identityReader.release();await work.query('RESET statement_timeout');}
  await enqueue(a);await sleep(400);await enqueue(a);await sleep(400);await enqueue(a);
  assert.equal((await repo.claimTracklets('early',1,3)).length,0);
  await sleep(250);const first=(await repo.claimTracklets('worker-a',1,.6))[0]!;assert.ok(first);
  await enqueue(a);await enqueue(b);await sleep(1100);
  const parallel=await repo.claimTracklets('worker-b',2,3);
  // First claim expired; generation changes on reclamation, while the other device is also eligible.
  assert.equal(parallel.length,2);const reclaimed=parallel.find(c=>c.queueId===first.queueId)!;assert.ok(reclaimed.generation>first.generation);
  await assert.rejects(repo.withLease(first,'projection',()=>repo.rebuildAndComplete(first)),ProjectionFenceLostError);
  for(const claim of parallel)await repo.withLease(claim,'projection',()=>repo.rebuildAndComplete(claim));
  const next=(await repo.claimTracklets('worker-next',1,.6))[0]!;assert.ok(next);assert.equal(next.sourceKey,a.sourceKey);
  await repo.withLease(next,'projection',async()=>{await sleep(1600);await repo.rebuildAndComplete(next);});
  // Live same-key work excludes another claim, even after the coalescing deadline.
  await enqueue(a);await sleep(1100);const active=(await repo.claimTracklets('owner',1,3))[0]!;
  await enqueue(a);await sleep(1100);assert.equal((await repo.claimTracklets('contender',1,3)).length,0);
  await repo.withLease(active,'projection',()=>repo.rebuildAndComplete(active));
  const pending=(await repo.claimTracklets('pending',1,3))[0]!;assert.ok(pending);
  // Cancellation during SQL must roll the transaction back before another write/commit.
  await admin.query('CREATE TABLE public.dispatch_cancel_probe(id int); GRANT INSERT ON public.dispatch_cancel_probe TO gowm_history_worker');
  const controller=new AbortController();const cancelling=new PostgresTrackletProjectionRepository(work,{leasePool:lease,signal:controller.signal});
  const timer=setTimeout(()=>controller.abort(),100);
  await assert.rejects(cancelling.withLease(pending,'projection',()=>withProjectionTransaction(guardedProjectionPool(work),async tx=>{
   await tx.query('INSERT INTO public.dispatch_cancel_probe VALUES(1)');await tx.query('SELECT pg_sleep(.4)');
  })));clearTimeout(timer);
  assert.equal(Number((await admin.query('SELECT count(*) n FROM dispatch_cancel_probe')).rows[0].n),0);
  await repo.withLease(pending,'projection',()=>repo.rebuildAndComplete(pending));
  const version=(await admin.query('SELECT current_version_id id FROM mobility_tracklet_head h JOIN mobility_tracklet t USING(tracklet_id) WHERE t.source_key=$1',[a.sourceKey])).rows[0].id;
  await admin.query('SELECT gowm_history.enqueue_tracklet_finalization($1,clock_timestamp(),grounding_sha256($2))',[version,randomUUID()]);
  const finals=await repo.claimFinalizations('finalizer',1,.6);assert.equal(finals.length,1);
  await admin.query('SELECT gowm_history.enqueue_tracklet_finalization($1,clock_timestamp(),grounding_sha256($2))',[version,randomUUID()]);
  assert.equal((await repo.claimFinalizations('other-finalizer',1,3)).length,0,'one version may have only one live finalization');
  await repo.withLease(finals[0]!,'finalization',async()=>{await sleep(1600);await repo.finalizeAndComplete(await repo.loadFinalization(finals[0]!));});
   await enqueue(a);await sleep(1100);const exhausted=(await repo.claimTracklets('exhausted',1,3))[0]!;
  await admin.query("UPDATE gowm_history.tracklet_projection_queue SET attempts=10,locked_at=clock_timestamp()-interval '2 seconds',lease_until=clock_timestamp()-interval '1 second' WHERE queue_id=$1",[exhausted.queueId]);
  await enqueue(b);await sleep(1100);const unaffected=(await repo.claimTracklets('unaffected',1,3))[0]!;assert.equal(unaffected.sourceKey,b.sourceKey);
  await repo.withLease(unaffected,'projection',()=>repo.rebuildAndComplete(unaffected));
  assert.deepEqual((await admin.query('SELECT state,attempts FROM gowm_history.tracklet_projection_queue WHERE queue_id=$1',[exhausted.queueId])).rows[0],{state:'RUNNING',attempts:10});
  assert.deepEqual((await admin.query(`SELECT has_table_privilege('gowm_history_worker_service','gowm_history.tracklet_dispatch','INSERT') dispatch_write,
   has_table_privilege('gowm_history_worker_service','gowm_history.historical_request_evaluation','INSERT') proof_write,
   has_function_privilege('gowm_history_service','gowm_history.renew_tracklet_projection(uuid,text,bigint,interval)','EXECUTE') reader_renew`)).rows[0],{dispatch_write:false,proof_write:false,reader_renew:false});
  console.log(JSON.stringify({status:'PASS',gate:'HISTORY_DISPATCH',...versions,stableIdentityDoesNotBlockFinalization:true,nonSlidingWindow:true,nextRound:true,deviceParallelism:true,sameKeyMutex:true,
   expiryReclaim:true,oldGenerationRejected:true,rebuildRenewal:true,finalizationRenewal:true,finalizationMutex:true,cancellationRollback:true,legacyContentHashUnchanged:true,minimalPrivileges:true,evidenceForeignKeyChainPreserved:true,exhaustedKeyCannotStarveOtherDevices:true}));
 }finally{await lease.end();await work.end();await admin.end();}
},{currentSchema:true});
