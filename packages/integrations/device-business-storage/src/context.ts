import type { PoolClient } from 'pg';
import { z } from 'zod';
import { OperationalReferenceKeySchema } from '../../../operational-model/src/events.js';
import { resolveIngestDevice, topicMatches } from './routing.js';

export const DeviceIdentitySchema = z.object({
  deviceId: z.string().min(1), deviceIdentifier: z.string().min(1), dataScopeKey: z.string().min(1),
  actorReferenceKey: OperationalReferenceKeySchema.extend({ kind: z.literal('WORLD_OBJECT') })
}).strict();
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>;
const StreamSchema = z.object({
  device_id: z.string().min(1), endpoint_id: z.string().min(1), topic_filter: z.string().min(1),
  identity_mode: z.enum(['BOUND_DEVICE', 'TOPIC', 'PAYLOAD']),
  identity_rule: z.object({ segment: z.number().int().nonnegative().optional(), path: z.array(z.string()).optional(), equals: z.string().optional() }).strict(),
  enabled: z.boolean(), datastream_key: z.string().min(1)
}).strict();
export const IngestDeviceContextSchema = DeviceIdentitySchema.extend({
  endpointId: z.string().min(1), routes: z.array(StreamSchema).min(1)
}).strict();
export type IngestDeviceContext = z.infer<typeof IngestDeviceContextSchema>;
export interface DeviceSelector { scope: string; deviceId?: string; namespace?: string; identifier?: string }

/** Uses an explicit selector or a unique enabled device in this data scope. Never crosses scopes. */
export async function resolveDeviceIdentity(c: PoolClient, selector: DeviceSelector): Promise<DeviceIdentity> {
  if (!selector.scope || (selector.deviceId !== undefined && !selector.deviceId.trim()) ||
      (selector.identifier !== undefined && (!selector.identifier.trim() || !selector.namespace?.trim())))
    throw Error('DEVICE_SELECTOR_INVALID');
  const rows = await c.query(`SELECT d.* FROM gowm_device.device d WHERE data_scope_key=$1
    AND ($2::text IS NULL OR device_id=$2)
    AND ($3::text IS NULL OR (identifier_namespace=$4 AND device_identifier=$3))
    AND (($2::text IS NOT NULL OR $3::text IS NOT NULL) OR enabled) ORDER BY device_id`,
    [selector.scope, selector.deviceId ?? null, selector.identifier ?? null, selector.namespace ?? null]);
  if (!rows.rowCount) throw Error('DEVICE_NO_MATCH');
  if (rows.rowCount !== 1) throw Error('DEVICE_AMBIGUOUS');
  const d = rows.rows[0];
  if (!d.enabled) throw Error('DEVICE_DISABLED');
  await c.query("SELECT set_config('gowm.data_scope_key',$1,true)", [selector.scope]);
  const ref = await c.query(`SELECT v.reference_key_value FROM public.world_object o
    JOIN public.world_reference_identity i ON i.entity_kind='WORLD_OBJECT' AND i.internal_id=o.id AND i.data_scope_key=o.data_scope_key
    JOIN gowm_reference_v1.identity v ON v.reference_key=i.reference_key
    WHERE o.id=$1 AND o.data_scope_key=$2 AND o.deleted_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.world_reference_retirement r WHERE r.reference_key=i.reference_key)`, [d.device_id, selector.scope]);
  if (ref.rowCount !== 1) throw Error('DEVICE_WORLD_REFERENCE_UNAVAILABLE');
  return DeviceIdentitySchema.parse({ deviceId: d.device_id, deviceIdentifier: d.device_identifier,
    dataScopeKey: d.data_scope_key, actorReferenceKey: ref.rows[0].reference_key_value });
}

export async function loadIngestDeviceContext(c: PoolClient, input: DeviceSelector & {
  endpointKey: string; brokerUrl: string; sourceKey: string; pipelineKey: string; topics: readonly string[];
}): Promise<IngestDeviceContext> {
  const identity = await resolveDeviceIdentity(c, input);
  const endpoint = await c.query('SELECT * FROM gowm_device.mqtt_endpoint WHERE endpoint_key=$1', [input.endpointKey]);
  const e = endpoint.rows[0];
  if (!e?.enabled) throw Error('MQTT_ENDPOINT_UNAVAILABLE');
  if (new URL(e.broker_url).href !== new URL(input.brokerUrl).href) throw Error('MQTT_ENDPOINT_CONFIG_CONFLICT');
  // Include other devices on the endpoint: ambiguity must not disappear by filtering to the selected device first.
  const streams = await c.query(`SELECT s.*,d.enabled AS device_enabled,t.source_key,t.pipeline_key
    FROM gowm_device.device_stream s JOIN gowm_device.device d USING(device_id,data_scope_key)
    JOIN public.datastream t USING(datastream_key,data_scope_key)
    WHERE s.endpoint_id=$1 AND s.enabled ORDER BY s.device_id,s.stream_key`, [e.endpoint_id]);
  const owned = streams.rows.filter(r => r.device_id === identity.deviceId);
  if (owned.some(r => r.source_key !== input.sourceKey || r.pipeline_key !== input.pipelineKey)) throw Error('DEVICE_STREAM_SOURCE_CONFLICT');
  for (const topic of input.topics) {
    const matching = owned.filter(r => topicMatches(r.topic_filter, topic));
    if (!matching.length) throw Error(`DEVICE_STREAM_NO_MATCH: ${topic}`);
    if (new Set(matching.map(r => r.datastream_key)).size !== 1) throw Error(`DEVICE_STREAM_AMBIGUOUS: ${topic}`);
  }
  return IngestDeviceContextSchema.parse({ ...identity, endpointId: e.endpoint_id, routes: streams.rows.map(r => ({
    device_id: r.device_id, endpoint_id: r.endpoint_id, topic_filter: r.topic_filter, identity_mode: r.identity_mode,
    identity_rule: r.identity_rule, enabled: r.enabled && r.device_enabled, datastream_key: r.datastream_key
  })) });
}

