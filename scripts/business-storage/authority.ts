import type { PoolClient } from 'pg';
import type { BusinessDeviceInput } from '../../packages/integrations/device-business-storage/src/context.js';

/** Explicit deployment administrator operation; runtime logins cannot modify this table. */
export async function authorizeBusinessServices(c: PoolClient, input: BusinessDeviceInput, allowedDeviceIds: string[]) {
  if (!allowedDeviceIds.length || allowedDeviceIds.some(id=>!id.trim())) throw Error('EXPLICIT_AUTHORIZED_DEVICES_REQUIRED');
  for (const [login,domain] of [['ugv_smpp_app','SMPP'],['ugv_sdar_app','SDAR']] as const) {
    const values=[login,input.scope,domain,input.smppServiceKey,input.providerId,input.resourceId,
      input.sdarServiceKey??null,input.sdarMcpServerId??null,input.agentProfileId??null,allowedDeviceIds];
    await c.query(`INSERT INTO gowm_business_api.service_authority(login_name,data_scope_key,business_domain,smpp_service_key,
      provider_id,resource_id,sdar_service_key,sdar_mcp_server_id,agent_profile_id,allowed_device_ids,allow_unique_default)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) ON CONFLICT DO NOTHING`,values);
    const row=(await c.query(`SELECT * FROM gowm_business_api.service_authority WHERE login_name=$1 AND data_scope_key=$2
      AND smpp_service_key=$3 AND provider_id=$4 AND resource_id=$5`,[login,input.scope,input.smppServiceKey,input.providerId,input.resourceId])).rows[0];
    if (!row || row.business_domain!==domain || row.sdar_service_key!==(input.sdarServiceKey??null) ||
      row.sdar_mcp_server_id!==(input.sdarMcpServerId??null) || row.agent_profile_id!==(input.agentProfileId??null) ||
      allowedDeviceIds.some(id=>!row.allowed_device_ids.includes(id))) throw Error('BUSINESS_AUTHORITY_CONFLICT');
  }
}
