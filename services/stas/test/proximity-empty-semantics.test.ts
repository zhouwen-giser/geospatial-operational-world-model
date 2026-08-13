import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transaction } from '../src/db/database.js';
import { ToolRepository } from '../src/repositories/tool-repository.js';
import { findProximityIntervalsInputSchema } from '../src/tools/schemas.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const versionRow = (n: number) => ({
  tracklet_id: id(n), tracklet_version_id: id(n + 10), version_no: 1,
  analysis_space_id: id(30), source_id: id(n + 20), source_type: 'camera',
  interpolation: 'Linear', max_accuracy_radius_m: 1,
});
const input = findProximityIntervalsInputSchema.parse({
  dataScopeId: id(40),
  trackletA: { trackletId: id(1), trackletVersionId: id(11) },
  trackletB: { trackletId: id(2), trackletVersionId: id(12) },
  timeRange: { start: '2026-08-13T01:00:00Z', end: '2026-08-13T01:05:00Z' },
  maxDistanceMeters: 10, minimumDurationSeconds: 5,
});

test('common evaluable domain with no proximity is COMPLETE with empty intervals', async () => {
  const responses = [[versionRow(1)], [versionRow(2)], [], [{ evaluable: true, min_distance_m: 25 }]];
  const transaction = { query: async () => ({ rows: responses.shift() ?? [] }) } as unknown as Transaction;
  const result = await new ToolRepository().execute('find_proximity_intervals', input, transaction);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(result.result, { intervals: [] });
});

test('no common defined domain is NO_DATA rather than a false result', async () => {
  const responses = [[versionRow(1)], [versionRow(2)], [], [{ evaluable: false, min_distance_m: null }]];
  const transaction = { query: async () => ({ rows: responses.shift() ?? [] }) } as unknown as Transaction;
  const result = await new ToolRepository().execute('find_proximity_intervals', input, transaction);
  assert.equal(result.status, 'NO_DATA');
  assert.equal(result.result, null);
});

test('proximity domain probe treats a NULL span-set intersection as undefined', async () => {
  const sql: string[] = [];
  const responses = [[versionRow(1)], [versionRow(2)], [], [{ evaluable: false, min_distance_m: null }]];
  const transaction = {
    query: async (text: string) => {
      sql.push(text);
      return { rows: responses.shift() ?? [] };
    },
  } as unknown as Transaction;
  await new ToolRepository().execute('find_proximity_intervals', input, transaction);
  assert.match(sql[3] ?? '', /\(getTime\(ta\) \* getTime\(tb\)\) IS NOT NULL/);
  assert.match(sql[3] ?? '', /\(getTime\(ta\) \* getTime\(tb\)\) IS NULL/);
});
