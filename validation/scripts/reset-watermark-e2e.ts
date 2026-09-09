import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {OperationalEventRepository} from '../../packages/runtime/src/operational-event-repository.js';
import {ProjectionWorker} from '../../services/projection-worker/src/worker.js';
import {createPostgresHistoricalProjectionStages} from '../../services/projection-worker/src/historical-runtime-adapter.js';
import {decodeResetAck} from '../../services/ugv-mqtt-ingest/src/reset-ack.js';
const url=process.env.DATABASE_URL;
if(!url||!new URL(url).pathname.startsWith('/gowm_history_repair_'))throw Error('isolated history repair database required');
const pool=new pg.Pool({connectionString:url,options:'-c gowm.data_scope_key=default'});
try {
 const object='ugv:ugv';
 await pool.query(`INSERT INTO gowm_device.device(device_id,data_scope_key,identifier_namespace,device_identifier,device_name,device_type)
 VALUES($1,'default','ugv','ugv','test','UGV') ON CONFLICT DO NOTHING`,[object]);
 const session=randomUUID();
 const at=(await pool.query('SELECT max(received_at) t FROM world_observation')).rows[0].t as Date;
 const receipt=new Date(at.getTime()+2000);
 const ref=(await pool.query("SELECT reference_key FROM world_reference_identity WHERE entity_kind='WORLD_OBJECT' AND internal_id=$1",[object])).rows[0].reference_key;
 const actor={namespace:'gowm' as const,kind:'WORLD_OBJECT' as const,id:ref,version:'1'};
 const context={dataScopeKey:'default',sourceKey:'ugv-airport-sim-mqtt',deviceId:'ugv',trackerSessionKey:'history-test:ugv',deviceContext:{deviceId:object,actorReferenceKey:actor}};
 await pool.query(`INSERT INTO ugv_ingest.mqtt_session(session_id,client_id,broker_id,session_epoch,session_present,protocol_version,
 connected_at,source_schema_lock,mapper_context,mapper_context_hash,code_version)
 VALUES($1,'reset-test','test',1,false,5,$2,'{}',$3,$4,'test')`,[session,new Date('2026-09-01'),context,'a'.repeat(64)]);
 await pool.query(`INSERT INTO ugv_ingest.inbox_message(message_id,session_id,device_id,topic,qos,duplicate_flag,retained_flag,
 payload_size,payload_sha256,raw_payload,adapter_received_at,schema_version,schema_hash,validation_state,processing_state)
 SELECT substring(o.raw_reference from 13)::uuid,$1,$2,'/ugv/gnss',1,false,false,0,$3,''::bytea,o.received_at,'test',$3,'VALID','DELIVERED'
 FROM world_observation o WHERE o.raw_reference LIKE 'ugv-inbox://%' ON CONFLICT DO NOTHING`,[session,object,'a'.repeat(64)]);
 const proof=(await pool.query("SELECT observation_id FROM world_observation WHERE raw_reference LIKE 'ugv-inbox://%' LIMIT 1")).rows[0].observation_id;
 const events=new OperationalEventRepository(pool);
 for(const [type,offset] of [['EXECUTION_STARTED_OBSERVED',-1000],['EXECUTION_STOPPED_OBSERVED',0]] as const){
  await events.insert({dataScopeKey:'default',sourceAuthority:'reset-test-authority',sourceEventKey:type,sourceRevisionNo:1,
   eventId:`reset-${type}`,operationalTaskId:'mission:ugv:chassis:reset-test',eventType:type,
   eventTime:new Date(at.getTime()+offset).toISOString(),actorReferenceKeys:[actor],targetReferenceKeys:[],payload:{},confidence:1,
   provenance:[{evidenceId:proof,authority:'reset-test-authority',evidenceType:'PROVIDER_EVENT',observedAt:at.toISOString()}]},at.toISOString());
 }
 const insert=async(ok:boolean,target:string,offset=0,retained=false,error?:string)=>{
  const id=randomUUID();const body=decodeResetAck(Buffer.from(JSON.stringify({data:JSON.stringify({ok,target,ts:(receipt.getTime()+offset)/1000,...(error?{error}:{})})})));
  await pool.query(`INSERT INTO ugv_ingest.inbox_message(message_id,session_id,device_id,topic,qos,duplicate_flag,retained_flag,
 payload_size,payload_sha256,raw_payload,decoded_payload,adapter_received_at,schema_version,schema_hash,validation_state)
 VALUES($1,$2,$3,'/sim/reset_ack',1,false,$4,0,$5,''::bytea,$6,$7,'test',$5,'VALID')`,[id,session,object,retained,'b'.repeat(64),body,new Date(receipt.getTime()+offset)]);return id;
 };
 const process=async()=> (await pool.query("SELECT gowm_history.process_reset_ack('reset-test','test') result")).rows[0].result;
 await insert(false,'ugv');assert.equal(await process(),'RESET_FAILED');
 await insert(true,'blue');assert.equal(await process(),'TARGET_NOT_BOUND');
 await insert(true,'ugv',0,true);assert.equal(await process(),'RETAINED_RESET_IGNORED');
 await insert(true,'ugv');assert.equal(await process(),'APPLIED');
 assert.equal((await pool.query("SELECT count(*)::int n FROM operational_source_watermark_revision WHERE source_authority='reset-test-authority' AND completeness_state='COMPLETE'")).rows[0].n,1);
 const frozenBefore=(await pool.query("SELECT content_hash FROM gowm_history.historical_trajectory_revision ORDER BY trajectory_revision_id")).rows;
 const count=Number((await pool.query("SELECT count(*) FROM pipeline_watermark_revision WHERE completeness_state='COMPLETE'")).rows[0].count);assert.ok(count>0);
 await insert(true,'ugv');assert.equal(await process(),'DUPLICATE_OR_CONFLICT');
 assert.equal(Number((await pool.query("SELECT count(*) FROM pipeline_watermark_revision WHERE completeness_state='COMPLETE'")).rows[0].count),count);
 await insert(true,'ugv',0,false,'changed');assert.equal(await process(),'DUPLICATE_OR_CONFLICT');
 assert.equal((await pool.query("SELECT count(*)::int n FROM ugv_ingest.inbox_message WHERE last_error='RESET_CONTENT_CONFLICT'")).rows[0].n,1);
 await insert(true,'red',-1000);assert.equal(await process(),'RESET_OUT_OF_ORDER');
 await pool.query("UPDATE gowm_device.device SET enabled=false WHERE device_id=$1",[object]);
 await insert(true,'ugv',1000);assert.equal(await process(),'DEVICE_UNAVAILABLE');
 await pool.query("UPDATE gowm_device.device SET enabled=true WHERE device_id=$1",[object]);
 const held=randomUUID();
 await pool.query(`INSERT INTO ugv_ingest.inbox_message(message_id,session_id,device_id,topic,qos,duplicate_flag,retained_flag,
 payload_size,payload_sha256,raw_payload,adapter_received_at,schema_version,schema_hash,validation_state)
 VALUES($1,$2,$3,'/ugv/gnss',1,false,false,0,$4,''::bytea,$5,'test',$4,'VALID')`,[held,session,object,'c'.repeat(64),receipt]);
 const waiting=await insert(true,'all',2000);assert.equal(await process(),'INBOX_DRAIN_PENDING');
 await pool.query("UPDATE ugv_ingest.inbox_message SET processing_state='IGNORED_BY_POLICY' WHERE message_id=$1",[held]);
 await pool.query("UPDATE ugv_ingest.inbox_message SET next_processing_at=clock_timestamp() WHERE message_id=$1",[waiting]);
 assert.equal(await process(),'APPLIED');
 const worker=new ProjectionWorker(pool,{historical:createPostgresHistoricalProjectionStages(pool),batchSize:1000,
 components:{bus:{publishEvent:async()=>{},drain:async()=>{}}}});
 try{await new Promise(resolve=>setTimeout(resolve,1100));for(let n=0;n<3;n++)await worker.tick();}finally{await worker.close();}
 assert.deepEqual((await pool.query("SELECT content_hash FROM gowm_history.historical_trajectory_revision ORDER BY trajectory_revision_id")).rows,frozenBefore);
 assert.equal((await pool.query("SELECT count(*)::int n FROM gowm_history.task_execution_interval_revision WHERE lifecycle_state='OPEN' AND stability_state='SEALED'")).rows[0].n,0);
 const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('gowm.data_scope_key','other',true)");
 await insert(true,'ugv',3000);
 await assert.rejects(c.query("SELECT gowm_history.process_reset_ack('reset-test','test')"),/RESET_SCOPE_MISMATCH/);
 await c.query('ROLLBACK');await c.query('BEGIN');await c.query('SET LOCAL ROLE gowm_history_service');await assert.rejects(c.query("SELECT gowm_history.process_reset_ack('reset-test','test')"),/permission denied/);await c.query('ROLLBACK');}finally{c.release();}
 // A new, unsupported clock revision is never treated as an event-time conversion.
 const clock=(await pool.query(`INSERT INTO source_clock_model(source_key,model_version,clock_domain,residual_sigma_ms,estimation_method)
 VALUES('ugv-airport-sim-mqtt','reset-test-unresolved','SIMULATION',0,'test') RETURNING clock_model_id`)).rows[0].clock_model_id;
 await pool.query(`INSERT INTO observation_time_solution SELECT (jsonb_populate_record(NULL::observation_time_solution,to_jsonb(ts)||
 jsonb_build_object('time_solution_id',gen_random_uuid(),'clock_model_id',$1::text,'supersedes_time_solution_id',NULL))).*
 FROM observation_time_solution ts LIMIT 1`,[clock]);
 assert.equal(await process(),'TIME_MODEL_UNSUPPORTED');
 assert.equal((await pool.query("SELECT count(*)::int n FROM gowm_history.reset_ack_evidence WHERE reason='TIME_MODEL_UNSUPPORTED'")).rows[0].n,1);
 console.log(JSON.stringify({status:'PASS',gate:'RESET_ACK_REAL_POSTGRES',watermarks:count}));
}finally{await pool.end();}
