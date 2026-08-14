import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSnapshotEvidence } from '../src/application/analysis-service.js';
import type { RepositoryExecution } from '../src/domain/analysis.js';

test('compact evidence references are generated from frozen inputs without duplicates', () => {
  const execution: RepositoryExecution = {
    status: 'COMPLETE', result: {}, subjects: [], algorithm: 'test', sqlTemplateId: 'test',
    snapshot: {
      trackletVersions: [{ trackletId: 't', trackletVersionId: 'tv', versionNo: 1 }],
      spatialObjectVersionIds: ['sv'], coverageSliceIds: ['cv'],
    },
    evidence: [{ id: 'tv', type: 'TRACKLET_VERSION' }, { id: 'm', type: 'MEASUREMENT' }],
  };
  const refs = buildSnapshotEvidence(execution);
  assert.deepEqual(refs.map((ref) => `${ref.type}:${ref.id}`), [
    'TRACKLET_VERSION:tv', 'MEASUREMENT:m', 'SPATIAL_OBJECT_VERSION:sv', 'COVERAGE_SLICE:cv',
  ]);
  assert.ok(refs.every((ref) => typeof ref.summaryHash === 'string' && ref.summaryHash.length === 64));
});
