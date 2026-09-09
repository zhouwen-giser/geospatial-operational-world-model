\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.data_scope(scope_key,operational_domain) VALUES ('task-index-test','TEST'),('task-index-other','TEST');
SELECT public.ingest_operational_task_event('task-index-test','test','index-event',1,'index-event','task-index-42',
 'CONTROL_REQUEST_OBSERVED','2026-09-09T01:00:00Z','2026-09-09T01:00:01Z',NULL,'[]','[]',NULL,
 '{"taskType":"INSPECTION"}',1,'[{"evidenceId":"index-evidence","authority":"test","evidenceType":"TEST","observedAt":"2026-09-09T01:00:00Z"}]','[]',300000,86400000);
SELECT public.project_operational_task('task-index-test','task-index-42');
SET LOCAL gowm.data_scope_key='task-index-test';
DO $test$
DECLARE ref text; before_version bigint; after_version bigint; r jsonb;
BEGIN
 SELECT reference_key,world_version INTO STRICT ref,before_version FROM public.operational_task_snapshot WHERE data_scope_key='task-index-test' AND operational_task_id='task-index-42';
 IF (SELECT count(*) FROM gowm_reference_v1.resolve('task-index-42',ARRAY['OPERATIONAL_TASK'],20,0.3,1000) WHERE reference_key=ref)<>1 THEN RAISE EXCEPTION 'task ID did not resolve'; END IF;
 IF (SELECT count(*) FROM gowm_reference_v1.resolve(ref,ARRAY['OPERATIONAL_TASK'],20,0.3,1000) WHERE reference_key=ref)<>1 THEN RAISE EXCEPTION 'wrf did not resolve'; END IF;
 IF EXISTS(SELECT 1 FROM gowm_reference_v1.resolve(ref,ARRAY['WORLD_OBJECT'],20,0.3,1000)) THEN RAISE EXCEPTION 'kind isolation failed'; END IF;
 r:=public.project_operational_task_reference('task-index-test','task-index-42');
 IF r<> '{"externalIdentifiersAdded":0,"searchRowsAdded":0}'::jsonb THEN RAISE EXCEPTION 'not idempotent'; END IF;
 DELETE FROM public.reference_search_projection WHERE reference_key=ref;
 after_version:=public.project_operational_task('task-index-test','task-index-42');
 IF after_version<>before_version OR NOT EXISTS(SELECT 1 FROM gowm_reference_v1.resolve(ref,ARRAY['OPERATIONAL_TASK'],20,0.3,1000)) THEN RAISE EXCEPTION 'unchanged snapshot did not restore index'; END IF;
 PERFORM public.rebuild_reference_search_projection('task-index-test');
 IF NOT EXISTS(SELECT 1 FROM gowm_reference_v1.resolve('task-index-42',ARRAY['OPERATIONAL_TASK'],20,0.3,1000)) THEN RAISE EXCEPTION 'full rebuild lost alias'; END IF;
 PERFORM set_config('gowm.data_scope_key','task-index-other',true);
 IF EXISTS(SELECT 1 FROM gowm_reference_v1.resolve(ref,ARRAY['OPERATIONAL_TASK'],20,0.3,1000)) THEN RAISE EXCEPTION 'scope isolation failed'; END IF;
 BEGIN
   PERFORM public.project_operational_task_reference('task-index-other','task-index-42');
   RAISE EXCEPTION 'wrong scope write allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $test$;
ROLLBACK;
