import pg from 'pg';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { install, verify, manifest, checksum } from './installer.js';
const command = process.argv[2] ?? 'help';
const args = process.argv.slice(3);
if (args.includes('--help') || command === 'help') {
    console.log('GOWM shared business storage: check | install [--domain all|smpp|sdar] | verify | fixture | test:postgres | handoff\nInstall requires explicit GOWM_DATABASE_URL. Tests/fixture require GOWM_BUSINESS_TEST_DATABASE_URL and GOWM_BUSINESS_SMOKE_ENABLE=true; only isolated databases with test in the name. Help/check/handoff do not connect to a database.');
}
else if (command === 'check') {
    const entries = await manifest();
    for (const e of entries) {
        for (const [path, expected] of [[e.path, e.sha256], [e.generatedPath, e.generatedSha256]]) {
            if (checksum(await readFile(`database/shared-business-storage/${path}`, 'utf8')) !== expected)
                throw Error(`CHECKSUM_DRIFT ${path}`);
        }
    }
    const sql = await readFile('database/migrations/078_device_shared_business_storage.sql', 'utf8');
    if ((sql.match(/CREATE TABLE gowm_/g) ?? []).length !== 9)
        throw Error('NINE_PUBLIC_TABLES_REQUIRED');
    console.log(JSON.stringify({ status: 'PASS', nativeMigrations: entries.length, publicTables: 9 }));
}
else if (command === 'handoff') {
    const dir = 'docs/shared-business-storage-handoff';
    await mkdir(dir, { recursive: true });
    for (const name of ['sources.json', 'source-inventory.json', 'install-manifest.json'])
        await cp(`database/shared-business-storage/${name}`, `${dir}/${name}`);
    await cp('database/shared-business-storage/transforms/namespace-transform-map.json', `${dir}/namespace-transform-map.json`);
    await mkdir(`${dir}/ddl`, {recursive:true});
    await cp('database/migrations/078_device_shared_business_storage.sql',`${dir}/ddl/078_device_shared_business_storage.sql`);
    await cp('database/shared-business-storage/generated',`${dir}/ddl/generated`,{recursive:true});
    await cp('database/shared-business-storage/overlays',`${dir}/ddl/overlays`,{recursive:true});
    await cp('database/shared-business-storage/THIRD_PARTY_NOTICES.md',`${dir}/THIRD_PARTY_NOTICES.md`);
    for (const name of ['LICENSE-SMPP','LICENSE-SDAR']) await cp(`database/shared-business-storage/upstream/${name}`,`${dir}/${name}`);
    try {const report=JSON.parse(await readFile('reports/device-shared-business-storage-v0.2/postgres-results.json','utf8'));await writeFile(`${dir}/verification-summary.json`,JSON.stringify({status:report.status,scenarios:report.scenarios,extensions:report.extensions},null,2)+'\n');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await writeFile(`${dir}/verification-summary.json`,JSON.stringify({status:'NOT_RUN'})+'\n');}
    console.log(`Handoff: ${dir}`);
}
else if (['install', 'verify', 'fixture', 'test:postgres'].includes(command)) {
    const test = command === 'fixture' || command === 'test:postgres';
    const url = process.env[test ? 'GOWM_BUSINESS_TEST_DATABASE_URL' : 'GOWM_DATABASE_URL'];
    if (!url || (test && process.env.GOWM_BUSINESS_SMOKE_ENABLE !== 'true')) {
        console.log(JSON.stringify({ status: 'NOT_RUN', reason: test ? 'explicit isolated GOWM_BUSINESS_TEST_DATABASE_URL and GOWM_BUSINESS_SMOKE_ENABLE=true required' : 'GOWM_DATABASE_URL required' }));
        process.exitCode = 2;
    }
    else {
        const pool = new pg.Pool({ connectionString: url, max: 6 });
        try {
            const c = await pool.connect();
            try {
                if (test) {
                    const r = await c.query('SELECT current_database() name');
                    if (!/test/i.test(r.rows[0].name))
                        throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
                }
                if (command === 'install') {
                    const d = args.includes('--domain') ? args[args.indexOf('--domain') + 1] : 'all';
                    if (d !== 'all' && d !== 'smpp' && d !== 'sdar')
                        throw Error('DOMAIN_INVALID');
                    await install(c, d);
                    console.log('INSTALL PASS');
                }
                else if (command === 'verify')
                    console.log(JSON.stringify(await verify(c)));
                else {
                    await install(c);
                }
            }
            finally {
                c.release();
            }
            if (test) {
                const { fixture, postgresTests } = await import('./fixture.js');
                if (command === 'fixture')
                    console.log(JSON.stringify(await fixture(pool)));
                else {
                    const result = await postgresTests(pool);
                    await writeFile('reports/device-shared-business-storage-v0.2/postgres-results.json', JSON.stringify(result, null, 2) + '\n');
                    console.log(JSON.stringify({ status: result.status, scenarios: result.scenarios }));
                    if (result.status !== 'PASS')
                        process.exitCode = 1;
                }
            }
        }
        finally {
            await pool.end();
        }
    }
}
else
    throw Error('UNKNOWN_COMMAND');
