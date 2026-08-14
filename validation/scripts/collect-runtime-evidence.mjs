#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('../../node_modules/pg');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

async function expectSqlState(client, sql, code) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE stas_app');
    await client.query(sql);
    assert.fail(`${sql} unexpectedly succeeded`);
  } catch (error) {
    assert.equal(error.code, code, `${sql}: ${error.message}`);
  } finally {
    await client.query('ROLLBACK');
  }
}

function flatten(node, rows = []) {
  rows.push({ nodeType: node['Node Type'], indexName: node['Index Name'] ?? null, actualRows: node['Actual Rows'] ?? null, loops: node['Actual Loops'] ?? null });
  for (const child of node.Plans ?? []) flatten(child, rows);
  return rows;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const runtime = await client.query(`
      SELECT current_setting('server_version') AS postgresql,
        (SELECT extversion FROM pg_extension WHERE extname='postgis') AS postgis,
        (SELECT extversion FROM pg_extension WHERE extname='postgis_raster') AS postgis_raster,
        (SELECT extversion FROM pg_extension WHERE extname='mobilitydb') AS mobilitydb,
        (SELECT extversion FROM pg_extension WHERE extname='h3') AS h3,
        (SELECT extversion FROM pg_extension WHERE extname='h3_postgis') AS h3_postgis,
        (SELECT count(*)::integer FROM schema_migration) AS migration_count,
        (SELECT analysis_srid FROM gowm_deployment_config WHERE singleton) AS analysis_srid
    `);
    const privileges = await client.query(`SELECT
      has_schema_privilege('stas_app','public','USAGE') AS public_usage,
      has_table_privilege('stas_app','public.world_observation','SELECT') AS base_select,
      has_table_privilege('stas_app','public.world_observation','UPDATE') AS base_update,
      has_table_privilege('stas_app','gowm_stas_v1.tracklet_version','SELECT') AS contract_select,
      has_table_privilege('stas_app','stas.analysis_record','INSERT') AS sink_insert,
      has_table_privilege('stas_app','stas.analysis_record','UPDATE') AS sink_update`);
    assert.deepEqual(privileges.rows[0], { public_usage: true, base_select: false, base_update: false, contract_select: true, sink_insert: true, sink_update: false });
    await expectSqlState(client, 'SELECT count(*) FROM public.world_observation', '42501');
    await expectSqlState(client, "UPDATE public.world_observation SET metadata='{}' WHERE false", '42501');

    await client.query('ANALYZE mobility_tracklet');
    await client.query('ANALYZE mobility_tracklet_version');

    const explain = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      WITH region AS (
        SELECT sov.geometry FROM gowm_stas_v1.spatial_object_version sov
        JOIN gowm_stas_v1.spatial_object so USING(spatial_object_id)
        WHERE sov.spatial_object_version_id='00000000-0000-4000-8000-000000000033'::uuid
          AND so.data_scope_id='00000000-0000-4000-8000-000000000030'::uuid
      )
      SELECT tv.tracklet_version_id,tv.tracklet_id,tv.version_no
      FROM region
      JOIN gowm_stas_v1.tracklet t ON t.data_scope_id='00000000-0000-4000-8000-000000000030'::uuid
      JOIN gowm_stas_v1.tracklet_head h ON h.tracklet_id=t.tracklet_id
      JOIN gowm_stas_v1.tracklet_version tv ON tv.tracklet_version_id=h.current_version_id
      WHERE tv.trajectory && span('2026-08-13T01:00:00Z'::timestamptz,'2026-08-13T01:00:10Z'::timestamptz,true,false)
        AND tv.trajectory && stbox(region.geometry)
      ORDER BY tv.tracklet_version_id LIMIT 5001`);
    const plan = explain.rows[0]['QUERY PLAN'][0];
    const nodes = flatten(plan.Plan);
    assert.equal(Number(plan.Plan['Actual Rows']), 5001);
    assert.ok(plan['Execution Time'] < 20_000, `candidate plan exceeded 20s: ${plan['Execution Time']}`);
    const index = await client.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='mobility_tracklet_scope_space_idx'");
    assert.equal(index.rows.length, 1);

    const evidence = {
      status: 'PASS', generatedAt: new Date().toISOString(), runtime: runtime.rows[0],
      roleBoundary: { ...privileges.rows[0], deniedBaseSelectSqlstate: '42501', deniedBaseUpdateSqlstate: '42501' },
      candidatePlan: { universe: 10001, cap: 5000, returnedByProbe: plan.Plan['Actual Rows'], planningTimeMs: plan['Planning Time'], executionTimeMs: plan['Execution Time'], scopedIndex: index.rows[0].indexdef, nodes },
    };
    await mkdir('validation/evidence', { recursive: true });
    await writeFile('validation/evidence/runtime-and-performance.json', `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
