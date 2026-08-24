\set ON_ERROR_STOP on

BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
  ('correlation-resolver-a','TEST','Correlation resolver scope A'),
  ('correlation-resolver-b','TEST','Correlation resolver scope B');

CREATE FUNCTION pg_temp.add_correlation_event(
  p_scope text,p_task text,p_event_id text,p_actor_id text,p_claims jsonb
)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM ingest_operational_task_event(
    p_scope,'provider-correlation',p_event_id,1,p_event_id,p_task,'EXECUTION_PROGRESS_OBSERVED',
    '2026-08-24T05:00:00Z','2026-08-24T05:00:01Z',NULL,
    jsonb_build_array(jsonb_build_object(
      'namespace','gowm','kind','WORLD_OBJECT','id',p_actor_id,'version','1'
    )),'[]',NULL,'{"taskType":"CORRELATION_TEST"}',0.99,
    jsonb_build_array(jsonb_build_object(
      'evidenceId','evidence-' || p_event_id,'authority','provider-correlation',
      'evidenceType','PROVIDER_EVENT','observedAt','2026-08-24T05:00:00Z'
    )),p_claims,300000,86400000
  );
END
$fn$;

SELECT pg_temp.add_correlation_event(
  'correlation-resolver-a','ot-correlation-1','correlation-event-1',
  'wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '[
    {"claimId":"operation-claim","externalAuthority":"orchestrator-a","externalKind":"OPERATION_CORRELATION","externalValue":"operation-exact-1","relationHint":"RELATED_TO","matchBasis":"PROPAGATED_CORRELATION_ID","confidence":0.7,"observedAt":"2026-08-24T05:00:00Z","receivedAt":"2026-08-24T05:00:01Z","evidenceIds":["evidence-correlation-event-1"]},
    {"claimId":"action-claim","externalAuthority":"provider-correlation","externalKind":"PROVIDER_ACTION","externalValue":"action-exact-1","relationHint":"RELATED_TO","matchBasis":"PROVIDER_DECLARED","confidence":0.4,"observedAt":"2026-08-24T05:00:00Z","receivedAt":"2026-08-24T05:00:01Z","evidenceIds":["evidence-correlation-event-1"]},
    {"claimId":"step-a","externalAuthority":"planner-a","externalKind":"PLANNING_STEP","externalValue":"step-a","relationHint":"REALIZES","matchBasis":"PROPAGATED_CORRELATION_ID","confidence":1,"observedAt":"2026-08-24T05:00:00Z","receivedAt":"2026-08-24T05:00:01Z","evidenceIds":["evidence-correlation-event-1"]},
    {"claimId":"step-b","externalAuthority":"planner-a","externalKind":"PLANNING_STEP","externalValue":"step-b","relationHint":"REALIZES","matchBasis":"PROPAGATED_CORRELATION_ID","confidence":1,"observedAt":"2026-08-24T05:00:00Z","receivedAt":"2026-08-24T05:00:01Z","evidenceIds":["evidence-correlation-event-1"]},
    {"claimId":"shared-task-1","externalAuthority":"planner-a","externalKind":"PLANNING_TASK","externalValue":"shared-task","relationHint":"REPORTS_EXECUTION_OF","matchBasis":"PROPAGATED_CORRELATION_ID","confidence":0.9,"observedAt":"2026-08-24T05:00:00Z","receivedAt":"2026-08-24T05:00:01Z","evidenceIds":["evidence-correlation-event-1"]}
  ]'
);
SELECT pg_temp.add_correlation_event(
  'correlation-resolver-a','ot-correlation-2','correlation-event-2',
  'wrf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '[{"claimId":"shared-task-2","externalAuthority":"planner-a","externalKind":"PLANNING_TASK","externalValue":"shared-task","relationHint":"REPORTS_EXECUTION_OF","matchBasis":"PROPAGATED_CORRELATION_ID","confidence":0.8,"observedAt":"2026-08-24T05:00:00Z","receivedAt":"2026-08-24T05:00:01Z","evidenceIds":["evidence-correlation-event-2"]}]'
);
SELECT pg_temp.add_correlation_event(
  'correlation-resolver-a','ot-correlation-3','correlation-event-3',
  'wrf_cccccccccccccccccccccccccccccccc','[]'
);
SELECT pg_temp.add_correlation_event(
  'correlation-resolver-b','ot-correlation-scope-b','correlation-event-scope-b',
  'wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '[{"claimId":"scope-b-operation","externalAuthority":"orchestrator-a","externalKind":"OPERATION_CORRELATION","externalValue":"operation-exact-1","relationHint":"RELATED_TO","matchBasis":"PROPAGATED_CORRELATION_ID","confidence":1,"observedAt":"2026-08-24T05:00:00Z","receivedAt":"2026-08-24T05:00:01Z","evidenceIds":["evidence-correlation-event-scope-b"]}]'
);

