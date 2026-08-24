\set ON_ERROR_STOP on

BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description)
VALUES ('predicate-evaluation-a','TEST','External predicate evaluation scope');

INSERT INTO world_object(id,data_scope_key,object_type,properties) VALUES
  ('predicate-subject','predicate-evaluation-a','VEHICLE','{}'),
  ('predicate-area','predicate-evaluation-a','AREA','{}'),
  ('predicate-near','predicate-evaluation-a','MARKER','{}'),
  ('predicate-reached','predicate-evaluation-a','MARKER','{}'),
  ('predicate-far','predicate-evaluation-a','MARKER','{}'),
  ('predicate-stale','predicate-evaluation-a','VEHICLE','{}');

INSERT INTO world_object_state(
  object_id,state,confidence,observed_at,received_at,source,source_observation_id,
  evidence_kind,projection_policy_version,uncertainty_summary
) VALUES
  ('predicate-subject','{"mode":"READY"}',1,clock_timestamp(),clock_timestamp(),'predicate-test','predicate-observation-subject','OBSERVATION','predicate-test-v1','{"accuracyRadiusM":1}'),
  ('predicate-area','{}',1,clock_timestamp(),clock_timestamp(),'predicate-test','predicate-observation-area','OBSERVATION','predicate-test-v1','{"accuracyRadiusM":0}'),
  ('predicate-near','{}',1,clock_timestamp(),clock_timestamp(),'predicate-test','predicate-observation-near','OBSERVATION','predicate-test-v1','{"accuracyRadiusM":1}'),
  ('predicate-reached','{}',1,clock_timestamp(),clock_timestamp(),'predicate-test','predicate-observation-reached','OBSERVATION','predicate-test-v1','{"accuracyRadiusM":1}'),
  ('predicate-far','{}',1,clock_timestamp(),clock_timestamp(),'predicate-test','predicate-observation-far','OBSERVATION','predicate-test-v1','{"accuracyRadiusM":1}'),
  ('predicate-stale','{"mode":"MOVING"}',1,clock_timestamp()-interval '1 day',clock_timestamp(),'predicate-test','predicate-observation-stale','OBSERVATION','predicate-test-v1','{"accuracyRadiusM":1}');

INSERT INTO world_object_geometry(object_id,geometry,observed_at) VALUES
  ('predicate-subject',ST_SetSRID(ST_Point(0,0),4326),clock_timestamp()),
  ('predicate-area',ST_GeomFromText('POLYGON((-0.001 -0.001,0.001 -0.001,0.001 0.001,-0.001 0.001,-0.001 -0.001))',4326),clock_timestamp()),
  ('predicate-near',ST_SetSRID(ST_Point(0.0001,0),4326),clock_timestamp()),
  ('predicate-reached',ST_SetSRID(ST_Point(0.00001,0),4326),clock_timestamp()),
  ('predicate-far',ST_SetSRID(ST_Point(1,1),4326),clock_timestamp()),
  ('predicate-stale',ST_SetSRID(ST_Point(2,2),4326),clock_timestamp()-interval '1 day');

CREATE TEMP TABLE predicate_refs(name text PRIMARY KEY,reference_key text NOT NULL);
INSERT INTO predicate_refs
SELECT internal_id,reference_key FROM world_reference_identity
WHERE data_scope_key='predicate-evaluation-a' AND entity_kind='WORLD_OBJECT';

