import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const mode = process.argv[3] ?? '--verify';
if (!['--write', '--verify'].includes(mode)) throw Error('Expected --write or --verify');
const digest = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const migrations = readdirSync(resolve(root, 'database/migrations')).filter(p => /^\d+_.*\.sql$/.test(p)).sort();
if (migrations.length !== 93 || migrations.some((name, i) => Number(name.split('_')[0]) !== i + 1)) {
  throw Error('Expected contiguous formal migrations 001–093; review release contract before changing head');
}
const sources = [
  'scripts/history-hot-migrate.ts', 'scripts/history-diagnose.ts',
  'scripts/functional-repair-upgrade.ts','scripts/capability-completion-upgrade.ts',
  'scripts/ingest-profile.ts','scripts/operations.ts','scripts/production-check.ts',
  ...['scripts/business-storage','packages/integrations/device-business-storage/src'].flatMap(dir=>
    readdirSync(resolve(root,dir)).filter(p=>p.endsWith('.ts')&&p!=='fixture.ts').map(p=>`${dir}/${p}`)),
  'services/projection-worker/src/index.ts',
  'services/world-api/src/app.ts','services/world-api/src/event-stream.ts','services/world-mcp-server/src/server.ts',
  'packages/runtime/src/event-repository.ts','packages/runtime/src/trajectory-repository.ts',
  'packages/runtime/src/projection.ts','packages/runtime/src/situation-repository.ts',
  'packages/runtime/src/bus.ts','packages/runtime/src/mqtt-security.ts',
  'services/providers/gowm-situation-provider/src/repository-adapter.ts','services/tls-edge/src/server.ts',
  'services/ugv-mqtt-ingest/src/app.ts','services/ugv-mqtt-ingest/src/repository.ts',
  'packages/platform/provider-sdk/src/idempotency.ts','packages/platform/provider-sdk/src/runtime.ts','packages/platform/provider-sdk/src/types.ts',
  'packages/trajectory-model/src/analytics.ts','packages/world-model-core/src/schema.ts','services/ugv-mqtt-ingest/src/config.ts',
  ...['packages/historical-trace-runtime/src', 'services/providers/historical-trace-provider/src','packages/integrations/ugv-mqtt-ingest-core/src'].flatMap(dir =>
    readdirSync(resolve(root, dir)).filter(p => p.endsWith('.ts') && !p.endsWith('.test.ts')).map(p => `${dir}/${p}`)),
].sort();
const manifest = {
  formatVersion: 1,
  releaseVersion: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  migrationHead: '093',
  upgrade: { baseline: '084', command: 'node dist/scripts/history-hot-migrate.js', checkArgument: '--check', initializeAccounts: false },
  functionalUpgrade: {baseline:'086',command:'node dist/scripts/functional-repair-upgrade.js',checkArgument:'--check',initializeAccounts:false,initializeDevices:false,rotatePasswords:false},
  capabilityUpgrade:{baseline:'089',command:'node dist/scripts/capability-completion-upgrade.js',checkArgument:'--check',applyArgument:'--projection-workers-stopped',initializeAccounts:false,initializeDevices:false,rotatePasswords:false,activateProfiles:false,recoverQueues:false},
  rollout: { initialHistoricalConcurrency: 1, qualifiedHistoricalConcurrency: 2, workerStopGraceSeconds: 60 },
  migrations: migrations.map(name => ({ path: `database/migrations/${name}`, sha256: digest(`database/migrations/${name}`) })),
  runtime: sources.map(path => ({ source: path, sha256: digest(path), compiled: `dist/${path.replace(/\.ts$/, '.js')}` })),
  handoff: ['docs/HISTORY_CONCURRENCY_AND_REUSE.md', 'docs/HISTORY_RESET_WATERMARKS.md','docs/FUNCTIONAL_REPAIR_2026_10.md','docs/DEV_DEPLOYMENT.md','docs/UGV_DEVICE_ACTOR.md',
    'docs/CAPABILITY_COMPLETION_2026_10.md','docs/CAPABILITY_INTEGRATION_HANDOFF.md','docs/PRODUCTION_OPERATIONS.md',
    'docs/shared-business-storage-handoff/smpp-handoff.md','docs/shared-business-storage-handoff/sdar-handoff.md'].map(path => ({ path, sha256: digest(path) })),
  configuration:['.env.example','docker-compose.yml','docker-compose.world-platform.yml','docker-compose.production.yml',
    'infrastructure/production/mosquitto.conf','infrastructure/production/mosquitto.acl',
    'database/Dockerfile','database/sbom/gowm-db.spdx.json','database/functional-repair-freeze-lock.json','database/capability-completion-freeze-lock.json',
    'contracts/consumers/historical-trajectory-artifact-v1.json',
    'database/shared-business-storage/install-manifest.json','database/shared-business-storage/overlays/business-api-v2.sql',
    'database/shared-business-storage/expected-ingest-profile-structure.json',
    'database/shared-business-storage/expected-reset-clock-structure.json',
    'scripts/validate-bootstrap-config.mjs','scripts/record-runtime-build.mjs'].map(path=>({path,sha256:digest(path)})),
};
const expected = `${JSON.stringify(manifest, null, 2)}\n`;
const destination = resolve(root, 'scripts/history-release-manifest.json');
if (mode === '--write') writeFileSync(destination, expected, { mode: 0o644 });
else if (readFileSync(destination, 'utf8') !== expected) throw Error('History release manifest differs from packaged sources');
console.log(`PASS: history and capability release manifest ${mode}, 93 migrations and ${sources.length} runtime modules`);
