import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp, type AppDependencies } from '../src/app.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AppError } from '../src/domain/errors.js';

const scope = '00000000-0000-4000-8000-000000000001';

function testDependencies(): AppDependencies {
  return {
    config: {
      DATABASE_URL: 'postgresql://unused', HOST: '127.0.0.1', PORT: 8080, LOG_LEVEL: 'silent',
      DB_POOL_MAX: 1, DB_CONNECTION_TIMEOUT_MS: 100, SERVICE_VERSION: 'test',
    },
    database: { withTransaction: async () => ({ mobilityDbVersion: '1.3.0', postgisVersion: '3.6.1', schemaContractVersion: '1.0.0', analysisSrid: 32654 }) } as unknown as AppDependencies['database'],
    analysisService: { execute: async () => ({ ok: true }), get: async () => ({ analysisId: scope }) } as unknown as AppDependencies['analysisService'],
    registry: new ToolRegistry(),
  };
}

test('health and readiness distinguish process liveness from database readiness', async () => {
  const dependencies = testDependencies();
  let databaseAvailable = true;
  dependencies.database = { withTransaction: async (timeout: number, isolation: string) => {
    assert.equal(timeout, 1000);
    assert.equal(isolation, 'REPEATABLE_READ');
    if (!databaseAvailable) throw new AppError('DATABASE_UNAVAILABLE', 503, 'Database unavailable', 'Unit fixture unavailable');
    return { mobilityDbVersion: '1.3.0', postgisVersion: '3.6.1', schemaContractVersion: '1.0.0', analysisSrid: 32654 };
  } } as unknown as AppDependencies['database'];
  const app = createApp(dependencies);
  try {
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().status, 'ready');
    assert.equal(ready.json().schemaContractVersion, '1.0.0');
    databaseAvailable = false;
    const unavailable = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.json().code, 'DATABASE_UNAVAILABLE');
    assert.match(unavailable.headers['content-type'] as string, /application\/problem\+json/);
    const live = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { status: 'ok', serviceVersion: 'test' });
  } finally {
    await app.close();
  }
});

test('colon action route exists and rejects missing authorized scope as RFC 9457', async () => {
  const app = createApp(testDependencies());
  const response = await app.inject({ method: 'POST', url: '/v1/tools/get_tracklet_gaps:execute', payload: { dataScopeId: scope } });
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers['content-type'], 'application/problem+json; charset=utf-8');
  assert.equal(response.json().code, 'DATA_SCOPE_FORBIDDEN');
  await app.close();
});

test('tool action route extracts only the tool name before its literal colon', async () => {
  const dependencies = testDependencies();
  dependencies.analysisService = {
    execute: async (name: string) => {
      assert.equal(name, 'get_tracklet_gaps');
      return { ok: true };
    },
  } as unknown as AppDependencies['analysisService'];
  const app = createApp(dependencies);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/tools/get_tracklet_gaps:execute',
    headers: { 'x-data-scope-id': scope },
    payload: { dataScopeId: scope },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().ok, true);
  await app.close();
});

test('STAS does not expose GOWM-owned observation or Tracklet commands', async () => {
  const app = createApp(testDependencies());
  for (const url of ['/v1/observations:ingest', '/v1/tracklets:build']) {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-data-scope-id': scope },
      payload: { dataScopeId: scope },
    });
    assert.equal(response.statusCode, 404, `${url} must not be owned by STAS`);
    assert.equal(response.json().code, 'NOT_FOUND');
  }
  await app.close();
});

test('persisted analysis route requires scope and delegates by UUID plus scope', async () => {
  const dependencies = testDependencies();
  dependencies.analysisService = { execute: async () => ({}), get: async (id: string, dataScopeId: string) => {
    assert.equal(dataScopeId, scope);
    return { analysisId: id };
  } } as unknown as AppDependencies['analysisService'];
  const app = createApp(dependencies);
  const denied = await app.inject({ method: 'GET', url: `/v1/analyses/${scope}` });
  assert.equal(denied.statusCode, 403);
  const response = await app.inject({ method: 'GET', url: `/v1/analyses/${scope}`, headers: { 'x-data-scope-id': scope } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().analysisId, scope);
  await app.close();
});

test('registry HTTP response exposes 15 tools', async () => {
  const app = createApp(testDependencies());
  const response = await app.inject({ method: 'GET', url: '/v1/tools' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().tools.length, 15);
  await app.close();
});

test('unknown routes use RFC 9457 not-found responses', async () => {
  const app = createApp(testDependencies());
  const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers['content-type'], 'application/problem+json; charset=utf-8');
  assert.equal(response.json().code, 'NOT_FOUND');
  assert.equal(response.json().instance, '/v1/does-not-exist');
  await app.close();
});

test('unsupported request media types use RFC 9457 responses', async () => {
  const app = createApp(testDependencies());
  const response = await app.inject({
    method: 'POST',
    url: '/v1/tools/get_tracklet_gaps:execute',
    headers: { 'content-type': 'application/xml', 'x-data-scope-id': scope },
    payload: '<observation/>',
  });
  assert.equal(response.statusCode, 415);
  assert.equal(response.headers['content-type'], 'application/problem+json; charset=utf-8');
  assert.equal(response.json().code, 'INVALID_ARGUMENT');
  await app.close();
});
