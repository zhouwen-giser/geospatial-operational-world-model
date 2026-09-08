import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parse, deparse } from 'pgsql-parser';
import { createHash } from 'node:crypto';
const root = 'database/shared-business-storage';
async function put(path, s) { if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== s)
        throw Error('GENERATED_DRIFT ' + path);
}
else
    await writeFile(path, s); }
const sources = JSON.parse(await readFile(`${root}/sources.json`, 'utf8'));
const hash = s => createHash('sha256').update(s).digest('hex');
const objects = new Set();
const parsed = [];
function walk(x, fn) { if (!x || typeof x !== 'object')
    return; fn(x); for (const v of Object.values(x))
    if (typeof v === 'object')
        walk(v, fn); }
for (const e of sources.entries) {
    const sql = await readFile(`${root}/${e.path}`, 'utf8');
    if (hash(sql) !== e.sha256)
        throw Error(`source drift ${e.file}`);
    const ast = await parse(sql);
    parsed.push([e, ast]);
    walk(ast, n => { if (n.CreateStmt)
        objects.add(n.CreateStmt.relation.relname); if (n.CreateSeqStmt)
        objects.add(n.CreateSeqStmt.sequence.relname); if (n.DefElem?.defname === 'sequence_name')
        objects.add(n.DefElem.arg.List.items.at(-1).String.sval); if (n.CreateFunctionStmt) {
        const a = n.CreateFunctionStmt.funcname;
        objects.add(a.at(-1).String.sval);
    } });
}
const manifest = [];
const inventory = [];
const dropped = [];
for (const [e, ast] of parsed) {
    const transforms = [];
    ast.stmts = ast.stmts.filter(s => { const n = s.stmt; if (n.TransactionStmt) {
        transforms.push('transaction boundary owned by installer');
        return false;
    } if (n.CreateExtensionStmt || n.CommentStmt?.objtype === 'OBJECT_EXTENSION') {
        transforms.push('extension preflight owned by installer; preserve existing extension namespace');
        return false;
    } if (n.VariableSetStmt) {
        transforms.push(`remove dump/session SET ${n.VariableSetStmt.name}; installer uses SET LOCAL`);
        return false;
    } if (n.SelectStmt?.targetList?.some(t => t.ResTarget?.val?.FuncCall?.funcname?.some(p => p.String?.sval === 'set_config'))) {
        transforms.push('remove dump search_path reset');
        return false;
    } return true; });
    walk(ast, n => {
        if (n.DropStmt?.removeType === 'OBJECT_TABLE')
            for (const o of n.DropStmt.objects) {
                const names = o.List?.items?.map(i => i.String.sval);
                if (names)
                    dropped.push({ schema: e.schema, table: names.at(-1), removedBy: e.sourcePath });
            }
        if (n.relname) {
            const r = n;
            if (!r.schemaname || r.schemaname === 'public') {
                if (objects.has(r.relname))
                    r.schemaname = e.schema;
            }
        }
        for (const k of ['funcname', 'names', 'objname', 'object', 'items']) {
            const a = n[k];
            if (Array.isArray(a) && a[0]?.String?.sval === 'public' && objects.has(a[1]?.String?.sval)) {
                a[0].String.sval = e.schema;
            }
        }
        // regclass defaults are SQL string literals, not RangeVar nodes.
        if (n.String?.sval?.startsWith('public.') && objects.has(n.String.sval.slice(7)))
            n.String.sval = e.schema + n.String.sval.slice(6);
        if (n.CreateFunctionStmt) {
            const f = n.CreateFunctionStmt;
            if (f.funcname.length === 1)
                f.funcname.unshift({ String: { sval: e.schema } });
            f.options.push({ DefElem: { defname: 'set', arg: { VariableSetStmt: { kind: 'VAR_SET_VALUE', name: 'search_path', args: [{ A_Const: { sval: { sval: e.schema } } }, { A_Const: { sval: { sval: 'public' } } }, { A_Const: { sval: { sval: 'pg_catalog' } } }], is_local: false } }, defaction: 'DEFELEM_UNSPEC', location: -1 } });
            transforms.push('function search_path pinned for unqualified PL/pgSQL references');
        }
        if (n.CreateStmt)
            inventory.push({ schema: e.schema, table: n.CreateStmt.relation.relname, source: e.sourcePath, family: e.family, columns: (n.CreateStmt.tableElts ?? []).filter(a => a.ColumnDef).map(a => a.ColumnDef.colname) });
    });
    const out = await deparse(ast);
    await mkdir(`${root}/generated/${e.schema}/${e.family}`, { recursive: true });
    const path = `generated/${e.schema}/${e.family}/${e.file}`;
    await put(`${root}/${path}`, out + '\n');
    manifest.push({ ...e, generatedPath: path, generatedSha256: hash(out + '\n'), transforms: [...new Set(transforms), 'AST application object namespace mapping; extension objects remain public'] });
}
const overlays=[];
for(const schema of ['ugv_smpp','ugv_sdar']){
 const short=schema==='ugv_smpp'?'smpp':'sdar';
 const steps=[['device_scope_v1.sql',schema+'.sql'],['scope_hardening_v1.sql',short+'-hardening.sql'],['additional_scope_v1.sql',short+'-additional.sql']];
 if(schema==='ugv_sdar')steps.push(['derived_ownership_v1.sql','sdar-derived-ownership.sql']);
 for(const [file,path]of steps)overlays.push({schema,family:'GOWM_OVERLAY',file,path:'overlays/'+path,sha256:hash(await readFile(`${root}/overlays/${path}`,'utf8'))});
}
overlays.push({schema:'ugv_smpp',family:'GOWM_READ_MODEL',file:'read_model_v1.sql',path:'overlays/read-model.sql',sha256:hash(await readFile(`${root}/overlays/read-model.sql`,'utf8'))});
const core={file:'078_device_shared_business_storage.sql',sha256:hash(await readFile('database/migrations/078_device_shared_business_storage.sql','utf8'))};
await put(`${root}/install-manifest.json`, JSON.stringify({ version: 1,core, entries: manifest,overlays }, null, 2) + '\n');
await put(`${root}/source-inventory.json`, JSON.stringify({ tables: inventory.filter(t => !dropped.some(d => d.schema === t.schema && d.table === t.table)), historicalDroppedTables: dropped }, null, 2) + '\n');
await put(`${root}/transforms/namespace-transform-map.json`, JSON.stringify({ applicationObjects: [...objects].sort(), entries: manifest.map(({ file, family, transforms }) => ({ file, family, transforms })) }, null, 2) + '\n');
