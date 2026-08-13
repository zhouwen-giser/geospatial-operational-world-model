import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transaction } from '../src/db/database.js';
import { ToolRepository } from '../src/repositories/tool-repository.js';
import { getPositionAtInputSchema } from '../src/tools/schemas.js';

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

test('get_position_at returns NO_DATA with the explicit gap that contains the timestamp', async () => {
  let call = 0;
  const fakeTransaction = {
    query: async () => {
      call += 1;
      if (call === 1) return { rows: [{
        tracklet_id: id(1), tracklet_version_id: id(2), version_no: 3,
        analysis_space_id: id(3), source_id: id(4), source_type: 'camera',
        interpolation: 'Linear', max_accuracy_radius_m: 3,
      }] };
      if (call === 2) return { rows: [] };
      return { rows: [{
        gap_no: 1, gap_start: '2026-08-13T01:01:00Z', gap_end: '2026-08-13T01:05:00Z',
        lower_inclusive: false, upper_inclusive: false,
        reason_codes: ['TRACKER_LOST'], observability_state: 'UNKNOWN',
      }] };
    },
  } as unknown as Transaction;
  const input = getPositionAtInputSchema.parse({
    dataScopeId: id(5), tracklet: { trackletId: id(1), trackletVersionId: id(2) },
    timestamp: '2026-08-13T01:03:00Z', interpolationPolicy: 'ALLOW_WITHIN_SEQUENCE',
  });
  const result = await new ToolRepository().execute('get_position_at', input, fakeTransaction);
  assert.equal(result.status, 'NO_DATA');
  assert.equal(result.gaps?.length, 1);
  assert.equal(result.gaps?.[0]?.timeRange.bounds, '()');
  assert.deepEqual(result.gaps?.[0]?.reasonCodes, ['TRACKER_LOST']);
});
