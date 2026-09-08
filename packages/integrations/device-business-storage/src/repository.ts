import type { Pool, PoolClient } from 'pg';
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
        groupId: string;
        revision: number;
        scope: string;
        sourceDomain: string;
        sourceIdentity: Json;
        geometry: Json;
        crs: string;
        supersedes?: string;
    }) {
        const normalized = i.crs === 'EPSG:4326';
        return (await c.query(`INSERT INTO gowm_task.target_geometry(target_group_id,revision,data_scope_key,source_domain,source_record_identity,geometry_kind,native_geometry,native_crs,geometry_wgs84,normalization_state,supersedes_target_id) VALUES($1,$2,$3,$4,$5,upper($6),$7,$8,CASE WHEN $9 THEN public.ST_SetSRID(public.ST_GeomFromGeoJSON($7::jsonb::text),4326) ELSE NULL END,$10,$11) RETURNING *`, [i.groupId, i.revision, i.scope, i.sourceDomain, i.sourceIdentity, String(i.geometry.type), i.geometry, i.crs, normalized, normalized ? 'NORMALIZED' : 'NATIVE_ONLY', i.supersedes ?? null])).rows[0];
    }
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
    }) {
        required(i.deviceId);
        await this.validateOwner(c, i.deviceId, i.domain, i.kind, i.key);
        const r = await c.query(`INSERT INTO gowm_task.target_binding(target_id,device_id,data_scope_key,owner_domain,owner_kind,owner_key,usage_role,target_purpose,argument_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_domain,owner_kind,owner_key,usage_role,argument_path) DO NOTHING RETURNING *`, [i.targetId, i.deviceId, i.scope, i.domain, i.kind, i.key, i.role, i.purpose, i.argumentPath]);
        if (r.rowCount)
            return r.rows[0];
        const old = (await c.query(`SELECT * FROM gowm_task.target_binding WHERE owner_domain=$1 AND owner_kind=$2 AND owner_key=$3 AND usage_role=$4 AND argument_path=$5`, [i.domain, i.kind, i.key, i.role, i.argumentPath])).rows[0];
        if (old?.target_id !== i.targetId || old.device_id !== i.deviceId || old.target_purpose !== i.purpose)
            throw Error('TARGET_BINDING_CONFLICT');
        return old;
    }
    async validateOwner(c: PoolClient, deviceId: string, domain: string, kind: OwnerKind, key: Json) {
        const expected: Record<OwnerKind, string[]> = { TASK: ['taskId'], MCP_TASK: ['taskId'], PLAN_NODE: ['planId', 'nodeId'], NODE_RUN: ['bindingId', 'instanceId', 'nodeId', 'nodeRunId'], PROVIDER_DISPATCH: ['taskId', 'stepId'] };
        if (!expected[kind] || Object.keys(key).length !== expected[kind].length || expected[kind].some(k => typeof key[k] !== 'string' || !String(key[k]).trim()))
            throw Error('OWNER_KEY_INVALID');
        let r;
        if (domain === 'SDAR' && kind === 'TASK')
            r = await c.query('SELECT 1 FROM ugv_sdar.agent_task WHERE task_id=$1 AND device_id=$2 FOR KEY SHARE', [key.taskId, deviceId]);
        else if (domain === 'SMPP' && kind === 'MCP_TASK')
            r = await c.query('SELECT 1 FROM ugv_smpp.provider_task WHERE task_id=$1 AND device_id=$2 FOR KEY SHARE', [key.taskId, deviceId]);
        else if (domain === 'UGV_PROVIDER' && kind === 'PROVIDER_DISPATCH')
            r = await c.query('SELECT 1 FROM ugv_smpp.ugv_mutation_journal WHERE task_id=$1 AND step_id=$2 AND device_id=$3 FOR KEY SHARE', [key.taskId, key.stepId, deviceId]);
        else if (domain === 'SDAR' && kind === 'PLAN_NODE')
            r = await c.query(`SELECT 1 FROM ugv_sdar.workflow_plan WHERE plan_id=$1 AND device_id=$2 AND EXISTS(SELECT 1 FROM jsonb_array_elements(definition_json->'nodes') n WHERE n->>'id'=$3) FOR KEY SHARE`, [key.planId, deviceId, key.nodeId]);
        else if (domain === 'SDAR' && kind === 'NODE_RUN')
            r = await c.query(`SELECT 1 FROM ugv_sdar.remote_task_binding WHERE binding_id=$1 AND workflow_instance_id=$2 AND workflow_node_id=$3 AND workflow_node_run_id=$4 AND device_id=$5 FOR KEY SHARE`, [key.bindingId, key.instanceId, key.nodeId, key.nodeRunId, deviceId]);
        else
            throw Error('OWNER_KIND_DOMAIN_INVALID');
        if (!r.rowCount)
            throw Error('OWNER_NOT_FOUND_OR_DEVICE_MISMATCH');
    }
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
    }) {
        required(i.deviceId);
        const device = await c.query('SELECT 1 FROM gowm_device.device WHERE device_id=$1 AND data_scope_key=$2', [i.deviceId, i.scope]);
        if (!device.rowCount)
            throw Error('MISSION_DEVICE_SCOPE_MISMATCH');
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,718081))', [JSON.stringify([i.deviceId, i.channel, i.authority, i.session, i.nativeId])]);
        const old = (await c.query(`SELECT * FROM gowm_execution.mission_identity WHERE device_id=$1 AND mission_channel=$2 AND authority_key=$3 AND native_session_key=$4 AND native_mission_id=$5`, [i.deviceId, i.channel, i.authority, i.session, i.nativeId])).rows[0];
        if (old) {
            if (i.missionId && i.missionId !== old.mission_instance_id)
                throw Error('MISSION_IDENTITY_CONFLICT');
            if (old.identity_kind !== i.kind)
                throw Error('MISSION_IDENTITY_CONFLICT');
            return old;
        }
        const id = i.missionId ?? (await c.query(`INSERT INTO gowm_execution.device_mission(device_id,data_scope_key,mission_channel,created_by) VALUES($1,$2,$3,$4) RETURNING mission_instance_id`, [i.deviceId, i.scope, i.channel, i.authority])).rows[0].mission_instance_id;
        return (await c.query(`INSERT INTO gowm_execution.mission_identity(mission_instance_id,device_id,mission_channel,authority_key,identity_kind,native_session_key,native_mission_id,evidence_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, i.deviceId, i.channel, i.authority, i.kind, i.session, i.nativeId, i.evidence])).rows[0];
    }
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
    }) {
        required(i.deviceId);
        const values = [i.deviceId, i.scope, i.bindingId, i.mcpTaskId ?? null, i.executionId, i.providerTaskId, i.stepId, i.missionId ?? null, i.relation, i.state, i.source, i.idempotencyKey, i.evidence, i.unresolved ?? null];
        const r = await c.query(`INSERT INTO gowm_execution.execution_mission_link(device_id,data_scope_key,binding_id,mcp_task_id,provider_execution_id,provider_task_record_id,provider_dispatch_step_id,mission_instance_id,relation_kind,link_state,source_system_key,idempotency_key,source_evidence_ref,unresolved_native_identity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(device_id,source_system_key,idempotency_key) DO NOTHING RETURNING *`, values);
        if (r.rowCount)
            return r.rows[0];
        const old = await c.query(`SELECT *, ROW(data_scope_key,binding_id,mcp_task_id,provider_execution_id,provider_task_record_id,provider_dispatch_step_id,mission_instance_id,relation_kind,link_state,source_evidence_ref,unresolved_native_identity) IS NOT DISTINCT FROM ROW($2::text,$3::uuid,$4::uuid,$5::text,$6::text,$7::text,$8::uuid,$9::text,$10::text,$13::jsonb,$14::jsonb) AS same FROM gowm_execution.execution_mission_link WHERE device_id=$1 AND source_system_key=$11 AND idempotency_key=$12`, values);
        if (!old.rows[0]?.same)
            throw Error('MISSION_RECEIPT_CONFLICT');
        return old.rows[0];
    }
    async listDeviceTasks(deviceId: string, limit = 50, cursor?: {
        createdAt: string;
        taskId: string;
    }) { required(deviceId); if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        throw Error('LIMIT_INVALID'); return (await this.pool.query(`SELECT * FROM gowm_business_v1.sdar_tasks WHERE device_id=$1 AND ($3::timestamptz IS NULL OR (created_at,task_id)>($3,$4)) ORDER BY created_at,task_id LIMIT $2`, [deviceId, limit, cursor?.createdAt ?? null, cursor?.taskId ?? null])).rows; }
    async getTaskLineage(deviceId: string, taskId: string) { required(deviceId); const [lineage, targets, steps] = await Promise.all([this.pool.query('SELECT * FROM gowm_business_v1.task_execution_lineage WHERE device_id=$1 AND sdar_task_id=$2 ORDER BY plan_id,workflow_instance_id,workflow_node_run_id,mcp_task_id,provider_task_record_id,dispatch_step_id,link_id', [deviceId, taskId]), this.getTaskTargets(deviceId, taskId), this.pool.query('SELECT * FROM gowm_business_v1.workflow_steps WHERE device_id=$1 AND task_id=$2 ORDER BY plan_id,instance_id,sequence,workflow_node_run_id', [deviceId, taskId])]); return { lineage: lineage.rows, targets, steps: steps.rows }; }
    async getMissionLineage(deviceId: string, id: string) { required(deviceId); return (await this.pool.query(`SELECT m.mission_instance_id,l.link_state,x.*,COALESCE(x.missing_stage,CASE WHEN l.link_state='CONFLICTED' THEN 'CONFLICTED' ELSE 'NO_REMOTE_TASK' END) AS missing_stage FROM gowm_execution.device_mission m LEFT JOIN gowm_execution.execution_mission_link l ON l.mission_instance_id=m.mission_instance_id AND l.device_id=m.device_id LEFT JOIN gowm_business_v1.task_execution_lineage x ON x.link_id=l.link_id AND x.device_id=m.device_id WHERE m.device_id=$1 AND m.mission_instance_id=$2`, [deviceId, id])).rows; }
    async getTaskTargets(deviceId: string, taskId: string) { required(deviceId); return (await this.pool.query(`SELECT b.* FROM gowm_business_v1.task_target_geometries b WHERE b.device_id=$1 AND ((b.owner_kind='TASK' AND b.owner_key->>'taskId'=$2) OR (b.owner_kind='PLAN_NODE' AND EXISTS(SELECT 1 FROM ugv_sdar.workflow_plan p WHERE p.device_id=$1 AND p.gowm_task_id=$2 AND p.plan_id=b.owner_key->>'planId')) OR (b.owner_kind='NODE_RUN' AND EXISTS(SELECT 1 FROM ugv_sdar.remote_task_binding r WHERE r.device_id=$1 AND r.agent_task_id=$2 AND r.binding_id=b.owner_key->>'bindingId')) OR EXISTS(SELECT 1 FROM gowm_business_v1.task_execution_lineage l WHERE l.device_id=$1 AND l.sdar_task_id=$2 AND ((b.owner_kind='MCP_TASK' AND b.owner_key->>'taskId'=l.mcp_task_id::text) OR (b.owner_kind='PROVIDER_DISPATCH' AND b.owner_key->>'taskId'=l.provider_task_record_id AND b.owner_key->>'stepId'=l.dispatch_step_id)))) ORDER BY b.created_at,b.target_binding_id`, [deviceId, taskId])).rows; }
    async getMcpTaskDetails(deviceId: string, id: string) { required(deviceId); return (await this.pool.query('SELECT * FROM gowm_business_v1.mcp_tasks WHERE device_id=$1 AND task_id=$2', [deviceId, id])).rows[0] ?? null; }
    async getLatestDeviceSnapshot(deviceId: string, source: string, channel: string) { required(deviceId); required(source); required(channel); return (await this.pool.query('SELECT * FROM ugv_smpp.ugv_state_snapshot WHERE device_id=$1 AND source_session_key=$2 AND channel=$3 ORDER BY observed_at DESC,revision DESC LIMIT 1', [deviceId, source, channel])).rows[0] ?? null; }
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
    async resolveRemoteTask(c: PoolClient, deviceId: string, bindingId: string, mcpTaskId: string, service: string) { required(deviceId); const row = await c.query(`SELECT 1 FROM ugv_smpp.provider_task WHERE device_id=$1 AND task_id=$2 AND smpp_service_key=$3 FOR KEY SHARE`, [deviceId, mcpTaskId, service]); if (!row.rowCount)
        throw Error('MCP_TASK_DEVICE_SERVICE_MISMATCH'); const r = await c.query(`UPDATE ugv_sdar.remote_task_binding SET canonical_mcp_task_id=$3 WHERE device_id=$1 AND binding_id=$2 AND smpp_service_key=$4 AND (canonical_mcp_task_id IS NULL OR canonical_mcp_task_id=$3) RETURNING *`, [deviceId, bindingId, mcpTaskId, service]); if (!r.rowCount)
        throw Error('REMOTE_IDENTITY_CONFLICT'); return r.rows[0]; }
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
