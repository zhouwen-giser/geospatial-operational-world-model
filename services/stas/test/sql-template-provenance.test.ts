import assert from 'node:assert/strict';
import test from 'node:test';
import { sqlTemplateSequenceHash } from '../src/application/analysis-service.js';

test('SQL provenance changes with executed text and excludes parameter values', () => {
  const baseline = sqlTemplateSequenceHash('nearest_approach.v1', [{
    text: 'SELECT ta |=| tb FROM p WHERE common_time IS NOT NULL',
    values: ['tracklet-a', 'tracklet-b'],
  }]);
  const otherValues = sqlTemplateSequenceHash('nearest_approach.v1', [{
    text: 'SELECT ta |=| tb FROM p WHERE common_time IS NOT NULL',
    values: ['different-a', 'different-b'],
  }]);
  const otherSql = sqlTemplateSequenceHash('nearest_approach.v1', [{
    text: 'SELECT ta |=| tb FROM p WHERE common_time IS NULL',
    values: ['tracklet-a', 'tracklet-b'],
  }]);

  assert.equal(baseline, otherValues);
  assert.notEqual(baseline, otherSql);
});

test('SQL provenance preserves statement order while normalizing line endings', () => {
  const windows = sqlTemplateSequenceHash('pair.v1', [
    { text: 'SELECT 1\r\n' },
    { text: 'SELECT 2\r\n' },
  ]);
  const unix = sqlTemplateSequenceHash('pair.v1', [
    { text: 'SELECT 1\n' },
    { text: 'SELECT 2\n' },
  ]);
  const reversed = sqlTemplateSequenceHash('pair.v1', [
    { text: 'SELECT 2\n' },
    { text: 'SELECT 1\n' },
  ]);

  assert.equal(windows, unix);
  assert.notEqual(unix, reversed);
});
