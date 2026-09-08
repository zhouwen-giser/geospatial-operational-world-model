import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { checksum } from './installer.js';
if (process.env.GOWM_BUSINESS_SMOKE_ENABLE !== 'true' || !process.env.GOWM_BUSINESS_TEST_DATABASE_URL)
    throw Error('explicit isolated test environment required');
const c = new pg.Client({ connectionString: process.env.GOWM_BUSINESS_TEST_DATABASE_URL });
await c.connect();
try {
    const db = await c.query('SELECT current_database() name');
    if (!/test/.test(db.rows[0].name))
        throw Error('TEST_DATABASE_NAME_REQUIRED');
    if(!process.argv.includes('--without-vector'))await c.query('CREATE EXTENSION IF NOT EXISTS vector');
    await c.query('CREATE TABLE IF NOT EXISTS public.schema_migration(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of (await readdir('database/migrations')).filter(x => /^\d{3}_.*\.sql$/.test(x)).sort()) {
        const sql = (await readFile(`database/migrations/${file}`, 'utf8')).replaceAll(':ANALYSIS_SRID', '3857').replaceAll(':TRACKLET_MAX_TIME_GAP_MS', '30000').replaceAll(':TRACKLET_MAX_DISTANCE_GAP_M', '1000').replaceAll(':TRACKLET_MAX_REQUIRED_SPEED_MPS', '100');
        const old = await c.query('SELECT checksum FROM public.schema_migration WHERE version=$1', [file]);
        if (old.rowCount)
            continue;
        try {
            await c.query(sql);
            await c.query('INSERT INTO public.schema_migration(version,checksum) VALUES($1,$2)', [file, checksum(sql)]);
        }
        catch (e) {
            throw new Error(`${file}: ${e instanceof Error ? e.message : e}`);
        }
    }
    console.log('isolated core bootstrap PASS');
}
finally {
    await c.end();
}
