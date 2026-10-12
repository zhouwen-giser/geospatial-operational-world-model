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
  const result = await c.query('SELECT gowm_business_api.resolve_device($1::jsonb,$2::boolean) AS context', [JSON.stringify(input),mode === 'admit']);
  const value = result.rows[0]?.context;
  return { ...DeviceIdentitySchema.parse({ deviceId:value?.deviceId,deviceIdentifier:value?.deviceIdentifier,
    dataScopeKey:value?.dataScopeKey,actorReferenceKey:value?.actorReferenceKey }),
    bindingId:z.string().uuid().parse(value?.bindingId),smppServiceKey:z.string().min(1).parse(value?.smppServiceKey) };
}
