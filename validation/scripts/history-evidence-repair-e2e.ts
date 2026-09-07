import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Ajv from 'ajv';
import {readFile} from 'node:fs/promises';
import {mapUgvMessage,VEHICLE_SPEED_MAPPER_VERSION,type MapperConfig} from '../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js';
import {normalizeObservationInput} from '../../packages/observation-model/src/canonical.js';
import {ObservationRepository} from '../../packages/runtime/src/observation-repository.js';
import {OperationalEventRepository} from '../../packages/runtime/src/operational-event-repository.js';
import {ProjectionWorker} from '../../services/projection-worker/src/worker.js';
import {createPostgresHistoricalProjectionStages} from '../../services/projection-worker/src/historical-runtime-adapter.js';
import {tick,loadAutoConfig} from '../../services/history-auto/src/index.js';
import {canonicalInputSetHash} from '../../packages/historical-trace-core/src/index.js';
import {PostgresHistoricalTrajectoryMaterializer} from '../../packages/historical-trace-runtime/src/historical-trajectory-materializer.js';
import type {SqlPool} from '../../packages/historical-trace-runtime/src/database.js';

const url=process.env.DATABASE_URL;
if(!url||!/^\/gowm_history_repair_[a-z0-9_]+$/.test(new URL(url).pathname))throw Error('Disposable gowm_history_repair_* database required');
const pool=new pg.Pool({connectionString:url,max:4});
const schedulerPool=new pg.Pool({connectionString:url,max:2,options:'-c role=gowm_history_scheduler_service'});
const config:MapperConfig={deviceId:'ugv',dataScopeKey:'default',sourceKey:'ugv-airport-sim-mqtt',producerPipelineKey:'ugv-history-test',
 scenarioId:'airport',worldEpoch:'history-test',trackerSessionKey:'history-test:ugv',analysisSpaceKey:'default',analysisSrid:32648,
 arrivalUncertaintyMs:1000,mapperVersion:VEHICLE_SPEED_MAPPER_VERSION};
const observations=new ObservationRepository(pool),events=new OperationalEventRepository(pool);
const worker=new ProjectionWorker(pool,{historical:createPostgresHistoricalProjectionStages(pool),batchSize:1000,
 components:{bus:{publishEvent:async()=>{},drain:async()=>{}}}});