SELECT project_operational_task('correlation-resolver-a','ot-correlation-1');
SELECT project_operational_task('correlation-resolver-a','ot-correlation-2');
SELECT project_operational_task('correlation-resolver-a','ot-correlation-3');
SELECT project_operational_task('correlation-resolver-b','ot-correlation-scope-b');

CREATE TEMP TABLE resolver_findings(label text PRIMARY KEY,finding_id uuid NOT NULL);
INSERT INTO resolver_findings VALUES
  ('operation',resolve_operational_correlation(
    'correlation-resolver-a','orchestrator-a','OPERATION_CORRELATION','operation-exact-1',
    'RELATED_TO','SPATIOTEMPORAL_INFERENCE',0.1,'[]',NULL,NULL,'correlation-resolver-v1'
  )),
  ('provider-action',resolve_operational_correlation(
    'correlation-resolver-a','provider-correlation','PROVIDER_ACTION','action-exact-1',
    'RELATED_TO','PROVIDER_DECLARED',0.4,'[]',NULL,NULL,'correlation-resolver-v1'
  )),
  ('step-a',resolve_operational_correlation(
    'correlation-resolver-a','planner-a','PLANNING_STEP','step-a',
    'REALIZES','PROPAGATED_CORRELATION_ID',1,'[]',NULL,NULL,'correlation-resolver-v1'
  )),
  ('step-b',resolve_operational_correlation(
    'correlation-resolver-a','planner-a','PLANNING_STEP','step-b',
    'REALIZES','PROPAGATED_CORRELATION_ID',1,'[]',NULL,NULL,'correlation-resolver-v1'
  )),
  ('conflict',resolve_operational_correlation(
    'correlation-resolver-a','planner-a','PLANNING_TASK','shared-task',
    'REPORTS_EXECUTION_OF','PROPAGATED_CORRELATION_ID',1,'[]',NULL,NULL,'correlation-resolver-v1'
  )),
  ('derived',resolve_operational_correlation(
    'correlation-resolver-a','planner-a','PLANNING_TASK','derived-missing',
    'RELATED_TO','RESOURCE_AND_TIME_MATCH',0.55,
    '[{"namespace":"gowm","kind":"WORLD_OBJECT","id":"wrf_cccccccccccccccccccccccccccccccc","version":"1"}]',
    '2026-08-24T04:59:00Z','2026-08-24T05:01:00Z','correlation-resolver-v1'
  )),
  ('no-match',resolve_operational_correlation(
    'correlation-resolver-a','planner-a','EXECUTION_INTENT','definitely-missing',
    'RELATED_TO','PROPAGATED_CORRELATION_ID',0.2,'[]',NULL,NULL,'correlation-resolver-v1'
  ));

DO $resolution_semantics$
DECLARE
  task_one_ref text;
  task_three_ref text;
  snapshot_hashes text;
