\set ON_ERROR_STOP on

BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
  ('analysis-finding-a','TEST','Analysis finding scope A'),
  ('analysis-finding-b','TEST','Analysis finding scope B');

CREATE TEMP TABLE finding_ids(predicate_id text,correlation_id uuid,replay_id uuid);
INSERT INTO finding_ids(predicate_id) VALUES (record_external_predicate_evaluation(
  'analysis-finding-a','{
    "predicateId":"analysis-no-data",
    "externalAuthority":"planner-analysis",
    "subject":{"externalReferenceId":"missing-analysis-subject"},
    "operator":"HAS_OBSERVED"
  }'::jsonb
));
UPDATE finding_ids SET correlation_id=resolve_operational_correlation(
  'analysis-finding-a','planner-analysis','EXECUTION_INTENT','missing-analysis-intent',
  'RELATED_TO','PROPAGATED_CORRELATION_ID',0.1,'[]',NULL,NULL,'correlation-resolver-v1'
);
UPDATE finding_ids SET replay_id=replay_external_predicate_evaluation(
  'analysis-finding-a',(SELECT predicate_id FROM finding_ids)
);

DO $replay_and_findings$
DECLARE correlation_replay uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM predicate_evaluation_replay replay JOIN finding_ids ids USING(replay_id)
    WHERE replay.outcome='MATCH' AND replay.evidence_world_version>0
      AND replay.policy_version='predicate-evaluator-v1'
      AND replay.input_hash ~ '^sha256:[0-9a-f]{64}$'
      AND replay.expected_hash=replay.replay_hash AND replay.difference_report='{}'::jsonb
  ) THEN RAISE EXCEPTION 'predicate did not replay from frozen input/evidence'; END IF;
  correlation_replay:=replay_operational_correlation((SELECT correlation_id FROM finding_ids));
  IF (SELECT outcome FROM correlation_resolution_replay WHERE replay_id=correlation_replay)<>'MATCH' THEN
    RAISE EXCEPTION 'correlation finding replay regressed';
  END IF;
  BEGIN
    UPDATE predicate_evaluation_replay SET outcome='DIFFERENCE' WHERE replay_id=(SELECT replay_id FROM finding_ids);
    RAISE EXCEPTION 'predicate replay receipt was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    PERFORM replay_external_predicate_evaluation('analysis-finding-b',(SELECT predicate_id FROM finding_ids));
    RAISE EXCEPTION 'cross-scope predicate replay was available';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END
$replay_and_findings$;

SET LOCAL ROLE gowm_operational_reader;
SELECT gowm_operational_reality_v1.set_data_scope('analysis-finding-a');
DO $finding_view$
BEGIN
  IF (SELECT count(*) FROM gowm_operational_reality_v1.analysis_finding)<>2 OR
     NOT EXISTS (SELECT 1 FROM gowm_operational_reality_v1.analysis_finding WHERE finding_kind='CORRELATION' AND status='NO_MATCH_FOUND') OR
     NOT EXISTS (SELECT 1 FROM gowm_operational_reality_v1.analysis_finding WHERE finding_kind='PREDICATE' AND status='NO_DATA') THEN
    RAISE EXCEPTION 'unified append-only analysis finding view is incomplete';
  END IF;
  BEGIN
    PERFORM count(*) FROM public.predicate_evaluation_replay;
    RAISE EXCEPTION 'operational reader accessed predicate replay base table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$finding_view$;
RESET ROLE;

ROLLBACK;
SELECT 'OPERATIONAL_ANALYSIS_FINDINGS_REPLAY_ASSERTIONS_PASS' AS result;
