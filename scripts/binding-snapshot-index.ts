import type pg from "pg";
export const bindingIndexColumns = ["data_scope_key","source_key","source_local_target_id","tracker_session_key","created_at DESC","binding_id DESC"];
/** Online upgrade step; callers must not wrap this in a transaction. */
export async function ensureBindingSnapshotIndex(pool:pg.Pool):Promise<void> {
  const indexes=await pool.query<{name:string;valid:boolean;columns:string[];plain:boolean}>(`
    SELECT c.relname name,i.indisvalid valid,
      ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true)||CASE i.indoption[n-1]
        WHEN 0 THEN '' WHEN 3 THEN ' DESC' ELSE '#OPTIONS='||i.indoption[n-1]::text END
        FROM generate_series(1,i.indnkeyatts) n) columns,
      i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree' AS plain
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
    WHERE i.indrelid='public.entity_binding'::regclass`);
  const equivalent=(x:typeof indexes.rows[number])=>x.plain&&JSON.stringify(x.columns)===JSON.stringify(bindingIndexColumns);
  if(indexes.rows.some(x=>x.valid&&equivalent(x)))return;
  const existing=indexes.rows.find(x=>x.name==="gowm_binding_snapshot_lookup");
  if(existing) {
    if(!equivalent(existing)||existing.valid)throw Error("Binding index name collision: manual review required");
    await pool.query("DROP INDEX CONCURRENTLY public.gowm_binding_snapshot_lookup");
  }
  await pool.query("CREATE INDEX CONCURRENTLY gowm_binding_snapshot_lookup ON public.entity_binding(data_scope_key,source_key,source_local_target_id,tracker_session_key,created_at DESC,binding_id DESC)");
}
