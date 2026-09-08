import pg, { type PoolClient } from 'pg';
import { initializeBusinessAccounts } from '../../scripts/business-storage/accounts.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeDefaultDevice, loadIngestDeviceContext, resolveDeviceIdentity, resolveBusinessDeviceContext,
  type DefaultDeviceInput, type IngestDeviceContext, UGV_STREAMS } from '../../packages/integrations/device-business-storage/src/index.js';
import { mapUgvMessage, DEVICE_ACTOR_MAPPER_VERSION, type MapperConfig } from '../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js';
import { UgvIngestRepository } from '../../services/ugv-mqtt-ingest/src/repository.js';
import { OperationalEventRepository } from '../../packages/runtime/src/operational-event-repository.js';
import { ObservationRepository } from '../../packages/runtime/src/observation-repository.js';
import { normalizeObservationInput } from '../../packages/observation-model/src/canonical.js';
import { OperationalReadRepository } from '../../packages/runtime/src/operational-read-repository.js';
import type { SourceSchemaRegistry } from '../../packages/integrations/ugv-mqtt-ingest-core/src/source-schema-registry.js';
import type { SourceSchemaLock } from '../../packages/integrations/ugv-mqtt-ingest-core/src/contracts.js';

const url = process.env.GOWM_ACTOR_TEST_DATABASE_URL;
if (!url && process.env.npm_lifecycle_event === 'validate:ugv-device-actor') throw Error('GOWM_ACTOR_TEST_DATABASE_URL is required');
const integration = url ? describe : describe.skip;
const key = `actor-${randomUUID()}`;
const input: DefaultDeviceInput = { scope:key, namespace:'ugv',identifier:`${key}-a`,deviceName:'Actor device A',
  sourceKey:key,pipelineKey:`${key}:pipeline`,analysisSpaceKey:'actor-test-utm48n',analysisSrid:32648,
  endpointKey:`${key}:endpoint-a`,brokerUrl:'mqtt://actor-broker-a:1883/',clientPrefix:'actor-test' };
const business = { scope:key,smppServiceKey:`${key}-smpp`,providerId:'ugv',resourceId:`${key}-resource` };
const base = { payloadSha256:'a'.repeat(64),adapterReceivedAt:new Date().toISOString(),retained:false,cursor:{} };
const lock: SourceSchemaLock = {lockVersion:'1.0',sourceDirectory:'/schema',files:[],topicSchemaHash:'a'.repeat(64),
  validatedTopics:Object.keys(UGV_STREAMS) as SourceSchemaLock['validatedTopics'],topicSchemas:{} as SourceSchemaLock['topicSchemas'],schemaDocuments:{}};
const schemas = { validate: (_topic:string,data:unknown) => ({success:true,data,errors:[]}) } as unknown as SourceSchemaRegistry;
function mapper(context: IngestDeviceContext): MapperConfig {
  return {deviceId:context.deviceIdentifier,dataScopeKey:key,sourceKey:key,producerPipelineKey:input.pipelineKey,
    scenarioId:'airport',worldEpoch:'actor-run',trackerSessionKey:`actor-run:${context.deviceIdentifier}`,analysisSpaceKey:input.analysisSpaceKey,
    analysisSrid:32648,arrivalUncertaintyMs:1000,mapperVersion:DEVICE_ACTOR_MAPPER_VERSION,deviceContext:context};
}

