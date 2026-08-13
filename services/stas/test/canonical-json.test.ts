import assert from 'node:assert/strict';
import test from 'node:test';
import { semanticAnalysisHash } from '../src/domain/canonical-json.js';

test('semantic analysis hash is key-order stable but query-sensitive', () => {
  const first = semanticAnalysisHash({ query: { b: 2, a: 1 }, snapshot: { ids: ['x'] } });
  const reordered = semanticAnalysisHash({ snapshot: { ids: ['x'] }, query: { a: 1, b: 2 } });
  const otherQuery = semanticAnalysisHash({ query: { a: 1, b: 3 }, snapshot: { ids: ['x'] } });
  assert.equal(first, reordered);
  assert.notEqual(first, otherQuery);
});
