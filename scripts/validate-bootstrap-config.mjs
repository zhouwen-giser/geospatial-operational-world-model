import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export function validateBootstrapConfig(env) {
  const mode=env.GOWM_BUSINESS_INSTALL_MODE||'storage';
  if (!['ingest','storage','ready'].includes(mode)) throw Error('GOWM_BUSINESS_INSTALL_MODE must be ingest, storage or ready');
  if (env.UGV_MQTT_INGEST_ENABLED==='true' && (env.UGV_DATA_SCOPE_KEY||'default')!==(env.GATEWAY_DATA_SCOPE_CLAIM||'default'))
    throw Error('UGV_DATA_SCOPE_KEY and GATEWAY_DATA_SCOPE_CLAIM conflict; explicitly reconcile authorization without moving existing data');
  const smpp=['SMPP_SERVICE_KEY','UGV_PROVIDER_ID','UGV_RESOURCE_ID'];
  const sdar=['SDAR_SERVICE_KEY','SDAR_MCP_SERVER_ID'];
  const present=k=>Boolean(env[k]?.trim());
  if ((smpp.some(present)&&!smpp.every(present)) || (sdar.some(present)&&(!sdar.every(present)||!smpp.every(present))) ||
    (present('SDAR_AGENT_PROFILE_ID')&&!sdar.every(present)) || (mode==='ready'&&(!smpp.every(present)||!sdar.every(present))))
    throw Error('BUSINESS_DEVICE_CONFIG_INCOMPLETE: provide the complete service identity groups; ready mode requires SMPP and SDAR identities');
  return {mode,bindingStatus:smpp.every(present)?'CONFIGURED':'NOT_CONFIGURED'};
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const file=process.argv[2];
  const env=file?Object.fromEntries((await readFile(file,'utf8')).split(/\r?\n/).filter(l=>/^[A-Z][A-Z0-9_]*=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)])):process.env;
  console.log(JSON.stringify({status:'PASS',...validateBootstrapConfig(env)}));
}
