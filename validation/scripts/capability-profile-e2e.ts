import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import pg from 'pg';
import {initializeDefaultDevice} from '../../packages/integrations/device-business-storage/src/bootstrap.js';
import {loadIngestDeviceContext} from '../../packages/integrations/device-business-storage/src/context.js';
import {registerRuntimeProfile,activateRuntimeProfile,loadActiveRuntimeProfile} from '../../packages/integrations/device-business-storage/src/ingest-profile.js';
import {PROFILED_MAPPER_VERSION,type UgvRuntimeProfile} from '../../packages/integrations/ugv-mqtt-ingest-core/src/runtime-profile.js';
import {loadSourceSchemaLock,UGV_AUTHORITY_TOPICS,sha256} from '../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js';
import {SourceSchemaRegistry} from '../../packages/integrations/ugv-mqtt-ingest-core/src/source-schema-registry.js';
import {mapUgvMessage,DEVICE_ACTOR_MAPPER_VERSION,type MapperConfig} from '../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js';
import {canonicalJson,normalizeObservationInput} from '../../packages/observation-model/src/canonical.js';
import {ObservationRepository} from '../../packages/runtime/src/observation-repository.js';
import {UgvIngestRepository} from '../../services/ugv-mqtt-ingest/src/repository.js';
import {closeIngestSession} from '../../scripts/ingest-profile.js';

