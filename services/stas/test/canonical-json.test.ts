import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize, semanticAnalysisHash } from '../src/domain/canonical-json.js';

test('semantic analysis hash is key-order stable but query-sensitive', () => {
  const first = semanticAnalysisHash({ query: { b: 2, a: 1 }, snapshot: { ids: ['x'] } });
  const reordered = semanticAnalysisHash({ snapshot: { ids: ['x'] }, query: { a: 1, b: 2 } });
  const otherQuery = semanticAnalysisHash({ query: { a: 1, b: 3 }, snapshot: { ids: ['x'] } });
  assert.equal(first, reordered);
  assert.notEqual(first, otherQuery);
});

test('canonical key order follows Unicode code points without normalization', () => {
  const value = canonicalize({ '😀': 6, '中': 5, 'é': 4, 'e\u0301': 3, a: 2, A: 1 });
  assert.deepEqual(Object.keys(value as Record<string, unknown>), ['A', 'a', 'e\u0301', 'é', '中', '😀']);
});
