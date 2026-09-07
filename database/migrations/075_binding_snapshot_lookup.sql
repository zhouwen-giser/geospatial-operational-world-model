BEGIN;
-- The migration runner performs the online CREATE INDEX CONCURRENTLY step
-- before this transaction. Raw fresh-schema replay may build an empty index.
DO $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
   JOIN pg_am am ON am.oid=c.relam WHERE i.indrelid='public.entity_binding'::regclass
   AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname='btree'
   AND ARRAY(SELECT pg_get_indexdef(i.indexrelid,n,true)||CASE i.indoption[n-1]
     WHEN 0 THEN '' WHEN 3 THEN ' DESC' ELSE '#OPTIONS='||i.indoption[n-1]::text END
     FROM generate_series(1,i.indnkeyatts) n)
     =ARRAY['data_scope_key','source_key','source_local_target_id','tracker_session_key','created_at DESC','binding_id DESC']) THEN
   IF EXISTS(SELECT 1 FROM public.entity_binding LIMIT 1) THEN
     RAISE EXCEPTION 'Use scripts/migrate.ts for the online binding index upgrade';
   END IF;
   CREATE INDEX gowm_binding_snapshot_lookup ON public.entity_binding(data_scope_key,source_key,
     source_local_target_id,tracker_session_key,created_at DESC,binding_id DESC);
 END IF;
END $fn$;
COMMIT;
