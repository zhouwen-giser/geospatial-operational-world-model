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
for(const name of ['087_business_runtime_authority.sql','088_compatibility_trajectory_read.sql','089_event_delivery_cursor.sql'])await read('database/migrations/'+name);
for(const name of ['090_historical_trajectory_artifact.sql','091_scoped_situation_projection.sql','092_ingest_runtime_profiles.sql','093_calibrated_reset_watermarks.sql'])await read('database/migrations/'+name);
for(const path of ['scripts/capability-completion-upgrade.ts','scripts/ingest-profile.ts','scripts/operations.ts','scripts/production-check.ts',
 'database/shared-business-storage/expected-ingest-profile-structure.json','database/shared-business-storage/expected-reset-clock-structure.json','contracts/consumers/historical-trajectory-artifact-v1.json',
 'docker-compose.production.yml','infrastructure/production/mosquitto.conf','infrastructure/production/mosquitto.acl',
 'services/tls-edge/src/server.ts','docs/CAPABILITY_COMPLETION_2026_10.md','docs/PRODUCTION_OPERATIONS.md','docs/CAPABILITY_INTEGRATION_HANDOFF.md'])await read(path);
for(const name of ['bootstrap.ts','authority.ts','runtime-verify.ts'])await read('scripts/business-storage/'+name);
await read('scripts/functional-repair-upgrade.ts');
await read('database/shared-business-storage/overlays/business-api-v2.sql');
for(const path of ['scripts/business-storage/accounts.ts','scripts/business-storage/device-cli.ts','packages/integrations/device-business-storage/src/bootstrap.ts'])await read(path);
await read('database/migrations/083_reset_ack_watermarks.sql');
await read('services/ugv-mqtt-ingest/src/reset-ack.ts');
await read('scripts/history-diagnose.ts');
const resetApp=await read('services/ugv-mqtt-ingest/src/app.ts');
if(!resetApp.includes('processResetAck')||!resetApp.includes('subscriptionPlan(frozenMapper)')||!resetApp.includes('[RESET_ACK_TOPIC]:1'))throw Error('Reset watermark processing/subscription missing');
const compose=await read('docker-compose.yml');
for(const marker of ['business-storage-init:','dist/scripts/business-storage/bootstrap.js','dist/scripts/business-storage/runtime-verify.js'])
 if(!compose.includes(marker))throw Error('Missing native/bootstrap readiness gate: '+marker);
for(const marker of ['business-accounts-init:','ugv-device-init:','dist/scripts/business-storage/accounts.js','device-cli.js init-default && node dist/scripts/business-storage/device-cli.js verify-default'])
 if(!compose.includes(marker))throw Error('Missing automatic bootstrap: '+marker);
const ingest=compose.split('  ugv-mqtt-ingest:')[1]?.split('\n  world-api:')[0];
if(!ingest?.includes('      ugv-device-init:\n        condition: service_completed_successfully'))throw Error('Ingest must depend on successful initialization');
const env=await read('.env.example');
if(!env.includes('UGV_MQTT_INGEST_ENABLED=true'))throw Error('New installations must enable UGV ingest');
for(const key of ['SMPP_DB_PASSWORD','SDAR_DB_PASSWORD'])if(!env.split('\n').includes(key+'='))throw Error('Business passwords must be generated at installation');
console.log('PASS: automatic device bootstrap, business account entrypoints and locked source contracts');

await read('database/migrations/084_operational_task_reference_search.sql');
const projectionWorker = await read('services/projection-worker/src/index.ts');
if (!projectionWorker.includes('runLane("CORE",0)') || !projectionWorker.includes('runLane("HISTORY",slot)')
    || !projectionWorker.includes('gowm-historical-request-worker')) {
  throw Error('Independent frozen historical request consumer missing');
}

await read('database/migrations/085_tracklet_dispatch_and_execution.sql');
await read('database/migrations/086_historical_request_evaluation.sql');

await read('scripts/history-hot-migrate.ts');
await read('docs/HISTORY_CONCURRENCY_AND_REUSE.md');
for(const key of ['HISTORICAL_REQUEST_CONCURRENCY','TRACKLET_REBUILD_CONCURRENCY','TRACKLET_FINALIZATION_CONCURRENCY']) {
 if(!env.includes(key+'=')||!compose.includes(key+':'))throw Error('Missing bounded concurrency configuration: '+key);
}
