\set ON_ERROR_STOP on

BEGIN;

CREATE FUNCTION pg_temp.gowm_assertion_snapshot(p_query_id text)
RETURNS jsonb LANGUAGE sql AS $snapshot$
  SELECT jsonb_build_object(
    'querySnapshotId','snapshot_' || substr(encode(public.digest(p_query_id,'sha256'),'hex'),1,32),
    'mode','BEST_EFFORT','consistency','BEST_EFFORT',
    'capturedAt','2026-08-24T00:00:00.000Z','resources','[]'::jsonb,
    'manifestHash','sha256:' || encode(public.digest(p_query_id || ':snapshot','sha256'),'hex')
  )
$snapshot$;

CREATE FUNCTION pg_temp.gowm_insert_scope_probe(p_query_id text,p_data_scope_claim text)
RETURNS void LANGUAGE plpgsql AS $probe$
DECLARE
  inserted_job_id uuid;
  principal_digest text := 'sha256:' || encode(digest(convert_to(p_query_id || ':principal','UTF8'),'sha256'),'hex');
  request_digest text := 'sha256:' || encode(digest(convert_to(p_query_id || ':request','UTF8'),'sha256'),'hex');
BEGIN
  INSERT INTO gowm_capability.gateway_job(
    job_kind,principal_hash,data_scope_key,request_hash,state,started_at
  ) VALUES (
    'WORLD_QUERY',principal_digest,p_data_scope_claim,request_digest,'RUNNING',clock_timestamp()
  ) RETURNING job_id INTO inserted_job_id;

  INSERT INTO gowm_capability.world_query_job(
    query_id,job_id,public_job_id,request_id,principal_ref,principal_hash,
    idempotency_key,request_hash,parameter_schema_hash,plan_hash,submission,
    authentication_method,authenticated_at,data_scope_claim,
    query_snapshot_manifest,principal_context
  ) VALUES (
    p_query_id,inserted_job_id,p_query_id || '-job',p_query_id || '-request',
    'principal:' || p_query_id,principal_digest,p_query_id || '-idempotency',request_digest,
    'sha256:' || repeat('3',64),'sha256:' || repeat('4',64),
    jsonb_build_object(
      'requestId',p_query_id || '-request',
      'idempotencyKey',p_query_id || '-idempotency',
      'parameterSchemaHash','sha256:' || repeat('3',64),
      'plan',jsonb_build_object('queryId',p_query_id)
    ),
    'TEST_ATTESTED',clock_timestamp(),p_data_scope_claim,
    pg_temp.gowm_assertion_snapshot(p_query_id),
    jsonb_build_object(
      'mode','STATIC_SERVICE','principalRef','principal:' || p_query_id,
      'authenticationMethod','TEST_ATTESTED','dataScopeClaim',p_data_scope_claim
    )
  );
END
$probe$;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
 ('result-registry-test','TEST','Derived result registry test'),
 ('result-registry-other','TEST','Derived result registry other scope'),
 ('result-registry-ambiguous','TEST','Derived result registry ambiguity scope');

INSERT INTO world_reference_external_identifier(
  reference_key,data_scope_key,authority,identifier_kind,identifier_value,
  normalized_value,confidence,evidence
)
SELECT identity.reference_key,identity.data_scope_key,'GOWM_GATEWAY','DATA_SCOPE_CLAIM',
       mapping.claim,normalize_reference_text(mapping.claim),1,
       jsonb_build_array(jsonb_build_object('kind','DATABASE_ASSERTION'))
FROM (VALUES
  ('gdps-result-registry-claim','result-registry-test'),
  ('ambiguous-result-registry-claim','result-registry-test'),
  ('ambiguous-result-registry-claim','result-registry-ambiguous')
) mapping(claim,scope_key)
JOIN world_reference_identity identity
  ON identity.entity_kind='DATA_SCOPE'
 AND identity.internal_id=mapping.scope_key
 AND identity.data_scope_key=mapping.scope_key;

