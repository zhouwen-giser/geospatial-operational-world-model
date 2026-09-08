import { describe, expect, it } from 'vitest';
import { mapUgvMessage, DEVICE_ACTOR_MAPPER_VERSION, type MapperConfig } from '../../packages/integrations/ugv-mqtt-ingest-core/src/mapper.js';
import { UGV_STREAMS } from '../../packages/integrations/device-business-storage/src/bootstrap.js';
import { CanonicalObservationInputSchema } from '../../packages/world-model-core/src/schema.js';
import { OperationalEventIngestSchema } from '../../packages/operational-model/src/events.js';

export function actorConfig(device = 'ugv', digit = 'a'): MapperConfig {
  const deviceId = `master:${device}`;
  return { deviceId:device, dataScopeKey:'actor-test',sourceKey:'actor-source',producerPipelineKey:'actor-pipeline',
    scenarioId:'airport',worldEpoch:'run',trackerSessionKey:`run:${device}`,analysisSpaceKey:'airport-utm48n',analysisSrid:32648,
    arrivalUncertaintyMs:1000,mapperVersion:DEVICE_ACTOR_MAPPER_VERSION,
    deviceContext:{ deviceId,deviceIdentifier:device,dataScopeKey:'actor-test',endpointId:'endpoint',
      actorReferenceKey:{namespace:'gowm',kind:'WORLD_OBJECT',id:`wrf_${digit.repeat(32)}`,version:'1'},
      routes:Object.entries(UGV_STREAMS).map(([topic,datastream]) => ({device_id:deviceId,endpoint_id:'endpoint',topic_filter:topic,
        identity_mode:'BOUND_DEVICE',identity_rule:{},enabled:true,datastream_key:datastream})) }
  };
}
const base = { messageId:'message',payloadSha256:'a'.repeat(64),adapterReceivedAt:'2026-09-08T00:00:00.000Z',retained:false,cursor:{} };
describe('UGV v3 master actor mapping', () => {
  it.each([
    ['/ugv/mission_state',{id:7,type:2,state:1,progress:1},['EXECUTION_STARTED_OBSERVED']],
    ['/ugv/area_recon/status',{status:4,region:{type:5,points:[[0,0],[10,0],[10,10]]},last_cmd_ack:{seq:1,ok:true}},['EXECUTION_STARTED_OBSERVED','CONTROL_ACCEPTED_OBSERVED']],
    ['/ugv/area_recon/status',{status:4,region:{type:5,points:[[0,0],[10,0],[10,10],[0,0]]},last_cmd_ack:{seq:1,ok:false}},['EXECUTION_STARTED_OBSERVED','CONTROL_REJECTED_OBSERVED']]
  ] as const)('uses the device master actor for %s', (topic,payload,types) => {
    const config = actorConfig();
    const result = mapUgvMessage({...base,topic,payload},config);
    for (const observation of result.observations) CanonicalObservationInputSchema.parse(observation);
    for (const event of result.events) OperationalEventIngestSchema.parse(event);
    expect(result.events.map(e => e.eventType)).toEqual(types);
    for (const event of result.events) expect(event.actorReferenceKeys).toEqual([config.deviceContext!.actorReferenceKey]);
    expect(mapUgvMessage({...base,topic,payload},config)).toEqual(result);
  });
  it('preserves vehicle identity without adding another ugv prefix and honors configured datastreams', () => {
    const config = actorConfig();
    config.deviceContext!.deviceId = 'ugv:ugv';
    config.deviceContext!.routes.forEach(r => { r.device_id = 'ugv:ugv'; r.datastream_key = `custom:${r.datastream_key}`; });
    const result = mapUgvMessage({...base,topic:'/ugv/speed',payload:36},config);
    expect(result.observations[0]?.subject).toEqual({type:'UGV',id:'ugv:ugv'});
    expect(result.observations[0]?.datastreamKey).toBe('custom:ugv-speed-v1');
  });
  it('rejects missing, malformed, mismatched and ambiguous device contexts', () => {
    const config = actorConfig();
    const input = {...base,topic:'/ugv/mission_state' as const,payload:{id:7,state:1,progress:0}};
    const {deviceContext:_,...missing} = config;
    expect(() => mapUgvMessage(input,missing)).toThrow();
    expect(() => mapUgvMessage(input,{...config,dataScopeKey:'other'})).toThrow('MAPPER_DEVICE_CONTEXT_MISMATCH');
    config.deviceContext!.actorReferenceKey.id = 'ugv';
    expect(() => mapUgvMessage(input,config)).toThrow();
    const ambiguous = actorConfig();
    ambiguous.deviceContext!.routes.push({...ambiguous.deviceContext!.routes[3]!,device_id:'other'});
    expect(() => mapUgvMessage(input,ambiguous)).toThrow('INGEST_DEVICE_AMBIGUOUS');
    const disabled = actorConfig(); disabled.deviceContext!.routes.forEach(r => {r.enabled=false;});
    expect(() => mapUgvMessage(input,disabled)).toThrow('INGEST_DEVICE_NO_MATCH');
  });
  it('keeps legacy v1/v2 event bodies unchanged even if new optional context is supplied', () => {
    const config = actorConfig();
    const input = {...base,topic:'/ugv/mission_state' as const,payload:{id:7,state:1,progress:0}};
    for (const mapperVersion of ['ugv-mqtt-canonical-v1','ugv-mqtt-canonical-v2']) {
      const {deviceContext:_,...legacy} = config;
      const result = mapUgvMessage(input,{...legacy,mapperVersion});
      expect(result.events[0]?.actorReferenceKeys).toEqual([]);
      expect(mapUgvMessage(input,{...config,mapperVersion})).toEqual(result);
    }
  });
});
