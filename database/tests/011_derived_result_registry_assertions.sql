\set ON_ERROR_STOP on

BEGIN;

CREATE FUNCTION pg_temp.gowm_assertion_snapshot(p_query_id text)
RETURNS jsonb LANGUAGE sql AS $snapshot$
  WITH seed AS (
    SELECT jsonb_build_object(
      'querySnapshotId','snapshot_legacy_' || substr(encode(public.digest(p_query_id,'sha256'),'hex'),1,32),
      'mode','BEST_EFFORT','consistency','BEST_EFFORT',
      'capturedAt','2026-08-24T00:00:00.000Z','resources','[]'::jsonb,
      'manifestHash','sha256:' || repeat('0',64)
    ) AS value
  )
  SELECT jsonb_set(
    value,'{manifestHash}',
    to_jsonb(gowm_capability.canonical_legacy_query_snapshot_hash(value)),false
  ) FROM seed
$snapshot$;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
 ('result-registry-test','TEST','Derived result registry test'),
 ('result-registry-other','TEST','Derived result registry other scope');

WITH job AS (
  INSERT INTO gowm_capability.gateway_job(
    job_kind,principal_hash,data_scope_key,request_hash,state,started_at,completed_at
  ) VALUES (
    'WORLD_QUERY','sha256:' || repeat('1',64),'result-registry-test',
    'sha256:' || repeat('2',64),'SUCCEEDED',clock_timestamp(),clock_timestamp()
  ) RETURNING job_id
)
INSERT INTO gowm_capability.world_query_job(
  query_id,job_id,public_job_id,request_id,principal_ref,principal_hash,
  idempotency_key,request_hash,parameter_schema_hash,plan_hash,submission,
  authentication_method,authenticated_at,data_scope_claim,
  query_snapshot_manifest,effective_snapshot_manifest,principal_context
)
SELECT 'g05-query',job_id,'g05-job','g05-request','principal:g05',
       'sha256:' || repeat('1',64),'g05-idempotency','sha256:' || repeat('2',64),
       'sha256:' || repeat('3',64),'sha256:' || repeat('4',64),
       '{"requestId":"g05-request","idempotencyKey":"g05-idempotency","parameterSchemaHash":"sha256:3333333333333333333333333333333333333333333333333333333333333333","plan":{"queryId":"g05-query"}}',
       'TEST_ATTESTED',clock_timestamp(),'result-registry-test',
       pg_temp.gowm_assertion_snapshot('g05-query'),pg_temp.gowm_assertion_snapshot('g05-query'),
       '{"mode":"STATIC_SERVICE","principalRef":"principal:g05","authenticationMethod":"TEST_ATTESTED"}'::jsonb
FROM job;

UPDATE gowm_capability.world_query_job
SET result=jsonb_build_object(
  'queryPlanVersion','2.0','queryId','g05-query','jobId','g05-job','status','COMPLETED',
  'nodes',jsonb_build_array(jsonb_build_object(
    'nodeId','node1','result',jsonb_build_object(
      'dataSnapshot',jsonb_build_object('scopeDigest','sha256:' || repeat('5',64)),
      'computeSnapshot',jsonb_build_object('policy',jsonb_build_object('version','1'))
    )
  )),
  'outputs',jsonb_build_object('count',1200),'warnings',jsonb_build_array(),
  'startedAt','2026-08-24T00:00:00Z','finishedAt','2026-08-24T00:00:01Z',
  'outputHash','sha256:' || repeat('6',64)
)
WHERE query_id='g05-query';

-- Repeated terminal persistence keeps the first stable public identity.
UPDATE gowm_capability.world_query_job SET result=result WHERE query_id='g05-query';

INSERT INTO world_reference_identity(reference_key,entity_kind,internal_id,data_scope_key)
SELECT 'wrf_' || lpad(to_hex(candidate),32,'0'),'WORLD_OBJECT','g05-member-' || candidate,'result-registry-test'
FROM generate_series(10000,11199) candidate;
INSERT INTO world_reference_identity(reference_key,entity_kind,internal_id,data_scope_key)
VALUES ('wrf_ffffffffffffffffffffffffffffffff','WORLD_OBJECT','g05-other','result-registry-other');