WITH job AS (
  INSERT INTO gowm_capability.gateway_job(
    job_kind,principal_hash,data_scope_key,request_hash,state,started_at,completed_at
  ) VALUES (
    'WORLD_QUERY','sha256:' || repeat('1',64),'gdps-result-registry-claim',
    'sha256:' || repeat('2',64),'SUCCEEDED',clock_timestamp(),clock_timestamp()
  ) RETURNING job_id
)
INSERT INTO gowm_capability.world_query_job(
  query_id,job_id,public_job_id,request_id,principal_ref,principal_hash,
  idempotency_key,request_hash,parameter_schema_hash,plan_hash,submission,
  authentication_method,authenticated_at,data_scope_claim,
  query_snapshot_manifest,principal_context
)
SELECT 'g05-query',job_id,'g05-job','g05-request','principal:g05',
       'sha256:' || repeat('1',64),'g05-idempotency','sha256:' || repeat('2',64),
       'sha256:' || repeat('3',64),'sha256:' || repeat('4',64),
       '{"requestId":"g05-request","idempotencyKey":"g05-idempotency","parameterSchemaHash":"sha256:3333333333333333333333333333333333333333333333333333333333333333","plan":{"queryId":"g05-query"}}',
       'TEST_ATTESTED',clock_timestamp(),'gdps-result-registry-claim',
       jsonb_build_object(
         'querySnapshotId','snapshot-g05','mode','PINNED','consistency','SNAPSHOT',
         'capturedAt','2026-08-24T00:00:00.000Z','resources','[]'::jsonb,
         'manifestHash','sha256:' || repeat('5',64)
       ),
       jsonb_build_object(
         'mode','STATIC_SERVICE','principalRef','principal:g05',
         'authenticationMethod','TEST_ATTESTED','dataScopeClaim','gdps-result-registry-claim'
       )
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

DO $terminal_rewrite$
DECLARE
  original_result jsonb;
  failure_constraint text;
  rewritten_result jsonb;
BEGIN
  SELECT result INTO STRICT original_result
  FROM gowm_capability.world_query_job WHERE query_id='g05-query';
  FOR rewritten_result IN
    SELECT candidate FROM (VALUES
      (jsonb_set(original_result,'{status}','"PARTIAL"'::jsonb)),
      (jsonb_set(original_result,'{outputHash}',to_jsonb('sha256:' || repeat('9',64))))
    ) mutation(candidate)
  LOOP
    BEGIN
      UPDATE gowm_capability.world_query_job SET result=rewritten_result WHERE query_id='g05-query';
      RAISE EXCEPTION 'terminal world query result was rewritten';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      GET STACKED DIAGNOSTICS failure_constraint = CONSTRAINT_NAME;
      IF failure_constraint IS DISTINCT FROM 'world_query_result_scope_claim_resolution' THEN
        RAISE EXCEPTION 'terminal rewrite used the wrong failure authority';
      END IF;
    END;
  END LOOP;
  IF (SELECT result FROM gowm_capability.world_query_job WHERE query_id='g05-query')
       IS DISTINCT FROM original_result OR
     (SELECT result_record FROM world_query_result_reference WHERE query_id='g05-query')
       IS DISTINCT FROM original_result THEN
    RAISE EXCEPTION 'terminal rewrite rejection changed persisted state';
  END IF;
END
$terminal_rewrite$;

DO $terminal_regression$
DECLARE
  failure_constraint text;