export async function verifyIngestProfiles(databaseUrl:string){
 const pool=new pg.Pool({connectionString:databaseUrl,max:4});const checks:string[]=[];
 const key='profile-'+randomUUID().slice(0,18),clientId=key,broker='profile-test:1883';
 async function tx<T>(fn:(c:pg.PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 try {
  const input={scope:key,namespace:'ugv',identifier:key,deviceName:'Profile test',sourceKey:key,pipelineKey:key+':pipeline',analysisSpaceKey:key+':utm48',analysisSrid:32648,
   endpointKey:key+':endpoint',brokerUrl:'mqtt://profile-test:1883/',clientPrefix:key};
  const context=(await tx(c=>initializeDefaultDevice(c,input))).context;
  const lock=await loadSourceSchemaLock(resolve('config/ugv-source-schema'));const {sourceDirectory:_,...contract}=lock;
  const now=Date.now()-20000;const profile:UgvRuntimeProfile={schemaVersion:'1.0',adapter:'ROS2_UGV_7_V1',profileId:key,version:'v1',
   sourceSchemaLockSha256:sha256(canonicalJson(contract)),dataScopeKey:key,sourceKey:key,deviceId:context.deviceId,endpointKey:input.endpointKey,
   worldEpoch:key,trackerSessionKey:key,analysisSpaceKey:input.analysisSpaceKey,analysisSrid:32648,originKind:'SIMULATION',
   routes:UGV_AUTHORITY_TOPICS.map(topic=>({topic,messageProfile:'ugv-mqtt',enabled:true,qos:1,clock:topic==='/ugv/gnss'?{mode:'CALIBRATED',calibration:{
    calibrationId:key,version:'v1',sourceKey:key,dataScopeKey:key,worldEpoch:key,trackerSessionKey:key,encoding:'ROS_STAMP',unit:'NANOSECONDS',
    anchors:[{ticks:'1000000000000',utc:new Date(now).toISOString(),evidenceReference:'test://calibration-1'},
     {ticks:'1010000000000',utc:new Date(now+10000).toISOString(),evidenceReference:'test://calibration-2'}],
    validFromTicks:'1000000000000',validToTicks:'1020000000000',uncertaintyMs:2,maximumDriftPpm:100,driftErrorPpm:1}}:{mode:'ARRIVAL_PROXY'}}))};
  const registered=await tx(c=>registerRuntimeProfile(c,profile));assert.deepEqual(await tx(c=>registerRuntimeProfile(c,profile)),registered);
  await assert.rejects(tx(c=>registerRuntimeProfile(c,{...profile,originKind:'PHYSICAL_SENSOR'})),/VERSION_CONFLICT/);
  await tx(c=>activateRuntimeProfile(c,key,context.deviceId,key,'v1'));checks.push('immutable_profile_register_replay_conflict_activate');
  const deviceRead=new pg.Pool({connectionString:databaseUrl,max:1,options:'-c role=gowm_device_reader'});
  try {
   const c=await deviceRead.connect();try{await c.query('BEGIN READ ONLY');assert.deepEqual(await loadActiveRuntimeProfile(c,key,context.deviceId),profile);await c.query('ROLLBACK');}finally{c.release();}
   await assert.rejects(deviceRead.query('DELETE FROM gowm_device.ingest_runtime_profile'),/permission denied/);
  }finally{await deviceRead.end();}
  const mapper:MapperConfig={deviceId:key,dataScopeKey:key,sourceKey:key,producerPipelineKey:input.pipelineKey,scenarioId:'airport',worldEpoch:key,trackerSessionKey:key,
   analysisSpaceKey:input.analysisSpaceKey,analysisSrid:32648,arrivalUncertaintyMs:1000,mapperVersion:PROFILED_MAPPER_VERSION,deviceContext:context,runtimeProfile:profile};
  const repo=new UgvIngestRepository(pool,key,1048576,1000,new SourceSchemaRegistry(lock));
  const session=await repo.startSession(clientId,broker,false,lock,'test',mapper);
  const frozen=(await pool.query('SELECT mapper_context,mapper_context_hash FROM ugv_ingest.mqtt_session WHERE session_id=$1',[session.sessionId])).rows[0];
  assert.equal((await repo.startSession(clientId,broker,true,lock,'test',mapper)).sessionId,session.sessionId);
  await assert.rejects(tx(c=>activateRuntimeProfile(c,key,context.deviceId,key,'v1')),/CLOSED_SESSIONS/);
  await assert.rejects(repo.startSession(clientId,broker,true,lock,'test',{...mapper,runtimeProfile:{...profile,version:'v2'}}),/mapper context changed/);
  checks.push('reader_permissions_and_active_session_freeze');
  let firstEstimate='';
  for(const [seq,sec] of [[1,1000],[2,1001]] as const){
   const payload={header:{stamp:{sec,nanosec:0},frame_id:'gnss'},latitude:30,longitude:114+seq*.0001,altitude:10,status:{status:0,service:1},position_covariance:[1,0,0,0,1,0,0,0,1],position_covariance_type:2};
   const accepted=await repo.accept(session.sessionId,'/ugv/gnss',Buffer.from(JSON.stringify(payload)),{qos:1,messageId:seq},new Date().toISOString());
   assert.equal(accepted.validationState,'VALID');await repo.markPuback(session.sessionId,seq,accepted.packetGeneration!);
   const pending=await repo.nextPending(clientId,broker);assert(pending);
   const mapping=mapUgvMessage(pending,pending.mapperConfig);assert.equal(mapping.observations.length,1);
   const observation=mapping.observations[0]!;assert.equal(observation.timeSolution.phenomenonTimeEstimate,new Date(now+(sec-1000)*1000).toISOString());
   assert(!observation.qualityFlags?.includes('SOURCE_TIME_TICKS_UNRESOLVED'));if(seq===1)firstEstimate=observation.timeSolution.phenomenonTimeEstimate;
   await repo.storeMapping(pending,mapping,mapper.mapperVersion);
   await assert.rejects(tx(c=>closeIngestSession(c,key,session.sessionId,'test')),/DISCONNECTED|DRAIN/);
   for(;;){const out=await repo.nextOutbox();if(!out)break;assert.equal(out.kind,'OBSERVATION');
    await new ObservationRepository(pool).insert(normalizeObservationInput(JSON.parse(out.bodyBytes.toString()),new Date().toISOString()));
    await repo.deliveryResult(out.outboxId,{delivered:true,status:202,attempts:out.attempts});}
  }
  checks.push('real_schema_inbox_mapping_outbox_and_delayed_source_clock');
  const proxy=(await pool.query("INSERT INTO source_clock_model(source_key,model_version,clock_domain,residual_sigma_ms,estimation_method) VALUES($1,'mqtt-arrival-proxy-v1','ADAPTER_WALL_CLOCK',0,'TEST_ONLY') RETURNING clock_model_id",[key])).rows[0].clock_model_id;
  const gnss=context.routes.find(r=>r.topic_filter==='/ugv/gnss')!;
  assert.equal((await pool.query('SELECT gowm_device.clock_matches_profile($1,$2,$3) ok',[JSON.stringify(mapper),gnss.datastream_key,proxy])).rows[0].ok,false);
  // The reset receipt has wall-clock ts; only persisted source-time solutions determine closure.
  const reset=await repo.accept(session.sessionId,'/sim/reset_ack',Buffer.from(JSON.stringify({data:JSON.stringify({ok:true,target:key,ts:Date.now()/1000})})),{qos:1,messageId:3},new Date().toISOString());
  await repo.markPuback(session.sessionId,3,reset.packetGeneration!);
  await pool.query('INSERT INTO gowm_history.reset_ack_policy(data_scope_key,device_id,targets) VALUES($1,$2,$3)',[key,context.deviceId,[key]]);
  await repo.processResetAck(clientId,broker,key);
  const receipt=(await pool.query('SELECT state,reason FROM gowm_history.reset_ack_evidence WHERE message_id=$1',[reset.messageId])).rows[0];
  assert.equal(receipt?.state,'APPLIED',JSON.stringify(receipt));
  const watermark=(await pool.query('SELECT event_boundary FROM gowm_history.reset_ack_watermark_input WHERE message_id=$1',[reset.messageId])).rows[0];
  assert.equal(watermark.event_boundary.toISOString(),new Date(now+1000).toISOString());assert.notEqual(watermark.event_boundary.toISOString(),firstEstimate);
  checks.push('reset_complete_uses_calibrated_observation_boundary');
  await repo.disconnect(session.sessionId,'test-quiesced');await tx(c=>closeIngestSession(c,key,session.sessionId,'explicit-test-close'));
  await assert.rejects(repo.startSession(clientId,broker,true,lock,'test',mapper),/CLOSED_SESSION/);
  await assert.rejects(repo.accept(session.sessionId,'/ugv/gnss',Buffer.from('{}'),{qos:1,messageId:4},new Date().toISOString()),/MQTT_SESSION_CLOSED/);
  await assert.rejects(pool.query("UPDATE ugv_ingest.mqtt_session SET mapper_context='{}' WHERE session_id=$1",[session.sessionId]),/IDENTITY_IMMUTABLE/);
  const v2=structuredClone(profile);v2.version='v2';v2.routes[1]!.enabled=false;
  await tx(c=>registerRuntimeProfile(c,v2));await tx(c=>activateRuntimeProfile(c,key,context.deviceId,key,'v2'));
  await assert.rejects(repo.startSession(clientId+'-stale',broker,false,lock,'test',mapper),/PROFILE_CHANGED_BEFORE_SESSION/);
  const context2=await tx(c=>loadIngestDeviceContext(c,{scope:key,deviceId:context.deviceId,endpointKey:input.endpointKey,brokerUrl:input.brokerUrl,sourceKey:key,pipelineKey:input.pipelineKey,topics:v2.routes.filter(r=>r.enabled).map(r=>r.topic)}));
  const next=await repo.startSession(clientId+'-v2',broker,false,lock,'test',{...mapper,deviceContext:context2,runtimeProfile:v2});assert.notEqual(next.sessionId,session.sessionId);
  assert.deepEqual((await pool.query('SELECT mapper_context,mapper_context_hash FROM ugv_ingest.mqtt_session WHERE session_id=$1',[session.sessionId])).rows[0],frozen);
  const old={...mapper,mapperVersion:DEVICE_ACTOR_MAPPER_VERSION};delete old.runtimeProfile;
  const legacy=mapUgvMessage({messageId:'legacy',topic:'/ugv/mission_state',payloadSha256:'a'.repeat(64),payload:{id:1,type:2,state:1,progress:1},adapterReceivedAt:new Date().toISOString(),retained:false,cursor:{}},old);
  assert.deepEqual(legacy.events[0]?.actorReferenceKeys,[context.actorReferenceKey]);checks.push('explicit_close_new_session_disabled_stream_and_legacy_replay');
  return {status:'PASS',checks,sourceCalibrationEvidence:'TEST_FIXTURE_ONLY',physicalDeviceAcceptance:'NOT_RUN',remoteDeployment:'NOT_RUN'};
 }finally{await pool.end();}
}
if(process.argv[1]?.endsWith('capability-profile-e2e.ts')){
 const url=process.env.GOWM_CAPABILITY_TEST_DATABASE_URL;if(!url)throw Error('GOWM_CAPABILITY_TEST_DATABASE_URL required');
 const result=await verifyIngestProfiles(url);await mkdir('reports/capability-completion-2026-10-12',{recursive:true});
 await writeFile('reports/capability-completion-2026-10-12/profile-postgres.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
