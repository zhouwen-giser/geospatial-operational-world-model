import assert from 'node:assert/strict';
import test from 'node:test';
import { requireMatchingDataScope } from '../src/api/scope.js';

const scope = '00000000-0000-4000-8000-000000000001';

test('scope must be supplied by authorization boundary and body', () => {
  assert.throws(() => requireMatchingDataScope(undefined, { dataScopeId: scope }), /x-data-scope-id/);
  assert.throws(() => requireMatchingDataScope(scope, { dataScopeId: 'different' }), /must match/);
  assert.equal(requireMatchingDataScope(scope, { dataScopeId: scope }), scope);
});
