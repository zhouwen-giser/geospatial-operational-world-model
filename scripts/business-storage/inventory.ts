import pg from 'pg';
import { writeFile, readFile } from 'node:fs/promises';
import { structure } from './structure.js';
const pool = new pg.Pool({ connectionString: process.env.GOWM_BUSINESS_TEST_DATABASE_URL });
try {
    const client = await pool.connect();
    try {
        await writeFile('database/shared-business-storage/expected-structure.json', JSON.stringify(await structure(client), null, 2) + '\n');
    }
    finally {
        client.release();
    }
    const tables = (await pool.query(`SELECT n.nspname schema,c.relname name,c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('ugv_smpp','ugv_sdar') AND c.relkind IN ('r','p') ORDER BY 1,2`)).rows;
    const columns = (await pool.query(`SELECT table_schema,table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema IN ('ugv_smpp','ugv_sdar','gowm_device','gowm_task','gowm_execution') ORDER BY table_schema,table_name,ordinal_position`)).rows;
    const keys = (await pool.query(`SELECT c.conrelid table_oid,c.confrelid parent_oid,c.conname name,c.contype kind,pg_get_constraintdef(c.oid) definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN ('ugv_smpp','ugv_sdar') ORDER BY c.conname`)).rows;
    const direct = new Set(tables.filter(t => columns.some(c => c.table_schema === t.schema && c.table_name === t.name && c.column_name === 'device_id')).map(t => t.oid));
    const reachable = new Map<number, number[]>();
    for (const oid of direct)
        reachable.set(oid, []);
    for (let i = 0; i < tables.length; i++) {
        let changed = false;
        for (const t of tables) {
            if (reachable.has(t.oid))
                continue;
            const fk = keys.find(k => k.table_oid === t.oid && k.kind === 'f' && reachable.has(k.parent_oid));
            if (fk) {
                reachable.set(t.oid, [fk.parent_oid, ...reachable.get(fk.parent_oid)!]);
                changed = true;
            }
        }
        if (!changed)
            break;
    }
    const sources = JSON.parse(await readFile('database/shared-business-storage/source-inventory.json', 'utf8')).tables;
    const result = tables.map(t => { const cols = columns.filter(c => c.table_schema === t.schema && c.table_name === t.name); const own = direct.has(t.oid), path = reachable.get(t.oid); const classification = own ? (/snapshot|event|source_state/.test(t.name) ? 'DEVICE_CHANNEL' : /lease/.test(t.name) ? 'WORKER_EPHEMERAL' : /task$|execution$|admission_intent/.test(t.name) ? 'DEVICE_ROOT' : 'DEVICE_CHILD') : path ? 'DEVICE_CHILD' : 'BUSINESS_GLOBAL'; return { schema: t.schema, table: t.name, classification, ownership: own ? 'explicit device_id; no default' : path ? 'native FK ancestry: ' + path.map(oid => tables.find(x => x.oid === oid)?.name).join(' -> ') : 'shared domain configuration, catalog, knowledge, ledger or context; not implicitly assigned to a device', source: sources.find((x: {
            schema: string;
            table: string;
        }) => x.schema === t.schema && x.table === t.name)?.source ?? 'GOWM installation metadata', columns: cols, keys: keys.filter(k => k.table_oid === t.oid).map(({ table_oid, parent_oid, ...k }) => k), consumerAction: own ? 'write explicit device_id; scope reads/claims/recovery; replace unique conflict targets with these keys' : path ? 'join native parent chain for device routing; preserve parent identity and retention' : 'retain shared namespace; global UUIDs and template versions stay unchanged' }; });
    await writeFile('database/shared-business-storage/device-scope-key-inventory.json', JSON.stringify({ tables: result }, null, 2) + '\n');
    await writeFile('docs/shared-business-storage-handoff/device-scope-key-inventory.json', JSON.stringify({ tables: result }, null, 2) + '\n');
    let dict = '# 公共九表数据字典\n\n所有身份列均无全库默认设备。详见正式 078 迁移中的 CHECK/UNIQUE/FK 和原生 overlay。\n';
    for (const schema of ['gowm_device', 'gowm_task', 'gowm_execution'])
        for (const table of new Set(columns.filter(c => c.table_schema === schema).map(c => c.table_name))) {
            dict += `\n## ${schema}.${table}\n\n|字段|类型|可空|默认值|\n|---|---|---|---|\n`;
            for (const c of columns.filter(c => c.table_schema === schema && c.table_name === table))
                dict += `|${c.column_name}|${c.data_type}|${c.is_nullable}|${c.column_default ?? ''}|\n`;
        }
    await writeFile('docs/shared-business-storage-handoff/data-dictionary.md', dict);
    console.log(JSON.stringify({ tables: result.length, classifications: Object.fromEntries([...new Set(result.map(t => t.classification))].map(k => [k, result.filter(t => t.classification === k).length])) }));
}
finally {
    await pool.end();
}
