import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findProximityIntervalsInputSchema,
  findSuccessorCandidatesInputSchema,
  getTrackletGapsInputSchema,
  sliceTrackletInputSchema,
} from '../src/tools/schemas.js';

const scope = '00000000-0000-4000-8000-000000000001';
const trackletId = '00000000-0000-4000-8000-000000000002';
const versionId = '00000000-0000-4000-8000-000000000003';
const timeRange = { start: '2026-08-13T01:00:00Z', end: '2026-08-13T01:05:00Z', bounds: '[)' as const };
const ref = { trackletId, trackletVersionId: versionId };

test('time range rejects an empty or reversed interval', () => {
  assert.equal(getTrackletGapsInputSchema.safeParse({ dataScopeId: scope, tracklet: ref, timeRange: { ...timeRange, end: timeRange.start } }).success, false);
});

test('tracklet version reference must be pinned by exactly one selector', () => {
  assert.equal(getTrackletGapsInputSchema.safeParse({ dataScopeId: scope, tracklet: { ...ref, versionNo: 3 }, timeRange }).success, false);
});

test('slice requires time and/or a versioned region', () => {
  assert.equal(sliceTrackletInputSchema.safeParse({ dataScopeId: scope, tracklet: ref }).success, false);
});

test('v1 proximity contract exposes scalar sensitivity only', () => {
  assert.equal(findProximityIntervalsInputSchema.safeParse({ dataScopeId: scope, trackletA: ref, trackletB: { trackletId: scope, versionNo: 1 }, timeRange, maxDistanceMeters: 10, minimumDurationSeconds: 5, uncertaintyAlgorithm: 'SEGMENT_HARD_BOUND_V1' }).success, false);
});

test('successor Level 2 requires acceleration and heading hard gates', () => {
  assert.equal(findSuccessorCandidatesInputSchema.safeParse({ dataScopeId: scope, predecessor: ref, maxGapSeconds: 120, maxSpeedMps: 15, reachabilityLevel: 2 }).success, false);
});
