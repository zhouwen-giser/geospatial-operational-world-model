import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transaction } from '../src/db/database.js';
import { AppError } from '../src/domain/errors.js';
import { ToolRepository } from '../src/repositories/tool-repository.js';
import {
  findRegionInteractionsInputSchema,
  findTrackletsInRegionInputSchema,
  sliceTrackletInputSchema,
} from '../src/tools/schemas.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const timeRange = { start: '2026-08-13T01:00:00Z', end: '2026-08-13T01:05:00Z' };
const versionRow = (analysisSpaceId = id(30)) => ({
  tracklet_id: id(1), tracklet_version_id: id(11), version_no: 1,
  analysis_space_id: analysisSpaceId, source_id: id(21), source_type: 'camera',
  interpolation: 'Linear', max_accuracy_radius_m: 1,
});
const regionRow = (analysisSpaceId = id(30)) => ({
  spatial_object_id: id(40), spatial_object_version_id: id(41), analysis_space_id: analysisSpaceId,
});

test('slice_tracklet rejects a region from another analysis space', async () => {
  const responses = [[versionRow()], [regionRow(id(31))]];
  const transaction = { query: async () => ({ rows: responses.shift() ?? [] }) } as unknown as Transaction;
  const input = sliceTrackletInputSchema.parse({
    dataScopeId: id(50), tracklet: { trackletId: id(1), trackletVersionId: id(11) },
    timeRange, region: { spatialObjectId: id(40), spatialObjectVersionId: id(41) },
  });

  await assert.rejects(
    new ToolRepository().execute('slice_tracklet', input, transaction),
    (error: unknown) => error instanceof AppError && error.code === 'CRS_MISMATCH',
  );
  assert.equal(responses.length, 0);
});

test('find_region_interactions rejects a region from another analysis space', async () => {
  const responses = [[versionRow()], [regionRow(id(31))]];
  const transaction = { query: async () => ({ rows: responses.shift() ?? [] }) } as unknown as Transaction;
  const input = findRegionInteractionsInputSchema.parse({
    dataScopeId: id(50), tracklet: { trackletId: id(1), trackletVersionId: id(11) },
    region: { spatialObjectId: id(40), spatialObjectVersionId: id(41) },
    timeRange, events: ['VISIT'],
  });

  await assert.rejects(
    new ToolRepository().execute('find_region_interactions', input, transaction),
    (error: unknown) => error instanceof AppError && error.code === 'CRS_MISMATCH',
  );
  assert.equal(responses.length, 0);
});

test('find_tracklets_in_region limits candidates to the region analysis space', async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const responses = [[regionRow()], []];
  const transaction = {
    query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: responses.shift() ?? [] };
    },
  } as unknown as Transaction;
  const input = findTrackletsInRegionInputSchema.parse({
    dataScopeId: id(50), region: { spatialObjectId: id(40), spatialObjectVersionId: id(41) },
    timeRange, mode: 'CANDIDATE',
  });

  const result = await new ToolRepository().execute('find_tracklets_in_region', input, transaction);
  assert.equal(result.status, 'COMPLETE');
  assert.match(calls[1]?.text ?? '', /t\.analysis_space_id=\$7::uuid/);
  assert.equal(calls[1]?.values[6], id(30));
});

test('slice_tracklet returns COMPLETE empty output when time is evaluable but the region misses', async () => {
  const responses = [[versionRow()], [regionRow()], [{
    temporal_evaluable: true,
    temporal_point: null,
    temporal_domain: null,
    sequence_count: null,
    spatial_object_version_id: id(41),
  }]];
  const transaction = { query: async () => ({ rows: responses.shift() ?? [] }) } as unknown as Transaction;
  const input = sliceTrackletInputSchema.parse({
    dataScopeId: id(50), tracklet: { trackletId: id(1), trackletVersionId: id(11) },
    timeRange, region: { spatialObjectId: id(40), spatialObjectVersionId: id(41) },
  });

  const result = await new ToolRepository().execute('slice_tracklet', input, transaction);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(result.result, {
    temporal_point: null,
    temporal_domain: null,
    sequence_count: 0,
    spatial_object_version_id: id(41),
  });
});

test('find_region_interactions uses range bounds for tstzspan visit endpoints', async () => {
  const sql: string[] = [];
  const responses = [[versionRow()], [regionRow()], [{
    visit_no: 1,
    visit_time: '[2026-08-13 01:01:00+00,2026-08-13 01:02:00+00]',
    visit_start: '2026-08-13T01:01:00Z',
    visit_end: '2026-08-13T01:02:00Z',
    duration_seconds: 60,
    start_event: 'ENTER',
    end_event: 'EXIT',
    is_cross: true,
    is_touch: false,
    boundary_accuracy_m: 2,
  }]];
  const transaction = {
    query: async (text: string) => {
      sql.push(text);
      return { rows: responses.shift() ?? [] };
    },
  } as unknown as Transaction;
  const input = findRegionInteractionsInputSchema.parse({
    dataScopeId: id(50), tracklet: { trackletId: id(1), trackletVersionId: id(11) },
    region: { spatialObjectId: id(40), spatialObjectVersionId: id(41) },
    timeRange, events: ['VISIT'],
  });

  const result = await new ToolRepository().execute('find_region_interactions', input, transaction);
  assert.equal(result.status, 'COMPLETE');
  assert.match(sql[2] ?? '', /lower\(v\.span\) AS visit_start/);
  assert.match(sql[2] ?? '', /upper\(v\.span\) AS visit_end/);
  assert.doesNotMatch(sql[2] ?? '', /(?:start|end)Timestamp\(v\.span\)/);
});