BEGIN
  BEGIN
    UPDATE gowm_capability.world_query_job SET result=NULL WHERE query_id='g05-query';
    RAISE EXCEPTION 'terminal world query result regressed to non-terminal';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    GET STACKED DIAGNOSTICS failure_constraint = CONSTRAINT_NAME;
    IF failure_constraint IS DISTINCT FROM 'world_query_result_scope_claim_resolution' THEN
      RAISE EXCEPTION 'terminal regression used the wrong failure authority';
    END IF;
  END;
  IF (SELECT result->>'status' FROM gowm_capability.world_query_job WHERE query_id='g05-query')
       IS DISTINCT FROM 'COMPLETED' OR
     (SELECT resolved_data_scope_key FROM gowm_capability.world_query_job WHERE query_id='g05-query')
       IS DISTINCT FROM 'result-registry-test' OR
     (SELECT count(*) FROM world_query_result_reference WHERE query_id='g05-query') <> 1 THEN
    RAISE EXCEPTION 'terminal regression rejection changed persisted state';
  END IF;
END
$terminal_regression$;

SELECT pg_temp.gowm_insert_scope_probe('g05-unmapped','foreign-result-registry-claim');
SELECT pg_temp.gowm_insert_scope_probe('g05-ambiguous','ambiguous-result-registry-claim');
SELECT pg_temp.gowm_insert_scope_probe('g05-case-variant','GDPS-result-registry-claim');
SELECT pg_temp.gowm_insert_scope_probe('g05-gateway-mismatch','gdps-result-registry-claim');
UPDATE gowm_capability.gateway_job gateway
SET data_scope_key='foreign-gateway-copy'
FROM gowm_capability.world_query_job query
WHERE query.query_id='g05-gateway-mismatch' AND query.job_id=gateway.job_id;
SELECT pg_temp.gowm_insert_scope_probe('g05-principal-mismatch','gdps-result-registry-claim');
UPDATE gowm_capability.world_query_job
SET principal_context=jsonb_set(principal_context,'{dataScopeClaim}','"foreign-principal-copy"'::jsonb)
WHERE query_id='g05-principal-mismatch';

DO $scope_failure$
DECLARE
  probe record;
  failure_constraint text;
  terminal_result jsonb := jsonb_build_object(
    'queryPlanVersion','2.0','jobId','scope-failure-job','status','COMPLETED',
    'nodes',jsonb_build_array(jsonb_build_object(
      'nodeId','node1','status','COMPLETED','result',jsonb_build_object(
        'dataSnapshot',jsonb_build_object('scopeDigest','sha256:' || repeat('a',64)),
        'computeSnapshot',jsonb_build_object('policy',jsonb_build_object('version','1'))
      )
    )),
    'outputs',jsonb_build_object(),'warnings',jsonb_build_array(),
    'startedAt','2026-08-24T00:00:00Z','finishedAt','2026-08-24T00:00:01Z',
    'outputHash','sha256:' || repeat('b',64)
  );
BEGIN
  FOR probe IN
    SELECT * FROM (VALUES
      ('g05-unmapped','unmapped'),
      ('g05-ambiguous','ambiguous'),
      ('g05-case-variant','byte-variant'),
      ('g05-gateway-mismatch','gateway-copy-mismatch'),
      ('g05-principal-mismatch','principal-copy-mismatch')
    ) candidate(query_id,failure_kind)
  LOOP
    BEGIN
      UPDATE gowm_capability.world_query_job
      SET result=jsonb_set(terminal_result,'{queryId}',to_jsonb(probe.query_id),true)
      WHERE query_id=probe.query_id;
      RAISE EXCEPTION '% scope claim unexpectedly registered a result',probe.failure_kind;
    EXCEPTION WHEN SQLSTATE '42501' THEN
      GET STACKED DIAGNOSTICS failure_constraint = CONSTRAINT_NAME;
      IF failure_constraint IS DISTINCT FROM 'world_query_result_scope_claim_resolution' THEN
        RAISE EXCEPTION '% scope claim used the wrong failure authority',probe.failure_kind;
      END IF;
    END;

    IF EXISTS (
         SELECT 1 FROM gowm_capability.world_query_job
         WHERE query_id=probe.query_id
           AND (result IS NOT NULL OR resolved_data_scope_key IS NOT NULL)
       ) OR EXISTS (
         SELECT 1 FROM world_query_result_reference WHERE query_id=probe.query_id
       ) OR EXISTS (
         SELECT 1 FROM world_reference_identity
         WHERE entity_kind='QUERY_RESULT' AND internal_id=probe.query_id
       ) THEN
      RAISE EXCEPTION '% scope claim left partial result-registry state',probe.failure_kind;
    END IF;
  END LOOP;
