import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { structure } from './structure.js';
const root = 'database/shared-business-storage';
export const checksum = (s: string) => createHash('sha256').update(s.replace(/\r\n?/g, '\n')).digest('hex');
export interface Entry {
    family: string;
    schema: string;
    file: string;
    generatedPath: string;
    generatedSha256: string;
    path: string;
    sha256: string;
}
export async function manifest(): Promise<Entry[]> { return JSON.parse(await readFile(`${root}/install-manifest.json`, 'utf8')).entries; }
export async function install(c: PoolClient, domain: 'all' | 'smpp' | 'sdar' = 'all') {
    await c.query('SELECT pg_advisory_lock(718079)');
    try {
        const pre = await c.query("SELECT to_regclass('public.world_object') w,to_regclass('public.datastream') d,to_regclass('public.schema_migration') m");
        if (!pre.rows[0].w || !pre.rows[0].d || !pre.rows[0].m)
            throw Error('GOWM_CORE_REQUIRED: run core migrations first');
        const prerequisite = await c.query("SELECT 1 FROM public.schema_migration WHERE version='087_business_runtime_authority.sql'");
        if (!prerequisite.rowCount)
            throw Error('GOWM_CORE_REQUIRED: apply through 087_business_runtime_authority.sql');
        for (const coreFile of ['078_device_shared_business_storage.sql','079_device_context_reader.sql']) {
            const core = await readFile(`database/migrations/${coreFile}`, 'utf8');
            const applied = await c.query('SELECT checksum FROM public.schema_migration WHERE version=$1', [coreFile]);
            if (applied.rowCount) {
                if (applied.rows[0].checksum !== checksum(core))
                    throw Error('CORE_CHECKSUM_DRIFT');
            }
            else {
                await c.query('BEGIN');
                try {
                    await c.query(core.replace(/^BEGIN;|^COMMIT;/gm, ''));
                    await c.query('INSERT INTO public.schema_migration(version,checksum) VALUES($1,$2)', [coreFile, checksum(core)]);
                    await c.query('COMMIT');
                }
                catch (e) {
                    await c.query('ROLLBACK');
                    throw e;
                }
            }
        }
        for (const schema of domain === 'all' ? ['ugv_smpp', 'ugv_sdar'] : [domain === 'smpp' ? 'ugv_smpp' : 'ugv_sdar']) {
            if (schema === 'ugv_sdar') {
                const ext = await c.query("SELECT e.extname,n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'");
                if (!ext.rowCount)
                    throw Error('DEPENDENCY_MISSING: vector extension must be installed by database administrator');
                if (ext.rows[0].nspname !== 'public')
                    throw Error('EXTENSION_NAMESPACE_UNSUPPORTED: vector expected in public; do not relocate existing extension');
            }
            const exists = await c.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
            if (exists.rowCount) {
                const marker = await c.query('SELECT to_regclass($1) AS name', [`${schema}.gowm_install_history`]);
                if (!marker.rows[0].name) {
                    const objects = await c.query('SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 UNION ALL SELECT p.proname AS relname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [schema]);
                    if (objects.rowCount)
                        throw Error(`UNKNOWN_NONEMPTY_SCHEMA: ${schema}: ${objects.rows.map(x => x.relname).join(',')}`);
                }
            }
            await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
            await c.query(`CREATE TABLE IF NOT EXISTS ${schema}.gowm_install_history(family text NOT NULL,file text NOT NULL,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(family,file))`);
            const entries = (await manifest()).filter(e => e.schema === schema);
            for (const e of entries) {
                const sql = await readFile(`${root}/${e.generatedPath}`, 'utf8');
                if (checksum(sql) !== e.generatedSha256)
                    throw Error(`GENERATED_CHECKSUM_DRIFT: ${e.file}`);
                await apply(c, schema, e.family, e.file, sql);
            }
            await apply(c, schema, 'GOWM_OVERLAY', 'device_scope_v1.sql', await readFile(`${root}/overlays/${schema}.sql`, 'utf8'));
            await apply(c, schema, 'GOWM_OVERLAY', 'scope_hardening_v1.sql', await readFile(`${root}/overlays/${schema === 'ugv_smpp' ? 'smpp' : 'sdar'}-hardening.sql`, 'utf8'));
            await apply(c, schema, 'GOWM_OVERLAY', 'additional_scope_v1.sql', await readFile(`${root}/overlays/${schema === 'ugv_smpp' ? 'smpp' : 'sdar'}-additional.sql`, 'utf8'));
            if (schema === 'ugv_sdar')
                await apply(c, schema, 'GOWM_OVERLAY', 'derived_ownership_v1.sql', await readFile(`${root}/overlays/sdar-derived-ownership.sql`, 'utf8'));
        }
        const ready = await c.query("SELECT to_regclass('ugv_smpp.ugv_execution') smpp,to_regclass('ugv_sdar.agent_task') sdar");
        if (ready.rows[0].smpp && ready.rows[0].sdar) {
            await apply(c, 'ugv_smpp', 'GOWM_READ_MODEL', 'read_model_v1.sql', await readFile(`${root}/overlays/read-model.sql`, 'utf8'));
            await applyRuntimeApi(c);
        }
    }
    finally {
        await c.query('SELECT pg_advisory_unlock(718079)');
    }
}
/** Additive retained upgrade only: no native installs, accounts, passwords or bindings. */
export async function applyRuntimeApi(c: PoolClient) {
    const ready=await c.query("SELECT to_regclass('ugv_smpp.gowm_install_history') smpp,to_regclass('ugv_sdar.gowm_install_history') sdar,to_regclass('gowm_business_v1.task_execution_lineage') model");
    if(!ready.rows[0].smpp || !ready.rows[0].sdar || !ready.rows[0].model) throw Error('NATIVE_READ_MODEL_REQUIRED');
    await apply(c,'ugv_smpp','GOWM_API','business_api_v2.sql',await readFile(`${root}/overlays/business-api-v2.sql`,'utf8'));
}
async function apply(c: PoolClient, schema: string, family: string, file: string, sql: string) {
    if(family.startsWith('GOWM_')){const contract=JSON.parse(await readFile(`${root}/install-manifest.json`,'utf8'));const item=contract.overlays.find((e:{schema:string;family:string;file:string})=>e.schema===schema&&e.family===family&&e.file===file);if(!item||item.sha256!==checksum(sql))throw Error('OVERLAY_MANIFEST_DRIFT: '+file);}
    const old = await c.query(`SELECT checksum FROM ${schema}.gowm_install_history WHERE family=$1 AND file=$2`, [family, file]);
    if (old.rowCount) {
        if (old.rows[0].checksum !== checksum(sql))
            throw Error(`MIGRATION_CHECKSUM_DRIFT: ${family}/${file}`);
        return;
    }
    await c.query('BEGIN');
    try {
        await c.query(`SET LOCAL search_path TO ${schema},public,pg_catalog`);
        await c.query(sql);
        await c.query(`INSERT INTO ${schema}.gowm_install_history(family,file,checksum) VALUES($1,$2,$3)`, [family, file, checksum(sql)]);
        await c.query('COMMIT');
    }
    catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`${schema}/${family}/${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
}
export async function verify(c: PoolClient,domain:'all'|'smpp'|'sdar'='all') {
    const selectedSchemas=domain==='all'?['gowm_device','gowm_task','gowm_execution','ugv_smpp','ugv_sdar','gowm_business_v1']:[domain==='smpp'?'ugv_smpp':'ugv_sdar'];
    const entries = (await manifest()).filter(e=>domain==='all'||selectedSchemas.includes(e.schema));
    const missing: string[] = [];
    for (const coreFile of ['078_device_shared_business_storage.sql','079_device_context_reader.sql','087_business_runtime_authority.sql']) {
        const row = await c.query('SELECT checksum FROM public.schema_migration WHERE version=$1', [coreFile]);
        if (row.rows[0]?.checksum !== checksum(await readFile(`database/migrations/${coreFile}`, 'utf8')))
            missing.push(coreFile);
    }
    for (const e of entries) {
        const r = await c.query(`SELECT checksum FROM ${e.schema}.gowm_install_history WHERE family=$1 AND file=$2`, [e.family, e.file]);
        if (r.rows[0]?.checksum !== e.generatedSha256)
            missing.push(`${e.family}/${e.file}`);
    }
    const contract=JSON.parse(await readFile(`${root}/install-manifest.json`,'utf8'));
    const bothReady=(await c.query("SELECT to_regclass('ugv_smpp.gowm_install_history') IS NOT NULL AND to_regclass('ugv_sdar.gowm_install_history') IS NOT NULL AS ready")).rows[0].ready;
    const overlays=contract.overlays.filter((e:{schema:string;family:string})=>selectedSchemas.includes(e.schema)&&(bothReady||!['GOWM_API','GOWM_READ_MODEL'].includes(e.family)));
    for(const e of overlays){const row=await c.query(`SELECT checksum FROM ${e.schema}.gowm_install_history WHERE family=$1 AND file=$2`,[e.family,e.file]);if(row.rows[0]?.checksum!==e.sha256)missing.push(`${e.family}/${e.file}`);}
    for(const schema of ['ugv_smpp','ugv_sdar'].filter(s=>selectedSchemas.includes(s))){const count=(await c.query(`SELECT count(*)::int n FROM ${schema}.gowm_install_history`)).rows[0].n;const expectedCount=entries.filter(e=>e.schema===schema).length+overlays.filter((e:{schema:string})=>e.schema===schema).length;if(count!==expectedCount)missing.push(`unexpected migration history:${schema}`);}
    const inventory = JSON.parse(await readFile(`${root}/source-inventory.json`, 'utf8'));
    for (const t of inventory.tables.filter((t:{schema:string})=>selectedSchemas.includes(t.schema))) {
        const r = await c.query('SELECT to_regclass($1) name', [`${t.schema}.${t.table}`]);
        if (!r.rows[0].name)
            missing.push(`${t.schema}.${t.table}`);
    }
    const objects = await c.query("SELECT n.nspname,c.relkind,count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1) GROUP BY 1,2 ORDER BY 1,2", [['gowm_device', 'gowm_task', 'gowm_execution', 'ugv_smpp', 'ugv_sdar', 'gowm_business_v1']]);
    const expected = JSON.parse(await readFile(`${root}/expected-structure.json`, 'utf8'));
    if(bothReady) {
        // Explicit additive v2 trigger replacement; all other published structure remains exact.
        const trigger=expected.triggers.find((t:{schema:string;name:string;tgname:string})=>t.schema==='ugv_sdar'&&t.name==='remote_task_binding'&&t.tgname==='gowm_remote_canonical');
        if(!trigger)throw Error('EXPECTED_REMOTE_CANONICAL_TRIGGER_MISSING');
        trigger.definition='CREATE TRIGGER gowm_remote_canonical BEFORE INSERT OR UPDATE ON ugv_sdar.remote_task_binding FOR EACH ROW EXECUTE FUNCTION gowm_business_api.validate_remote_canonical_identity()';
        const functions=(await c.query(`SELECT p.proname,p.prosecdef,p.proconfig,r.rolname owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='gowm_business_api' ORDER BY p.proname`)).rows;
        if(functions.length!==7 || functions.some(p=>p.owner!=='gowm_business_api_owner'||JSON.stringify(p.proconfig)!==JSON.stringify(['search_path=pg_catalog'])||(!p.prosecdef&&p.proname!=='is_deployment_admin'))) missing.push('business-api:owner/search_path/security');
        if((await c.query("SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='gowm_business_api' AND a.grantee=0 AND a.privilege_type='EXECUTE') AS open")).rows[0].open)missing.push('business-api:public-execute');
    }
    const actual = await structure(c);
    // 092 adds new profile objects to the core-owned device schema. Keep the
    // released native structure exact and verify this additive set separately.
    const profileMigration='092_ingest_runtime_profiles.sql';
    const profileLedger=await c.query('SELECT checksum FROM public.schema_migration WHERE version=$1',[profileMigration]);
    const isProfileObject=(row:{schema:string;name:string})=>row.schema==='gowm_device'&&
        ['ingest_runtime_profile','ingest_profile_activation','protect_ingest_profile'].includes(row.name);
    if(domain==='all'&&profileLedger.rowCount){
        if(profileLedger.rows[0].checksum!==checksum(await readFile(`database/migrations/${profileMigration}`,'utf8')))
            missing.push(profileMigration);
        const profileExpected=JSON.parse(await readFile(`${root}/expected-ingest-profile-structure.json`,'utf8'));
        for(const key of Object.keys(actual) as (keyof typeof actual)[]){
            if(JSON.stringify(actual[key].filter(isProfileObject))!==JSON.stringify(profileExpected[key]))missing.push(`ingest-profile-structure:${key}`);
            actual[key]=actual[key].filter(row=>!isProfileObject(row));
        }
    }
    const clockMigration='093_calibrated_reset_watermarks.sql';
    const clockLedger=await c.query('SELECT checksum FROM public.schema_migration WHERE version=$1',[clockMigration]);
    if(domain==='all'&&clockLedger.rowCount){
        if(clockLedger.rows[0].checksum!==checksum(await readFile(`database/migrations/${clockMigration}`,'utf8')))
            missing.push(clockMigration);
        const isClockObject=(row:{schema:string;name:string})=>row.schema==='gowm_device'&&row.name==='clock_matches_profile';
        const clockExpected=JSON.parse(await readFile(`${root}/expected-reset-clock-structure.json`,'utf8'));
        for(const key of Object.keys(actual) as (keyof typeof actual)[]){
            if(JSON.stringify(actual[key].filter(isClockObject))!==JSON.stringify(clockExpected[key]))missing.push(`reset-clock-structure:${key}`);
            actual[key]=actual[key].filter(row=>!isClockObject(row));
        }
    }
    for (const key of Object.keys(actual) as (keyof typeof actual)[]) {
        if (JSON.stringify(actual[key].filter((row:{schema:string})=>selectedSchemas.includes(row.schema))) !== JSON.stringify(expected[key].filter((row:{schema:string})=>selectedSchemas.includes(row.schema))))
            missing.push(`structure:${key}`);
    }
    if (missing.length)
        throw Error(`VERIFY_FAILED: ${missing.join(',')}`);
    return { status: 'PASS',domain, objects: objects.rows.filter((row:{nspname:string})=>selectedSchemas.includes(row.nspname)) };
}