integration('UGV master actor integration on isolated PostgreSQL', () => {
  let pool: pg.Pool, a: IngestDeviceContext, b: IngestDeviceContext;
  async function tx<T>(fn: (c:PoolClient)=>Promise<T>, rollback=false) {
    const c=await pool.connect();
    try { await c.query('BEGIN'); const r=await fn(c); await c.query(rollback?'ROLLBACK':'COMMIT'); return r; }
    catch(e) { await c.query('ROLLBACK'); throw e; } finally {c.release();}
  }
  beforeAll(async () => {
    if (!url || !/^gowm_ugv_actor_test(?:_[a-z0-9_]+)?$/.test(new URL(url).pathname.slice(1))) throw Error('ISOLATED_ACTOR_TEST_DATABASE_REQUIRED');
    pool=new pg.Pool({connectionString:url,max:4});
  });
  afterAll(async()=>{ await pool?.end(); });

  it('initializes the default source and device twice without duplicates or synthetic observations', async () => {
    const before=(await pool.query('SELECT count(*) FROM public.world_observation')).rows;
    const first=await tx(c=>initializeDefaultDevice(c,input));
    const second=await tx(c=>initializeDefaultDevice(c,input));
    expect(second).toEqual(first); a=first.context;
    expect(a.deviceId).toBe(`ugv:${input.identifier}`);
    expect(a.actorReferenceKey).toMatchObject({namespace:'gowm',kind:'WORLD_OBJECT'});
    expect((await pool.query('SELECT count(*)::int n FROM gowm_device.device WHERE data_scope_key=$1',[key])).rows[0].n).toBe(1);
    expect(a.routes).toHaveLength(7);
    expect((await pool.query('SELECT count(*) FROM public.world_observation')).rows).toEqual(before);
  });
  it('reuses site TEST scope, source default space and existing world object without rewriting them', async () => {
    await tx(async c=>{
      const site={...input,scope:`${key}-site`,sourceKey:`${key}-site-source`,pipelineKey:`${key}-site-pipeline`,
        identifier:`${key}-site`,endpointKey:`${key}-site-endpoint`,brokerUrl:'mqtt://site-broker/'};
      await c.query("INSERT INTO data_scope(scope_key,operational_domain) VALUES($1,'TEST')",[site.scope]);
      await c.query("INSERT INTO source_registry(source_key,data_scope_key,source_type,default_analysis_space_key) VALUES($1,$2,'MQTT','default')",[site.sourceKey,site.scope]);
      const deviceId=`ugv:${site.identifier}`;
      await c.query("INSERT INTO world_object(id,data_scope_key,object_type,properties) VALUES($1,$2,'UGV','{\"name\":\"Site UGV\"}')",[deviceId,site.scope]);
      const snapshot=async()=>({
        scope:(await c.query('SELECT * FROM data_scope WHERE scope_key=$1',[site.scope])).rows,
        source:(await c.query('SELECT * FROM source_registry WHERE source_key=$1',[site.sourceKey])).rows,
        world:(await c.query('SELECT * FROM world_object WHERE id=$1',[deviceId])).rows
      });
      const before=await snapshot();
      const first=await initializeDefaultDevice(c,site),second=await initializeDefaultDevice(c,site);
      expect(first).toEqual(second); expect(first.context.deviceId).toBe(deviceId);
      expect(first.context.routes).toHaveLength(7);expect(await snapshot()).toEqual(before);
      expect((await c.query('SELECT count(*)::int n FROM gowm_device.device WHERE data_scope_key=$1',[site.scope])).rows[0].n).toBe(1);
    },true);
  });
  it('creates business logins with stable passwords and grants current and future domain tables', async () => {
    const env={SMPP_DB_PASSWORD:randomUUID().replaceAll('-',''),SDAR_DB_PASSWORD:randomUUID().replaceAll('-','')};
    // This suite is restricted to a disposable GOWM test database/server.
    await initializeBusinessAccounts(url!,env);
    const passwords=(await pool.query("SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('ugv_smpp_app','ugv_sdar_app') ORDER BY rolname")).rows;
    await initializeBusinessAccounts(url!,env);
    expect((await pool.query("SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('ugv_smpp_app','ugv_sdar_app') ORDER BY rolname")).rows).toEqual(passwords);
    await expect(initializeBusinessAccounts(url!,{...env,SMPP_DB_PASSWORD:'different'.repeat(8)})).rejects.toThrow('BUSINESS_ACCOUNT_AUTH_FAILED');
    for(const [role,schema,password] of [['ugv_smpp_app','ugv_smpp',env.SMPP_DB_PASSWORD],['ugv_sdar_app','ugv_sdar',env.SDAR_DB_PASSWORD]]){
      await pool.query(`CREATE TABLE ${schema}.bootstrap_probe(id int)`);
      const login=new URL(url!);login.username=role!;login.password=password!;
      const c=new pg.Client({connectionString:login.href});await c.connect();
      try {
        expect((await c.query('SHOW search_path')).rows[0].search_path).toBe(`${schema}, public`);
        await c.query('INSERT INTO bootstrap_probe VALUES(1)');
        expect((await c.query('SELECT * FROM bootstrap_probe')).rows).toEqual([{id:1}]);
        const other=schema==='ugv_smpp'?'ugv_sdar':'ugv_smpp';
        expect((await c.query("SELECT has_schema_privilege(current_user,$1,'USAGE') allowed",[other])).rows[0].allowed).toBe(false);
      } finally {await c.end();await pool.query(`DROP TABLE ${schema}.bootstrap_probe`);}
    }
  });
  it('makes SMPP and later SDAR resolve the same sole master and preserves earlier binding history', async () => {
    const smpp=await tx(c=>resolveBusinessDeviceContext(c,business));
    const sdarInput={...business,sdarServiceKey:`${key}-sdar`,sdarMcpServerId:'mcp-ugv'};
    await expect(tx(c=>resolveBusinessDeviceContext(c,sdarInput,'verify'))).rejects.toThrow('BUSINESS_BINDING_INCOMPLETE');
    const sdar=await tx(c=>resolveBusinessDeviceContext(c,sdarInput));
    expect(await tx(c=>resolveBusinessDeviceContext(c,sdarInput,'verify'))).toEqual(sdar);
    expect(sdar.deviceId).toBe(a.deviceId); expect(smpp.deviceId).toBe(a.deviceId);
    expect(sdar.bindingId).not.toBe(smpp.bindingId);
    expect((await pool.query('SELECT old.valid_to<=new.valid_from ok FROM gowm_device.device_service_binding old CROSS JOIN gowm_device.device_service_binding new WHERE old.binding_id=$1 AND new.binding_id=$2',[smpp.bindingId,sdar.bindingId])).rows[0].ok).toBe(true);
    expect(await tx(c=>resolveBusinessDeviceContext(c,sdarInput))).toEqual(sdar);
    expect((await pool.query('SELECT valid_to FROM gowm_device.device_service_binding WHERE binding_id=$1',[smpp.bindingId])).rows[0].valid_to).not.toBeNull();
    await expect(tx(c=>resolveBusinessDeviceContext(c,{...sdarInput,sdarMcpServerId:'conflicting-mcp'}))).rejects.toThrow('BUSINESS_BINDING_CONFLICT');
    expect((await tx(c=>initializeDefaultDevice(c,{...input,business:sdarInput}))).business?.bindingId).toBe(sdar.bindingId);
  });
  it('runs the deployable initialization and read-only verification commands against the same configuration', async () => {
    const env={...process.env,GOWM_DATABASE_URL:url!,UGV_DATA_SCOPE_KEY:key,UGV_DEVICE_NAMESPACE:input.namespace,
      UGV_DEVICE_ID:input.identifier,UGV_DEVICE_NAME:input.deviceName,UGV_SOURCE_KEY:key,UGV_PRODUCER_PIPELINE_KEY:input.pipelineKey,
      UGV_ANALYSIS_SPACE_KEY:input.analysisSpaceKey,UGV_MQTT_ENDPOINT_KEY:input.endpointKey,UGV_MQTT_URL:input.brokerUrl,
      UGV_MQTT_CLIENT_ID_PREFIX:input.clientPrefix,SMPP_SERVICE_KEY:business.smppServiceKey,UGV_PROVIDER_ID:business.providerId,
      UGV_RESOURCE_ID:business.resourceId,SDAR_SERVICE_KEY:`${key}-sdar`,SDAR_MCP_SERVER_ID:'mcp-ugv'};
    for (const command of ['init-default','verify-default']) {
      const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','scripts/business-storage/device-cli.ts',command],{env});
      expect(JSON.parse(stdout)).toMatchObject({status:'PASS',context:{deviceId:a.deviceId},business:{deviceId:a.deviceId}});
    }
  });
  it('rejects conflicting initialization without changing existing endpoint or master', async () => {
    await expect(tx(c=>initializeDefaultDevice(c,{...input,brokerUrl:'mqtt://other-broker/'}))).rejects.toThrow('DEFAULT_DEVICE_CONFIG_CONFLICT');
    await expect(tx(c=>initializeDefaultDevice(c,{...input,deviceId:'other-device'}))).rejects.toThrow('DEFAULT_DEVICE_IDENTITY_CONFLICT');
    expect((await tx(c=>initializeDefaultDevice(c,input))).context).toEqual(a);
  });
  it('uses an existing world object and enforces explicit selection after a second device is registered', async () => {
    const other={...input,identifier:`${key}-b`,deviceId:`existing:${key}-b`,deviceName:'Actor B',endpointKey:`${key}:endpoint-b`,brokerUrl:'mqtt://actor-broker-b:1883/'};
    await pool.query("INSERT INTO public.world_object(id,object_type,data_scope_key,properties) VALUES($1,'UGV',$2,'{\"name\":\"Existing B\"}')", [other.deviceId,key]);
    b=(await tx(c=>initializeDefaultDevice(c,other))).context;
    expect(b.actorReferenceKey.id).not.toBe(a.actorReferenceKey.id);
    expect(b.deviceId).toBe(other.deviceId);
    expect((await pool.query('SELECT properties FROM public.world_object WHERE id=$1',[b.deviceId])).rows[0].properties.name).toBe('Existing B');
    await expect(tx(c=>resolveBusinessDeviceContext(c,{...business,smppServiceKey:'unbound-service',resourceId:'unbound-resource'}))).rejects.toThrow('DEVICE_AMBIGUOUS');
    expect((await tx(c=>resolveBusinessDeviceContext(c,business))).deviceId).toBe(a.deviceId);
    expect((await tx(c=>resolveBusinessDeviceContext(c,{...business,deviceId:b.deviceId,resourceId:'resource-b'}))).deviceId).toBe(b.deviceId);
    await expect(tx(c=>resolveBusinessDeviceContext(c,{...business,deviceId:b.deviceId}))).rejects.toThrow('BUSINESS_BINDING_CONFLICT');
  });
  it('fails closed for disabled, unknown, cross-scope, missing reference and conflicting source', async () => {
    await expect(tx(c=>resolveDeviceIdentity(c,{scope:key,deviceId:'missing'}))).rejects.toThrow('DEVICE_NO_MATCH');
    await expect(tx(c=>resolveDeviceIdentity(c,{scope:'default',deviceId:a.deviceId}))).rejects.toThrow('DEVICE_NO_MATCH');
    await tx(async c=>{
      await c.query('UPDATE gowm_device.device SET enabled=false WHERE device_id=$1',[a.deviceId]);
      await expect(resolveDeviceIdentity(c,{scope:key,deviceId:a.deviceId})).rejects.toThrow('DEVICE_DISABLED');
    },true);
    await tx(async c=>{
      await c.query("INSERT INTO public.world_reference_retirement(reference_key,reason,receipt_ref) VALUES($1,'isolated actor test','actor-test')",[a.actorReferenceKey.id]);
      await expect(resolveDeviceIdentity(c,{scope:key,deviceId:a.deviceId})).rejects.toThrow('DEVICE_WORLD_REFERENCE_UNAVAILABLE');
    },true);
    await tx(async c=>{
      await c.query('UPDATE public.world_object SET deleted_at=now() WHERE id=$1',[a.deviceId]);
      await expect(resolveDeviceIdentity(c,{scope:key,deviceId:a.deviceId})).rejects.toThrow('DEVICE_WORLD_REFERENCE_UNAVAILABLE');
    },true);
    await expect(tx(c=>loadIngestDeviceContext(c,{...input,sourceKey:'wrong',topics:Object.keys(UGV_STREAMS)}))).rejects.toThrow('DEVICE_STREAM_SOURCE_CONFLICT');
    await tx(async c=>{
      await c.query('UPDATE gowm_device.device_stream SET enabled=false WHERE device_id=$1',[a.deviceId]);
      await expect(loadIngestDeviceContext(c,{...input,topics:Object.keys(UGV_STREAMS)})).rejects.toThrow('DEVICE_STREAM_NO_MATCH');
    },true);
  });
  it('reads device context using a role that cannot modify device configuration', async () => {
    await tx(async c=>{
      await c.query('SET LOCAL ROLE gowm_device_reader');
      expect(await loadIngestDeviceContext(c,{...input,topics:Object.keys(UGV_STREAMS)})).toEqual(a);
      expect((await c.query("SELECT has_table_privilege(current_user,'gowm_device.device','INSERT') can_write")).rows[0].can_write).toBe(false);
    });
  });
  it('ingests canonical vehicle observations using the registered datastream and the same master world object', async () => {
    const observation=mapUgvMessage({...base,messageId:randomUUID(),topic:'/ugv/gnss',
      payload:{latitude:29.7195,longitude:106.81485,altitude:500}},mapper(a)).observations[0]!;
    expect(observation.subject.id).toBe(a.deviceId);
    const stored=await new ObservationRepository(pool).insert(normalizeObservationInput(observation,base.adapterReceivedAt),{project:false});
    expect(stored.status).toBe('accepted');
    expect((await pool.query("SELECT internal_id FROM public.world_reference_identity WHERE reference_key=$1",[a.actorReferenceKey.id])).rows[0].internal_id).toBe(observation.subject.id);
  });
  it('persists all event actor variants and filters two devices by identity across reference versions', async () => {
    const events=new OperationalEventRepository(pool), read=new OperationalReadRepository(pool);
    for (const context of [a,b]) {
      for (const [topic,payload] of [
        ['/ugv/mission_state',{id:7,type:2,state:1,progress:1}],
        ['/ugv/area_recon/status',{status:4,last_cmd_ack:{seq:1,ok:true}}],
        ['/ugv/area_recon/status',{status:8,last_cmd_ack:{seq:2,ok:false}}]
      ] as const) {
        const result=mapUgvMessage({...base,messageId:randomUUID(),topic,payload},mapper(context));
        for (const event of result.events) {
          expect((await events.insert(event)).event.actorReferenceKeys).toEqual([context.actorReferenceKey]);
          expect((await events.insert(event)).status).toBe('duplicate');
        }
      }
    }
    await pool.query('SELECT public.project_pending_operational_tasks(1000)');
    for (const context of [a,b]) {
      const found=await read.find(key,{actorReferenceKeys:[{...context.actorReferenceKey,version:'later-version'}]});
      expect(found.result.tasks).toHaveLength(2);
      expect(found.result.tasks.every(t=>t.actorReferenceKeys.some(r=>r.id===context.actorReferenceKey.id))).toBe(true);
    }
  });
  it('retains frozen actor versions on reconnect and rejects route or device drift', async () => {
    const config=mapper(a), repo=new UgvIngestRepository(pool,config.deviceId,1048576,10000,schemas);
    const client=`${key}-reconnect`, broker='actor-broker-a:1883';
    const first=await repo.startSession(client,broker,false,lock,'actor-test',config);
    const next={...config,deviceContext:{...a,actorReferenceKey:{...a.actorReferenceKey,version:'999'}}};
    expect((await repo.startSession(client,broker,true,lock,'actor-test',next)).sessionId).toBe(first.sessionId);
    const stored=(await pool.query('SELECT mapper_context FROM ugv_ingest.mqtt_session WHERE session_id=$1',[first.sessionId])).rows[0].mapper_context;
    expect(stored).toEqual(config);
    await expect(repo.startSession(client,broker,true,lock,'actor-test',mapper(b))).rejects.toMatchObject({code:'MAPPER_CONTEXT_CHANGED_WITH_ACTIVE_SESSION'});
    const drift=structuredClone(config); drift.deviceContext!.routes[0]!.datastream_key='changed';
    await expect(repo.startSession(client,broker,true,lock,'actor-test',drift)).rejects.toMatchObject({code:'MAPPER_CONTEXT_CHANGED_WITH_ACTIVE_SESSION'});
  });
  it('maps accepted inboxes using their frozen master and preserves duplicate outbox bytes', async () => {
    const config=mapper(b), repo=new UgvIngestRepository(pool,config.deviceId,1048576,10000,schemas);
    const client=`${key}-pending`, broker='actor-broker-b:1883';
    const session=await repo.startSession(client,broker,false,lock,'actor-test',config);
    const body=Buffer.from(JSON.stringify({id:7,type:2,state:1,progress:1}));
    const accepted=await repo.accept(session.sessionId,'/ugv/mission_state',body,{messageId:1,qos:1},base.adapterReceivedAt);
    expect((await repo.accept(session.sessionId,'/ugv/mission_state',body,{messageId:1,qos:1,dup:true},base.adapterReceivedAt)).messageId).toBe(accepted.messageId);
    await pool.query('UPDATE gowm_device.device SET device_name=$2 WHERE device_id=$1',[b.deviceId,'Renamed B']);
    const pending=(await repo.nextPending(client,broker))!;
    expect(pending.mapperConfig).toEqual(config);
    const result=mapUgvMessage(pending,pending.mapperConfig);
    await repo.storeMapping(pending,result,config.mapperVersion);
    const before=(await pool.query('SELECT body_sha256,request_body_bytes FROM ugv_ingest.outbox_message WHERE inbox_message_id=$1 ORDER BY ordinal',[pending.messageId])).rows;
    await repo.storeMapping(pending,result,config.mapperVersion);
    expect((await pool.query('SELECT body_sha256,request_body_bytes FROM ugv_ingest.outbox_message WHERE inbox_message_id=$1 ORDER BY ordinal',[pending.messageId])).rows).toEqual(before);
    const event=before.map(r=>JSON.parse(r.request_body_bytes.toString())).find(r=>r.actorReferenceKeys);
    expect(event.actorReferenceKeys).toEqual([b.actorReferenceKey]);
  });
  it('does not rewrite legacy events and blocks version changes while legacy work remains pending', async () => {
    const {deviceContext:_,...rest}=mapper(a), legacy={...rest,mapperVersion:'ugv-mqtt-canonical-v2'};
    const events=new OperationalEventRepository(pool);
    const old=mapUgvMessage({...base,messageId:randomUUID(),topic:'/ugv/mission_state',payload:{id:9,state:1,progress:0}},legacy).events[0]!;
    await events.insert(old);
    const before=(await pool.query('SELECT content_hash,actor_reference_keys FROM public.operational_task_event WHERE event_id=$1',[old.eventId])).rows;
    const repo=new UgvIngestRepository(pool,legacy.deviceId,1048576,10000,schemas), client=`${key}-legacy`;
    const session=await repo.startSession(client,'broker',false,lock,'old',legacy);
    await repo.accept(session.sessionId,'/ugv/mission_state',Buffer.from('{"id":9,"state":1,"progress":0}'),{messageId:1,qos:1},base.adapterReceivedAt);
    await expect(repo.startSession(client,'broker',false,lock,'new',mapper(a))).rejects.toMatchObject({code:'MAPPER_CONTEXT_CHANGED_WITH_PENDING_INBOX'});
    const pending=(await repo.nextPending(client,'broker'))!;
    expect(mapUgvMessage(pending,pending.mapperConfig).events[0]?.actorReferenceKeys).toEqual([]);
    expect((await pool.query('SELECT content_hash,actor_reference_keys FROM public.operational_task_event WHERE event_id=$1',[old.eventId])).rows).toEqual(before);
  });
});