CREATE FUNCTION pg_temp.add_predicate_event(p_id text,p_type text,p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE event_at timestamptz := clock_timestamp()-interval '2 seconds';
BEGIN
  PERFORM ingest_operational_task_event(
    'predicate-evaluation-a','predicate-test',p_id,1,p_id,'predicate-task',p_type,
    event_at,event_at+interval '1 second',NULL,'[]','[]',NULL,p_payload,1,
    jsonb_build_array(jsonb_build_object(
      'evidenceId','evidence-'||p_id,'authority','predicate-test',
      'evidenceType','PREDICATE_TEST','observedAt',event_at
    )),'[]',300000,86400000
  );
END
$fn$;

SELECT pg_temp.add_predicate_event('predicate-started','EXECUTION_STARTED_OBSERVED','{"taskType":"INSPECTION"}');
SELECT pg_temp.add_predicate_event('predicate-stopped','EXECUTION_STOPPED_OBSERVED');
SELECT pg_temp.add_predicate_event('predicate-confirmed','PHYSICAL_EFFECT_CONFIRMED');
SELECT pg_temp.add_predicate_event('predicate-contradicted','PHYSICAL_EFFECT_CONTRADICTED');
SELECT project_operational_task('predicate-evaluation-a','predicate-task');

CREATE TEMP TABLE predicate_test_baseline AS
SELECT (SELECT count(*) FROM world_reference_identity) AS identities,
       (SELECT count(*) FROM world_observation) AS observations,
       (SELECT count(*) FROM world_event) AS world_events;

CREATE TEMP TABLE predicate_results(label text PRIMARY KEY,evaluation_id text NOT NULL,status text NOT NULL);
CREATE FUNCTION pg_temp.evaluate_predicate(p_label text,p_predicate jsonb)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE result_id text;
BEGIN
  result_id := record_external_predicate_evaluation('predicate-evaluation-a',p_predicate);
  INSERT INTO predicate_results
  SELECT p_label,evaluation_id,status FROM external_predicate_evaluation
  WHERE data_scope_key='predicate-evaluation-a' AND evaluation_id=result_id;
END
$fn$;

SELECT pg_temp.evaluate_predicate('inside',jsonb_build_object(
  'predicateId','predicate-inside','externalAuthority','planner-test',
  'subject',jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-subject'),'version','1'),
  'operator','IS_INSIDE','object',jsonb_build_object('id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-area'))
));
SELECT pg_temp.evaluate_predicate('near',jsonb_build_object(
  'predicateId','predicate-near','externalAuthority','planner-test',
  'subject',jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-subject'),'version','1'),
  'operator','IS_NEAR','object',jsonb_build_object('id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-near')),
  'parameters',jsonb_build_object('thresholdMeters',10)
));
SELECT pg_temp.evaluate_predicate('intersects',jsonb_build_object(
  'predicateId','predicate-intersects','externalAuthority','planner-test',
  'subject',jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-subject'),'version','1'),
  'operator','INTERSECTS','object',jsonb_build_object('id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-area'))
));
SELECT pg_temp.evaluate_predicate('reached',jsonb_build_object(
  'predicateId','predicate-reached','externalAuthority','planner-test',
  'subject',jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-subject'),'version','1'),
  'operator','HAS_REACHED','object',jsonb_build_object('id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-reached'))
));

CREATE TEMP TABLE predicate_task_ref AS
SELECT reference_key FROM operational_task_snapshot
WHERE data_scope_key='predicate-evaluation-a' AND operational_task_id='predicate-task';

SELECT pg_temp.evaluate_predicate('stopped',jsonb_build_object(
  'predicateId','predicate-stopped','externalAuthority','planner-test',
  'subject',jsonb_build_object('namespace','gowm','kind','OPERATIONAL_TASK','id',(SELECT reference_key FROM predicate_task_ref),'version','1'),
  'operator','HAS_STOPPED'
));
SELECT pg_temp.evaluate_predicate('observed',jsonb_build_object(
  'predicateId','predicate-observed','externalAuthority','planner-test',
  'subject',jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-subject'),'version','1'),
  'operator','HAS_OBSERVED'
));
SELECT pg_temp.evaluate_predicate('event-occurred',jsonb_build_object(
  'predicateId','predicate-event','externalAuthority','planner-test',
  'subject',jsonb_build_object('namespace','gowm','kind','OPERATIONAL_TASK','id',(SELECT reference_key FROM predicate_task_ref),'version','1'),
  'operator','EVENT_OCCURRED','object',jsonb_build_object('eventType','EXECUTION_STOPPED_OBSERVED')
));
SELECT pg_temp.evaluate_predicate('state-equals',jsonb_build_object(
  'predicateId','predicate-state','externalAuthority','planner-test',
  'subject',jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-subject'),'version','1'),
  'operator','STATE_EQUALS','object',jsonb_build_object('field','mode','value','READY')
));
SELECT pg_temp.evaluate_predicate('no-data',jsonb_build_object(
  'predicateId','predicate-no-data','externalAuthority','planner-test',
  'subject',jsonb_build_object('externalReferenceId','unknown-subject'),
  'operator','HAS_OBSERVED'
));
SELECT pg_temp.evaluate_predicate('indeterminate',jsonb_build_object(
  'predicateId','predicate-indeterminate','externalAuthority','planner-test',
  'subject',jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-stale'),'version','1'),
  'operator','STATE_EQUALS','object',jsonb_build_object('field','mode','value','READY')
));
SELECT pg_temp.evaluate_predicate('not-supported',jsonb_build_object(
  'predicateId','predicate-not-supported','externalAuthority','planner-test',
  'subject',jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-subject'),'version','1'),
  'operator','IS_NEAR','object',jsonb_build_object('id',(SELECT reference_key FROM predicate_refs WHERE name='predicate-far')),
  'parameters',jsonb_build_object('thresholdMeters',10)
));
SELECT pg_temp.evaluate_predicate('conflicting',jsonb_build_object(
  'predicateId','predicate-conflicting','externalAuthority','planner-test',
  'subject',jsonb_build_object('namespace','gowm','kind','OPERATIONAL_TASK','id',(SELECT reference_key FROM predicate_task_ref),'version','1'),
  'operator','STATE_EQUALS','object',jsonb_build_object('field','outcomeVerification','value','VERIFIED')
));

