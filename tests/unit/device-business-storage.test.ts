import { describe, it, expect } from 'vitest';
import { resolveIngestDevice, filtersOverlap, topicMatches, type DeviceRoute } from '../../packages/integrations/device-business-storage/src/routing.js';
import { readFile } from 'node:fs/promises';
import { parse } from 'pgsql-parser';
const route: DeviceRoute = { device_id: 'A', endpoint_id: 'broker', topic_filter: 'fleet/+/state', identity_mode: 'TOPIC', identity_rule: { segment: 1, equals: 'A' }, enabled: true };
describe('shared device storage routes', () => {
    it('routes two devices on the same topic filter without fallback', () => { const r = [route, { ...route, device_id: 'B', identity_rule: { segment: 1, equals: 'B' } }]; expect(resolveIngestDevice(r, 'broker', 'fleet/B/state', {})).toEqual({ status: 'MATCH', deviceId: 'B' }); expect(resolveIngestDevice(r, 'broker', 'fleet/X/state', {})).toEqual({ status: 'NO_MATCH' }); });
    it('reports overlap and permits duplicate matches of one device', () => { const a = { ...route, identity_mode: 'BOUND_DEVICE' as const }; expect(resolveIngestDevice([a, { ...a, device_id: 'B' }], 'broker', 'fleet/A/state', {}).status).toBe('AMBIGUOUS'); expect(resolveIngestDevice([a, a], 'broker', 'fleet/A/state', {}).status).toBe('MATCH'); expect(filtersOverlap('fleet/#', 'fleet/+/state')).toBe(true); expect(filtersOverlap('fleet/A/#', 'fleet/B/#')).toBe(false); });
    it('preserves MQTT wildcard and system-topic semantics', () => { expect(topicMatches('fleet/#', 'fleet')).toBe(true); expect(topicMatches('#', '$SYS/state')).toBe(false); expect(topicMatches('fleet/+', 'fleet/')).toBe(true); expect(() => topicMatches('fleet/#/bad', 'fleet/x')).toThrow(); });
    it('reads explicit own payload paths and does not execute expressions', () => { const p = { ...route, identity_mode: 'PAYLOAD' as const, identity_rule: { path: ['observer', 'id'], equals: 'A' } }; expect(resolveIngestDevice([p], 'broker', 'fleet/shared/state', { observer: { id: 'A' }, subject: 'B' })).toEqual({ status: 'MATCH', deviceId: 'A' }); expect(() => resolveIngestDevice([{ ...p, identity_rule: { path: ['__proto__'], equals: 'A' } }], 'broker', 'fleet/shared/state', {})).toThrow(); });
});
describe('hosted SQL contract', () => {
    it('parses every formal generated migration and overlay without a database', async () => { const { readdir } = await import('node:fs/promises'); const m = JSON.parse(await readFile('database/shared-business-storage/install-manifest.json', 'utf8')); for (const e of m.entries)
        await parse(await readFile('database/shared-business-storage/' + e.generatedPath, 'utf8')); for (const f of await readdir('database/shared-business-storage/overlays'))
        await parse(await readFile('database/shared-business-storage/overlays/' + f, 'utf8')); await parse(await readFile('database/migrations/078_device_shared_business_storage.sql', 'utf8')); }, 30000);
    it('keeps both runtime 014 filenames and application sequences out of public', async () => { const m = JSON.parse(await readFile('database/shared-business-storage/install-manifest.json', 'utf8')); expect(m.entries.filter((e: {
        family: string;
        file: string;
    }) => e.family === 'SMPP_RUNTIME' && e.file.startsWith('014_'))).toHaveLength(2); const sql = await readFile('database/shared-business-storage/generated/ugv_sdar/SDAR_RUNTIME/0001_sdar_v1_2_2_baseline.sql', 'utf8'); expect(sql).toContain('public.vector'); expect(sql).not.toContain('CREATE TABLE public.'); expect(sql).not.toContain('SEQUENCE NAME public.'); });
});
