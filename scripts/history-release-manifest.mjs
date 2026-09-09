import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const mode = process.argv[3] ?? '--verify';
if (!['--write', '--verify'].includes(mode)) throw Error('Expected --write or --verify');
const digest = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const migrations = readdirSync(resolve(root, 'database/migrations')).filter(p => /^\d+_.*\.sql$/.test(p)).sort();
if (migrations.length !== 86 || migrations.some((name, i) => Number(name.split('_')[0]) !== i + 1)) {
  throw Error('Expected contiguous formal migrations 001–086; review release contract before changing head');
}
const sources = [
  'scripts/history-hot-migrate.ts', 'scripts/history-diagnose.ts',
  'services/projection-worker/src/index.ts',
  ...['packages/historical-trace-runtime/src', 'services/providers/historical-trace-provider/src'].flatMap(dir =>
    readdirSync(resolve(root, dir)).filter(p => p.endsWith('.ts') && !p.endsWith('.test.ts')).map(p => `${dir}/${p}`)),
].sort();
const manifest = {
  formatVersion: 1,
  releaseVersion: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  migrationHead: '086',
  upgrade: { baseline: '084', command: 'node dist/scripts/history-hot-migrate.js', checkArgument: '--check', initializeAccounts: false },
  rollout: { initialHistoricalConcurrency: 1, qualifiedHistoricalConcurrency: 2, workerStopGraceSeconds: 60 },
  migrations: migrations.map(name => ({ path: `database/migrations/${name}`, sha256: digest(`database/migrations/${name}`) })),
  runtime: sources.map(path => ({ source: path, sha256: digest(path), compiled: `dist/${path.replace(/\.ts$/, '.js')}` })),
  handoff: ['docs/HISTORY_CONCURRENCY_AND_REUSE.md', 'docs/HISTORY_RESET_WATERMARKS.md'].map(path => ({ path, sha256: digest(path) })),
};
const expected = `${JSON.stringify(manifest, null, 2)}\n`;
const destination = resolve(root, 'scripts/history-release-manifest.json');
if (mode === '--write') writeFileSync(destination, expected, { mode: 0o644 });
else if (readFileSync(destination, 'utf8') !== expected) throw Error('History release manifest differs from packaged sources');
console.log(`PASS: history release manifest ${mode}, 86 migrations and ${sources.length} runtime modules`);
