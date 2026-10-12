import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import pg, { type PoolClient } from 'pg';
import { initializeBusinessAccounts } from '../../scripts/business-storage/accounts.js';
import { authorizeBusinessServices } from '../../scripts/business-storage/authority.js';
import { verifyBusinessRuntime } from '../../scripts/business-storage/runtime-verify.js';
import { install, verify } from '../../scripts/business-storage/installer.js';
import { fixture,postgresTests } from '../../scripts/business-storage/fixture.js';
import { initializeDefaultDevice, resolveBusinessDeviceContext, BusinessStorage, type DefaultDeviceInput } from '../../packages/integrations/device-business-storage/src/index.js';
import { ObservationRepository } from '../../packages/runtime/src/observation-repository.js';
import { OperationalEventRepository } from '../../packages/runtime/src/operational-event-repository.js';
import { EventRepository } from '../../packages/runtime/src/event-repository.js';
import { TrajectoryRepository } from '../../packages/runtime/src/trajectory-repository.js';
import { normalizeObservationInput } from '../../packages/observation-model/src/canonical.js';
import { mapUgvMessage, DEVICE_ACTOR_MAPPER_VERSION, type MapperConfig } from '../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js';
import { ProjectionWorker } from '../../services/projection-worker/src/worker.js';
import { createPostgresHistoricalProjectionStages } from '../../services/projection-worker/src/historical-runtime-adapter.js';
import { distanceBySegmentsM, stopsBySegments } from '../../packages/trajectory-model/src/analytics.js';
import { pumpEventStream, writeFrame } from '../../services/world-api/src/event-stream.js';
import { SituationRepository } from '../../packages/runtime/src/situation-repository.js';
import { WorldRepository } from '../../packages/runtime/src/world-repository.js';
import { RepositorySituationReadPort } from '../../services/providers/gowm-situation-provider/src/repository-adapter.js';

const url=process.env.DATABASE_URL;
if(!url || !/^\/gowm_functional_(?:test|ci_[a-z0-9_]+)$/.test(new URL(url).pathname)) throw Error('ISOLATED_FUNCTIONAL_DATABASE_REQUIRED');
const pool=new pg.Pool({connectionString:url,max:6});
const env={SMPP_DB_PASSWORD:'functional-ci-smpp-disposable-00001',SDAR_DB_PASSWORD:'functional-ci-sdar-disposable-00002'};
const input:DefaultDeviceInput={scope:'default',namespace:'ugv',identifier:'ugv',deviceName:'UGV',sourceKey:'ugv-airport-sim-mqtt',
  pipelineKey:'ugv-airport-sim-mqtt:canonical-v1',analysisSpaceKey:'airport-utm48n',analysisSrid:32648,
  endpointKey:'ugv-default',brokerUrl:'mqtt://functional-test-broker:1883/',clientPrefix:'functional-test'};
const service={scope:'default',smppServiceKey:'functional-smpp',providerId:'ugv',resourceId:'functional-resource',
  sdarServiceKey:'functional-sdar',sdarMcpServerId:'functional-mcp',agentProfileId:'functional-profile'};