END
$scope_failure$;

-- A pre-existing result identity is idempotent only when its immutable record
-- agrees with the terminal result, even when the internal scope is correct.
SELECT pg_temp.gowm_insert_scope_probe('g05-existing-mismatch','gdps-result-registry-claim');
SELECT register_result_registry_identity(
  'wrf_dddddddddddddddddddddddddddddddd','QUERY_RESULT','g05-existing-mismatch',
  'result-registry-test','Existing mismatched query result'
);
INSERT INTO world_query_result_reference(
  reference_key,query_id,data_scope_key,result_hash,status,data_snapshot_hash,
  compute_snapshot_hash,result_record,valid_until
) VALUES (
  'wrf_dddddddddddddddddddddddddddddddd','g05-existing-mismatch','result-registry-test',
  'sha256:' || repeat('c',64),'COMPLETED','sha256:' || repeat('d',64),
  'sha256:' || repeat('e',64),'{"status":"COMPLETED"}'::jsonb,
  clock_timestamp() + interval '1 hour'
);

DO $existing_mismatch$
DECLARE
  failure_constraint text;
BEGIN
  BEGIN
    UPDATE gowm_capability.world_query_job
    SET result=jsonb_build_object(
      'queryPlanVersion','2.0','queryId','g05-existing-mismatch',
      'jobId','g05-existing-mismatch-job','status','COMPLETED','nodes','[]'::jsonb,
      'outputs','{}'::jsonb,'warnings','[]'::jsonb,
      'startedAt','2026-08-24T00:00:00Z','finishedAt','2026-08-24T00:00:01Z',
      'outputHash','sha256:' || repeat('f',64)
    )
    WHERE query_id='g05-existing-mismatch';
    RAISE EXCEPTION 'existing mismatched result record was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    GET STACKED DIAGNOSTICS failure_constraint = CONSTRAINT_NAME;
    IF failure_constraint IS DISTINCT FROM 'world_query_result_scope_claim_resolution' THEN
      RAISE EXCEPTION 'existing mismatch used the wrong failure authority';
    END IF;
  END;
  IF EXISTS (
       SELECT 1 FROM gowm_capability.world_query_job
       WHERE query_id='g05-existing-mismatch'
         AND (result IS NOT NULL OR resolved_data_scope_key IS NOT NULL)
     ) OR
     (SELECT count(*) FROM world_query_result_reference WHERE query_id='g05-existing-mismatch') <> 1 OR
     (SELECT data_scope_key FROM world_query_result_reference WHERE query_id='g05-existing-mismatch')
       IS DISTINCT FROM 'result-registry-test' OR
     (SELECT result_record FROM world_query_result_reference WHERE query_id='g05-existing-mismatch')
       IS DISTINCT FROM '{"status":"COMPLETED"}'::jsonb THEN
    RAISE EXCEPTION 'existing mismatch rejection was not atomic';
  END IF;
END
$existing_mismatch$;

-- A source job may acquire lineage before it is terminal. Its terminal scope
-- must agree with every pre-existing derived/set row.
SELECT pg_temp.gowm_insert_scope_probe('g05-lineage-mismatch','gdps-result-registry-claim');
SELECT create_derived_reference(
  'result-registry-other','ANALYSIS_RESULT','mismatched-lineage','g05-lineage-mismatch',
  'node1',ARRAY[]::text[],'sha256:' || repeat('1',64),'sha256:' || repeat('2',64),
  'lineage/1',NULL,NULL,clock_timestamp() + interval '1 hour',false
);

