\set ON_ERROR_STOP on

BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
  ('correlation-claim-a','TEST','Correlation claim scope A'),
  ('correlation-claim-b','TEST','Correlation claim scope B');
INSERT INTO source_registry(source_key,data_scope_key,source_type,default_analysis_space_key)
VALUES ('correlation-test-source','correlation-claim-a','EXTERNAL','default');
INSERT INTO producer_pipeline(source_key,pipeline_key,pipeline_version,output_kind)
VALUES ('correlation-test-source','correlation-test-pipeline','1','CANONICAL_OBSERVATION');
INSERT INTO datastream(datastream_key,source_key,data_scope_key,pipeline_key,schema_version)
VALUES ('correlation-test-stream','correlation-test-source','correlation-claim-a','correlation-test-pipeline','1');
INSERT INTO world_object(id,object_type,properties,data_scope_key)
VALUES ('correlation-test-object','ASSET','{}','correlation-claim-a');

INSERT INTO world_observation(
  observation_id,observer_type,observer_id,subject_type,subject_id,observation_type,
  value,confidence,observed_at,received_at,source,correlation_id,metadata,schema_version,status,
  data_scope_key,source_record_key,source_revision_no,origin_kind,source_local_target_id,
  datastream_key,producer_pipeline_key,raw_reference,payload_hash,quality_flags,entity_binding_status,
  execution_intent_id,operation_correlation_id,external_planning_task_id,external_planning_step_id,
  provider_action_id,device_command_id
) VALUES (
  'correlation-observation-1','Provider','provider-a','Asset','correlation-test-object','operation-progress',
  '{}',0.9,'2026-08-24T01:00:00Z','2026-08-24T01:00:01Z','correlation-test-source','wire-correlation','{}','1.2','accepted',
  'correlation-claim-a','record-1',1,'EXTERNAL','asset-1',
  'correlation-test-stream','correlation-test-pipeline','inline://correlation/1',repeat('c',64),'{}','DECLARED',
  'intent-1','operation-1','planning-task-shared','planning-step-1','provider-action-1','device-command-1'
);

DO $observation_claims$
BEGIN
  IF (SELECT count(*) FROM external_correlation_claim
      WHERE data_scope_key='correlation-claim-a' AND source_kind='OBSERVATION'
        AND source_id='correlation-observation-1') <> 6 THEN
    RAISE EXCEPTION 'propagated observation correlation fields did not create six claims';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM external_correlation_claim
    WHERE source_id='correlation-observation-1' AND external_kind='PLANNING_TASK'
      AND external_value='planning-task-shared' AND relation_hint='REPORTS_EXECUTION_OF'
      AND match_basis='PROPAGATED_CORRELATION_ID' AND confidence=1
      AND observed_at='2026-08-24T01:00:00Z' AND received_at='2026-08-24T01:00:01Z'
      AND evidence_ids='["correlation-observation-1"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'observation correlation claim lost contract semantics';
  END IF;
END
$observation_claims$;

INSERT INTO world_event(
  event_id,event_type,subject_type,subject_id,event_time,world_version,correlation_id,causation_id,
  payload,schema_version,data_scope_key,operation_correlation_id,provider_action_id,external_planning_task_id
) VALUES (
  '00000000-0000-4000-8000-000000000025','ObservationReceived','Asset','correlation-test-object',
  '2026-08-24T01:00:00Z',1,'wire-correlation','correlation-observation-1',
  '{"sourceAuthority":"provider-a"}','1.0','correlation-claim-a','operation-1','provider-action-1','planning-task-shared'
);

INSERT INTO world_event(
  event_id,event_type,subject_type,subject_id,event_time,world_version,correlation_id,causation_id,
  payload,schema_version,data_scope_key,operation_correlation_id,provider_action_id,external_planning_task_id
) VALUES (
  '00000000-0000-4000-8000-000000000025','ObservationReceived','Asset','correlation-test-object',
  '2026-08-24T01:00:00Z',1,'wire-correlation','correlation-observation-1',
  '{"sourceAuthority":"provider-a"}','1.0','correlation-claim-a','operation-1','provider-action-1','planning-task-shared'
) ON CONFLICT DO NOTHING;

INSERT INTO world_event(
  event_id,event_type,subject_type,subject_id,event_time,world_version,correlation_id,causation_id,
  payload,schema_version,data_scope_key,external_planning_task_id
) VALUES (
  '00000000-0000-4000-8000-000000000026','ObservationReceived','Asset','correlation-test-object',
  '2026-08-24T01:00:02Z',2,'wire-correlation-2','correlation-observation-2',
  '{"sourceAuthority":"provider-b"}','1.0','correlation-claim-a','planning-task-shared'
);

DO $claim_contract$
DECLARE
  claim uuid;
BEGIN
  IF (SELECT count(*) FROM external_correlation_claim
      WHERE source_kind='WORLD_EVENT' AND source_id='00000000-0000-4000-8000-000000000025') <> 3 THEN
    RAISE EXCEPTION 'world event retry duplicated or omitted correlation claims';
  END IF;
  IF (SELECT count(*) FROM external_correlation_claim
      WHERE data_scope_key='correlation-claim-a' AND external_kind='PLANNING_TASK'
        AND external_value='planning-task-shared') <> 3 THEN
    RAISE EXCEPTION 'one external task was incorrectly treated as a unique internal identity';
  END IF;
  IF EXISTS (SELECT 1 FROM external_correlation_claim WHERE data_scope_key='correlation-claim-b') THEN
    RAISE EXCEPTION 'correlation claims leaked across scope';
  END IF;
  IF EXISTS (
    SELECT 1 FROM world_reference_identity
    WHERE internal_id IN ('intent-1','operation-1','planning-task-shared','planning-step-1','provider-action-1','device-command-1')
  ) THEN
    RAISE EXCEPTION 'external correlation value became internal reference truth';
  END IF;
  SELECT claim_id INTO STRICT claim FROM external_correlation_claim
  WHERE source_id='correlation-observation-1' ORDER BY claim_id LIMIT 1;
  BEGIN
    UPDATE external_correlation_claim SET confidence=0.5 WHERE claim_id=claim;
    RAISE EXCEPTION 'external correlation claim was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    DELETE FROM external_correlation_claim WHERE claim_id=claim;
    RAISE EXCEPTION 'external correlation claim was deletable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    UPDATE world_observation SET operation_correlation_id='changed'
    WHERE observation_id='correlation-observation-1';
    RAISE EXCEPTION 'observation correlation evidence was mutable';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;
  BEGIN
    UPDATE world_event SET operation_correlation_id='changed'
    WHERE event_id='00000000-0000-4000-8000-000000000025';
    RAISE EXCEPTION 'world event correlation evidence was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$claim_contract$;

ROLLBACK;

SELECT 'EXTERNAL_CORRELATION_CLAIM_ASSERTIONS_PASS' AS result;