export function resolveIngestStream(context: IngestDeviceContext, topic: string, payload: unknown): string {
  const resolved = resolveIngestDevice(context.routes, context.endpointId, topic, payload);
  if (resolved.status !== 'MATCH') throw Error(`INGEST_DEVICE_${resolved.status}`);
  if (resolved.deviceId !== context.deviceId) throw Error('INGEST_SESSION_DEVICE_MISMATCH');
  const matches = context.routes.filter(r => resolveIngestDevice([r], context.endpointId, topic, payload).status === 'MATCH');
  const streams = new Set(matches.map(r => r.datastream_key));
  if (streams.size !== 1) throw Error('DEVICE_STREAM_AMBIGUOUS');
  return [...streams][0]!;
}

export interface BusinessDeviceInput {
  scope: string; deviceId?: string; smppServiceKey: string; providerId: string; resourceId: string;
  sdarServiceKey?: string; sdarMcpServerId?: string; agentProfileId?: string;
}
/** Caller owns the transaction. Existing binding wins; first admission persists a unique-device choice. */
export async function resolveBusinessDeviceContext(c: PoolClient, input: BusinessDeviceInput, mode: 'admit' | 'verify' = 'admit') {
  if (![input.scope,input.smppServiceKey,input.providerId,input.resourceId].every(x => typeof x === 'string' && x.trim()) ||
      Boolean(input.sdarServiceKey) !== Boolean(input.sdarMcpServerId) ||
      (input.deviceId !== undefined && !input.deviceId.trim())) throw Error('BUSINESS_DEVICE_CONFIG_INVALID');
  if (mode === 'admit') await c.query('SELECT pg_advisory_xact_lock(718078)');
  const found = await c.query(`SELECT * FROM gowm_device.device_service_binding WHERE data_scope_key=$1 AND valid_to IS NULL
    AND smpp_service_key=$2 AND provider_id=$3 AND resource_id=$4`, [input.scope,input.smppServiceKey,input.providerId,input.resourceId]);
  if ((found.rowCount ?? 0) > 1) throw Error('BUSINESS_BINDING_AMBIGUOUS');
  const prior = found.rows[0];
  if (prior && input.deviceId && prior.device_id !== input.deviceId) throw Error('BUSINESS_BINDING_CONFLICT');
  const id = input.deviceId ?? prior?.device_id;
  const identity = await resolveDeviceIdentity(c, { scope: input.scope, ...(id ? { deviceId: id } : {}) });
  const current = (await c.query(`SELECT * FROM gowm_device.device_service_binding WHERE device_id=$1 AND valid_to IS NULL ${mode === 'admit' ? 'FOR UPDATE' : ''}`, [identity.deviceId])).rows[0];
  const desired = { smpp_service_key: input.smppServiceKey, provider_id: input.providerId, resource_id: input.resourceId,
    sdar_service_key: input.sdarServiceKey ?? null, sdar_mcp_server_id: input.sdarMcpServerId ?? null, agent_profile_id: input.agentProfileId ?? null };
  let validFrom: string | null = null;
  if (current) {
    for (const key of ['smpp_service_key','provider_id','resource_id'] as const)
      if (current[key] !== desired[key]) throw Error('BUSINESS_BINDING_CONFLICT');
    for (const key of ['sdar_service_key','sdar_mcp_server_id','agent_profile_id'] as const)
      if (desired[key] !== null && current[key] !== null && current[key] !== desired[key]) throw Error('BUSINESS_BINDING_CONFLICT');
    const enrich = ['sdar_service_key','sdar_mcp_server_id','agent_profile_id'] as const;
    if (!enrich.some(key => desired[key] !== null && current[key] === null))
      return { ...identity, bindingId: String(current.binding_id), smppServiceKey: String(current.smpp_service_key) };
    if (mode === 'verify') throw Error('BUSINESS_BINDING_INCOMPLETE');
    // A later SDAR admission may fill previously absent values. Preserve the old
    // binding for existing tasks; never rewrite or replace an established value.
    for (const key of enrich) desired[key] ??= current[key];
    validFrom = (await c.query("UPDATE gowm_device.device_service_binding SET valid_to=GREATEST(clock_timestamp(),valid_from+interval '1 microsecond') WHERE binding_id=$1 RETURNING valid_to::text AS valid_to", [current.binding_id])).rows[0].valid_to;
  }
  if (mode === 'verify') throw Error('BUSINESS_BINDING_UNAVAILABLE');
  const inserted = await c.query(`INSERT INTO gowm_device.device_service_binding(data_scope_key,device_id,smpp_service_key,provider_id,resource_id,sdar_service_key,sdar_mcp_server_id,agent_profile_id,valid_from)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz,clock_timestamp())) RETURNING binding_id`, [input.scope,identity.deviceId,...Object.values(desired),validFrom]);
  return { ...identity, bindingId: String(inserted.rows[0].binding_id), smppServiceKey: input.smppServiceKey };
}