const logins:pg.Pool[]=[];
const results:string[]=[];
async function test(name:string,body:()=>Promise<void>){await body();results.push(name);console.log(JSON.stringify({case:name,status:'PASS'}));}
async function tx<T>(p:pg.Pool,body:(c:PoolClient)=>Promise<T>,readonly=false,rollback=false):Promise<T>{
  const c=await p.connect();try{await c.query(readonly?'BEGIN READ ONLY':'BEGIN');const v=await body(c);await c.query(rollback?'ROLLBACK':'COMMIT');return v;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
function login(role:string,password:string){const u=new URL(url!);u.username=role;u.password=password;const p=new pg.Pool({connectionString:u.href,max:3});logins.push(p);return p;}
const smpp=login('ugv_smpp_app',env.SMPP_DB_PASSWORD),sdar=login('ugv_sdar_app',env.SDAR_DB_PASSWORD);
let context:Awaited<ReturnType<typeof initializeDefaultDevice>>['context'];
let worker:ProjectionWorker|undefined;
let app:FastifyInstance|undefined;
async function api(){
  if(!app){process.env.LOG_LEVEL='silent';process.env.GOWM_DATA_SCOPE='default';const {buildWorldApi}=await import('../../services/world-api/src/app.js');app=buildWorldApi();}
  return app;
}
try {
  await test('native-install-replay-and-vector',async()=>{
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    await tx(pool,async c=>{ /* installer owns transactions */ },true);
    const c=await pool.connect();try{
      if(!(await c.query("SELECT to_regclass('ugv_smpp.gowm_install_history') installed")).rows[0].installed){
        await c.query('CREATE SCHEMA IF NOT EXISTS ugv_smpp');
        await c.query('CREATE TABLE ugv_smpp.functional_unowned_guard(id integer)');
        try{await assert.rejects(install(c),/UNKNOWN_NONEMPTY_SCHEMA/);}
        finally{await c.query('DROP TABLE ugv_smpp.functional_unowned_guard');}
      }
      await install(c);assert.equal((await verify(c)).status,'PASS');await install(c);assert.equal((await verify(c,'smpp')).status,'PASS');assert.equal((await verify(c,'sdar')).status,'PASS');assert.equal((await verify(c)).status,'PASS');
      if((await c.query("SELECT to_regclass('gowm_device.ingest_runtime_profile') installed")).rows[0].installed){
        await c.query('ALTER TABLE gowm_device.ingest_runtime_profile ADD COLUMN unexpected_fixture_column text');
        try{await assert.rejects(verify(c),/ingest-profile-structure:columns/);}
        finally{await c.query('ALTER TABLE gowm_device.ingest_runtime_profile DROP COLUMN unexpected_fixture_column');}
        assert.equal((await verify(c)).status,'PASS');
      }
    }finally{c.release();}
    assert.equal((await pool.query("SELECT vector_dims('[1,2,3]'::public.vector) n")).rows[0].n,3);
  });
  await test('default-raw-scope-device-seven-streams-idempotent',async()=>{
    const first=await tx(pool,c=>initializeDefaultDevice(c,input));const second=await tx(pool,c=>initializeDefaultDevice(c,input));
    assert.deepEqual(second,first);context=first.context;assert.equal(context.routes.length,7);
    assert.equal((await pool.query('SELECT count(*)::int n FROM data_scope')).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM gowm_device.device')).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM world_observation')).rows[0].n,0);
  });
  await test('managed-logins-passwords-preserved',async()=>{
    await initializeBusinessAccounts(url!,env);
    const before=(await pool.query("SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('ugv_smpp_app','ugv_sdar_app') ORDER BY rolname")).rows;
    await initializeBusinessAccounts(url!,env);assert.deepEqual((await pool.query("SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('ugv_smpp_app','ugv_sdar_app') ORDER BY rolname")).rows,before);
    await assert.rejects(initializeBusinessAccounts(url!,{...env,SMPP_DB_PASSWORD:'wrong-password-disposable-00000000'}),/BUSINESS_ACCOUNT_AUTH_FAILED/);
    await tx(pool,c=>authorizeBusinessServices(c,service,[context.deviceId]));
  });
  await test('actual-logins-first-admit-concurrent-and-readonly',async()=>{
    const [a,b]=await Promise.all([tx(smpp,c=>resolveBusinessDeviceContext(c,service)),tx(sdar,c=>resolveBusinessDeviceContext(c,service))]);
    assert.equal(a.deviceId,context.deviceId);assert.equal(a.bindingId,b.bindingId);assert.deepEqual(a.actorReferenceKey,context.actorReferenceKey);
    for(const p of [smpp,sdar]) assert.deepEqual(await tx(p,c=>resolveBusinessDeviceContext(c,service,'verify'),true),a);
    assert.equal((await verifyBusinessRuntime(url!,{...env,GOWM_BUSINESS_INSTALL_MODE:'ready',UGV_DATA_SCOPE_KEY:'default',
      SMPP_SERVICE_KEY:service.smppServiceKey,UGV_PROVIDER_ID:service.providerId,UGV_RESOURCE_ID:service.resourceId,
      SDAR_SERVICE_KEY:service.sdarServiceKey,SDAR_MCP_SERVER_ID:service.sdarMcpServerId,SDAR_AGENT_PROFILE_ID:service.agentProfileId})).businessReady,true);
  });
  await test('login-authorization-and-role-switch-not-guc',async()=>{
    await assert.rejects(smpp.query("UPDATE gowm_device.device SET device_name='unauthorized'"),/permission denied/);
    await assert.rejects(smpp.query('SET ROLE gowm_business_api_owner'),/permission denied/);
    await assert.rejects(tx(smpp,async c=>{await c.query("SELECT set_config('gowm.data_scope_key','default',true)");return resolveBusinessDeviceContext(c,{...service,smppServiceKey:'forged'});}),/BUSINESS_CALLER_NOT_AUTHORIZED/);
    await assert.rejects(tx(smpp,c=>resolveBusinessDeviceContext(c,{...service,scope:'forged'})),/BUSINESS_CALLER_NOT_AUTHORIZED/);
    await tx(smpp,async c=>{await c.query('SET LOCAL ROLE gowm_business_client');assert.equal((await resolveBusinessDeviceContext(c,service,'verify')).deviceId,context.deviceId);},true);
    await tx(pool,async c=>{await c.query('UPDATE gowm_device.device SET enabled=false WHERE device_id=$1',[context.deviceId]);
      await assert.rejects(tx(smpp,c=>resolveBusinessDeviceContext(c,{...service,deviceId:'missing'})),/BUSINESS_BINDING_CONFLICT/);},false,true);
  });
  const base=Date.parse('2026-10-11T00:00:00Z');
  const config:MapperConfig={deviceId:'ugv',dataScopeKey:'default',sourceKey:input.sourceKey,producerPipelineKey:input.pipelineKey,scenarioId:'airport',
    worldEpoch:'functional',trackerSessionKey:'functional:ugv',analysisSpaceKey:input.analysisSpaceKey,analysisSrid:32648,
    arrivalUncertaintyMs:1000,mapperVersion:DEVICE_ACTOR_MAPPER_VERSION,deviceContext:context!};
  const observations=new ObservationRepository(pool),operational=new OperationalEventRepository(pool),trajectories=new TrajectoryRepository(pool);
  async function ingest(at:number,longitude=106.81485,session='functional:ugv'){
    const mapped=mapUgvMessage({messageId:randomUUID(),topic:'/ugv/gnss',payload:{longitude,latitude:29.7195,altitude:500},
      payloadSha256:'a'.repeat(64),adapterReceivedAt:new Date(at).toISOString(),retained:false,cursor:{}},{...config,trackerSessionKey:session});
    for(const o of mapped.observations) await observations.insert(normalizeObservationInput(o,new Date(at).toISOString()));
  }
  worker=new ProjectionWorker(pool,{historical:createPostgresHistoricalProjectionStages(pool),batchSize:100,
    components:{bus:{publishEvent:async()=>{},drain:async()=>{}}}});
  async function project(){await new Promise(r=>setTimeout(r,1100));for(let i=0;i<3;i++) await worker!.tick();}
  await test('default-legal-observation-and-master-actor',async()=>{
    await ingest(base);await ingest(base+5000);await ingest(base+3600000);await ingest(base+3605000,107.69485);
    const mapped=mapUgvMessage({messageId:randomUUID(),topic:'/ugv/mission_state',payload:{id:7,type:2,state:1,progress:0},
      payloadSha256:'a'.repeat(64),adapterReceivedAt:new Date(base).toISOString(),retained:false,cursor:{}},config);
    assert.ok(mapped.events.length);for(const event of mapped.events){assert.deepEqual(event.actorReferenceKeys,[context.actorReferenceKey]);await operational.insert(event,new Date(base).toISOString());}
    await project();
    assert.ok((await pool.query('SELECT count(*)::int n FROM world_observation WHERE subject_id=$1',[context.deviceId])).rows[0].n>=4);
    const port=new RepositorySituationReadPort(new SituationRepository(pool),new WorldRepository(pool),pool,'default');
    assert.equal((await port.readiness()).ready,true);
  });
  await test('canonical-gaps-distance-stops-and-truncation',async()=>{
    const track=await trajectories.continuousTrack(context.deviceId,{limit:100},'default');
    assert.equal(track.points.length,4);assert.equal(track.status,'PARTIAL');assert.ok(track.gaps.length>=2);
    assert.equal(distanceBySegmentsM(track.segments),0);assert.deepEqual(stopsBySegments(track.segments,10,30000),[]);
    assert.ok(track.points.every((p:any)=>p.measurementId&&p.timeSolutionId&&p.sequenceKey));
    const clipped=await trajectories.continuousTrack(context.deviceId,{limit:1,from:new Date(base).toISOString(),to:new Date(base+5000).toISOString()},'default');
    assert.equal(clipped.points.length,1);assert.equal(clipped.truncated,true);
    assert.equal((await trajectories.continuousTrack(context.deviceId,{limit:20,from:new Date(base-20000).toISOString(),to:new Date(base-10000).toISOString()},'default')).status,'NO_DATA');
    assert.equal((await trajectories.continuousTrack(context.deviceId,{limit:20},'other')).points.length,0);
  });
  await test('rest-and-mcp-use-the-same-versioned-gap-contract',async()=>{
    const app=await api(),path='/trajectory/'+encodeURIComponent(context.deviceId);
    const track=await app.inject({url:path+'/track'});assert.equal(track.statusCode,200);assert.equal(track.json().summary.distanceTraveledM,0);
    assert.equal(track.json().status,'PARTIAL');assert.equal(track.headers['x-gowm-trajectory-gap-count'],String(track.json().gaps.length));
    const stops=await app.inject({url:path+'/stops'});assert.equal(stops.statusCode,200);assert.deepEqual(stops.json(),[]);
    assert.equal((await app.inject({url:path+'/track',headers:{'x-gowm-data-scope':'forged'}})).statusCode,403);
    const address=await app.listen({host:'127.0.0.1',port:0});process.env.WORLD_API_URL=address;
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
    const {createWorldMcpServer}=await import('../../services/world-mcp-server/src/server.js');
    const server=createWorldMcpServer(),client=new Client({name:'functional-ci',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();
    try{await server.connect(st);await client.connect(ct);const response=await client.callTool({name:'get_object_track',arguments:{objectId:context.deviceId}});
      assert.equal(response.isError,undefined);const data=response.structuredContent as any;
      assert.equal(data.facts.status,'PARTIAL');assert.equal(data.summary.distanceTraveledM,0);assert.deepEqual(data.context.trajectoryIdentity,track.json().identity);
      assert.equal(data.context.worldVersion,undefined);assert.equal(data.facts.points.length,4);
    }finally{await client.close();await server.close();}
  });
  await test('late-revision-preserves-old-input-and-session-ambiguity',async()=>{
    const before=(await pool.query('SELECT tracklet_version_id,content_hash FROM mobility_tracklet_version ORDER BY tracklet_version_id')).rows;
    await ingest(base+1000);await ingest(base+10000,106.81485,'functional:other');
    const pending=await (await api()).inject({url:'/trajectory/'+encodeURIComponent(context.deviceId)+'/track?trackerSessionKey=functional%3Aother'});
    assert.equal(pending.statusCode,503);await project();
    assert.deepEqual((await pool.query('SELECT tracklet_version_id,content_hash FROM mobility_tracklet_version WHERE tracklet_version_id=ANY($1::uuid[]) ORDER BY tracklet_version_id',[before.map(r=>r.tracklet_version_id)])).rows,before);
    await assert.rejects(trajectories.continuousTrack(context.deviceId,{limit:100},'default'),/TRAJECTORY_SELECTION_AMBIGUOUS/);
    assert.equal((await trajectories.continuousTrack(context.deviceId,{limit:100,trackerSessionKey:'functional:ugv'},'default')).points.length,5);
    assert.equal((await (await api()).inject({url:'/trajectory/'+encodeURIComponent(context.deviceId)+'/track'})).statusCode,409);
  });
  await test('two-device-native-target-mission-lineage-real-logins',async()=>{
    const devices=await fixture(pool);
    const native=await postgresTests(pool);assert.equal(native.status,'PASS',JSON.stringify(native.scenarios.filter(r=>r.status!=='PASS')));
    console.log(JSON.stringify({gate:'NATIVE_SDK_REGRESSION',status:native.status,cases:native.scenarios.length}));
    for(const device of devices){const binding=(await pool.query('SELECT * FROM gowm_device.device_service_binding WHERE device_id=$1 AND valid_to IS NULL',[device.deviceId])).rows[0];
      await tx(pool,c=>authorizeBusinessServices(c,{scope:'TEST:gowm-shared-storage-v02',smppServiceKey:binding.smpp_service_key,providerId:binding.provider_id,
        resourceId:binding.resource_id,sdarServiceKey:binding.sdar_service_key,sdarMcpServerId:binding.sdar_mcp_server_id},[device.deviceId]));
      for(const p of [smpp,sdar]){const repo=new BusinessStorage(p);assert.equal((await repo.listDeviceTasks(device.deviceId)).length,1);
        assert.ok((await repo.getTaskLineage(device.deviceId,device.taskId)).lineage.length>=3);
        assert.equal((await repo.getMcpTaskDetails(device.deviceId,device.mcpIds[0]!))?.device_id,device.deviceId);
        assert.ok((await repo.getMissionLineage(device.deviceId,device.missionId)).length>=1);}
      const p=new BusinessStorage(sdar);
      await sdar.query('UPDATE ugv_sdar.remote_task_binding SET updated_at=updated_at WHERE binding_id=$1',[device.remoteIds[0]]);
      assert.equal((await p.transaction(c=>p.resolveRemoteTask(c,device.deviceId,device.remoteIds[0]!,device.mcpIds[0]!,'test-smpp'))).canonical_mcp_task_id,device.mcpIds[0]);
      await p.transaction(async c=>{const target=await p.createTarget(c,{deviceId:device.deviceId,groupId:randomUUID(),revision:1,scope:'TEST:gowm-shared-storage-v02',
        sourceDomain:'SDAR',sourceIdentity:{test:true},geometry:{type:'Point',coordinates:[106,29]},crs:'EPSG:4326'});
        const args={targetId:target.target_id,deviceId:device.deviceId,scope:'TEST:gowm-shared-storage-v02',domain:'SDAR',kind:'TASK' as const,key:{taskId:device.taskId},role:'REQUESTED',purpose:'MOVE_DESTINATION',argumentPath:'functional'};
        assert.deepEqual(await p.attachTargetToOwner(c,args),await p.attachTargetToOwner(c,args));
      });
      const s=new BusinessStorage(smpp);
      await s.transaction(async c=>{const mission=await s.registerMissionIdentity(c,{deviceId:device.deviceId,scope:'TEST:gowm-shared-storage-v02',channel:'CHASSIS',authority:'functional',kind:'MISSION_ID_WITH_SESSION',session:'functional',nativeId:'1',evidence:{test:true}});
        const args={deviceId:device.deviceId,scope:'TEST:gowm-shared-storage-v02',bindingId:device.bindingId,mcpTaskId:device.mcpIds[0]!,executionId:`test-external-${device.deviceId.endsWith('A')?'A':'B'}-0`,
          providerTaskId:device.providerIds[0]!,stepId:'primary',missionId:mission.mission_instance_id,relation:'CREATED',state:'LINKED',source:'functional',idempotencyKey:'functional',evidence:{test:true}};
        assert.deepEqual(await s.linkExecutionToMission(c,args),await s.linkExecutionToMission(c,args));});
    }
    const repo=new BusinessStorage(sdar);assert.equal((await repo.getTaskLineage(devices[0]!.deviceId,devices[1]!.taskId)).lineage.length,0);
    await assert.rejects(tx(sdar,c=>repo.validateOwner(c,devices[0]!.deviceId,'SDAR','TASK',{taskId:devices[1]!.taskId})),/OWNER_NOT_FOUND_OR_DEVICE_MISMATCH/);
    await assert.rejects(tx(sdar,c=>repo.validateOwner(c,devices[0]!.deviceId,'SMPP','MCP_TASK',{taskId:devices[0]!.mcpIds[0]!})),/BUSINESS_CALLER_NOT_AUTHORIZED/);
    const port=new RepositorySituationReadPort(new SituationRepository(pool),new WorldRepository(pool),pool,'default');
    assert.equal((await port.readiness()).ready,true,'091 scoped projection supports multiple stored scopes while the Provider enforces its accepted scope');
  });
  await test('second-device-default-ambiguity-and-explicit-binding-priority',async()=>{
    const second=await tx(pool,c=>initializeDefaultDevice(c,{...input,identifier:'second',endpointKey:'second',brokerUrl:'mqtt://second/'}));
    const extra={...service,smppServiceKey:'functional-new',resourceId:'functional-new'};
    await tx(pool,c=>authorizeBusinessServices(c,extra,[context.deviceId]));
    await assert.rejects(tx(smpp,c=>resolveBusinessDeviceContext(c,extra)),/DEVICE_AMBIGUOUS/);
    assert.equal((await tx(smpp,c=>resolveBusinessDeviceContext(c,service,'verify'),true)).deviceId,context.deviceId);
    await assert.rejects(tx(smpp,c=>resolveBusinessDeviceContext(c,{...service,deviceId:second.context.deviceId})),/BUSINESS_BINDING_CONFLICT/);
    await pool.query('UPDATE gowm_device.device SET enabled=false WHERE device_id=$1',[context.deviceId]);
    await assert.rejects(tx(smpp,c=>resolveBusinessDeviceContext(c,service)),/DEVICE_DISABLED/);
    await pool.query('UPDATE gowm_device.device SET enabled=true WHERE device_id=$1',[context.deviceId]);
  });
  const events=new EventRepository(pool);
  async function event(c:pg.Pool|PoolClient,id:string,version:number,scope='default'){
    await c.query("INSERT INTO world_event(event_id,event_type,subject_type,subject_id,event_time,world_version,correlation_id,causation_id,data_scope_key) VALUES($1,'functional.event','UGV',$2,clock_timestamp(),$3,'functional','functional',$4)",[id,context.deviceId,version,scope]);
  }
  await test('sse-over-ten-thousand-same-version-pages',async()=>{
    await pool.query("INSERT INTO world_event(event_type,subject_type,subject_id,event_time,world_version,correlation_id,causation_id,data_scope_key) SELECT 'functional.event','UGV',$1,clock_timestamp(),7,'functional','functional','default' FROM generate_series(1,12001)",[context.deviceId]);
    while(await events.appendFeed(1000)){}
    let cursor='0',ids=new Set<string>(),count=0;for(;;){const page=await events.feedPage('default',cursor,173);if(!page.length)break;
      for(const row of page){assert.ok(!ids.has(row.event.eventId));ids.add(row.event.eventId);count++;cursor=row.position;}}
    assert.ok(count>=12001);assert.equal(ids.size,count);
  });
  await test('late-commit-and-concurrent-relays-rollback',async()=>{
    const c=await pool.connect();const late=randomUUID(),early=randomUUID();
    try{await c.query('BEGIN');await event(c,late,1);await event(pool,early,999);await events.appendFeed(1000);
      assert.equal(await events.feedCursor('default',late),undefined);const first=await events.feedCursor('default',early);assert.ok(first);
      await c.query('COMMIT');await Promise.all([events.appendFeed(1000),new EventRepository(pool).appendFeed(1000)]);
      const last=await events.feedCursor('default',late);assert.ok(last);assert.ok(BigInt(last.position)>BigInt(first.position));
      const page=await events.feedPage('default',first.position);assert.ok(page.some(row=>row.event.eventId===late));
      assert.equal(await events.feedCursor('TEST:gowm-shared-storage-v02',late),undefined);
      const rollback=randomUUID();await c.query('BEGIN');await event(c,rollback,1000);await c.query('ROLLBACK');await events.appendFeed(1000);assert.equal(await events.feedCursor('default',rollback),undefined);
    }finally{await c.query('ROLLBACK');c.release();}
  });
  await test('sse-pump-reconnect-scope-filter-and-backpressure',async()=>{
    const page=await events.feedPage('default','0',7);const cursor=page[4]!;
    const controller=new AbortController();const frames:string[]=[];const response=new EventEmitter() as ServerResponse;
    Object.assign(response,{destroyed:false,write:(frame:string)=>{frames.push(frame);if(frames.length===3)controller.abort();return true;}});
    await pumpEventStream(events,response,{scope:'default',after:cursor.position,filter:{eventType:'functional.event'},signal:controller.signal,pageSize:2});
    const next=(await events.feedPage('default',cursor.position,100)).find(row=>row.event.eventType==='functional.event');assert.ok(next);
    assert.equal(frames.length,3);assert.ok(frames[0]!.includes(`id: ${next.event.eventId}`));assert.ok(frames[0]!.endsWith('\n\n'));
    const slow=new EventEmitter() as ServerResponse;Object.assign(slow,{destroyed:false,write:()=>false});
    await assert.rejects(writeFrame(slow,'data: x\n\n',new AbortController().signal,10),/STREAM_BACKPRESSURE_TIMEOUT/);
    assert.equal(slow.listenerCount('drain'),0);
    const abort=new AbortController();const pending=writeFrame(slow,'data: x\n\n',abort.signal,1000);abort.abort();await assert.rejects(pending,/STREAM_CLOSED/);
    assert.equal(slow.listenerCount('close'),0);
  });
  await test('http-sse-cursor-validation-and-real-disconnect',async()=>{
    const app=await api(),base=String(process.env.WORLD_API_URL);
    assert.equal((await app.inject({url:'/events/stream',headers:{'last-event-id':'invalid'}})).statusCode,400);
    assert.equal((await app.inject({url:'/events/stream',headers:{'last-event-id':randomUUID()}})).statusCode,410);
    const cursor=(await events.feedPage('default','0',100)).find(row=>row.event.eventType==='functional.event')!;
    assert.equal((await app.inject({url:'/events/stream?eventType=incompatible',headers:{'last-event-id':cursor.event.eventId}})).statusCode,410);
    assert.equal((await app.inject({url:'/events/stream',headers:{'x-gowm-data-scope':'forged','last-event-id':cursor.event.eventId}})).statusCode,403);
    const abort=new AbortController();
    try{
      const response=await fetch(base+'/events/stream?eventType=functional.event&sinceWorldVersion=999999',{headers:{'last-event-id':cursor.event.eventId},signal:abort.signal});
      assert.equal(response.status,200);const reader=response.body!.getReader();let text='';
      while(!text.includes('\n\n')){const r=await reader.read();assert.equal(r.done,false);text+=new TextDecoder().decode(r.value);}
      const next=(await events.feedPage('default',cursor.position,100)).find(row=>row.event.eventType==='functional.event')!;
      assert.ok(text.startsWith('id: '+next.event.eventId+'\n'));abort.abort();await reader.cancel().catch(()=>{});
    }finally{abort.abort();}
  });
  console.log(JSON.stringify({status:'PASS',gate:'FUNCTIONAL_REPAIR_REAL_POSTGRES',evidence:'ISOLATED_LOCAL_FIXTURE_NOT_EXTERNAL_ACCEPTANCE',cases:results}));
}finally{await app?.close();const {closeDatabasePool}=await import('../../packages/runtime/src/db.js');await closeDatabasePool();await worker?.close();for(const p of logins)await p.end();await pool.end();}
