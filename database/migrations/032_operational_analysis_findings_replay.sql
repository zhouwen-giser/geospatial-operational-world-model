BEGIN;

CREATE TABLE predicate_evaluation_replay (
  replay_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL,
  evaluation_id text NOT NULL,
  evidence_world_version bigint NOT NULL CHECK (evidence_world_version>=0),
  policy_version text NOT NULL,
  source_event_range jsonb NOT NULL CHECK (jsonb_typeof(source_event_range)='object'),
  input_hash text NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  expected_hash text NOT NULL CHECK (expected_hash ~ '^sha256:[0-9a-f]{64}$'),
  replay_hash text NOT NULL CHECK (replay_hash ~ '^sha256:[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('MATCH','DIFFERENCE')),
  difference_report jsonb NOT NULL CHECK (jsonb_typeof(difference_report)='object'),
  replayed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(data_scope_key,evaluation_id)
    REFERENCES external_predicate_evaluation(data_scope_key,evaluation_id)
);
CREATE INDEX predicate_evaluation_replay_target_idx
  ON predicate_evaluation_replay(data_scope_key,evaluation_id,replayed_at,replay_id);

CREATE TRIGGER predicate_evaluation_replay_immutable
  BEFORE UPDATE OR DELETE ON predicate_evaluation_replay
  FOR EACH ROW EXECUTE FUNCTION reject_operational_observability_mutation();

CREATE FUNCTION replay_external_predicate_evaluation(p_data_scope_key text,p_evaluation_id text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE
  stored record;computed jsonb;replay_output jsonb;replay_digest text;stored_replay_id uuid;
  source_range jsonb:='{}'::jsonb;task_internal_id text;
BEGIN
  SELECT * INTO STRICT stored FROM public.external_predicate_evaluation
  WHERE data_scope_key=p_data_scope_key AND evaluation_id=p_evaluation_id;
  computed:=public.compute_external_predicate_evaluation(
    stored.data_scope_key,stored.predicate,stored.evaluated_at_world_version,stored.method_version);
  replay_output:=computed->'output';
  IF stored.observability_assessment IS NOT NULL THEN
    replay_output:=replay_output||jsonb_build_object('observabilityAssessment',stored.observability_assessment);
    IF replay_output->>'status'='NOT_SUPPORTED' AND (
      COALESCE((stored.observability_assessment->>'coverageSufficient')::boolean,false)=false OR
      stored.observability_assessment->>'status'<>'FRESH'
    ) THEN
      replay_output:=jsonb_set(replay_output,'{status}','"INDETERMINATE"'::jsonb);
      replay_output:=jsonb_set(replay_output,'{warnings}',
        (replay_output->'warnings')||jsonb_build_array('negative result withheld by observability assessment'));
    END IF;
  END IF;
  replay_digest:=public.grounding_sha256(replay_output::text);
  SELECT internal_id INTO task_internal_id FROM public.world_reference_identity
  WHERE data_scope_key=p_data_scope_key AND reference_key=stored.predicate#>>'{subject,id}'
    AND entity_kind='OPERATIONAL_TASK';
  IF task_internal_id IS NOT NULL THEN
    SELECT jsonb_strip_nulls(jsonb_build_object('from',min(event_time),'to',max(event_time))) INTO source_range
    FROM public.operational_task_event
    WHERE data_scope_key=p_data_scope_key AND operational_task_id=task_internal_id
      AND world_version<=stored.evaluated_at_world_version;
  END IF;
  INSERT INTO public.predicate_evaluation_replay(
    data_scope_key,evaluation_id,evidence_world_version,policy_version,source_event_range,
    input_hash,expected_hash,replay_hash,outcome,difference_report
  ) VALUES (
    p_data_scope_key,p_evaluation_id,stored.evaluated_at_world_version,stored.method_version,source_range,
    stored.input_hash,stored.result_hash,replay_digest,
    CASE WHEN stored.result_hash=replay_digest THEN 'MATCH' ELSE 'DIFFERENCE' END,
    CASE WHEN stored.result_hash=replay_digest THEN '{}'::jsonb ELSE jsonb_build_object(
      'expectedStatus',stored.status,'replayStatus',replay_output->>'status',
      'expectedHash',stored.result_hash,'replayHash',replay_digest) END
  ) RETURNING replay_id INTO stored_replay_id;
  RETURN stored_replay_id;
END
$fn$;

CREATE VIEW gowm_operational_reality_v1.analysis_finding AS
SELECT 'CORRELATION'::text AS finding_kind,finding.finding_id::text AS finding_id,
       finding.relation AS status,finding.world_version,finding.evidence_ids,
       finding.method_version,finding.resolution_hash AS result_hash,finding.created_at
FROM correlation_finding finding
WHERE finding.data_scope_key=gowm_operational_reality_v1.current_data_scope_key()
UNION ALL
SELECT 'PREDICATE',evaluation.evaluation_id,evaluation.status,evaluation.evaluated_at_world_version,
       evaluation.supporting_evidence_ids||evaluation.contradicting_evidence_ids,
       evaluation.method_version,evaluation.result_hash,evaluation.created_at
FROM external_predicate_evaluation evaluation
WHERE evaluation.data_scope_key=gowm_operational_reality_v1.current_data_scope_key();

REVOKE ALL ON FUNCTION replay_external_predicate_evaluation(text,text) FROM PUBLIC;
REVOKE ALL ON TABLE gowm_operational_reality_v1.analysis_finding FROM PUBLIC;
GRANT SELECT ON gowm_operational_reality_v1.analysis_finding TO gowm_operational_reader;

COMMIT;
