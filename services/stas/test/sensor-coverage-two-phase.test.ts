import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transaction } from '../src/db/database.js';
import { AppError } from '../src/domain/errors.js';
import { ToolRepository } from '../src/repositories/tool-repository.js';
import { findSensorCoverageInputSchema } from '../src/tools/schemas.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const input = findSensorCoverageInputSchema.parse({
  dataScopeId: id(1),
  timeRange: { start: '2026-08-13T01:00:00Z', end: '2026-08-13T01:05:00Z' },
  spatialObjectVersionId: id(2),
  limit: 2,
});
const region = {
  spatial_object_id: id(7), spatial_object_version_id: id(2), analysis_space_id: id(8),
};

test('sensor coverage caps bbox candidates before exact evaluation and pins only exact evidence', async () => {
  const sql: string[] = [];
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const responses = [
    [region],
    [{ coverage_slice_id: id(3) }],
    [{
      coverage_slice_id: id(3), sensor_deployment_id: id(4), datastream_id: id(5),
      valid_time: '[2026-08-13 01:00:00+00,2026-08-13 01:05:00+00)',
      coverage_geometry: { type: 'Polygon', coordinates: [] }, detectable_object_class: 'person',
      coverage_confidence: 0.9, coverage_model_version: 'fov-v1', occlusion_model_version: null,
      assumptions: [], sensor_pose_version_id: null, sensor_extrinsic_version_id: null,
      detector_model_id: null, processing_run_id: id(6), prerequisite_state: 'MISSING_STATUS',
      watermark_state: 'MISSING_WATERMARK', status_intervals: null, status_interval_ids: null,
      watermarks: null, watermark_revision_ids: null,
    }],
  ];
  const transaction = {
    query: async (text: string, values: unknown[]) => {
      sql.push(text);
      calls.push({ text, values });
      return { rows: responses.shift() ?? [] };
    },
  } as unknown as Transaction;

  const result = await new ToolRepository().execute('find_sensor_coverage', input, transaction);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.candidateCount, 1);
  assert.equal(result.exactCount, 1);
  assert.deepEqual(result.snapshot.coverageSliceIds, [id(3)]);
  assert.deepEqual(result.snapshot.datastreamIds, [id(5)]);
  assert.equal((result.result as { items: Array<{ prerequisite_state: string }> }).items[0]?.prerequisite_state, 'MISSING_STATUS');

  const coarse = sql[1] ?? '';
  const exact = sql[2] ?? '';
  assert.match(coarse, /coverage_geometry\s*&&\s*qr\.geometry/);
  assert.match(coarse, /sd\.analysis_space_id=\$11::uuid/);
  assert.equal(calls[1]?.values[10], id(8));
  assert.doesNotMatch(coarse, /ST_(?:Intersects|Covers)/i);
  assert.match(exact, /FROM unnest\(\$1::uuid\[\]\)/);
  assert.match(exact, /ST_Intersects\(cs\.coverage_geometry,qr\.geometry\)/);
  assert.match(exact, /sd\.analysis_space_id=\$8::uuid/);
  assert.equal(calls[2]?.values[7], id(8));
  assert.match(exact, /w\.datastream_id=cs\.datastream_id/);
  assert.match(exact, /NOT EXISTS/);
  assert.match(exact, /producer_pipeline_id=ds\.producer_pipeline_id/);
  assert.match(exact, /ss\.valid_time\s*&&\s*tstzrange\(\$9::timestamptz,\$10::timestamptz,'\[\)'\)/);
  assert.match(exact, /known\.valid_time\s*&&\s*tstzrange\(\$9::timestamptz,\$10::timestamptz,'\[\)'\)/);
  assert.match(exact, /active\.valid_time\s*&&\s*tstzrange\(\$9::timestamptz,\$10::timestamptz,'\[\)'\)/);
  assert.match(exact, /latest\.closed_through_event_time\s*>=\s*\$10::timestamptz/);
  assert.match(exact, /PINNED_NOT_CLOSED_THROUGH_REQUESTED_END/);
  assert.equal(calls[2]?.values[8], input.timeRange.start);
  assert.equal(calls[2]?.values[9], input.timeRange.end);
});

test('sensor coverage rejects an over-cap coarse universe without running exact predicates', async () => {
  const sql: string[] = [];
  const responses = [
    [region],
    [{ coverage_slice_id: id(3) }, { coverage_slice_id: id(4) }, { coverage_slice_id: id(5) }],
  ];
  const transaction = {
    query: async (text: string) => {
      sql.push(text);
      return { rows: responses.shift() ?? [] };
    },
  } as unknown as Transaction;

  await assert.rejects(
    new ToolRepository().execute('find_sensor_coverage', input, transaction),
    (error: unknown) => error instanceof AppError && error.code === 'TOO_MANY_CANDIDATES',
  );
  assert.equal(sql.length, 2);
  assert.doesNotMatch(sql[1] ?? '', /ST_(?:Intersects|Covers)/i);
});

test('sensor coverage rejects a sensor outside the authorized data scope', async () => {
  const sensorInput = findSensorCoverageInputSchema.parse({
    dataScopeId: id(1), sensorId: id(9),
    timeRange: { start: '2026-08-13T01:00:00Z', end: '2026-08-13T01:05:00Z' },
  });
  const sql: string[] = [];
  const transaction = {
    query: async (text: string) => {
      sql.push(text);
      return { rows: [] };
    },
  } as unknown as Transaction;

  await assert.rejects(
    new ToolRepository().execute('find_sensor_coverage', sensorInput, transaction),
    (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND',
  );
  assert.equal(sql.length, 1);
  assert.match(sql[0] ?? '', /sensor_id=\$1::uuid AND data_scope_id=\$2::uuid/);
});
