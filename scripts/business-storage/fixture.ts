import { readdir } from 'node:fs/promises';
import pg, { type Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { BusinessStorage, resolveIngestDevice, type DeviceRoute } from '../../packages/integrations/device-business-storage/src/index.js';
import {insertNativeRecord,type NativeTable} from '../../packages/integrations/device-business-storage/src/native-writer.js';
import { install, verify } from './installer.js';
const scope = 'TEST:gowm-shared-storage-v02', prefix = 'gowm-shared-v02';
const hash = 'a'.repeat(64);
async function insert(c: PoolClient, table: string, values: Record<string, unknown>) {
    if(table.startsWith('ugv_'))return insertNativeRecord(c,table as NativeTable,values);
    // Fixture-only allowlisted domain, never used to route application requests.
    if (!/^(public|ugv_sdar|ugv_smpp)\.[a-z_]+$/.test(table) || Object.keys(values).some(k => !/^\w+$/.test(k)))
        throw Error('FIXTURE_TABLE_INVALID');
    const keys = Object.keys(values);
    await c.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')})`, Object.values(values));
}
export interface DeviceFixture {
    deviceId: string;
    taskId: string;
    planId: string;
    instanceId: string;
    bindingId: string;
    missionId: string;
    mcpIds: string[];
    providerIds: string[];
    pointId: string;
    polygonId: string;
    remoteIds: string[];
}
export async function fixture(pool: Pool): Promise<DeviceFixture[]> {
    const repo = new BusinessStorage(pool);
    return repo.transaction(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(718082)');
        const prior = await c.query(`SELECT properties->'fixture' data FROM gowm_device.device WHERE device_id=ANY($1) ORDER BY device_id`, [[`${prefix}-A`, `${prefix}-B`]]);
        if (prior.rowCount === 2 && prior.rows.every(r => r.data))
            return prior.rows.map(r => r.data);
        await c.query(`INSERT INTO public.data_scope(scope_key,operational_domain,description) VALUES($1,'TEST','isolated shared storage fixture; no device calls') ON CONFLICT DO NOTHING`, [scope]);
        const now = new Date();
        const result: DeviceFixture[] = [];
        for (const letter of ['A', 'B']) {
            const deviceId = `${prefix}-${letter}`, taskId = `${deviceId}-task`, planId = `${deviceId}-plan`, instanceId = `${deviceId}-workflow`;
            await insert(c, 'public.world_object', { id: deviceId, object_type: 'VEHICLE', data_scope_key: scope });
            await repo.registerDevice(c, { deviceId, scope, namespace: prefix, identifier: letter, name: `TEST UGV ${letter}`, type: 'UGV' });
            const binding = await repo.replaceDeviceServiceBinding(c, { deviceId, scope, smppServiceKey: 'test-smpp', providerId: 'ugv', resourceId: `test-resource-${letter}`, sdarServiceKey: 'test-sdar', sdarMcpServerId: 'test-mcp' });
            await insert(c, 'ugv_sdar.conversation_context', { context_id: `${deviceId}-context`, user_id: 'fixture', created_at: now, updated_at: now });
            await insert(c, 'ugv_sdar.goal', { goal_id: `${deviceId}-goal`, context_id: `${deviceId}-context`, version: 1, title: 'TEST destination and observation area', description: 'Storage fixture only', status: 'active', created_at: now, updated_at: now });
            await insert(c, 'ugv_sdar.agent_task', { task_id: taskId, context_id: `${deviceId}-context`, user_id: 'fixture', phase: 'executing', phase_message: 'Storage fixture', goal_id: `${deviceId}-goal`, goal_version: 1, created_at: now, updated_at: now, request_text: 'TEST navigation storage', request_metadata: { fixture: true }, device_id: deviceId, gowm_binding_id: binding.binding_id, sdar_service_key: 'test-sdar' });
            const point = await repo.createTarget(c, { groupId: randomUUID(), revision: 1, scope, sourceDomain: 'SDAR', sourceIdentity: { taskId }, geometry: { type: 'Point', coordinates: [120, 30] }, crs: 'EPSG:4326' });
            const polygon = await repo.createTarget(c, { groupId: randomUUID(), revision: 1, scope, sourceDomain: 'SDAR', sourceIdentity: { taskId }, geometry: { type: 'Polygon', coordinates: [[[120, 30], [120.01, 30], [120.01, 30.01], [120, 30]]] }, crs: 'EPSG:4326' });
            for (const [target, purpose, path] of [[point, 'MOVE_DESTINATION', 'destination'], [polygon, 'OBSERVATION_AREA', 'area']] as const)
                await repo.attachTargetToOwner(c, { targetId: target.target_id, deviceId, scope, domain: 'SDAR', kind: 'TASK', key: { taskId }, role: 'REQUESTED', purpose, argumentPath: path });
            await insert(c, 'ugv_sdar.workflow_plan', { plan_id: planId, goal_id: `${deviceId}-goal`, goal_version: 1, definition_json: { nodes: [{ id: 'move' }, { id: 'observe' }] }, confirmation_status: 'confirmed', attempt_count: 1, created_at: now, goal_contract_json: { goalId: `${deviceId}-goal`, version: 1 }, device_id: deviceId, gowm_task_id: taskId });
            await c.query('UPDATE ugv_sdar.agent_task SET plan_id=$2 WHERE task_id=$1', [taskId, planId]);
            await insert(c, 'ugv_sdar.workflow_instance', { instance_id: instanceId, plan_id: planId, workflow_definition_id: `${deviceId}-definition`, workflow_version: 1, goal_id: `${deviceId}-goal`, goal_version: 1, status: 'running', input_json: { destination: [120, 30] }, errors_json: [], started_at: now, device_id: deviceId });
            const mcpIds: string[] = [], providerIds: string[] = [], remoteIds: string[] = [];
            for (let attempt = 0; attempt < 3; attempt++) {
                const nodeId = attempt === 2 ? 'observe' : 'move', runId = `${instanceId}:${nodeId}:${attempt}`, mcp = randomUUID(), provider = `${deviceId}-execution-${attempt}`, remote = `${deviceId}-remote-${attempt}`;
                mcpIds.push(mcp);
                providerIds.push(provider);
                remoteIds.push(remote);
                await insert(c, 'ugv_sdar.workflow_node_event', { event_id: `${deviceId}-event-${attempt}`, instance_id: instanceId, sequence: attempt + 1, node_id: nodeId, event_type: attempt === 0 ? 'node_failed' : 'node_started', event_timestamp: now, summary: `attempt ${attempt}`, device_id: deviceId });
                const snapshot = randomUUID();
                await insert(c, 'ugv_smpp.operation_snapshot', { snapshot_id: snapshot, provider_id: 'ugv', provider_version: `fixture-${letter}-${attempt}`, operation_name: 'vehicle_move', manifest_hash: hash, definition: { fixture: true } });
                await insert(c, 'ugv_smpp.provider_task', { task_id: mcp, provider_id: 'ugv', operation_name: 'vehicle_move', operation_snapshot_id: snapshot, authorization_context_hash: hash, execution_mode: 'live', arguments: { destination: [120, 30], fixture: true }, argument_hash: hash, external_execution_id: `test-external-${letter}-${attempt}`, internal_state: 'RUNNING', mcp_status: 'working', accepted_at: now, device_id: deviceId, gowm_binding_id: binding.binding_id, smpp_service_key: 'test-smpp' });
                await insert(c, 'ugv_smpp.ugv_execution', { task_id: provider, external_execution_id: `test-external-${letter}-${attempt}`, operation_name: 'vehicle_move', argument_hash: hash, resource_id: `test-resource-${letter}`, tracks: ['CHASSIS'], execution_context: { fixture: true }, state: 'RUNNING', revision: 1, reason_code: 'FIXTURE', payload: { arguments: { destination: [120, 30] } }, created_at: now, updated_at: now, device_id: deviceId, gowm_binding_id: binding.binding_id, smpp_service_key: 'test-smpp', mcp_task_id: mcp });
                for (const step of ['primary', 'followup'])
                    await insert(c, 'ugv_smpp.ugv_mutation_journal', { task_id: provider, step_id: step, phase: step === 'primary' ? 'PRIMARY' : 'FOLLOWUP', tool_name: 'fixture_navigation', argument_hash: hash, state: 'UNCERTAIN', intent_persisted_at: now, dispatched_at: now, completed_at: now, payload: { arguments: { destination: [120, 30] }, fixture: true }, device_id: deviceId });
                await insert(c, 'ugv_sdar.mcp_invocation', { invocation_id: `${remote}-invocation`, task_id: taskId, context_id: `${deviceId}-context`, server_id: 'test-mcp', tool_name: 'vehicle_move', arguments_json: { destination: [120, 30] }, status: 'succeeded', started_at: now, completed_at: now, duration_ms: 0, device_id: deviceId });
                await insert(c, 'ugv_sdar.remote_task_binding', { binding_id: remote, server_id: 'test-mcp', operation_name: 'vehicle_move', remote_task_id: mcp, agent_task_id: taskId, context_id: `${deviceId}-context`, goal_id: `${deviceId}-goal`, goal_version: 1, workflow_plan_id: planId, workflow_definition_id: `${deviceId}-definition`, workflow_definition_version: 1, workflow_instance_id: instanceId, workflow_node_id: nodeId, workflow_node_run_id: runId, mcp_invocation_id: `${remote}-invocation`, protocol_status: 'working', protocol_revision: '1', tasks_schema_revision: '1', last_provider_updated_at: now, local_state: 'polling', execution_mode: 'live', credential_revision: 'fixture', session_revision: 'fixture', poll_interval_ms: 1000, created_at: now, updated_at: now, task_behavior: 'task_required', task_cancellation: 'unknown', runtime_revision: '1', device_id: deviceId, smpp_service_key: 'test-smpp', canonical_mcp_task_id: mcp });
                await repo.attachTargetToOwner(c, { targetId: point.target_id, deviceId, scope, domain: 'SDAR', kind: 'PLAN_NODE', key: { planId, nodeId }, role: 'PLANNED', purpose: 'MOVE_DESTINATION', argumentPath: 'destination' });
                await repo.attachTargetToOwner(c, { targetId: point.target_id, deviceId, scope, domain: 'SDAR', kind: 'NODE_RUN', key: { bindingId: remote, instanceId, nodeId, nodeRunId: runId }, role: 'DISPATCHED', purpose: 'MOVE_DESTINATION', argumentPath: 'destination' });
                await repo.attachTargetToOwner(c, { targetId: point.target_id, deviceId, scope, domain: 'SMPP', kind: 'MCP_TASK', key: { taskId: mcp }, role: 'DISPATCHED', purpose: 'MOVE_DESTINATION', argumentPath: 'destination' });
                await repo.attachTargetToOwner(c, { targetId: point.target_id, deviceId, scope, domain: 'UGV_PROVIDER', kind: 'PROVIDER_DISPATCH', key: { taskId: provider, stepId: 'primary' }, role: 'DISPATCHED', purpose: 'MOVE_DESTINATION', argumentPath: 'destination' });
            }
            const mission = await repo.registerMissionIdentity(c, { deviceId, scope, channel: 'CHASSIS', authority: 'fixture-native', kind: 'MISSION_ID_WITH_SESSION', session: 'native-session-1', nativeId: '7', evidence: { fixture: true, receipt: 'ack-1' } });
            for (const [step, state, missionId] of [['primary', 'LINKED', mission.mission_instance_id], ['followup', 'UNCERTAIN', undefined]] as const)
                await repo.linkExecutionToMission(c, { deviceId, scope, bindingId: binding.binding_id, mcpTaskId: mcpIds[0]!, executionId: `test-external-${letter}-0`, providerTaskId: providerIds[0]!, stepId: step, ...(missionId ? { missionId } : {}), relation: 'CREATED', state, source: 'fixture-provider', idempotencyKey: `receipt-${step}`, evidence: { fixture: true, step } });
            await insert(c, 'ugv_smpp.ugv_state_snapshot', { revision: '1', observed_at: now, snapshot: { fixture: true, deviceId }, device_id: deviceId, source_session_key: 'native-session-1', channel: 'CHASSIS' });
            await insert(c, 'ugv_smpp.ugv_business_event_source_state', { source_id: 'local-source', source_stream_id: 'local-stream', next_sequence: 2, device_id: deviceId });
            await insert(c, 'ugv_smpp.ugv_business_event_source_log', { source_id: 'local-source', source_sequence: 1, source_event_id: 'event-1', source_stream_id: 'local-stream', payload_hash: hash, occurred_at: now, retain_until: new Date(now.getTime() + 86400000), payload: { fixture: true, deviceId }, device_id: deviceId });
            await insert(c, 'ugv_smpp.idempotency_record', { authorization_context_hash: hash, operation_name: 'vehicle_move', idempotency_key: 'same-key', argument_hash: hash, execution_mode: 'live', task_id: mcpIds[0], device_id: deviceId, smpp_service_key: 'test-smpp' });
            const data = { deviceId, taskId, planId, instanceId, bindingId: binding.binding_id, missionId: mission.mission_instance_id, mcpIds, providerIds, pointId: point.target_id, polygonId: polygon.target_id, remoteIds };
            await c.query('UPDATE gowm_device.device SET properties=$2 WHERE device_id=$1', [deviceId, { fixture: data }]);
            result.push(data);
        }
        await repo.replaceDeviceServiceBinding(c, { deviceId: result[0]!.deviceId, scope, smppServiceKey: 'test-smpp-next', providerId: 'ugv', resourceId: 'test-resource-A-next', sdarServiceKey: 'test-sdar-next', sdarMcpServerId: 'test-mcp-next' });
        return result;
    });
}
export async function postgresTests(pool: Pool) {
    const repo = new BusinessStorage(pool), data = await fixture(pool), a = data[0]!, b = data[1]!;
    const results: {
        id: string;
        status: string;
        detail?: string;
    }[] = [];
    async function test(id: string, fn: () => Promise<void>) { try {
        await fn();
        results.push({ id, status: 'PASS' });
    }
    catch (e) {
        results.push({ id, status: 'FAIL', detail: e instanceof Error ? e.message : String(e) });
    } }
    async function sandbox(fn: (c: PoolClient) => Promise<void>) { const c = await pool.connect(); try {
        await c.query('BEGIN');
        await fn(c);
    }
    finally {
        await c.query('ROLLBACK');
        c.release();
    } }
    const eq = async (sql: string, values: unknown[], expected: unknown) => assert.deepEqual((await pool.query(sql, values)).rows[0]?.v, expected);
    await test('T01', async () => { await eq('SELECT count(*)::int v FROM gowm_device.device d JOIN public.world_object w ON w.id=d.device_id WHERE d.data_scope_key=$1', [scope], 2); });
    await test('T02', async () => { await assert.rejects(() => sandbox(async (c) => { await c.query(`INSERT INTO gowm_device.device_stream(data_scope_key,device_id,endpoint_id,stream_key,topic_filter,identity_mode,identity_rule,message_profile,datastream_key) VALUES('wrong-scope',$1,gen_random_uuid(),'bad','test/#','BOUND_DEVICE','{}','test','missing')`, [a.deviceId]); }), /foreign key/); });
    const routes: DeviceRoute[] = [a, b].map((d, i) => ({ device_id: d.deviceId, endpoint_id: 'test', topic_filter: 'fleet/+/state', identity_mode: 'TOPIC', identity_rule: { segment: 1, equals: i ? 'B' : 'A' }, enabled: true }));
    await test('T03', async () => { assert.deepEqual(resolveIngestDevice(routes, 'test', 'fleet/A/state', {}), { status: 'MATCH', deviceId: a.deviceId }); assert.equal(resolveIngestDevice(routes, 'test', 'fleet/X/state', {}).status, 'NO_MATCH'); const p = routes.map((r, i) => ({ ...r, identity_mode: 'PAYLOAD' as const, identity_rule: { path: ['device'], equals: i ? 'B' : 'A' } })); assert.deepEqual(resolveIngestDevice(p, 'test', 'fleet/shared/state', { device: 'B' }), { status: 'MATCH', deviceId: b.deviceId }); });
    await test('T04', async () => { assert.equal(resolveIngestDevice(routes.map(r => ({ ...r, identity_mode: 'BOUND_DEVICE' as const })), 'test', 'fleet/A/state', {}).status, 'AMBIGUOUS'); });
    await test('T05', async () => { await assert.rejects(() => sandbox(async (c) => { await repo.replaceDeviceServiceBinding(c, { deviceId: a.deviceId, scope, smppServiceKey: 'test-smpp', providerId: 'ugv', resourceId: 'test-resource-B' }); }), /duplicate key/); });
    await test('T06', async () => { await eq(`SELECT count(DISTINCT device_id)::int v FROM gowm_device.device_service_binding WHERE sdar_service_key='test-sdar' AND sdar_mcp_server_id='test-mcp'`, [], 2); });
    await test('T07', async () => { await eq('SELECT gowm_binding_id::text v FROM ugv_sdar.agent_task WHERE task_id=$1', [a.taskId], a.bindingId); await assert.rejects(() => sandbox(async (c) => { await c.query('UPDATE ugv_sdar.agent_task SET device_id=$2 WHERE task_id=$1', [a.taskId, b.deviceId]); }), /IMMUTABLE|DEVICE_BINDING_MISMATCH/); });
    await test('T08', async () => { const c = await pool.connect(); try {
        assert.equal((await verify(c)).status, 'PASS');
    }
    finally {
        c.release();
    } await eq(`SELECT count(*)::int v FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('agent_task','provider_task','ugv_execution')`, [], 0); });
    await test('T09', async () => { const before = await pool.query(`SELECT (SELECT count(*) FROM ugv_smpp.gowm_install_history)+(SELECT count(*) FROM ugv_sdar.gowm_install_history) n`); const c = await pool.connect(); try {
        await install(c);
    }
    finally {
        c.release();
    } assert.deepEqual((await pool.query(`SELECT (SELECT count(*) FROM ugv_smpp.gowm_install_history)+(SELECT count(*) FROM ugv_sdar.gowm_install_history) n`)).rows, before.rows); assert.deepEqual(await fixture(pool), data); await sandbox(async (c) => { await insert(c, 'public.world_object', { id: prefix + '-C', object_type: 'VEHICLE', data_scope_key: scope }); await repo.registerDevice(c, { deviceId: prefix + '-C', scope, namespace: prefix, identifier: 'C', name: 'test third device', type: 'UGV' }); }); });
    await test('T10', async () => { await eq(`SELECT count(*)::int v FROM ugv_smpp.gowm_install_history WHERE family='SMPP_RUNTIME' AND file LIKE '014_%'`, [], 2); await eq(`SELECT count(DISTINCT family)::int v FROM ugv_smpp.gowm_install_history WHERE family IN ('SMPP_RUNTIME','UGV_PROVIDER')`, [], 2); });
    await test('T11', async () => { await eq(`SELECT public.vector_dims('[1,2,3]'::public.vector)::int v`, [], 3); await eq(`SELECT count(*)::int v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ugv_sdar' AND p.proname='enforce_remote_task_input_context_authority' AND p.proconfig IS NOT NULL`, [], 1); await sandbox(async (c) => { await c.query(`INSERT INTO ugv_sdar.runtime_bootstrap_probe(label,embedding) VALUES('fixture','[1,2,3]')`); }); });
    await test('T12', async () => { for (const d of data) {
        assert.equal((await repo.listDeviceTasks(d.deviceId)).length, 1);
        assert.equal((await repo.getMcpTaskDetails(d.deviceId, d.mcpIds[0]!)).device_id, d.deviceId);
    } assert.equal(await repo.getMcpTaskDetails(a.deviceId, b.mcpIds[0]!), null); });
    await test('T13', async () => { await assert.rejects(() => sandbox(async (c) => { await insert(c, 'ugv_smpp.ugv_execution_command_ack', { device_id: a.deviceId, task_id: b.providerIds[0], command: 'test', command_sequence: 1, payload: {}, created_at: new Date() }); }), /foreign key/); await assert.rejects(() => sandbox(async (c) => { await c.query('UPDATE ugv_sdar.remote_task_binding SET canonical_mcp_task_id=$2 WHERE binding_id=$1', [a.remoteIds[0], b.mcpIds[0]]); }), /MCP_TASK_DEVICE_SERVICE_MISMATCH/); });
    const idem = (d: DeviceFixture) => ({ deviceId: d.deviceId, service: 'test-smpp', authorizationHash: hash, operation: 'vehicle_move', key: 'same-key', argumentHash: hash, mode: 'live', simulationKey: '', taskId: d.mcpIds[0]! });
    await test('T14', async () => { await sandbox(async (c) => { for (const d of data) {
        const row = await repo.acceptIdempotency(c, idem(d));
        assert.equal(row.task_id, d.mcpIds[0]);
    } }); });
    await test('T15', async () => { await assert.rejects(() => sandbox(async (c) => { await repo.acceptIdempotency(c, { ...idem(a), argumentHash: 'b'.repeat(64) }); }), /IDEMPOTENCY_ARGUMENT_CONFLICT/); });
    await test('T16', async () => { for (const d of data)
        assert.equal((await repo.getLatestDeviceSnapshot(d.deviceId, 'native-session-1', 'CHASSIS')).snapshot.deviceId, d.deviceId); });
    await test('T17', async () => { await sandbox(async (c) => { await c.query(`UPDATE ugv_smpp.ugv_business_event_source_state SET next_sequence=3 WHERE device_id=$1 AND source_id='local-source'`, [a.deviceId]); assert.equal((await c.query(`SELECT next_sequence FROM ugv_smpp.ugv_business_event_source_state WHERE device_id=$1`, [b.deviceId])).rows[0].next_sequence, '2'); }); });
    async function command(c: PoolClient, d: DeviceFixture) { await insert(c, 'ugv_smpp.task_command', { device_id: d.deviceId, task_id: d.mcpIds[0], command_sequence: 777, command_type: 'UPDATE', request_hash: 'c'.repeat(64), state: 'PENDING', payload: { fixture: true } }); }
    await test('T18', async () => { await sandbox(async (c) => { await command(c, a); await command(c, b); const claimed = await repo.claimDueCommands(c, [a.deviceId], 'worker-A'); assert.equal(claimed.length, 1); assert.equal(claimed[0].task_id, a.mcpIds[0]); assert.equal((await c.query(`SELECT state FROM ugv_smpp.task_command WHERE task_id=$1 AND command_sequence=777`, [b.mcpIds[0]])).rows[0].state, 'PENDING'); }); await assert.rejects(() => sandbox(c => repo.claimDueCommands(c, [], 'worker').then(() => { })), /EXPLICIT/); });
    await test('T19', async () => { await repo.transaction(c => command(c, a)); const c1 = await pool.connect(), c2 = await pool.connect(); try {
        await c1.query('BEGIN');
        await c2.query('BEGIN');
        const first = await repo.claimDueCommands(c1, [a.deviceId], 'worker-1');
        const second = await repo.claimDueCommands(c2, [a.deviceId], 'worker-2');
        assert.equal(first.length, 1);
        assert.equal(second.length, 0);
        await c1.query('COMMIT');
        await c2.query('COMMIT');
        await repo.transaction(async (c) => { await c.query(`UPDATE ugv_smpp.task_command SET claim_until=clock_timestamp()-interval '1 second' WHERE task_id=$1 AND command_sequence=777`, [a.mcpIds[0]]); await repo.recoverExpiredCommands(c, [a.deviceId]); const restarted = await repo.claimDueCommands(c, [a.deviceId], 'worker-restarted'); assert.equal(restarted[0].task_id, a.mcpIds[0]); assert.equal(restarted[0].claim_owner, 'worker-restarted'); });
    }
    finally {
        await c1.query('ROLLBACK');
        await c2.query('ROLLBACK');
        c1.release();
        c2.release();
        await pool.query('DELETE FROM ugv_smpp.task_command WHERE task_id=$1 AND command_sequence=777', [a.mcpIds[0]]);
    } });
    await test('T20', async () => { await sandbox(async (c) => { assert.ok(await repo.acquireDeviceLease(c, a.deviceId, 'chassis', 'owner-1')); assert.equal(await repo.acquireDeviceLease(c, a.deviceId, 'chassis', 'owner-2'), null); assert.ok(await repo.acquireDeviceLease(c, b.deviceId, 'chassis', 'owner-2')); }); });
    await test('T21', async () => { const id = randomUUID(); await assert.rejects(() => repo.transaction(async (c) => { await c.query(`INSERT INTO ugv_sdar.agent_task SELECT (jsonb_populate_record(NULL::ugv_sdar.agent_task,to_jsonb(t)||jsonb_build_object('task_id',$2::text,'revision',0))).* FROM ugv_sdar.agent_task t WHERE task_id=$1`, [a.taskId, id]); await repo.attachTargetToOwner(c, { targetId: b.pointId, deviceId: a.deviceId, scope: 'wrong', domain: 'SDAR', kind: 'TASK', key: { taskId: id }, role: 'REQUESTED', purpose: 'MOVE_DESTINATION', argumentPath: 'destination' }); }), /foreign key/); await eq('SELECT count(*)::int v FROM ugv_sdar.agent_task WHERE task_id=$1', [id], 0); });
    await test('T22', async () => { await sandbox(async (c) => { for (const geometry of [{ type: 'Point', coordinates: [1, 2] }, { type: 'LineString', coordinates: [[1, 2], [2, 3]] }, { type: 'Polygon', coordinates: [[[1, 2], [2, 2], [2, 3], [1, 2]]] }]) {
        const t = await repo.createTarget(c, { groupId: randomUUID(), revision: 1, scope, sourceDomain: 'GOWM_USER', sourceIdentity: { fixture: true }, geometry, crs: 'EPSG:4326' });
        assert.equal(t.normalization_state, 'NORMALIZED');
    } const t = await repo.createTarget(c, { groupId: randomUUID(), revision: 1, scope, sourceDomain: 'GOWM_USER', sourceIdentity: { fixture: true }, geometry: { type: 'Point', coordinates: [10000, 20000] }, crs: 'UNSPECIFIED' }); assert.equal(t.normalization_state, 'NATIVE_ONLY'); assert.equal(t.geometry_wgs84, null); }); });
    await test('T23', async () => { await sandbox(async (c) => { const old = (await c.query('SELECT * FROM gowm_task.target_geometry WHERE target_id=$1', [a.pointId])).rows[0]; const next = await repo.createTarget(c, { groupId: old.target_group_id, revision: 2, scope, sourceDomain: 'SDAR', sourceIdentity: { taskId: a.taskId }, geometry: { type: 'Point', coordinates: [121, 31] }, crs: 'EPSG:4326', supersedes: a.pointId }); assert.notEqual(next.target_id, a.pointId); assert.equal((await c.query(`SELECT target_id FROM gowm_task.target_binding WHERE owner_kind='PROVIDER_DISPATCH' AND device_id=$1 LIMIT 1`, [a.deviceId])).rows[0].target_id, a.pointId); }); await assert.rejects(() => sandbox(async (c) => { await c.query('UPDATE gowm_task.target_geometry SET native_crs=$2 WHERE target_id=$1', [a.pointId, 'changed']); }), /IMMUTABLE/); });
    await test('T24', async () => { for (const key of [{ taskId: 'missing' }, { taskId: b.taskId }])
        await assert.rejects(() => sandbox(async (c) => { await repo.attachTargetToOwner(c, { targetId: a.pointId, deviceId: a.deviceId, scope, domain: 'SDAR', kind: 'TASK', key, role: 'REQUESTED', purpose: 'MOVE_DESTINATION', argumentPath: 'bad' }); }), /OWNER_NOT_FOUND/); });
    await test('T25', async () => { const read = await repo.getTaskLineage(a.deviceId, a.taskId); assert.equal(new Set(read.lineage.map(r => r.workflow_node_run_id)).size, 3); assert.equal(read.steps.filter(r => r.record_kind === 'REMOTE_NODE_RUN').length, 3); });
    await test('T26', async () => { assert.notEqual(a.missionId, b.missionId); await sandbox(async (c) => { const next = await repo.registerMissionIdentity(c, { deviceId: a.deviceId, scope, channel: 'CHASSIS', authority: 'fixture-native', kind: 'MISSION_ID_WITH_SESSION', session: 'native-session-2', nativeId: '7', evidence: { receipt: 2 } }); assert.notEqual(next.mission_instance_id, a.missionId); }); });
    await test('T27', async () => { await sandbox(async (c) => { const same = await repo.registerMissionIdentity(c, { deviceId: a.deviceId, scope, channel: 'CHASSIS', authority: 'fixture-native', kind: 'MISSION_ID_WITH_SESSION', session: 'native-session-1', nativeId: '7', evidence: { receipt: 1 } }); assert.equal(same.mission_instance_id, a.missionId); await assert.rejects(() => repo.registerMissionIdentity(c, { deviceId: a.deviceId, scope, channel: 'CHASSIS', authority: 'fixture-native', kind: 'MISSION_ID_WITH_SESSION', session: 'native-session-1', nativeId: '7', missionId: b.missionId, evidence: { receipt: 1 } }), /MISSION_IDENTITY_CONFLICT/); }); });
    await test('T28', async () => { const r = await repo.getTaskLineage(a.deviceId, a.taskId); assert.ok(r.lineage.some(x => x.link_state === 'UNCERTAIN' && x.mission_instance_id === null && x.missing_stage === 'MISSION_UNRESOLVED')); });
    await test('T29', async () => { for (const d of data) {
        const r = await repo.getTaskLineage(d.deviceId, d.taskId);
        assert.equal(r.lineage.length, 6);
        assert.equal(r.lineage.filter(x => x.missing_stage === 'LINKED').length, 1);
        assert.ok(r.targets.length >= 10);
        assert.ok(r.targets.some(t => t.native_geometry.type === 'Polygon'));
    } });
    await test('T30', async () => { const r = await repo.getMissionLineage(a.deviceId, a.missionId); assert.equal(r[0].sdar_task_id, a.taskId); assert.equal((await repo.getMissionLineage(b.deviceId, a.missionId)).length, 0); });
    await test('T31', async () => { await sandbox(async (c) => { await c.query(`UPDATE ugv_smpp.provider_task SET handle_expires_at=clock_timestamp()-interval '1 day' WHERE task_id=$1`, [a.mcpIds[0]]); const r = await c.query(`SELECT * FROM gowm_business_v1.task_execution_lineage WHERE device_id=$1 AND sdar_task_id=$2 AND mission_instance_id=$3`, [a.deviceId, a.taskId, a.missionId]); assert.equal(r.rowCount, 1); }); });
    await test('T32', async () => { await sandbox(async (c) => { await c.query('SET LOCAL search_path=ugv_sdar,public'); assert.equal((await c.query(`SELECT 'agent_task'::regclass::oid= 'ugv_sdar.agent_task'::regclass::oid v`)).rows[0].v, true); await c.query('SET LOCAL search_path=ugv_smpp,public'); assert.equal((await c.query(`SELECT 'provider_task'::regclass::oid='ugv_smpp.provider_task'::regclass::oid v`)).rows[0].v, true); }); await eq(`SELECT count(*)::int v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('runtime_bootstrap_probe_id_seq','skill_execution_event_sequence_number_seq')`, [], 0); });
    await test('T33', async () => { const expected = (await readdir('database/migrations')).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort(); assert.deepEqual((await pool.query('SELECT version FROM public.schema_migration ORDER BY version')).rows.map(r => r.version), expected); });
    await test('T34', async () => { await eq(`SELECT count(*)::int v FROM information_schema.columns WHERE table_schema IN ('gowm_device','gowm_task','gowm_execution') AND column_name IN ('smpp_store_id','sdar_store_id','provider_store_id')`, [], 0); });
    await test('T35', async () => { await eq(`SELECT count(*)::int v FROM pg_extension WHERE extname IN ('postgis','vector')`, [], 2); });
    await test('T02_DEVICE_STREAM_SCOPE', async () => { await assert.rejects(() => sandbox(async (c) => { const ep = await prepareRoutes(c); await repo.registerDeviceStream(c, { ...routes[0]!, endpoint_id: ep.endpoint_id, data_scope_key: 'wrong-scope', stream_key: 'bad', message_profile: 'test', datastream_key: prefix + '-stream' }); }), /STREAM_DEVICE_SCOPE_MISMATCH/); });
    async function prepareRoutes(c: PoolClient) {
        await c.query(`INSERT INTO public.analysis_space(analysis_space_key,canonical_srid,dimension_model,distance_model,transform_pipeline_version) VALUES($1,3857,'2D','PLANAR_METRE_V1','fixture') ON CONFLICT DO NOTHING`, [prefix + '-analysis']);
        await c.query(`INSERT INTO public.source_registry(source_key,data_scope_key,source_type,default_analysis_space_key) VALUES($1,$2,'TEST',$3) ON CONFLICT DO NOTHING`, [prefix + '-source', scope, prefix + '-analysis']);
        await c.query(`INSERT INTO public.producer_pipeline(pipeline_key,source_key,pipeline_version,output_kind) VALUES($1,$2,'1','TEST') ON CONFLICT DO NOTHING`, [prefix + '-pipeline', prefix + '-source']);
        await c.query(`INSERT INTO public.datastream(datastream_key,source_key,data_scope_key,pipeline_key,schema_version) VALUES($1,$2,$3,$4,'1') ON CONFLICT DO NOTHING`, [prefix + '-stream', prefix + '-source', scope, prefix + '-pipeline']);
        return repo.upsertMqttEndpoint(c, { key: prefix + '-broker', url: 'mqtt://fixture.invalid', clientPrefix: 'fixture' });
    }
    await test('T04_BOUND_CONFIG_OVERLAP', async () => { await assert.rejects(() => sandbox(async (c) => { const ep = await prepareRoutes(c); for (const d of data)
        await repo.registerDeviceStream(c, { device_id: d.deviceId, endpoint_id: ep.endpoint_id, topic_filter: d === a ? 'fleet/#' : 'fleet/+/state', identity_mode: 'BOUND_DEVICE', identity_rule: {}, enabled: true, data_scope_key: scope, stream_key: d.deviceId, message_profile: 'test', datastream_key: prefix + '-stream' }); }), /AMBIGUOUS_BOUND_ROUTE/); });
    await test('T14_SDAR_ADMISSION_DEVICE_KEY', async () => {
        await sandbox(async (c) => {
            for (const [index, d] of data.entries()) {
                await insert(c, 'ugv_sdar.task_capability_binding', { binding_id: d.deviceId + '-capability', task_id: d.taskId, requested_capability_id: 'fixture-move', capability_version: 1, input_snapshot: { fixture: true }, success_criteria_snapshot: JSON.stringify(['fixture']), evidence_requirement_snapshot: '[]', constraint_snapshot: '[]', initial_implementation_refs: JSON.stringify(['fixture']), binding_hash: (index ? 'd' : 'e').repeat(64), bound_at: new Date() });
                await insert(c, 'ugv_sdar.task_capability_execution_attempt', { attempt_id: d.deviceId + '-attempt', task_id: d.taskId, capability_binding_id: d.deviceId + '-capability', attempt_no: 1, reason: 'initial', status: 'prepared' });
                await insert(c, 'ugv_sdar.initial_task_admission', { idempotency_key: 'same-admission-key', request_hash: 'sha256:' + hash, task_id: d.taskId, context_id: d.deviceId + '-context', capability_binding_id: d.deviceId + '-capability', capability_attempt_id: d.deviceId + '-attempt', created_context: false, accepted_at: new Date(), device_id: d.deviceId, sdar_service_key: 'test-sdar' });
            }
            assert.equal((await c.query(`SELECT count(*)::int n FROM ugv_sdar.initial_task_admission WHERE idempotency_key='same-admission-key'`)).rows[0].n, 2);
        });
    });
    const receipt = { deviceId: a.deviceId, scope, bindingId: a.bindingId, mcpTaskId: a.mcpIds[0]!, executionId: 'test-external-A-0', providerTaskId: a.providerIds[0]!, stepId: 'primary', missionId: a.missionId, relation: 'CREATED', state: 'LINKED', source: 'fixture-provider', idempotencyKey: 'receipt-primary', evidence: { fixture: true, step: 'primary' } };
    await test('T27_RECEIPT_IDEMPOTENCY_CONFLICT', async () => { await sandbox(async (c) => { const first = await repo.linkExecutionToMission(c, receipt); const repeat = await repo.linkExecutionToMission(c, receipt); assert.equal(first.link_id, repeat.link_id); await assert.rejects(() => repo.linkExecutionToMission(c, { ...receipt, evidence: { different: true } }), /MISSION_RECEIPT_CONFLICT/); }); });
    await test('T28_CONTROL_NO_NEW_MISSION', async () => { await assert.rejects(() => sandbox(async (c) => { await insert(c, 'ugv_smpp.ugv_mutation_journal', { task_id: a.providerIds[0], step_id: 'cancel-test', phase: 'CANCEL', tool_name: 'fixture-control', argument_hash: hash, state: 'INTENT_PERSISTED', intent_persisted_at: new Date(), payload: { fixture: true }, device_id: a.deviceId }); await repo.linkExecutionToMission(c, { ...receipt, stepId: 'cancel-test', idempotencyKey: 'cancel-create-invalid' }); }), /CONTROL_CANNOT_CREATE_MISSION/); });
    await test('T18_SDAR_REMOTE_POLL_SCOPE', async () => { await sandbox(async (c) => { await c.query('UPDATE ugv_sdar.remote_task_binding SET next_poll_at=clock_timestamp() WHERE device_id=ANY($1)', [[a.deviceId, b.deviceId]]); const claimed = await repo.claimRemoteTasks(c, [a.deviceId], 'fixture-poller'); assert.equal(claimed.length, 1); assert.equal(claimed[0].device_id, a.deviceId); assert.equal((await c.query('SELECT count(*)::int n FROM ugv_sdar.remote_task_binding WHERE device_id=$1 AND poll_claim_token IS NOT NULL', [b.deviceId])).rows[0].n, 0); }); });
    await test('T36', async () => { const { access } = await import('node:fs/promises'); for (const f of ['storage-contract.json', 'data-dictionary.md', 'device-scope-key-inventory.json', 'namespace-transform-map.json', 'read-model-mapping.json', 'repository-adaptation-matrix.md', 'smpp-handoff.md', 'sdar-handoff.md', 'mqtt-ingest-handoff.md'])
        await access('docs/shared-business-storage-handoff/' + f); });
    return { status: results.every(r => r.status === 'PASS') ? 'PASS' : 'FAIL', database: 'isolated test database (credentials omitted)', scenarios: results, fixture: data, lineage: await repo.getTaskLineage(a.deviceId, a.taskId), extensions: (await pool.query("SELECT extname,extversion FROM pg_extension WHERE extname IN ('postgis','vector')")).rows };
}
