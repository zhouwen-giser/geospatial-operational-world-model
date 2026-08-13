import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transaction } from '../src/db/database.js';
import { ToolRepository } from '../src/repositories/tool-repository.js';
import {
  comparePairFeaturesInputSchema,
  findNearbyTrackletsInputSchema,
  nearestApproachInputSchema,
} from '../src/tools/schemas.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const timeRange = { start: '2026-08-13T01:00:00Z', end: '2026-08-13T01:05:00Z' };
const versionRow = (n: number) => ({
  tracklet_id: id(n), tracklet_version_id: id(n + 10), version_no: 1,
  analysis_space_id: id(30), source_id: id(n + 20), source_type: 'camera',
  interpolation: 'Linear', max_accuracy_radius_m: 1,
});

test('nearest_approach returns NO_DATA without a common defined domain', async () => {
  const sql: string[] = [];
  const responses = [[versionRow(1)], [versionRow(2)], []];
  const transaction = {
    query: async (text: string) => {
      sql.push(text);
      return { rows: responses.shift() ?? [] };
    },
  } as unknown as Transaction;
  const input = nearestApproachInputSchema.parse({
    dataScopeId: id(40),
    trackletA: { trackletId: id(1), trackletVersionId: id(11) },
    trackletB: { trackletId: id(2), trackletVersionId: id(12) },
    timeRange, dimensionPolicy: '2D',
  });

  const result = await new ToolRepository().execute('nearest_approach', input, transaction);
  assert.equal(result.status, 'NO_DATA');
  assert.equal(result.result, null);
  assert.match(sql[2] ?? '', /getTime\(ta\) \* getTime\(tb\)/);
  assert.match(sql[2] ?? '', /WHERE common_time IS NOT NULL/);
});

test('compare_pair_features does not coerce a missing distance to zero', async () => {
  const sql: string[] = [];
  const responses = [[versionRow(1)], [versionRow(2)], [{
    minimum_distance_m: null,
    common_time: null,
    coverage_a: null,
    coverage_b: null,
    proximity_times: null,
  }]];
  const transaction = {
    query: async (text: string) => {
      sql.push(text);
      return { rows: responses.shift() ?? [] };
    },
  } as unknown as Transaction;
  const input = comparePairFeaturesInputSchema.parse({
    dataScopeId: id(40),
    trackletA: { trackletId: id(1), trackletVersionId: id(11) },
    trackletB: { trackletId: id(2), trackletVersionId: id(12) },
    timeRange, features: ['TEMPORAL_OVERLAP', 'MIN_DISTANCE'],
    thresholds: { proximityMeters: [10] },
  });

  const result = await new ToolRepository().execute('compare_pair_features', input, transaction);
  assert.equal(result.status, 'NO_DATA');
  assert.equal(result.result, null);
  assert.match(sql[2] ?? '', /getTime\(ta\) \* getTime\(tb\)/);
  assert.match(sql[2] ?? '', /WHERE common_time IS NOT NULL/);
});

test('find_nearby_tracklets returns NO_DATA when the subject is undefined in the requested time', async () => {
  const sql: string[] = [];
  const responses = [[versionRow(1)], [{ evaluable: false }]];
  const transaction = {
    query: async (text: string) => {
      sql.push(text);
      return { rows: responses.shift() ?? [] };
    },
  } as unknown as Transaction;
  const input = findNearbyTrackletsInputSchema.parse({
    dataScopeId: id(40), subject: { trackletId: id(1), trackletVersionId: id(11) },
    timeRange, maxDistanceMeters: 10,
  });

  const result = await new ToolRepository().execute('find_nearby_tracklets', input, transaction);
  assert.equal(result.status, 'NO_DATA');
  assert.equal(result.result, null);
  assert.equal(sql.length, 2);
  assert.match(sql[1] ?? '', /atTime\(trajectory,\$2::tstzspan\) IS NOT NULL AS evaluable/);
});
