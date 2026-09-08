-- Fixed event-channel families: preserve native columns and rewrite all dependent
-- keys together. Names come exclusively from this installation-owned allowlist.
DO $$
DECLARE names text[]; t text; r record; saved jsonb='[]'; d text;
BEGIN
 SELECT array_agg(tablename ORDER BY tablename) INTO names FROM pg_tables WHERE schemaname='ugv_smpp' AND (tablename LIKE 'provider_business_event%' OR tablename LIKE 'adapter_business_event%');
 FOREACH t IN ARRAY names LOOP
  EXECUTE format('ALTER TABLE ugv_smpp.%I ADD device_id text NOT NULL REFERENCES gowm_device.device(device_id)',t);
 END LOOP;
 FOR r IN SELECT c.oid,c.conrelid::regclass::text tbl,c.conname,pg_get_constraintdef(c.oid) def,
  p.relname parent FROM pg_constraint c JOIN pg_class p ON p.oid=c.confrelid
  WHERE c.contype='f' AND c.confrelid IN(SELECT oid FROM pg_class WHERE relnamespace='ugv_smpp'::regnamespace AND relname=ANY(names)) LOOP
  saved=saved||jsonb_build_array(jsonb_build_object('tbl',r.tbl,'name',r.conname,'def',r.def));
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.tbl,r.conname);
 END LOOP;
 FOREACH t IN ARRAY names LOOP
  FOR r IN SELECT c.conname,pg_get_constraintdef(c.oid) def FROM pg_constraint c WHERE c.conrelid=format('ugv_smpp.%I',t)::regclass AND c.contype IN ('p','u') LOOP
   EXECUTE format('ALTER TABLE ugv_smpp.%I DROP CONSTRAINT %I',t,r.conname);
   d=regexp_replace(r.def,'\(', '(device_id, ');
   EXECUTE format('ALTER TABLE ugv_smpp.%I ADD CONSTRAINT %I %s',t,r.conname,d);
  END LOOP;
  FOR r IN SELECT i.indexrelid::regclass::text idx,pg_get_indexdef(i.indexrelid) def FROM pg_index i WHERE i.indrelid=format('ugv_smpp.%I',t)::regclass AND i.indisunique AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid) LOOP
   EXECUTE format('DROP INDEX %s',r.idx);
   EXECUTE regexp_replace(r.def,'USING btree \(', 'USING btree (device_id, ');
  END LOOP;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(saved) LOOP
  d=replace(r.value->>'def','FOREIGN KEY (','FOREIGN KEY (device_id, ');
  d=regexp_replace(d,'REFERENCES ([^ (]+) *\(', 'REFERENCES \1 (device_id, ');
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',r.value->>'tbl',r.value->>'name',d);
 END LOOP;
END $$;
-- All direct native children keep their global parent key and gain explicit
-- device+parent FKs if they can independently be polled, consumed or recovered.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['task_observation','task_input_request','task_command','task_input_response_inbox','smpp_reconciliation_audit','provider_task_resource_binding','provider_task_visibility_tombstone'] LOOP
  EXECUTE format('ALTER TABLE ugv_smpp.%I ADD device_id text NOT NULL, ADD FOREIGN KEY(device_id,task_id) REFERENCES ugv_smpp.provider_task(device_id,task_id)',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION gowm_device.reject_business_ownership_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)->'device_id') IS DISTINCT FROM (to_jsonb(OLD)->'device_id') OR
 (to_jsonb(NEW)->'gowm_binding_id') IS DISTINCT FROM (to_jsonb(OLD)->'gowm_binding_id') OR
 (to_jsonb(NEW)->'smpp_service_key') IS DISTINCT FROM (to_jsonb(OLD)->'smpp_service_key') OR
 (to_jsonb(NEW)->'sdar_service_key') IS DISTINCT FROM (to_jsonb(OLD)->'sdar_service_key')
 THEN RAISE EXCEPTION 'BUSINESS_OWNERSHIP_IMMUTABLE'; END IF; RETURN NEW;
END $$;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT table_schema,table_name FROM information_schema.columns WHERE table_schema IN ('ugv_smpp') AND column_name='device_id' LOOP
 EXECUTE format('CREATE TRIGGER gowm_ownership_immutable BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION gowm_device.reject_business_ownership_mutation()',r.table_schema,r.table_name);
 END LOOP;
END $$;
