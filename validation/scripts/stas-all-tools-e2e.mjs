#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { Client } = require('../../node_modules/pg');
const api = (process.env.STAS_API_URL ?? 'http://127.0.0.1:18080').replace(/\/+$/, '');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const ids = Object.freeze({
  scope: '00000000-0000-4000-8000-000000000001',
  otherScope: '00000000-0000-4000-8000-000000000003',
  sensor: '00000000-0000-4000-8000-000000000006',
  region: '00000000-0000-4000-8000-000000000021',
  regionVersion: '00000000-0000-4000-8000-000000000022',
  coverage: '00000000-0000-4000-8000-000000000023',
  a: '40000000-0000-4000-8000-000000000001',
  b: '40000000-0000-4000-8000-000000000002',
  c: '40000000-0000-4000-8000-000000000003',
});
const range = { start: '2026-08-13T01:00:00.000Z', end: '2026-08-13T01:00:10.000Z', bounds: '[)' };
const common = { dataScopeId: ids.scope, snapshotPolicy: 'PINNED', evidenceLevel: 'FULL' };

async function request(path, { method = 'GET', body, scope = ids.scope } = {}) {
  const headers = { accept: 'application/json', ...(scope ? { 'x-data-scope-id': scope } : {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${api}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: response.status, body: parsed };
}

function ref(trackletId, trackletVersionId) { return { trackletId, trackletVersionId }; }

async function main() {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const rows = await db.query(`SELECT t.tracklet_id,h.current_version_id FROM mobility_tracklet t JOIN mobility_tracklet_head h USING(tracklet_id) WHERE t.tracklet_id=ANY($1::uuid[])`, [[ids.a, ids.b, ids.c]]);
    const versions = Object.fromEntries(rows.rows.map((row) => [row.tracklet_id, row.current_version_id]));
    assert.equal(Object.keys(versions).length, 3);
    const a = ref(ids.a, versions[ids.a]);
    const b = ref(ids.b, versions[ids.b]);
    const region = { spatialObjectId: ids.region, spatialObjectVersionId: ids.regionVersion };
    const inputs = new Map([
      ['get_tracklet', { ...common, tracklet: a, detail: 'OBSERVATION_REFS', limit: 20 }],
      ['get_tracklet_gaps', { ...common, tracklet: a, timeRange: range, reasons: [], limit: 20 }],
      ['get_tracklet_quality', { ...common, tracklet: a, timeRange: range, dimensions: ['TEMPORAL_COVERAGE','POSITION_UNCERTAINTY','SOURCE_HEALTH','PROVENANCE','CONFLICTS','SAMPLING'] }],
      ['slice_tracklet', { ...common, tracklet: a, timeRange: range, region, spatialMode: 'INTERSECTS_INCLUSIVE_BOUNDARY', boundaryPolicy: 'REPORT_AMBIGUOUS' }],
      ['get_position_at', { ...common, tracklet: a, timestamp: '2026-08-13T01:00:03.000Z', interpolationPolicy: 'ALLOW_WITHIN_SEQUENCE' }],
      ['get_motion_summary', { ...common, tracklet: a, timeRange: range, units: 'SI', perSequence: true }],
      ['find_stop_intervals', { ...common, tracklet: a, timeRange: range, maximumDiameterMeters: 2, minimumDurationSeconds: 0.1, limit: 20 }],
      ['find_region_interactions', { ...common, tracklet: a, region, timeRange: range, events: ['VISIT','ENTER','EXIT','TOUCH','CROSS'], minimumVisitSeconds: 0, boundaryPolicy: 'REPORT_AMBIGUOUS', limit: 20 }],
      ['find_tracklets_in_region', { ...common, region, timeRange: range, sourceTypes: [], mode: 'EXACT_VISIT', limit: 50 }],
      ['nearest_approach', { ...common, trackletA: a, trackletB: b, timeRange: range, dimensionPolicy: '2D', uncertaintyPolicy: 'NOMINAL_WITH_SCALAR_SENSITIVITY' }],
      ['find_proximity_intervals', { ...common, trackletA: a, trackletB: b, timeRange: range, maxDistanceMeters: 5, minimumDurationSeconds: 0, uncertaintyPolicy: 'NOMINAL_WITH_SCALAR_SENSITIVITY', uncertaintyAlgorithm: 'SCALAR_SENSITIVITY', limit: 20 }],
      ['find_nearby_tracklets', { ...common, subject: a, timeRange: range, maxDistanceMeters: 5, sourceTypes: [], mode: 'EXACT_EVER', uncertaintyPolicy: 'NOMINAL', limit: 50 }],
      ['find_successor_candidates', { ...common, predecessor: a, maxGapSeconds: 5, maxSpeedMps: 20, reachabilityLevel: 1, uncertaintyPolicy: 'NOMINAL', sourceTypes: [], limit: 50 }],
      ['compare_pair_features', { ...common, trackletA: a, trackletB: b, timeRange: range, features: ['TEMPORAL_OVERLAP','MIN_DISTANCE','PROXIMITY_DURATION','GAP_CONTEXT'], thresholds: { proximityMeters: [5] } }],
      ['find_sensor_coverage', { ...common, sensorId: ids.sensor, objectClass: 'person', timeRange: range, spatialObjectVersionId: ids.regionVersion, includeInactive: false, limit: 20 }],
    ]);
    const registry = await request('/v1/tools', { scope: null });
    assert.equal(registry.status, 200);
    assert.equal(registry.body.tools.length, 15);
    assert.deepEqual(new Set(registry.body.tools.map((tool) => tool.name)), new Set(inputs.keys()));

    const results = {};
    for (const [name, input] of inputs) {
      const response = await request(`/v1/tools/${name}:execute`, { method: 'POST', body: input });
      assert.equal(response.status, 200, `${name}: ${JSON.stringify(response.body)}`);
      assert.ok(['COMPLETE','NO_DATA','INDETERMINATE'].includes(response.body.status), `${name}: invalid status`);
      assert.equal(response.body.snapshot.dataScopeId, ids.scope);
      assert.equal(response.body.method.tool, name);
      assert.match(response.body.method.sqlTemplateHash, /^[0-9a-f]{64}$/);
      assert.ok(Array.isArray(response.body.evidence));
      results[name] = response.body;
      process.stdout.write(`ok ${name} ${response.body.status}\n`);
    }
    assert.ok(results.get_tracklet_gaps.result.items.some((item) => item.observability_state === 'UNKNOWN'));
    assert.equal(results.get_position_at.status, 'NO_DATA');
    assert.ok(results.find_region_interactions.result.items.length > 0);
    assert.ok(results.find_successor_candidates.result.items.some((item) => item.tracklet_id === ids.c));
    assert.ok(results.find_sensor_coverage.result.items.some((item) => item.coverage_slice_id === ids.coverage));

    const persisted = results.get_tracklet.analysisId;
    const replay = await request(`/v1/analyses/${persisted}`);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.analysisId, persisted);
    const deniedReplay = await request(`/v1/analyses/${persisted}`, { scope: ids.otherScope });
    assert.equal(deniedReplay.status, 404);
    const deniedExecution = await request('/v1/tools/get_tracklet:execute', { method: 'POST', body: inputs.get('get_tracklet'), scope: ids.otherScope });
    assert.equal(deniedExecution.status, 403);
    const capScope = '00000000-0000-4000-8000-000000000030';
    const capCount = await db.query("SELECT count(*)::integer AS count FROM mobility_tracklet WHERE data_scope_key='fixture-cap-10001'");
    assert.equal(capCount.rows[0].count, 10_001);
    const capped = await request('/v1/tools/find_tracklets_in_region:execute', {
      method: 'POST', scope: capScope, body: {
        dataScopeId: capScope, snapshotPolicy: 'PINNED', evidenceLevel: 'FULL', deadlineMs: 20_000,
        region: { spatialObjectId: '00000000-0000-4000-8000-000000000032', spatialObjectVersionId: '00000000-0000-4000-8000-000000000033' },
        timeRange: range, sourceTypes: [], mode: 'CANDIDATE', limit: 5000,
      },
    });
    assert.equal(capped.status, 422, JSON.stringify(capped.body));
    assert.equal(capped.body.code, 'TOO_MANY_CANDIDATES');
    assert.equal(capped.body.cap, 5000);
    assert.equal(capped.body.observedAtLeast, 5001);
    const stored = await db.query('SELECT count(*)::integer AS count FROM stas.analysis_record WHERE data_scope_key=$1', ['fixture-real']);
    assert.ok(stored.rows[0].count >= 15);
    const evidence = { status: 'PASS', generatedAt: new Date().toISOString(), toolCount: inputs.size,
      tools: Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { status: result.status, analysisId: result.analysisId }])),
      persistedAnalysisCount: stored.rows[0].count, replayAnalysisId: persisted,
      crossScopeReplayStatus: deniedReplay.status, crossScopeExecutionStatus: deniedExecution.status,
      candidateUniverse: capCount.rows[0].count, candidateCap: 5000, observedAtLeast: capped.body.observedAtLeast };
    await mkdir('validation/evidence', { recursive: true });
    await writeFile('validation/evidence/stas-all-tools.json', `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    await db.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
