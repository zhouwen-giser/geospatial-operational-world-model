import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {mkdir,writeFile} from 'node:fs/promises';
import {ProjectionProcessor} from '../../packages/runtime/src/projection.js';
import {SituationRepository} from '../../packages/runtime/src/situation-repository.js';
import {WorldRepository} from '../../packages/runtime/src/world-repository.js';
import {RepositorySituationReadPort} from '../../services/providers/gowm-situation-provider/src/repository-adapter.js';
import {fixtureIdentity,seedFixtureFoundation,insertPosition} from './history-concurrency-fixture.js';

export async function verifyScopedSituation(databaseUrl:string){
 const pool=new pg.Pool({connectionString:databaseUrl,max:4});
 const reader=new pg.Pool({connectionString:databaseUrl,max:1,options:'-c role=gowm_situation_service'});
 const a=fixtureIdentity(randomUUID()),b=fixtureIdentity(randomUUID());const checks:string[]=[];
 try {
  await seedFixtureFoundation(pool,a);await seedFixtureFoundation(pool,b);
  const processor=new ProjectionProcessor(pool);
  for(const [f,count] of [[a,2],[b,3]] as const){
   await pool.query("UPDATE world_object SET object_type='UGV' WHERE id=$1",[f.targetKey]);
   for(let i=1;i<=count;i++){
    await insertPosition(pool,f,{ordinal:i,phenomenonTime:`2026-08-30T00:00:0${i}Z`,x:448000+i,subjectType:'UGV'});
    await processor.process(`history-queue-position-${i}-${f.targetKey}`);
   }
  }
  const cell=(await pool.query("SELECT h3_r9::text h3 FROM world_object_geometry WHERE object_id=$1",[a.targetKey])).rows[0].h3;
  const situation=new SituationRepository(reader);
  const aa=await situation.getCell(cell,a.dataScopeKey),bb=await situation.getCell(cell,b.dataScopeKey);
  assert.equal(aa?.metrics.observationCount,2);assert.equal(bb?.metrics.observationCount,3);
  assert.equal(aa?.metrics.vehicleCount,1);assert.equal(bb?.metrics.vehicleCount,1);checks.push('same_cell_two_scopes_independent_counts');
  const before=JSON.stringify(aa);await processor.process(`history-queue-position-2-${a.targetKey}`);
  const replay=await situation.getCell(cell,a.dataScopeKey);
  assert.equal(replay?.metrics.observationCount,2);assert.equal(replay?.worldVersion,aa?.worldVersion);checks.push('projection_redelivery_idempotence');
  const direct=await reader.query('SELECT * FROM gowm_situation.cell_scored');assert.equal(direct.rows.length,0);
  await assert.rejects(situation.getCell(cell),/SITUATION_DATA_SCOPE_REQUIRED/);
  await assert.rejects(reader.query('SELECT * FROM gowm_situation.cell'),/permission denied/);
  await assert.rejects(reader.query('SELECT * FROM public.situation_cell_scored'),/permission denied/);
  checks.push('scope_required_transaction_reset_and_minimal_privileges');
  for(const f of [a,b]){
   const port=new RepositorySituationReadPort(situation,new WorldRepository(reader),reader,f.dataScopeKey);
   assert.deepEqual(await port.readiness(),{ready:true,reasons:[]});
   const refs=await port.candidateReferences(f.dataScopeKey,[cell],20);
   assert.equal(refs.length,1);assert.equal(refs[0]?.id,f.subjectReferenceKey);
   const ranked=await port.ranked(f.dataScopeKey,{resolution:9,metric:'observations',order:'DESC',limit:10});
   assert.equal(ranked[0]?.metrics.observationCount,f===a?2:3);
   const area=await port.areaCells(f.dataScopeKey,{type:'Point',coordinates:[116.4,39.9]},9);
   assert.equal(area[0]?.metrics.observationCount,f===a?2:3);
   await assert.rejects(port.getCells('default',[cell]),/non-deployment/);
  }
  checks.push('multi_scope_provider_ready_ranking_area_candidates_and_authorization');
  // Counts must track current objects through every mutation; historical evidence remains.
  await pool.query("UPDATE world_object SET object_type='Agent' WHERE id=$1",[a.targetKey]);
  let changed=await situation.getCell(cell,a.dataScopeKey);assert.equal(changed?.metrics.vehicleCount,0);assert.equal(changed?.metrics.agentCount,1);
  await pool.query('UPDATE world_object SET deleted_at=clock_timestamp() WHERE id=$1',[a.targetKey]);
  changed=await situation.getCell(cell,a.dataScopeKey);assert.equal(changed?.metrics.agentCount,0);assert.equal(changed?.metrics.observationCount,2);
  await pool.query('UPDATE world_object SET deleted_at=NULL WHERE id=$1',[a.targetKey]);
  assert.equal((await situation.getCell(cell,a.dataScopeKey))?.metrics.agentCount,1);
  await pool.query(`UPDATE world_object_geometry SET geometry=ST_SetSRID(ST_MakePoint(117.4,40.9),4326),
   h3_r7=h3_latlng_to_cell(ST_SetSRID(ST_MakePoint(117.4,40.9),4326),7),h3_r8=h3_latlng_to_cell(ST_SetSRID(ST_MakePoint(117.4,40.9),4326),8),
   h3_r9=h3_latlng_to_cell(ST_SetSRID(ST_MakePoint(117.4,40.9),4326),9),h3_r10=h3_latlng_to_cell(ST_SetSRID(ST_MakePoint(117.4,40.9),4326),10)
   WHERE object_id=$1`,[a.targetKey]);
  assert.equal((await situation.getCell(cell,a.dataScopeKey))?.metrics.agentCount,0);
  assert.equal((await situation.getCell(cell,b.dataScopeKey))?.metrics.vehicleCount,1);
  checks.push('scoped_current_type_delete_restore_and_move_counters_preserve_evidence');
  assert(before.length>0);return {status:'PASS',checks,remoteDeployment:'NOT_RUN'};
 }finally{await Promise.all([reader.end(),pool.end()]);}
}
if(process.argv[1]?.endsWith('capability-situation-e2e.ts')){
 const url=process.env.GOWM_CAPABILITY_TEST_DATABASE_URL;if(!url)throw Error('GOWM_CAPABILITY_TEST_DATABASE_URL required');
 const result=await verifyScopedSituation(url);await mkdir('reports/capability-completion-2026-10-12',{recursive:true});
 await writeFile('reports/capability-completion-2026-10-12/situation-postgres.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
