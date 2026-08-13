import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError, mapDatabaseError } from '../src/domain/errors.js';
import { toProblem } from '../src/api/problem.js';

test('PostgreSQL statement timeout maps to a stable deadline error', () => {
  const error = mapDatabaseError({ code: '57014', message: 'canceling statement due to statement timeout' });
  assert.equal(error.code, 'DEADLINE_EXCEEDED');
  assert.equal(error.status, 504);
});

test('RFC 9457 response includes stable code and instance', () => {
  const problem = toProblem(new AppError('TOO_MANY_CANDIDATES', 422, 'Too many', 'cap exceeded'), '/v1/tools/find_nearby_tracklets:execute');
  assert.deepEqual(problem, {
    type: 'https://stas.example/problems/too-many-candidates',
    title: 'Too many',
    status: 422,
    detail: 'cap exceeded',
    instance: '/v1/tools/find_nearby_tracklets:execute',
    code: 'TOO_MANY_CANDIDATES',
  });
});

test('Fastify content-type and not-found errors map to stable application errors', () => {
  const mediaType = mapDatabaseError({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 });
  assert.equal(mediaType.code, 'INVALID_ARGUMENT');
  assert.equal(mediaType.status, 415);

  const notFound = mapDatabaseError({ code: 'FST_ERR_NOT_FOUND', statusCode: 404 });
  assert.equal(notFound.code, 'NOT_FOUND');
  assert.equal(notFound.status, 404);

  const serialization = mapDatabaseError({ code: '40001' });
  assert.equal(serialization.status, 503);
  assert.equal(serialization.meta?.retryableTransaction, true);
  assert.equal(serialization.meta?.sqlstate, '40001');

  const overlappingFirstWriter = mapDatabaseError({
    code: '23505',
    constraint: 'observation_event_source_id_source_record_key_source_revisi_key',
  });
  assert.equal(overlappingFirstWriter.status, 503);
  assert.equal(overlappingFirstWriter.meta?.retryableTransaction, true);
});
