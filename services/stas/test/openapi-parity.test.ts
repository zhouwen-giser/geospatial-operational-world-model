import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ToolRegistry } from '../src/tools/registry.js';

const openapiPath = fileURLToPath(new URL('../openapi/openapi.yaml', import.meta.url));
const specification = readFileSync(openapiPath, 'utf8');

test('OpenAPI exposes exactly the application-owned runtime paths', () => {
  const paths = specification.split(/\r?\n/)
    .filter((line) => /^  \/\S+:$/.test(line))
    .map((line) => line.trim().slice(0, -1));
  assert.deepEqual(paths, [
    '/healthz', '/readyz', '/v1/tools', '/v1/tools/{name}',
    '/v1/tools/{name}:execute', '/v1/analyses/{analysisId}',
  ]);
  assert.doesNotMatch(specification, /^  \/v1\/(observations:ingest|tracklets:build|analysis-jobs)/m);
});

test('OpenAPI tool enum and input schema refs match the 15-tool registry', () => {
  const registry = new ToolRegistry().list();
  for (const definition of registry) {
    assert.match(specification, new RegExp(`\\b${definition.name}\\b`), `${definition.name} enum`);
    assert.ok(specification.includes(`#/components/schemas/${definition.name}_input_v1`), `${definition.name} input schema`);
  }
  assert.equal(registry.length, 15);
  assert.match(specification, /status: \{ enum: \[COMPLETE, PARTIAL, NO_DATA, INDETERMINATE\] \}/);
  for (const policy of ['REQUIRED_EXACT_MATCH','TOOL_DECLARED_NO_CROSS_GAP','UNKNOWN_DOMAIN_EXPLICIT','REPORT_SEPARATE_DIMENSIONS']) {
    assert.ok(specification.includes(policy), policy);
  }
});
