import {describe,it,expect,vi,afterEach} from 'vitest';
import {loadAutoConfig,retryDelay} from '../../services/history-auto/src/index.js';
import {loadUgvIngestConfig} from '../../services/ugv-mqtt-ingest/src/config.js';
import {mapUgvMessage,VEHICLE_SPEED_MAPPER_VERSION,type MapperConfig} from '../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js';
import {ensureBindingSnapshotIndex} from '../../scripts/binding-snapshot-index.js';
import {UgvIngestRepository} from '../../services/ugv-mqtt-ingest/src/repository.js';
import type {SourceSchemaRegistry} from '../../packages/integrations/ugv-mqtt-ingest-core/src/source-schema-registry.js';
import type pg from 'pg';
const config:MapperConfig={deviceId:'ugv',dataScopeKey:'default',sourceKey:'ugv-airport-sim-mqtt',producerPipelineKey:'test',
 scenarioId:'airport',worldEpoch:'run',trackerSessionKey:'run:ugv',analysisSpaceKey:'default',analysisSrid:32648,
 arrivalUncertaintyMs:1000,mapperVersion:VEHICLE_SPEED_MAPPER_VERSION};
const input={messageId:'11111111-1111-4111-8111-111111111111',payloadSha256:'a'.repeat(64),adapterReceivedAt:'2026-09-07T06:53:13.301Z',retained:false,cursor:{}};
afterEach(()=>vi.unstubAllEnvs());
describe('history evidence repair controls',()=>{
 it('durably rejects non-authorized QoS0 before mapping, including speed when disabled',async()=>{
   for(const [enabled,topic,qos,expected] of [[false,'/ugv/speed',0,'SOURCE_QOS_CONTRACT_CONFLICT'],
     [true,'/ugv/speed',0,'VALID'],[true,'/ugv/gnss',0,'SOURCE_QOS_CONTRACT_CONFLICT'],[false,'/ugv/speed',1,'VALID']] as const) {
     const query=vi.fn().mockResolvedValue({rows:[{accepted_message_id:'m',was_redelivery:false,accepted_packet_generation:'1'}]});
     const schemas={validate:()=>({success:true,data:{data:0}})} as unknown as SourceSchemaRegistry;
     const repo=new UgvIngestRepository({query} as unknown as pg.Pool,'ugv',10000,10000,schemas,enabled);
     const result=await repo.accept('session',topic,Buffer.from('{"data":0}'),{qos,messageId:1},input.adapterReceivedAt);
     expect(result.validationState).toBe(expected);expect(query.mock.calls[0]![1][12]).toBe(expected);
   }
 });
 it('maps new speed and GNSS to one vehicle/session, preserving legacy replay',()=>{
   const speed=mapUgvMessage({...input,topic:'/ugv/speed',payload:{data:36},sourceQos:0},config).observations[0]!;
   const gnss=mapUgvMessage({...input,topic:'/ugv/gnss',payload:{longitude:106.81485,latitude:29.7195,altitude:500}},config).observations[0]!;
   expect(speed.subject).toEqual(gnss.subject);expect(speed.trackerSessionId).toBe(gnss.trackerSessionId);
   expect(speed.sourceLocalTargetId).toBe('ugv');expect(speed.measurements[0]?.scalarValue).toBe(10);
   expect(speed.metadata).toMatchObject({sourceQos:0,deliveryGuarantee:'BEST_EFFORT_NO_PUBACK'});
   const old=mapUgvMessage({...input,topic:'/ugv/speed',payload:{data:36}},{...config,mapperVersion:'ugv-mqtt-canonical-v1'}).observations[0]!;
   expect(old.subject.id).toBe('device:ugv:motion');expect(old.trackerSessionId).toBeUndefined();
   expect(speed.observationId).not.toBe(old.observationId);
 });
 it('defaults to bounded native scheduling and rejects unknown ownership',()=>{
   expect(loadAutoConfig({})).toMatchObject({enabled:true,owner:'gowm',takeover:false,interval:60,batch:16});
   expect(()=>loadAutoConfig({GOWM_HISTORY_AUTO_OWNER:'both'})).toThrow();
   expect(()=>loadAutoConfig({GOWM_HISTORY_AUTO_MAX_TASKS:'0'})).toThrow();
   expect([1,2,3,4,5,10].map(retryDelay)).toEqual([60,120,240,480,900,900]);
 });
 it('requires explicit boolean QoS compatibility',async()=>{
   vi.stubEnv('UGV_MQTT_SPEED_QOS0_COMPAT','yes');await expect(loadUgvIngestConfig()).rejects.toThrow('must be true or false');
 });
 it('reuses an equivalent outer binding index without writes',async()=>{
   const query=vi.fn().mockResolvedValue({rows:[{name:'analysis_binding_snapshot_lookup',valid:true,plain:true,
     columns:['data_scope_key','source_key','source_local_target_id','tracker_session_key','created_at DESC','binding_id DESC']}]});
   await ensureBindingSnapshotIndex({query} as unknown as pg.Pool);expect(query).toHaveBeenCalledTimes(1);
 });
});
