import pg from 'pg';
import { initializeDefaultDevice, loadIngestDeviceContext, resolveBusinessDeviceContext, UGV_STREAMS, type DefaultDeviceInput } from '../../packages/integrations/device-business-storage/src/index.js';

const command = process.argv[2] ?? 'help';
if (command === 'help' || process.argv.includes('--help')) {
  console.log('GOWM device: init-default | verify-default\nRequires explicit GOWM_DATABASE_URL and UGV_MQTT_URL. Reuses UGV_DEVICE_ID (external identifier), UGV_DATA_SCOPE_KEY, UGV_SOURCE_KEY and UGV_PRODUCER_PIPELINE_KEY. Optional complete service binding: SMPP_SERVICE_KEY, UGV_PROVIDER_ID, UGV_RESOURCE_ID, SDAR_SERVICE_KEY, SDAR_MCP_SERVER_ID, SDAR_AGENT_PROFILE_ID. No MQTT connection or consumer switch.');
} else {
  if (!['init-default','verify-default'].includes(command)) throw Error('UNKNOWN_DEVICE_COMMAND');
  const env = process.env;
  const required = (key: string) => { const value = env[key]?.trim(); if (!value) throw Error(`${key} is required`); return value; };
  const optional = (key: string) => env[key]?.trim() || undefined;
  const businessKeys = ['SMPP_SERVICE_KEY','UGV_PROVIDER_ID','UGV_RESOURCE_ID','SDAR_SERVICE_KEY','SDAR_MCP_SERVER_ID','SDAR_AGENT_PROFILE_ID'];
  const input: DefaultDeviceInput = {
    scope:env.UGV_DATA_SCOPE_KEY ?? 'airport-sim-ugv-01', namespace:env.UGV_DEVICE_NAMESPACE ?? 'ugv',
    identifier:env.UGV_DEVICE_ID ?? 'ugv',deviceName:env.UGV_DEVICE_NAME ?? 'UGV',
    ...(optional('GOWM_DEVICE_ID') ? { deviceId:required('GOWM_DEVICE_ID') } : {}),
    sourceKey:env.UGV_SOURCE_KEY ?? 'ugv-airport-sim-mqtt',pipelineKey:env.UGV_PRODUCER_PIPELINE_KEY ?? 'ugv-airport-sim-mqtt:canonical-v1',
    analysisSpaceKey:env.UGV_ANALYSIS_SPACE_KEY ?? 'airport-utm48n',analysisSrid:Number(env.UGV_ANALYSIS_SRID ?? 32648),
    endpointKey:env.UGV_MQTT_ENDPOINT_KEY ?? 'ugv-default',brokerUrl:required('UGV_MQTT_URL'),
    clientPrefix:env.UGV_MQTT_CLIENT_ID_PREFIX ?? 'gowm-ugv-ingest',
    ...(optional('UGV_MQTT_CREDENTIAL_REF') ? { credentialRef:required('UGV_MQTT_CREDENTIAL_REF') } : {}),
    ...(businessKeys.some(k => optional(k)) ? { business:{ smppServiceKey:required('SMPP_SERVICE_KEY'),providerId:required('UGV_PROVIDER_ID'),resourceId:required('UGV_RESOURCE_ID'),
      ...(optional('SDAR_SERVICE_KEY') ? { sdarServiceKey:required('SDAR_SERVICE_KEY'),sdarMcpServerId:required('SDAR_MCP_SERVER_ID') } : {}),
      ...(optional('SDAR_AGENT_PROFILE_ID') ? { agentProfileId:required('SDAR_AGENT_PROFILE_ID') } : {}) } } : {})
  };
  if (optional('SDAR_MCP_SERVER_ID') && !optional('SDAR_SERVICE_KEY')) throw Error('SDAR_SERVICE_KEY is required with SDAR_MCP_SERVER_ID');
  const pool = new pg.Pool({ connectionString:required('GOWM_DATABASE_URL'),max:1 });
  const c = await pool.connect();
  try {
    await c.query(command === 'verify-default' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const result = command === 'init-default' ? await initializeDefaultDevice(c,input) : {
      context:await loadIngestDeviceContext(c,{ ...input,topics:Object.keys(UGV_STREAMS) }),
      ...(input.business ? { business: await resolveBusinessDeviceContext(c, { ...input.business,scope:input.scope,
        deviceId:(await loadIngestDeviceContext(c,{...input,topics:Object.keys(UGV_STREAMS)})).deviceId }, 'verify') } : {}),
      bindings:(await c.query('SELECT binding_id,smpp_service_key,sdar_service_key FROM gowm_device.device_service_binding WHERE data_scope_key=$1 AND device_id=(SELECT device_id FROM gowm_device.device WHERE data_scope_key=$1 AND identifier_namespace=$2 AND device_identifier=$3) AND valid_to IS NULL', [input.scope,input.namespace,input.identifier])).rows
    };
    await c.query('COMMIT');
    console.log(JSON.stringify({ status:'PASS',...result }));
  } catch (error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); await pool.end(); }
}
