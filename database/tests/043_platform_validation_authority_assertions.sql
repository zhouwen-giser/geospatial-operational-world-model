\set ON_ERROR_STOP on
BEGIN;

DO $privileges$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['reference_lifecycle','world_reference_version','result_reference','scope_reference'] LOOP
    IF NOT has_table_privilege('platform_validation_provider','gowm_platform_validation_v1.'||relation,'SELECT') THEN
      RAISE EXCEPTION 'missing validation read contract privilege: %',relation;
    END IF;
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['public.world_reference_identity','public.world_reference_retirement','public.world_reference_descriptor_version',
    'public.world_query_result_reference','public.derived_reference','public.reference_set',
    'gowm_capability.world_query_job','route_planner_runtime.route_query_result_reference','coverage_planner.coverage_result_set'] LOOP
    IF has_table_privilege('platform_validation_provider',relation,'SELECT') OR
       has_table_privilege('platform_validation_provider',relation,'UPDATE') THEN
      RAISE EXCEPTION 'validation provider can access private authority: %',relation;
    END IF;
  END LOOP;
END
$privileges$;

DO $world_platform_privileges$
BEGIN
  IF NOT has_table_privilege('coverage_planner_provider','gowm_network_v1.coverage_area_reference','SELECT') OR
     NOT has_table_privilege('platform_validation_provider','gowm_platform_validation_v1.coverage_area_currentness','SELECT') OR
     has_table_privilege('coverage_planner_provider','public.spatial_feature_version','SELECT') OR
     has_table_privilege('platform_validation_provider','coverage_planner.coverage_request','SELECT') THEN
    RAISE EXCEPTION 'area reference adapters violate the scoped view boundary';
  END IF;
  IF has_table_privilege('route_planner_provider','public.world_object','INSERT') OR
     has_table_privilege('route_planner_provider','route_planner_runtime.route_request','INSERT') OR
     NOT has_function_privilege('route_planner_provider','route_planner_runtime.submit_route_request(text,text,text,text,text,jsonb,text)','EXECUTE') THEN
    RAISE EXCEPTION 'route runtime writes are not restricted to controlled functions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='route_planner_provider' AND 'default_transaction_read_only=on'=ANY(rolconfig)) THEN
    RAISE EXCEPTION 'real Route LOGIN cannot execute its controlled runtime write contract';
  END IF;
END
$world_platform_privileges$;

INSERT INTO data_scope(scope_key,operational_domain) VALUES ('validation-authority-test','TEST'),('validation-authority-other','TEST');
DO $seed$
DECLARE tenant text; query_key text; job_key uuid; result_key text; derived_key text;
BEGIN
  FOREACH tenant IN ARRAY ARRAY['a','b'] LOOP
    query_key:='validation-query-'||tenant;
    INSERT INTO gowm_capability.gateway_job(job_kind,principal_hash,data_scope_key,request_hash,state,started_at,completed_at)
    VALUES ('WORLD_QUERY','sha256:'||repeat('1',64),'validation-authority-test','sha256:'||repeat('2',64),'SUCCEEDED',clock_timestamp(),clock_timestamp())
    RETURNING job_id INTO job_key;
    INSERT INTO gowm_capability.world_query_job(query_id,job_id,public_job_id,request_id,principal_ref,principal_hash,
      idempotency_key,request_hash,parameter_schema_hash,plan_hash,submission,authentication_method,authenticated_at,data_scope_claim,dataset_scope_claim,
      query_snapshot_manifest,principal_context)
    VALUES (query_key,job_key,'job-'||query_key,'request-'||query_key,'principal:validation','sha256:'||repeat('1',64),
      'idempotency-'||query_key,'sha256:'||repeat('2',64),'sha256:'||repeat('3',64),'sha256:'||repeat('4',64),
      jsonb_build_object('requestId','request-'||query_key,'idempotencyKey','idempotency-'||query_key,
        'parameterSchemaHash','sha256:'||repeat('3',64),'plan',jsonb_build_object('queryId',query_key)),
      'SQL_ASSERTION',clock_timestamp(),'validation-authority-test','tenant-'||tenant,
      jsonb_build_object(
        'querySnapshotId','snapshot-'||query_key,'mode','PINNED','consistency','SNAPSHOT',
        'capturedAt','2026-08-24T00:00:00.000Z','resources','[]'::jsonb,
        'manifestHash','sha256:'||repeat('5',64)
      ),
      jsonb_build_object(
        'mode','STATIC_SERVICE','principalRef','principal:validation',
        'authenticationMethod','SQL_ASSERTION','dataScopeClaim','validation-authority-test',
        'datasetScopeClaim','tenant-'||tenant
      ));
    UPDATE gowm_capability.world_query_job SET result='{"status":"COMPLETED","nodes":[]}' WHERE query_id=query_key;
    IF tenant='a' THEN
      SELECT reference_key INTO STRICT result_key FROM world_query_result_reference WHERE query_id=query_key;
      derived_key:=create_derived_reference('validation-authority-test','ANALYSIS_RESULT','test.analysis',query_key,'node',ARRAY[result_key],
        'sha256:'||repeat('5',64),'sha256:'||repeat('6',64),'1.0',NULL,NULL,clock_timestamp()+interval '1 hour',true);
      PERFORM create_reference_set('validation-authority-test','TEST',query_key,ARRAY[result_key],clock_timestamp()+interval '1 hour');
      INSERT INTO world_reference_retirement(reference_key,retired_at,reason,receipt_ref)
      VALUES (derived_key,clock_timestamp()-interval '1 second','Superseded analysis','urn:gowm:test:validation-retirement');
      INSERT INTO world_reference_descriptor_version(reference_key,data_scope_key,reference_type,display_name,stale,revalidation_required,content_hash)
      VALUES (result_key,'validation-authority-test','QUERY_RESULT','Authoritative stale result',true,true,'sha256:'||repeat('7',64));
    END IF;
  END LOOP;
