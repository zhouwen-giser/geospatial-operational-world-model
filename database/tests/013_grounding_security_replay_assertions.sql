\set ON_ERROR_STOP on

BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
  ('grounding-replay-a','TEST','Grounding replay A'),
  ('grounding-replay-b','TEST','Grounding replay B');
INSERT INTO world_object(id,object_type,properties,data_scope_key)
VALUES ('grounding-replay-object','ROAD','{"name":"Replay Road"}','grounding-replay-a');
INSERT INTO world_reference_descriptor_version(
  reference_key,data_scope_key,reference_type,display_name,content_hash
)
SELECT reference_key,'grounding-replay-a','WORLD_OBJECT','Replay Road','sha256:' || repeat('a',64)
FROM world_reference_identity
WHERE entity_kind='WORLD_OBJECT' AND internal_id='grounding-replay-object';
INSERT INTO world_reference_name(
  reference_key,data_scope_key,name_kind,language_tag,name_text,normalized_text,source_ref,confidence
)
SELECT reference_key,'grounding-replay-a','CANONICAL_NAME','en','Replay Road','replay road','g07-test',1
FROM world_reference_identity
WHERE entity_kind='WORLD_OBJECT' AND internal_id='grounding-replay-object';

DO $projection_replay$
DECLARE
  first_id uuid;
  second_id uuid;
  repaired_id uuid;
BEGIN
  first_id := rebuild_reference_search_projection_audited('grounding-replay-a','reference-search-v1');
  second_id := rebuild_reference_search_projection_audited('grounding-replay-a','reference-search-v1');
  IF (SELECT outcome FROM grounding_replay_audit WHERE replay_id=first_id) <> 'REBUILT_DIFFERENCE' OR
     (SELECT outcome FROM grounding_replay_audit WHERE replay_id=second_id) <> 'MATCH' THEN
    RAISE EXCEPTION 'reference search replay did not detect repair and then stabilize';
  END IF;
  DELETE FROM reference_search_projection
  WHERE data_scope_key='grounding-replay-a' AND search_kind='CANONICAL_NAME';
  repaired_id := rebuild_reference_search_projection_audited('grounding-replay-a','reference-search-v1');
  IF (SELECT outcome FROM grounding_replay_audit WHERE replay_id=repaired_id) <> 'REBUILT_DIFFERENCE' OR
     NOT EXISTS (SELECT 1 FROM reference_search_projection WHERE data_scope_key='grounding-replay-a' AND normalized_text='replay road') THEN
    RAISE EXCEPTION 'reference search projection corruption was not repaired';
  END IF;
END
$projection_replay$;

WITH job AS (
  INSERT INTO gowm_capability.gateway_job(
    job_kind,principal_hash,data_scope_key,request_hash,state,started_at,completed_at
  ) VALUES (
    'WORLD_QUERY','sha256:' || repeat('1',64),'grounding-replay-a',
    'sha256:' || repeat('2',64),'SUCCEEDED',clock_timestamp(),clock_timestamp()
  ) RETURNING job_id
)
INSERT INTO gowm_capability.world_query_job(
  query_id,job_id,public_job_id,request_id,principal_ref,principal_hash,
  idempotency_key,request_hash,parameter_schema_hash,plan_hash,submission,
  authentication_method,authenticated_at,data_scope_claim
)
SELECT 'g07-query',job_id,'g07-job','g07-request','principal:g07',
       'sha256:' || repeat('1',64),'g07-idempotency','sha256:' || repeat('2',64),
       'sha256:' || repeat('3',64),'sha256:' || repeat('4',64),
       '{"requestId":"g07-request","idempotencyKey":"g07-idempotency","parameterSchemaHash":"sha256:3333333333333333333333333333333333333333333333333333333333333333","plan":{"queryId":"g07-query"}}',
       'TEST_ATTESTED',clock_timestamp(),'grounding-replay-a'
FROM job;

UPDATE gowm_capability.world_query_job
SET result=jsonb_build_object(
  'queryPlanVersion','2.0','queryId','g07-query','jobId','g07-job','status','COMPLETED',
  'nodes',jsonb_build_array(jsonb_build_object(
    'nodeId','node1','result',jsonb_build_object(
      'dataSnapshot',jsonb_build_object('scopeDigest','sha256:' || repeat('5',64)),
      'computeSnapshot',jsonb_build_object('policy',jsonb_build_object('version','g07'))
    )
  )),
  'outputs',jsonb_build_object('count',1),'warnings',jsonb_build_array(),
  'startedAt','2026-08-24T00:00:00Z','finishedAt','2026-08-24T00:00:01Z',
  'outputHash','sha256:' || repeat('6',64)
)
WHERE query_id='g07-query';

DO $query_replay$
DECLARE
  stored record;
  matched_id uuid;
  data_difference_id uuid;
  mismatch_id uuid;
BEGIN
  SELECT result_hash,data_snapshot_hash,compute_snapshot_hash INTO STRICT stored
  FROM world_query_result_reference WHERE query_id='g07-query';
  matched_id := record_query_result_replay(
    'g07-query',stored.result_hash,stored.data_snapshot_hash,stored.compute_snapshot_hash,'world-query-v2'
  );
  data_difference_id := record_query_result_replay(
    'g07-query','sha256:' || repeat('7',64),'sha256:' || repeat('8',64),stored.compute_snapshot_hash,'world-query-v2'
  );
  mismatch_id := record_query_result_replay(
    'g07-query','sha256:' || repeat('9',64),stored.data_snapshot_hash,stored.compute_snapshot_hash,'world-query-v2'
  );
  IF (SELECT outcome FROM grounding_replay_audit WHERE replay_id=matched_id) <> 'MATCH' OR
     (SELECT outcome FROM grounding_replay_audit WHERE replay_id=data_difference_id) <> 'DATA_VERSION_DIFFERENCE' OR
     (SELECT outcome FROM grounding_replay_audit WHERE replay_id=mismatch_id) <> 'CHECKSUM_MISMATCH' THEN
    RAISE EXCEPTION 'query result replay classification is incorrect';
  END IF;
  IF EXISTS (SELECT 1 FROM grounding_replay_audit WHERE data_scope_key='grounding-replay-b') THEN
    RAISE EXCEPTION 'replay audit leaked across scope';
  END IF;
  BEGIN
    UPDATE grounding_replay_audit SET difference_report='{}' WHERE replay_id=matched_id;
    RAISE EXCEPTION 'replay audit was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$query_replay$;

ROLLBACK;

SELECT 'GROUNDING_SECURITY_REPLAY_ASSERTIONS_PASS' AS result;