DO $semantics$
DECLARE
  result_key text;
  derived_first text;
  derived_second text;
  set_key text;
  set_count integer;
  validation_status text;
  retained_count integer;
BEGIN
  SELECT reference_key INTO STRICT result_key
  FROM world_query_result_reference WHERE query_id='g05-query';
  IF (SELECT count(*) FROM world_query_result_reference WHERE query_id='g05-query') <> 1 OR
     result_key !~ '^wrf_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'World Query did not receive one stable public result reference';
  END IF;

  derived_first := create_derived_reference(
    'result-registry-test','GEOMETRY','buffer','g05-query','node1',ARRAY[result_key],
    'sha256:' || repeat('7',64),'sha256:' || repeat('8',64),'buffer/1.0',
    '{"geometryType":"Polygon","crs":"EPSG:4326"}',NULL,
    clock_timestamp() + interval '1 hour',false
  );
  derived_second := create_derived_reference(
    'result-registry-test','GEOMETRY','buffer','g05-query','node1',ARRAY[result_key],
    'sha256:' || repeat('7',64),'sha256:' || repeat('8',64),'buffer/1.0',
    '{"geometryType":"Polygon","crs":"EPSG:4326"}',NULL,
    clock_timestamp() + interval '2 hours',false
  );
  IF derived_first <> derived_second OR (SELECT count(*) FROM derived_reference WHERE reference_key=derived_first) <> 1 THEN
    RAISE EXCEPTION 'DerivedReference creation is not idempotent';
  END IF;

  SELECT create_reference_set(
    'result-registry-test','ROAD_CANDIDATES','g05-query',
    ARRAY(SELECT 'wrf_' || lpad(to_hex(candidate),32,'0') FROM generate_series(10000,11199) candidate),
    clock_timestamp() + interval '1 hour'
  ) INTO set_key;
  SELECT member_count INTO STRICT set_count FROM reference_set WHERE reference_key=set_key;
  IF set_count <> 1200 OR (SELECT count(*) FROM reference_set_member member JOIN reference_set set_record USING(reference_set_id) WHERE set_record.reference_key=set_key) <> 1200 THEN
    RAISE EXCEPTION 'ReferenceSet member count is incorrect';
  END IF;

  PERFORM gowm_result_v1.set_data_scope('result-registry-test');
  SELECT status INTO STRICT validation_status
  FROM gowm_result_v1.validate(set_key,'1',clock_timestamp() + interval '2 hours');
  IF validation_status <> 'EXPIRED' THEN
    RAISE EXCEPTION 'expired ReferenceSet validated as %',validation_status;
  END IF;
  SELECT count(*) INTO retained_count FROM reference_set WHERE reference_key=set_key;
  IF retained_count <> 1 THEN RAISE EXCEPTION 'expiry deleted audit lineage'; END IF;

  PERFORM gowm_result_v1.set_data_scope('result-registry-other');
  IF EXISTS (SELECT 1 FROM gowm_result_v1.query_result) OR
     EXISTS (SELECT 1 FROM gowm_result_v1.reference_set) THEN
    RAISE EXCEPTION 'result registry leaked across scope';
  END IF;

  BEGIN
    PERFORM create_reference_set(
      'result-registry-test','INVALID_CROSS_SCOPE','g05-query',
      ARRAY['wrf_ffffffffffffffffffffffffffffffff'],clock_timestamp() + interval '1 hour'
    );
    RAISE EXCEPTION 'cross-scope member was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    UPDATE reference_set SET semantic_type='mutated' WHERE reference_key=set_key;
    RAISE EXCEPTION 'ReferenceSet was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$semantics$;

ROLLBACK;

SELECT 'DERIVED_RESULT_REGISTRY_ASSERTIONS_PASS' AS result;