END
$seed$;

DO $immutable$
BEGIN
  BEGIN
    UPDATE world_reference_retirement SET reason='Rewrite retirement';
    RAISE EXCEPTION 'retirement update was accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    DELETE FROM world_reference_retirement;
    RAISE EXCEPTION 'retirement deletion was accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$immutable$;

INSERT INTO world_object(id,object_type,data_scope_key) VALUES ('validation-world-a','TEST','validation-authority-test'),('validation-world-b','TEST','validation-authority-other');
INSERT INTO world_object_state(object_id,version) VALUES ('validation-world-a',7),('validation-world-b',99);
UPDATE world_object SET deleted_at=clock_timestamp()-interval '1 second' WHERE id='validation-world-a';

SET LOCAL ROLE platform_validation_provider;
SELECT gowm_platform_validation_v1.set_scope('validation-authority-test','tenant-a');
DO $scoped$
BEGIN
  IF (SELECT count(*) FROM gowm_platform_validation_v1.result_reference)<>3 THEN RAISE EXCEPTION 'dataset-scoped result projection is incomplete or leaked'; END IF;
  IF NOT EXISTS (SELECT 1 FROM gowm_platform_validation_v1.result_reference WHERE entity_kind='QUERY_RESULT' AND descriptor_stale) THEN RAISE EXCEPTION 'stale descriptor was lost'; END IF;
  IF NOT EXISTS (SELECT 1 FROM gowm_platform_validation_v1.result_reference WHERE entity_kind='DERIVED_REFERENCE' AND retired AND source_status='COMPLETED') THEN
    RAISE EXCEPTION 'retirement/source status separation failed: %',
      (SELECT jsonb_agg(jsonb_build_object('sourceStatus',source_status,'retired',retired))
       FROM gowm_platform_validation_v1.result_reference WHERE entity_kind='DERIVED_REFERENCE');
  END IF;
  IF (SELECT count(*) FROM gowm_platform_validation_v1.scope_reference)<>1 THEN RAISE EXCEPTION 'Foundation scope identity is unavailable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM gowm_platform_validation_v1.world_reference_version WHERE entity_kind='WORLD_OBJECT' AND retired) THEN RAISE EXCEPTION 'deleted world object was not retired'; END IF;
  IF (SELECT world_version FROM gowm_network_v1.source_world)<>'0' THEN RAISE EXCEPTION 'source-world projection leaked or retained deleted state'; END IF;
END
$scoped$;
SELECT gowm_platform_validation_v1.set_scope('validation-authority-test','tenant-b');
DO $other_dataset$ BEGIN
  IF (SELECT count(*) FROM gowm_platform_validation_v1.result_reference)<>1 THEN RAISE EXCEPTION 'sibling dataset leaked'; END IF;
END $other_dataset$;
SELECT gowm_platform_validation_v1.set_scope('validation-authority-test',NULL);
DO $missing_dataset$ BEGIN
  IF EXISTS (SELECT 1 FROM gowm_platform_validation_v1.result_reference) THEN RAISE EXCEPTION 'absent dataset scope bypassed isolation'; END IF;
END $missing_dataset$;
SELECT gowm_platform_validation_v1.set_scope('validation-authority-other','tenant-a');
DO $other_scope$ BEGIN
  IF EXISTS (SELECT 1 FROM gowm_platform_validation_v1.result_reference) THEN RAISE EXCEPTION 'foreign data scope leaked'; END IF;
  IF (SELECT world_version FROM gowm_network_v1.source_world)<>'99' THEN RAISE EXCEPTION 'source-world authority is not scope-specific'; END IF;
END $other_scope$;

RESET ROLE;
SET LOCAL ROLE gowm_evidence_service;
SELECT gowm_evidence_v1.set_data_scope('validation-authority-test');
SELECT set_config('gowm.dataset_scope_key','tenant-a',true);
DO $read_scope$ BEGIN
  IF (SELECT count(*) FROM gowm_result_v1.query_result)<>1
     OR (SELECT count(*) FROM gowm_result_v1.derived_reference)<>1
     OR (SELECT count(*) FROM gowm_result_v1.reference_set)<>1 THEN
    RAISE EXCEPTION 'result read did not enforce the same dataset scope as validation';
  END IF;
END $read_scope$;
SELECT set_config('gowm.dataset_scope_key','',true);
DO $read_missing_scope$ BEGIN
  IF EXISTS (SELECT 1 FROM gowm_result_v1.query_result)
     OR EXISTS (SELECT 1 FROM gowm_result_v1.derived_reference)
     OR EXISTS (SELECT 1 FROM gowm_result_v1.reference_set)
     OR EXISTS (SELECT 1 FROM gowm_result_v1.reference_set_member) THEN
    RAISE EXCEPTION 'result read bypassed a missing dataset claim';
  END IF;
END $read_missing_scope$;

ROLLBACK;
SELECT 'PLATFORM_VALIDATION_AUTHORITY_ASSERTIONS_PASS' AS result;
