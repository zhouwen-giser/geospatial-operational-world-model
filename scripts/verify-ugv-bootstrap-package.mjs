import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root=resolve(process.argv[2]??'.');
const read=p=>readFile(resolve(root,p),'utf8');
const lock=JSON.parse(await read('config/ugv-source-schema/SOURCE_LOCK.json'));
for(const name of ['mqtt_topics.json','mcp_ugv.json','error_codes.json']) {
 const entry=lock.files.find(f=>f.name===name);
 const bytes=await readFile(resolve(root,'config/ugv-source-schema',name));
 if(!entry||bytes.length!==entry.bytes||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('UGV source lock mismatch: '+name);
}
for(const path of ['scripts/business-storage/accounts.ts','scripts/business-storage/device-cli.ts','packages/integrations/device-business-storage/src/bootstrap.ts'])await read(path);
const compose=await read('docker-compose.yml');
for(const marker of ['business-accounts-init:','ugv-device-init:','dist/scripts/business-storage/accounts.js','device-cli.js init-default && node dist/scripts/business-storage/device-cli.js verify-default'])
 if(!compose.includes(marker))throw Error('Missing automatic bootstrap: '+marker);
const ingest=compose.split('  ugv-mqtt-ingest:')[1]?.split('\n  world-api:')[0];
if(!ingest?.includes('      ugv-device-init:\n        condition: service_completed_successfully'))throw Error('Ingest must depend on successful initialization');
const env=await read('.env.example');
if(!env.includes('UGV_MQTT_INGEST_ENABLED=true'))throw Error('New installations must enable UGV ingest');
for(const key of ['SMPP_DB_PASSWORD','SDAR_DB_PASSWORD'])if(!env.split('\n').includes(key+'='))throw Error('Business passwords must be generated at installation');
console.log('PASS: automatic device bootstrap, business account entrypoints and locked source contracts');