DO $predicate_semantics$
BEGIN
  IF EXISTS (
    SELECT 1 FROM predicate_results WHERE
      (label='inside' AND status<>'SUPPORTED') OR
      (label='near' AND status<>'PARTIALLY_SUPPORTED') OR
      (label='intersects' AND status<>'SUPPORTED') OR
      (label='reached' AND status<>'SUPPORTED') OR
      (label='stopped' AND status<>'SUPPORTED') OR
      (label='observed' AND status<>'SUPPORTED') OR
      (label='event-occurred' AND status<>'SUPPORTED') OR
      (label='state-equals' AND status<>'SUPPORTED') OR
      (label='no-data' AND status<>'NO_DATA') OR
      (label='indeterminate' AND status<>'INDETERMINATE') OR
      (label='not-supported' AND status<>'NOT_SUPPORTED') OR
      (label='conflicting' AND status<>'CONFLICTING')
  ) OR (SELECT count(*) FROM predicate_results)<>12 THEN
    RAISE EXCEPTION 'external predicate operator/status semantics failed: %',
      (SELECT jsonb_object_agg(label,status) FROM predicate_results);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM external_predicate_evaluation evaluation JOIN predicate_results result USING(evaluation_id)
    WHERE result.label='not-supported' AND evaluation.evidence_snapshot->>'coverageSufficient'='true'
      AND jsonb_array_length(evaluation.contradicting_evidence_ids)>0
  ) THEN RAISE EXCEPTION 'NOT_SUPPORTED lacked sufficient coverage or explicit opposite evidence'; END IF;
  IF EXISTS (
    SELECT 1 FROM external_predicate_evaluation evaluation JOIN predicate_results result USING(evaluation_id)
    WHERE result.label IN ('no-data','indeterminate') AND evaluation.status='NOT_SUPPORTED'
  ) THEN RAISE EXCEPTION 'absence or stale coverage was collapsed to NOT_SUPPORTED'; END IF;
END
$predicate_semantics$;

DO $predicate_boundary_and_immutability$
DECLARE id_before text;id_after text;
BEGIN
  SELECT evaluation_id INTO STRICT id_before FROM predicate_results WHERE label='inside';
  id_after := record_external_predicate_evaluation(
    'predicate-evaluation-a',(SELECT predicate FROM external_predicate_evaluation WHERE evaluation_id=id_before)
  );
  IF id_after<>id_before OR (SELECT count(*) FROM external_predicate_evaluation WHERE evaluation_id=id_before)<>1 THEN
    RAISE EXCEPTION 'identical predicate evaluation was not idempotent';
  END IF;
  IF (SELECT count(*) FROM world_reference_identity)<>(SELECT identities FROM predicate_test_baseline) OR
     (SELECT count(*) FROM world_observation)<>(SELECT observations FROM predicate_test_baseline) OR
     (SELECT count(*) FROM world_event)<>(SELECT world_events FROM predicate_test_baseline) THEN
    RAISE EXCEPTION 'external predicate input was promoted into world identity or fact tables';
  END IF;
  BEGIN
    UPDATE external_predicate_evaluation SET status='SUPPORTED' WHERE evaluation_id=id_before;
    RAISE EXCEPTION 'predicate evaluation was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$predicate_boundary_and_immutability$;

SET LOCAL ROLE gowm_operational_reader;
SELECT gowm_operational_reality_v1.set_data_scope('predicate-evaluation-a');
DO $predicate_read_contract$
BEGIN
  IF (SELECT count(*) FROM gowm_operational_reality_v1.predicate_evaluation)<>12 THEN
    RAISE EXCEPTION 'scoped predicate read view omitted evaluations';
  END IF;
  BEGIN
    PERFORM count(*) FROM public.external_predicate_evaluation;
    RAISE EXCEPTION 'operational reader accessed predicate base table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$predicate_read_contract$;
RESET ROLE;

ROLLBACK;

SELECT 'EXTERNAL_PREDICATE_EVALUATION_ASSERTIONS_PASS' AS result;
