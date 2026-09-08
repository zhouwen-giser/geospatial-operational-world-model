import type { PoolClient } from 'pg';
import { registerDeviceStream } from './repository.js';
import { loadIngestDeviceContext, resolveBusinessDeviceContext, type BusinessDeviceInput } from './context.js';

export const UGV_STREAMS = {
  '/ugv/gnss': 'ugv-position-v1', '/ugv/speed': 'ugv-speed-v1', 'status/ugv': 'ugv-platform-status-v1',
  '/ugv/mission_state': 'ugv-chassis-mission-v1', '/ugv/area_recon/status': 'ugv-recon-status-v1',
  '/ugv/area_recon/targets': 'ugv-recon-target-v1', '/ugv/area_recon/exception': 'ugv-recon-exception-v1'
} as const;
export interface DefaultDeviceInput {
  scope: string; namespace: string; identifier: string; deviceId?: string; deviceName: string;
  sourceKey: string; pipelineKey: string; analysisSpaceKey: string; analysisSrid: number;
  endpointKey: string; brokerUrl: string; clientPrefix: string; credentialRef?: string;
  business?: Omit<BusinessDeviceInput, 'scope' | 'deviceId'>;
}
const objects = {
  data_scope: 'scope_key', analysis_space: 'analysis_space_key', source_registry: 'source_key', producer_pipeline: 'pipeline_key',
  datastream: 'datastream_key', 'gowm_device.mqtt_endpoint': 'endpoint_key'
} as const;
/** Only fixed table/column names from this module; conflicts are verified, never overwritten. */
async function ensure(c: PoolClient, table: keyof typeof objects, values: Record<string, unknown>, compare = Object.keys(values)) {
  const cols = Object.keys(values), args = Object.values(values), key = objects[table];
  await c.query(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map((_,i) => `$${i+1}`).join(',')}) ON CONFLICT DO NOTHING`, args);
  const row = (await c.query(`SELECT * FROM ${table} WHERE ${key}=$1`, [values[key]])).rows[0];
  if (!row || compare.some(k => row[k] !== values[k])) throw Error(`DEFAULT_DEVICE_CONFIG_CONFLICT: ${table}`);
  return row;
}

/** Explicit administrator operation, within a caller-owned transaction. Does not contact MQTT or consumers. */
export async function initializeDefaultDevice(c: PoolClient, i: DefaultDeviceInput) {
  if (![i.scope,i.namespace,i.identifier,i.deviceName,i.sourceKey,i.pipelineKey,i.endpointKey,i.clientPrefix].every(x => x?.trim()))
    throw Error('DEFAULT_DEVICE_CONFIG_INVALID');
  const url = new URL(i.brokerUrl);
  if (!['mqtt:','mqtts:','ws:','wss:'].includes(url.protocol) || url.username || url.password) throw Error('MQTT_ENDPOINT_CONFIG_INVALID');
  await c.query('SELECT pg_advisory_xact_lock(718080)');
  await ensure(c, 'data_scope', { scope_key: i.scope, operational_domain: 'SIMULATION' });
  await ensure(c, 'analysis_space', { analysis_space_key: i.analysisSpaceKey, canonical_srid: i.analysisSrid,
    dimension_model: '3D', distance_model: 'PLANAR_METRE_V1', transform_pipeline_version: 'postgis-v1' }, ['canonical_srid']);
  await ensure(c, 'source_registry', { source_key: i.sourceKey, data_scope_key: i.scope, source_type: 'MQTT', default_analysis_space_key: i.analysisSpaceKey }, ['data_scope_key','default_analysis_space_key']);
  await ensure(c, 'producer_pipeline', { pipeline_key: i.pipelineKey, source_key: i.sourceKey, pipeline_version: '1', output_kind: 'CANONICAL_OBSERVATION' }, ['source_key']);
  const matches = await c.query('SELECT * FROM gowm_device.device WHERE data_scope_key=$1 AND identifier_namespace=$2 AND device_identifier=$3', [i.scope,i.namespace,i.identifier]);
  const match = matches.rows[0];
  if (match && (i.deviceId && match.device_id !== i.deviceId || !match.enabled)) throw Error('DEFAULT_DEVICE_IDENTITY_CONFLICT');
  const deviceId = match?.device_id ?? i.deviceId ?? `ugv:${i.identifier}`;
  // A master may already use another namespace. Do not silently change its identity or duplicate it.
  const existing = (await c.query('SELECT * FROM gowm_device.device WHERE device_id=$1', [deviceId])).rows[0];
  if (existing && !match) throw Error('DEFAULT_DEVICE_IDENTITY_CONFLICT');
  const world = (await c.query('SELECT * FROM public.world_object WHERE id=$1', [deviceId])).rows[0];
  if (world && (world.data_scope_key !== i.scope || world.deleted_at || !['UGV','VEHICLE','Vehicle'].includes(world.object_type)))
    throw Error('DEFAULT_DEVICE_WORLD_OBJECT_CONFLICT');
  if (!world) await c.query("INSERT INTO public.world_object(id,data_scope_key,object_type,properties) VALUES($1,$2,'UGV',$3)", [deviceId,i.scope,{ name:i.deviceName }]);
  if (!match) await c.query(`INSERT INTO gowm_device.device(device_id,data_scope_key,identifier_namespace,device_identifier,device_name,device_type)
    VALUES($1,$2,$3,$4,$5,'UGV')`, [deviceId,i.scope,i.namespace,i.identifier,i.deviceName]);
  const endpoint = await ensure(c, 'gowm_device.mqtt_endpoint', { endpoint_key:i.endpointKey, broker_url:url.href, client_id_prefix:i.clientPrefix, credential_ref:i.credentialRef ?? null },
    ['broker_url','client_id_prefix','credential_ref']);
  if (!endpoint.enabled) throw Error('MQTT_ENDPOINT_DISABLED');
  for (const [topic,preferred] of Object.entries(UGV_STREAMS)) {
    const prior = (await c.query('SELECT * FROM public.datastream WHERE datastream_key=$1', [preferred])).rows[0];
    const datastream = prior && (prior.source_key !== i.sourceKey || prior.data_scope_key !== i.scope || prior.pipeline_key !== i.pipelineKey)
      ? `${i.sourceKey}:${preferred}` : preferred;
    await ensure(c, 'datastream', { datastream_key:datastream,source_key:i.sourceKey,data_scope_key:i.scope,pipeline_key:i.pipelineKey,schema_version:'1.2' }, ['source_key','data_scope_key','pipeline_key']);
    const old = (await c.query('SELECT * FROM gowm_device.device_stream WHERE device_id=$1 AND endpoint_id=$2 AND stream_key=$3', [deviceId,endpoint.endpoint_id,topic])).rows[0];
    if (old) {
      if (!old.enabled || old.topic_filter !== topic || old.identity_mode !== 'BOUND_DEVICE' || old.datastream_key !== datastream ||
          old.message_profile !== 'ugv-mqtt' || Object.keys(old.identity_rule).length) throw Error(`DEFAULT_DEVICE_STREAM_CONFLICT: ${topic}`);
    } else {
      await registerDeviceStream(c, {
        device_id:deviceId,data_scope_key:i.scope,endpoint_id:endpoint.endpoint_id,stream_key:topic,topic_filter:topic,
        identity_mode:'BOUND_DEVICE',identity_rule:{},enabled:true,message_profile:'ugv-mqtt',datastream_key:datastream
      });
    }
  }
  const context = await loadIngestDeviceContext(c, { ...i,deviceId,topics:Object.keys(UGV_STREAMS) });
  const business = i.business ? await resolveBusinessDeviceContext(c, { ...i.business,scope:i.scope,deviceId }) : undefined;
  return { context, ...(business ? { business } : {}) };
}