DO $lineage_mismatch$
DECLARE
  failure_constraint text;
BEGIN
  BEGIN
    UPDATE gowm_capability.world_query_job
    SET result=jsonb_build_object(
      'queryPlanVersion','2.0','queryId','g05-lineage-mismatch',
      'jobId','g05-lineage-mismatch-job','status','COMPLETED','nodes','[]'::jsonb,
      'outputs','{}'::jsonb,'warnings','[]'::jsonb,
      'startedAt','2026-08-24T00:00:00Z','finishedAt','2026-08-24T00:00:01Z',
      'outputHash','sha256:' || repeat('3',64)
    )
    WHERE query_id='g05-lineage-mismatch';
    RAISE EXCEPTION 'mismatched pre-terminal lineage was accepted';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    GET STACKED DIAGNOSTICS failure_constraint = CONSTRAINT_NAME;
    IF failure_constraint IS DISTINCT FROM 'world_query_result_scope_claim_resolution' THEN
      RAISE EXCEPTION 'lineage mismatch used the wrong failure authority';
    END IF;
  END;
  IF EXISTS (
       SELECT 1 FROM gowm_capability.world_query_job
       WHERE query_id='g05-lineage-mismatch'
         AND (result IS NOT NULL OR resolved_data_scope_key IS NOT NULL)
     ) OR EXISTS (
       SELECT 1 FROM world_query_result_reference WHERE query_id='g05-lineage-mismatch'
     ) OR (SELECT count(*) FROM derived_reference WHERE source_query_id='g05-lineage-mismatch') <> 1 THEN
    RAISE EXCEPTION 'lineage mismatch rejection was not atomic';
  END IF;
END
$lineage_mismatch$;

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
  IF (SELECT resolved_data_scope_key FROM gowm_capability.world_query_job WHERE query_id='g05-query')
       IS DISTINCT FROM 'result-registry-test' OR
     (SELECT data_scope_key FROM world_query_result_reference WHERE query_id='g05-query')
       IS DISTINCT FROM 'result-registry-test' OR
     (SELECT count(*) FROM world_reference_identity
       WHERE reference_key=result_key AND entity_kind='QUERY_RESULT'
         AND internal_id='g05-query' AND data_scope_key='result-registry-test') <> 1 OR
     (SELECT count(*) FROM world_reference_descriptor_version
       WHERE reference_key=result_key AND data_scope_key='result-registry-test') <> 1 OR
     (SELECT count(*) FROM world_reference_name
       WHERE reference_key=result_key AND data_scope_key='result-registry-test') <> 1 OR
     (SELECT count(*) FROM reference_search_projection
       WHERE reference_key=result_key AND data_scope_key='result-registry-test') <> 1 OR
     EXISTS (
       SELECT 1 FROM world_reference_identity
       WHERE entity_kind='QUERY_RESULT' AND internal_id='g05-query'
         AND data_scope_key <> 'result-registry-test'
     ) OR EXISTS (
       SELECT 1 FROM world_reference_descriptor_version
       WHERE reference_key=result_key AND data_scope_key <> 'result-registry-test'
     ) OR EXISTS (
       SELECT 1 FROM world_reference_name
       WHERE reference_key=result_key AND data_scope_key <> 'result-registry-test'
     ) OR EXISTS (
       SELECT 1 FROM reference_search_projection
       WHERE reference_key=result_key AND data_scope_key <> 'result-registry-test'
     ) THEN
    RAISE EXCEPTION 'external data scope claim escaped into the internal result registry';
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
  IF NOT EXISTS (SELECT 1 FROM gowm_result_v1.query_result WHERE reference_key=result_key) THEN
    RAISE EXCEPTION 'mapped query result is not visible through the scoped result contract';
  END IF;
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