const base=Date.parse('2026-09-07T06:53:13.301Z');
const validatePage=new Ajv().compile(JSON.parse(await readFile(new URL('../../contracts/historical-evidence/v2-page.schema.json',import.meta.url),'utf8')));
async function ingest(topic:'/ugv/gnss'|'/ugv/speed'|'/ugv/mission_state',payload:unknown,at:number) {
 const mapped=mapUgvMessage({messageId:randomUUID(),topic,payload,payloadSha256:'a'.repeat(64),adapterReceivedAt:new Date(at).toISOString(),retained:false,cursor:{}},config);
 for(const o of mapped.observations)await observations.insert(normalizeObservationInput(o,new Date(at).toISOString()));
 for(const e of mapped.events)await events.insert(e,new Date(at).toISOString());
}
try {
 const members=[{timeSolutionId:'abc',ordinalNo:1,createdAt:'2026-09-07T06:00:00.000Z'},'fixed'];
 assert.equal((await pool.query('SELECT gowm_history_v2.input_digest($1::jsonb) h',[JSON.stringify(members)])).rows[0].h,canonicalInputSetHash(members));
 if(!process.argv.includes('--verify-existing')) {
 await ingest('/ugv/mission_state',{id:7,type:2,state:1,progress:0},base-1000);
 for(let i=0;i<197;i++)await ingest('/ugv/gnss',{longitude:106.81485,latitude:29.7195,altitude:500},base+Math.round(i*786189/196));
 await ingest('/ugv/speed',{data:0},base+600000);
 }
 for(let i=0;i<4;i++){const result=await worker.tick();console.log(JSON.stringify({stage:'projection',...result}));}
 assert.equal((await pool.query("SELECT count(*)::int n FROM pipeline_watermark_revision WHERE completeness_state='UNKNOWN' AND closed_through_event_time IS NULL")).rows[0].n,1);
 const version=(await pool.query('SELECT sample_count,numInstants(trajectory) nodes FROM mobility_tracklet_version ORDER BY version_no DESC LIMIT 1')).rows[0];
 assert.equal(version.sample_count,197);assert.equal(version.nodes,2);
 const scheduling=await tick(schedulerPool,loadAutoConfig({}));console.log(JSON.stringify({stage:'auto',...scheduling}));
 if(!process.argv.includes('--verify-existing'))assert.equal(scheduling.queued,1);
 for(let i=0;i<3;i++)console.log(JSON.stringify({stage:'materialize',...await worker.tick()}));
 const history=(await pool.query(`SELECT i.reference_key,r.revision_no,r.content_hash,r.finalization_state,r.sample_count
   FROM gowm_history.historical_trajectory i JOIN gowm_history.historical_trajectory_revision r USING(historical_trajectory_id)
   ORDER BY r.created_at DESC LIMIT 1`)).rows[0];assert.ok(history,'native scheduler must produce actual history');
 assert.equal(history.sample_count,197);assert.equal(history.finalization_state,'PROVISIONAL');
 const client=await pool.connect();let first:any;let restored:any[]=[];
 try {await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SELECT gowm_history_v1.set_data_scope('default')");
   const captured=(await client.query('SELECT clock_timestamp() t')).rows[0].t;
   let cursor=null;
   do {const page=(await client.query('SELECT gowm_history_v2.read_trajectory_samples($1,$2,$3,50,$4::jsonb) page',[history.reference_key,history.revision_no,captured,JSON.stringify(cursor)])).rows[0].page;
     first??=page;restored.push(...page.samples);cursor=page.nextCursor;
     assert.ok(validatePage(page),JSON.stringify(validatePage.errors));
     assert.equal(page.evidenceHash,first.evidenceHash);assert.equal(page.evidenceSampleCount,197);assert.equal(page.geometryNodeCount,2);
   }while(cursor);await client.query('ROLLBACK');
 }finally{client.release();}
 assert.equal(restored.length,197);assert.equal(new Set(restored.map(x=>x.sampleId)).size,197);
 assert.ok(restored.every(x=>x.observationId&&x.timeSolutionId&&x.sourceTrackletVersionId));
 assert.ok(Math.max(...restored.slice(1).map((x,i)=>Date.parse(x.observedAt)-Date.parse(restored[i].observedAt)))<=5906);
 const legacyQuery=(await pool.query(`SELECT a.query_payload FROM analysis_record a
   JOIN gowm_history.historical_trajectory_revision r USING(analysis_id) ORDER BY r.created_at DESC LIMIT 1`)).rows[0].query_payload;
 legacyQuery.sourceSelectionProfileReferenceKey={namespace:'gowm.history',kind:'HISTORY_METHOD_PROFILE',id:'trajectory-single-authoritative-v1',version:'1.0'};
 await new PostgresHistoricalTrajectoryMaterializer(pool as unknown as SqlPool).materialize({dataScopeKey:'default',capturedAt:new Date().toISOString(),query:legacyQuery});
 const legacy=(await pool.query(`SELECT i.reference_key,r.revision_no,r.sample_count,r.content_hash FROM gowm_history.historical_trajectory i
   JOIN gowm_history.historical_trajectory_revision r USING(historical_trajectory_id) ORDER BY r.created_at DESC LIMIT 1`)).rows[0];
 assert.equal(legacy.sample_count,2,'legacy geometry-node statistics must remain v1');
 const legacyClient=await pool.connect();
 try {await legacyClient.query('BEGIN READ ONLY');await legacyClient.query("SELECT gowm_history_v1.set_data_scope('default')");
   const recovered=(await legacyClient.query('SELECT gowm_history_v2.read_trajectory_samples($1,$2,clock_timestamp(),1000,NULL) page',[legacy.reference_key,legacy.revision_no])).rows[0].page;
   assert.equal(recovered.evidenceSampleCount,197,'v2 must restore the last original endpoint from legacy geometry');
   assert.equal(recovered.contentHash,legacy.content_hash);await legacyClient.query('ROLLBACK');
 }finally{legacyClient.release();}
 await ingest('/ugv/gnss',{longitude:106.81485,latitude:29.7195,altitude:500},base+1000);
 await pool.query("INSERT INTO data_scope(scope_key,operational_domain,description) VALUES('history-other-scope','TEST','isolated negative read') ON CONFLICT DO NOTHING");
 const reader=await pool.connect();
 try {
   await reader.query('BEGIN READ ONLY');await reader.query('SET LOCAL ROLE gowm_history_service');
   await reader.query("SELECT gowm_history_v1.set_data_scope('default')");
   const unchanged=(await reader.query('SELECT gowm_history_v2.read_trajectory_samples($1,$2,clock_timestamp(),1000,NULL) page',[history.reference_key,history.revision_no])).rows[0].page;
   assert.equal(unchanged.evidenceSampleCount,197);assert.equal(unchanged.evidenceHash,first.evidenceHash);
   await reader.query('SAVEPOINT negative');
   await assert.rejects(reader.query('SELECT gowm_history_v2.read_trajectory_samples($1,$2,clock_timestamp(),1,$3::jsonb)',
     [history.reference_key,history.revision_no,JSON.stringify({revisionId:first.revisionId,evidenceHash:'wrong',after:1})]),/CURSOR_MISMATCH/);
   await reader.query('ROLLBACK TO SAVEPOINT negative');
   await assert.rejects(reader.query("SELECT gowm_history.bootstrap_unknown_watermarks('default','ugv-airport-sim-mqtt','ugv')"),/permission denied/);
   await reader.query('ROLLBACK TO SAVEPOINT negative');
   await reader.query("SELECT gowm_history_v1.set_data_scope('history-other-scope')");
   await assert.rejects(reader.query('SELECT gowm_history_v2.read_trajectory_samples($1,$2,clock_timestamp(),1,NULL)',[history.reference_key,history.revision_no]),/TRAJECTORY_NOT_FOUND/);
   await reader.query('ROLLBACK');
 }finally{reader.release();}
 console.log(JSON.stringify({status:'PASS',evidence:'LOCAL_SYNTHETIC_REAL_PG_NOT_REMOTE_REPLAY',samples:197,geometryNodes:2,
   sourceLineage:true,unknownBootstrap:true,autoMaterialization:true,dedicatedSchedulerRole:true,legacyRevisionRecovery:true,
   lateDataIsolation:true,scopedReader:true,invalidCursorRejected:true,history,evidenceHash:first.evidenceHash}));
} finally {await worker.close();await schedulerPool.end();await pool.end();}
