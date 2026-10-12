import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { filtersOverlap, type DeviceRoute, validateTopicFilter } from './routing.js';
export type Json = Record<string, unknown>;
export type OwnerKind = 'TASK' | 'PLAN_NODE' | 'NODE_RUN' | 'MCP_TASK' | 'PROVIDER_DISPATCH';
function required(v: string) { if (typeof v !== 'string' || !v.trim())
    throw Error('DEVICE_ID_REQUIRED'); return v; }
export class BusinessStorage {
    constructor(readonly pool: Pool) { }
    async transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> { const c = await this.pool.connect(); try {
        await c.query('BEGIN');
        const v = await fn(c);
        await c.query('COMMIT');
        return v;
    }
    catch (e) {
        await c.query('ROLLBACK');
        throw e;
    }
    finally {
        c.release();
    } }
    private async controlledWrite(c: PoolClient, operation: string, input: unknown) {
        return (await c.query('SELECT gowm_business_api.write($1::text,$2::jsonb) AS result',[operation,JSON.stringify(input)])).rows[0].result;
    }
    private async controlledRead(operation: string, input: { deviceId: string; [key: string]: unknown }) {
        required(input.deviceId);
        return (await this.pool.query('SELECT gowm_business_api.read($1::text,$2::jsonb) AS result',[operation,JSON.stringify(input)])).rows[0].result as QueryResultRow[];
    }
    async registerDevice(c: PoolClient, input: {
        deviceId: string;
        scope: string;
        namespace: string;
        identifier: string;
        name: string;
        type: string;
        properties?: Json;
    }) { required(input.deviceId); return (await c.query(`INSERT INTO gowm_device.device(device_id,data_scope_key,identifier_namespace,device_identifier,device_name,device_type,properties) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(device_id) DO UPDATE SET device_name=excluded.device_name,properties=excluded.properties,updated_at=now() WHERE device.data_scope_key=excluded.data_scope_key AND device.identifier_namespace=excluded.identifier_namespace AND device.device_identifier=excluded.device_identifier RETURNING *`, [input.deviceId, input.scope, input.namespace, input.identifier, input.name, input.type, input.properties ?? {}])).rows[0] ?? Promise.reject(Error('DEVICE_IDENTITY_CONFLICT')); }
    async upsertMqttEndpoint(c: PoolClient, input: {
        key: string;
        url: string;
        clientPrefix: string;
        credentialRef?: string;
    }) { return (await c.query(`INSERT INTO gowm_device.mqtt_endpoint(endpoint_key,broker_url,client_id_prefix,credential_ref) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint_key) DO UPDATE SET broker_url=excluded.broker_url,client_id_prefix=excluded.client_id_prefix,credential_ref=excluded.credential_ref,updated_at=now() RETURNING *`, [input.key, input.url, input.clientPrefix, input.credentialRef ?? null])).rows[0]; }
    registerDeviceStream = registerDeviceStream;
    async replaceDeviceServiceBinding(c: PoolClient, i: {
        deviceId: string;
        scope: string;
        smppServiceKey: string;
        providerId: string;
        resourceId: string;
        sdarServiceKey?: string;
        sdarMcpServerId?: string;
        agentProfileId?: string;
    }) {
        required(i.deviceId);
        await c.query('SELECT pg_advisory_xact_lock(718078)');
        await c.query('SELECT device_id FROM gowm_device.device WHERE device_id=$1 FOR UPDATE', [i.deviceId]);
        await c.query(`UPDATE gowm_device.device_service_binding SET valid_to=GREATEST(clock_timestamp(),valid_from+interval '1 microsecond') WHERE device_id=$1 AND valid_to IS NULL`, [i.deviceId]);
        return (await c.query(`INSERT INTO gowm_device.device_service_binding(data_scope_key,device_id,smpp_service_key,provider_id,resource_id,sdar_service_key,sdar_mcp_server_id,agent_profile_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [i.scope, i.deviceId, i.smppServiceKey, i.providerId, i.resourceId, i.sdarServiceKey ?? null, i.sdarMcpServerId ?? null, i.agentProfileId ?? null])).rows[0];
    }
    async listDeviceConfig(deviceId: string) { required(deviceId); return (await this.pool.query(`SELECT d.*, (SELECT jsonb_agg(to_jsonb(s)) FROM gowm_device.device_stream s WHERE s.device_id=d.device_id) streams,(SELECT jsonb_agg(to_jsonb(b)) FROM gowm_device.device_service_binding b WHERE b.device_id=d.device_id AND b.valid_to IS NULL) bindings FROM gowm_device.device d WHERE device_id=$1`, [deviceId])).rows[0] ?? null; }
    async createTarget(c: PoolClient, i: {
        deviceId?: string;
        groupId: string;
        revision: number;
        scope: string;
        sourceDomain: string;
        sourceIdentity: Json;
        geometry: Json;
        crs: string;
        supersedes?: string;
    }) { return this.controlledWrite(c,'createTarget',i); }
    async attachTargetToOwner(c: PoolClient, i: {
        targetId: string;
        deviceId: string;
        scope: string;
        domain: string;
        kind: OwnerKind;
        key: Json;
        role: string;
        purpose: string;
        argumentPath: string;
    }) { return this.controlledWrite(c,'attachTargetToOwner',i); }
    async validateOwner(c: PoolClient, deviceId: string, domain: string, kind: OwnerKind, key: Json) { await this.controlledWrite(c,'validateOwner',{deviceId,domain,kind,key}); }
    async registerMissionIdentity(c: PoolClient, i: {
        deviceId: string;
        scope: string;
        channel: string;
        authority: string;
        kind: string;
        session: string;
        nativeId: string;
        evidence: Json;
        missionId?: string;
    }) { return this.controlledWrite(c,'registerMissionIdentity',i); }
    async linkExecutionToMission(c: PoolClient, i: {
        deviceId: string;
        scope: string;
        bindingId: string;
        mcpTaskId?: string;
        executionId: string;
        providerTaskId: string;
        stepId: string;
        missionId?: string;
        relation: string;
        state: string;
        source: string;
        idempotencyKey: string;
        evidence: Json;
        unresolved?: Json;
    }) { return this.controlledWrite(c,'linkExecutionToMission',i); }
    async listDeviceTasks(deviceId: string, limit = 50, cursor?: {
        createdAt: string;
        taskId: string;
    }) { return this.controlledRead('tasks',{deviceId,limit,cursor}); }
    async getTaskLineage(deviceId: string, taskId: string) { const [lineage,targets,steps]=await Promise.all([this.controlledRead('lineage',{deviceId,taskId}),this.getTaskTargets(deviceId,taskId),this.controlledRead('steps',{deviceId,taskId})]); return {lineage,targets,steps}; }
    async getMissionLineage(deviceId: string, id: string) { return this.controlledRead('mission',{deviceId,id}); }
    async getTaskTargets(deviceId: string, taskId: string) { return this.controlledRead('targets',{deviceId,taskId}); }
    async getMcpTaskDetails(deviceId: string, id: string) { return await this.controlledRead('mcp',{deviceId,id}) as unknown as QueryResultRow | null; }
    async getLatestDeviceSnapshot(deviceId: string, source: string, channel: string) { required(source); required(channel); return await this.controlledRead('snapshot',{deviceId,source,channel}) as unknown as QueryResultRow | null; }
    async claimDueCommands(c: PoolClient, allowedDeviceIds: string[], owner: string, leaseMs = 30000) { if (!allowedDeviceIds.length || allowedDeviceIds.some(x => !x.trim()) || !owner || leaseMs <= 0)
        throw Error('EXPLICIT_CLAIM_SCOPE_REQUIRED'); return (await c.query(`WITH candidate AS (SELECT cmd.task_id,cmd.command_sequence FROM ugv_smpp.task_command cmd JOIN ugv_smpp.provider_task t ON t.task_id=cmd.task_id WHERE t.device_id=ANY($1::text[]) AND cmd.state IN ('PENDING','RETRY_WAIT') AND cmd.next_attempt_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM ugv_smpp.task_command active WHERE active.task_id=cmd.task_id AND active.state='CLAIMED') ORDER BY cmd.priority DESC,cmd.next_attempt_at,cmd.task_id,cmd.command_sequence FOR UPDATE OF t,cmd SKIP LOCKED LIMIT 1) UPDATE ugv_smpp.task_command cmd SET state='CLAIMED',claim_owner=$2,claim_until=clock_timestamp()+$3*interval '1 millisecond',attempt_count=attempt_count+1 FROM candidate c WHERE cmd.task_id=c.task_id AND cmd.command_sequence=c.command_sequence RETURNING cmd.*`, [allowedDeviceIds, owner, leaseMs])).rows; }
    async acquireDeviceLease(c: PoolClient, deviceId: string, key: string, owner: string, ms = 30000) { required(deviceId); if (!key || !owner || ms <= 0)
        throw Error('LEASE_ARGUMENT_INVALID'); return (await c.query(`INSERT INTO ugv_smpp.runtime_lease(device_id,lease_key,owner_id,fencing_token,expires_at) VALUES($1,$2,$3,1,clock_timestamp()+$4*interval '1 millisecond') ON CONFLICT(scope_key,lease_key) DO UPDATE SET owner_id=excluded.owner_id,fencing_token=runtime_lease.fencing_token+1,expires_at=excluded.expires_at,updated_at=clock_timestamp() WHERE runtime_lease.expires_at<=clock_timestamp() RETURNING *`, [deviceId, key, owner, ms])).rows[0] ?? null; }
    async acceptIdempotency(c: PoolClient, i: {
        deviceId: string;
        service: string;
        authorizationHash: string;
        operation: string;
        key: string;
        argumentHash: string;
        mode: string;
        simulationKey: string;
        taskId: string;
    }) {
        required(i.deviceId);
        const args = [i.deviceId, i.service, i.authorizationHash, i.operation, i.key, i.mode, i.simulationKey, i.argumentHash, i.taskId];
        const inserted = await c.query(`INSERT INTO ugv_smpp.idempotency_record(device_id,smpp_service_key,authorization_context_hash,operation_name,idempotency_key,execution_mode,simulation_key,argument_hash,task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING *`, args);
        if (inserted.rowCount)
            return inserted.rows[0];
        const row = (await c.query(`SELECT * FROM ugv_smpp.idempotency_record WHERE device_id=$1 AND smpp_service_key=$2 AND authorization_context_hash=$3 AND operation_name=$4 AND idempotency_key=$5 AND execution_mode=$6 AND simulation_key=$7 FOR UPDATE`, args.slice(0, 7))).rows[0];
        if (!row || row.argument_hash.trim() !== i.argumentHash)
            throw Error('IDEMPOTENCY_ARGUMENT_CONFLICT');
        return row;
    }
    async recoverExpiredCommands(c: PoolClient, allowedDeviceIds: string[]) { if (!allowedDeviceIds.length)
        throw Error('EXPLICIT_CLAIM_SCOPE_REQUIRED'); return (await c.query(`UPDATE ugv_smpp.task_command cmd SET state='RETRY_WAIT',claim_owner=NULL,claim_until=NULL,next_attempt_at=clock_timestamp() FROM ugv_smpp.provider_task t WHERE t.task_id=cmd.task_id AND t.device_id=ANY($1::text[]) AND cmd.state='CLAIMED' AND cmd.claim_until<=clock_timestamp() RETURNING cmd.*`, [allowedDeviceIds])).rows; }
    async claimRemoteTasks(c: PoolClient, allowedDeviceIds: string[], owner: string, ms = 30000) { if (!allowedDeviceIds.length || !owner || ms <= 0)
        throw Error('EXPLICIT_CLAIM_SCOPE_REQUIRED'); return (await c.query(`WITH candidate AS(SELECT binding_id FROM ugv_sdar.remote_task_binding WHERE device_id=ANY($1::text[]) AND local_state IN ('polling','cancel_observing') AND next_poll_at<=clock_timestamp() AND (poll_claim_expires_at IS NULL OR poll_claim_expires_at<=clock_timestamp()) ORDER BY next_poll_at,binding_id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE ugv_sdar.remote_task_binding r SET poll_claim_token=$2,poll_claimed_at=clock_timestamp(),poll_claim_expires_at=clock_timestamp()+$3*interval '1 millisecond' FROM candidate c WHERE r.binding_id=c.binding_id RETURNING r.*`, [allowedDeviceIds, owner, ms])).rows; }
    async resolveRemoteTask(c: PoolClient, deviceId: string, bindingId: string, mcpTaskId: string, service: string) {
        required(deviceId); return this.controlledWrite(c,'resolveRemoteTask',{deviceId,bindingId,mcpTaskId,service});
    }
}

export async function registerDeviceStream(c: PoolClient, input: DeviceRoute & {
        data_scope_key: string;
        stream_key: string;
        message_profile: string;
        datastream_key: string;
    }) {
        required(input.device_id);
        validateTopicFilter(input.topic_filter);
        const owner = await c.query('SELECT 1 FROM gowm_device.device d JOIN public.datastream s ON s.data_scope_key=d.data_scope_key WHERE d.device_id=$1 AND d.data_scope_key=$2 AND s.datastream_key=$3', [input.device_id, input.data_scope_key, input.datastream_key]);
        if (!owner.rowCount)
            throw Error('STREAM_DEVICE_SCOPE_MISMATCH');
        if (input.identity_mode === 'TOPIC' && (!Number.isInteger(input.identity_rule.segment) || input.identity_rule.segment! < 0))
            throw Error('INVALID_TOPIC_RULE');
        if (input.identity_mode === 'PAYLOAD' && (!input.identity_rule.path?.length || input.identity_rule.path.some(p => ['__proto__', 'constructor', 'prototype'].includes(p))))
            throw Error('INVALID_PAYLOAD_RULE');
        if (input.identity_mode !== 'BOUND_DEVICE' && !input.identity_rule.equals)
            throw Error('IDENTITY_EQUALS_REQUIRED');
        await c.query('SELECT pg_advisory_xact_lock(718080)');
        if (input.identity_mode === 'BOUND_DEVICE' && input.enabled) {
            const existing = await c.query<DeviceRoute>(`SELECT * FROM gowm_device.device_stream WHERE endpoint_id=$1 AND enabled AND identity_mode='BOUND_DEVICE' AND device_id<>$2`, [input.endpoint_id, input.device_id]);
            if (existing.rows.some(r => filtersOverlap(r.topic_filter, input.topic_filter)))
                throw Error('AMBIGUOUS_BOUND_ROUTE');
        }
        return (await c.query(`INSERT INTO gowm_device.device_stream(data_scope_key,device_id,endpoint_id,stream_key,topic_filter,identity_mode,identity_rule,message_profile,datastream_key,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(device_id,endpoint_id,stream_key) DO UPDATE SET topic_filter=excluded.topic_filter,identity_mode=excluded.identity_mode,identity_rule=excluded.identity_rule,enabled=excluded.enabled RETURNING *`, [input.data_scope_key, input.device_id, input.endpoint_id, input.stream_key, input.topic_filter, input.identity_mode, input.identity_rule, input.message_profile, input.datastream_key, input.enabled])).rows[0];
    }
