import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '../src/tools/registry.js';

test('registry exposes all 15 P0 tool contracts and no executable schema object', () => {
  const registry = new ToolRegistry();
  const tools = registry.list();
  assert.equal(tools.length, 15);
  assert.deepEqual(tools.map((item) => item.name).sort(), [
    'compare_pair_features', 'find_nearby_tracklets', 'find_proximity_intervals',
    'find_region_interactions', 'find_sensor_coverage', 'find_stop_intervals',
    'find_successor_candidates', 'find_tracklets_in_region', 'get_motion_summary',
    'get_position_at', 'get_tracklet', 'get_tracklet_gaps', 'get_tracklet_quality',
    'nearest_approach', 'slice_tracklet',
  ]);
  assert.equal('schema' in registry.describe(tools[0]!), false);
});

test('registry declares repository CRS and uncertainty failures', () => {
  const registry = new ToolRegistry();
  for (const name of ['find_proximity_intervals', 'compare_pair_features', 'find_sensor_coverage']) {
    assert.ok(registry.get(name)?.errorCodes.includes('CRS_MISMATCH'), `${name}: CRS_MISMATCH`);
  }
  for (const name of ['find_nearby_tracklets', 'find_successor_candidates']) {
    assert.ok(registry.get(name)?.errorCodes.includes('UNSUPPORTED_UNCERTAINTY_MODEL'), `${name}: uncertainty`);
  }
});