BEGIN
  SELECT reference_key INTO STRICT task_one_ref FROM operational_task
  WHERE data_scope_key='correlation-resolver-a' AND operational_task_id='ot-correlation-1';
  SELECT reference_key INTO STRICT task_three_ref FROM operational_task
  WHERE data_scope_key='correlation-resolver-a' AND operational_task_id='ot-correlation-3';
  SELECT string_agg(snapshot_hash,',' ORDER BY operational_task_id) INTO snapshot_hashes
  FROM operational_task_snapshot WHERE data_scope_key='correlation-resolver-a';

  IF NOT EXISTS (
    SELECT 1 FROM correlation_finding finding JOIN resolver_findings ids USING(finding_id)
    WHERE ids.label='operation' AND finding.relation='REALIZES'
      AND finding.match_basis='PROPAGATED_CORRELATION_ID'
      AND finding.operational_task_reference_key=task_one_ref
      AND finding.correlation_confidence=0.7 AND finding.candidate_count=1
  ) THEN RAISE EXCEPTION 'exact operation correlation did not outrank the lower inferred hint'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM correlation_finding finding JOIN resolver_findings ids USING(finding_id)
    WHERE ids.label='provider-action' AND finding.relation='REALIZES'
      AND finding.match_basis='PROVIDER_DECLARED' AND finding.operational_task_reference_key=task_one_ref
  ) THEN RAISE EXCEPTION 'provider-declared action did not resolve independently of physical truth'; END IF;
  IF (SELECT count(DISTINCT finding.operational_task_reference_key)
      FROM correlation_finding finding JOIN resolver_findings ids USING(finding_id)
      WHERE ids.label IN ('step-a','step-b'))<>1 THEN
    RAISE EXCEPTION 'several external planning steps did not resolve to one operational task';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM correlation_finding finding JOIN resolver_findings ids USING(finding_id)
    WHERE ids.label='conflict' AND finding.relation='CONFLICTING_MATCHES'
      AND finding.operational_task_reference_key IS NULL AND finding.candidate_count=2
  ) THEN RAISE EXCEPTION 'conflicting exact external task IDs were not preserved'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM correlation_finding finding JOIN resolver_findings ids USING(finding_id)
    WHERE ids.label='derived' AND finding.relation='POSSIBLY_CORRESPONDS_TO'
      AND finding.match_basis='RESOURCE_AND_TIME_MATCH'
      AND finding.operational_task_reference_key=task_three_ref AND finding.correlation_confidence=0.55
  ) THEN RAISE EXCEPTION 'bounded resource/time inference was promoted or lost'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM correlation_finding finding JOIN resolver_findings ids USING(finding_id)
    WHERE ids.label='no-match' AND finding.relation='NO_MATCH_FOUND'
      AND finding.operational_task_reference_key IS NULL AND finding.candidate_count=0
  ) THEN RAISE EXCEPTION 'no-match resolution fabricated a candidate'; END IF;
  IF EXISTS (
    SELECT 1 FROM correlation_finding_candidate candidate
    JOIN correlation_finding finding USING(finding_id)
    JOIN resolver_findings ids USING(finding_id)
    JOIN operational_task task ON task.reference_key=candidate.operational_task_reference_key
    WHERE ids.label='operation' AND task.data_scope_key<>'correlation-resolver-a'
  ) THEN RAISE EXCEPTION 'correlation resolution leaked across scope'; END IF;
  IF (SELECT string_agg(snapshot_hash,',' ORDER BY operational_task_id)
      FROM operational_task_snapshot WHERE data_scope_key='correlation-resolver-a')<>snapshot_hashes THEN
    RAISE EXCEPTION 'correlation resolution mutated OperationalTask projection truth';
  END IF;
END
$resolution_semantics$;

DO $finding_replay_immutability$
DECLARE
  target uuid;
  replay uuid;
BEGIN
  SELECT finding_id INTO STRICT target FROM resolver_findings WHERE label='operation';
  replay := replay_operational_correlation(target);
  IF (SELECT outcome FROM correlation_resolution_replay WHERE replay_id=replay)<>'MATCH' THEN
    RAISE EXCEPTION 'correlation did not replay from its frozen evidence world version';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM correlation_finding WHERE finding_id=target
      AND method_version='correlation-resolver-v1' AND world_version>0
  ) THEN RAISE EXCEPTION 'correlation finding omitted method or world version'; END IF;
  BEGIN
    UPDATE correlation_finding SET correlation_confidence=1 WHERE finding_id=target;
    RAISE EXCEPTION 'correlation finding was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    DELETE FROM correlation_finding_candidate WHERE finding_id=target;
    RAISE EXCEPTION 'correlation candidates were mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$finding_replay_immutability$;

ROLLBACK;

SELECT 'OPERATIONAL_CORRELATION_ASSERTIONS_PASS' AS result;
