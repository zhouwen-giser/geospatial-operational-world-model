\set ON_ERROR_STOP on

BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
  ('observability-a','TEST','Operational observability scope A'),
  ('observability-b','TEST','Operational observability scope B');
INSERT INTO world_object(id,data_scope_key,object_type,properties) VALUES
  ('observability-fresh','observability-a','SENSOR_TARGET','{}'),
  ('observability-stale','observability-a','SENSOR_TARGET','{}'),
  ('observability-gap','observability-a','SENSOR_TARGET','{}'),
  ('observability-unhealthy','observability-a','SENSOR_TARGET','{}'),
  ('observability-insufficient','observability-a','SENSOR_TARGET','{}'),
  ('observability-scope-b','observability-b','SENSOR_TARGET','{}');
INSERT INTO world_object_state(
  object_id,state,confidence,observed_at,received_at,source,source_observation_id,
  evidence_kind,projection_policy_version
) VALUES
  ('observability-fresh','{}',1,clock_timestamp()-interval '5 seconds',clock_timestamp(),'source-fresh','observation-fresh','OBSERVATION','observability-v1'),
  ('observability-stale','{}',1,clock_timestamp()-interval '1 day',clock_timestamp(),'source-stale','observation-stale','OBSERVATION','observability-v1'),
  ('observability-gap','{}',1,clock_timestamp()-interval '5 seconds',clock_timestamp(),'source-gap','observation-gap-current','OBSERVATION','observability-v1'),
  ('observability-unhealthy','{}',1,clock_timestamp()-interval '5 seconds',clock_timestamp(),'source-unhealthy','observation-unhealthy','OBSERVATION','observability-v1'),
  ('observability-insufficient','{}',1,clock_timestamp()-interval '5 seconds',clock_timestamp(),'source-insufficient','observation-insufficient','OBSERVATION','observability-v1'),
  ('observability-scope-b','{}',1,clock_timestamp()-interval '5 seconds',clock_timestamp(),'source-b','observation-b','OBSERVATION','observability-v1');

CREATE TEMP TABLE observability_refs(name text PRIMARY KEY,reference_key text NOT NULL);
INSERT INTO observability_refs SELECT internal_id,reference_key FROM world_reference_identity
WHERE data_scope_key IN ('observability-a','observability-b') AND entity_kind='WORLD_OBJECT';

INSERT INTO operational_source_health_revision(
  data_scope_key,source_authority,health_status,valid_from,observed_at,evidence_id
) VALUES
  ('observability-a','source-fresh','HEALTHY',clock_timestamp()-interval '1 hour',clock_timestamp(),'health-fresh'),
  ('observability-a','source-stale','HEALTHY',clock_timestamp()-interval '1 hour',clock_timestamp(),'health-stale'),
  ('observability-a','source-gap','HEALTHY',clock_timestamp()-interval '1 hour',clock_timestamp(),'health-gap'),
  ('observability-a','source-unhealthy','UNHEALTHY',clock_timestamp()-interval '1 hour',clock_timestamp(),'health-unhealthy'),
  ('observability-a','source-insufficient','HEALTHY',clock_timestamp()-interval '1 hour',clock_timestamp(),'health-insufficient');
INSERT INTO operational_source_watermark_revision(
  data_scope_key,source_authority,closed_through_event_time,allowed_lateness,completeness_state,evidence_id
) VALUES
  ('observability-a','source-fresh',clock_timestamp()+interval '1 minute',interval '5 seconds','COMPLETE','watermark-fresh'),
  ('observability-a','source-stale',clock_timestamp()+interval '1 minute',interval '5 seconds','COMPLETE','watermark-stale'),
  ('observability-a','source-gap',clock_timestamp()+interval '1 minute',interval '5 seconds','COMPLETE','watermark-gap'),
  ('observability-a','source-unhealthy',clock_timestamp()+interval '1 minute',interval '5 seconds','COMPLETE','watermark-unhealthy'),
  ('observability-a','source-insufficient',clock_timestamp()-interval '1 hour',interval '5 seconds','PARTIAL','watermark-insufficient');

INSERT INTO operational_coverage_evidence(
  data_scope_key,subject_reference_key,source_authority,valid_time,coverage_sufficient,evidence_id,policy_version
)
SELECT 'observability-a',reference_key,'source-'||split_part(name,'-',2),
       tstzrange(clock_timestamp()-interval '2 hours',clock_timestamp()+interval '2 hours','[)'),
       name<>'observability-insufficient','coverage-'||split_part(name,'-',2),'coverage-v1'
FROM observability_refs WHERE name IN (
  'observability-fresh','observability-stale','observability-gap','observability-unhealthy','observability-insufficient'
);
INSERT INTO operational_observation_gap(
  data_scope_key,subject_reference_key,source_authority,gap_time,evidence_id,reason
) VALUES (
  'observability-a',(SELECT reference_key FROM observability_refs WHERE name='observability-gap'),'source-gap',
  tstzrange(clock_timestamp()-interval '30 seconds',clock_timestamp()+interval '30 seconds','[)'),
  'gap-evidence','transport outage'
);

CREATE TEMP TABLE observability_results(label text PRIMARY KEY,assessment_id text NOT NULL,status text NOT NULL,coverage_sufficient boolean NOT NULL);
CREATE FUNCTION pg_temp.assess(p_label text,p_object text,p_source text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE id_value text;to_value timestamptz:=clock_timestamp();from_value timestamptz:=to_value-interval '1 minute';
BEGIN
  id_value := record_operational_observability(
    'observability-a',(SELECT reference_key FROM observability_refs WHERE name=p_object),
    from_value,to_value,jsonb_build_array(p_source),300
  );
  INSERT INTO observability_results
  SELECT p_label,assessment_id,output->>'status',(output->>'coverageSufficient')::boolean
  FROM operational_observability_assessment
  WHERE data_scope_key='observability-a' AND assessment_id=id_value;
END
$fn$;

SELECT pg_temp.assess('fresh','observability-fresh','source-fresh');
SELECT pg_temp.assess('stale','observability-stale','source-stale');
SELECT pg_temp.assess('gap','observability-gap','source-gap');
SELECT pg_temp.assess('unhealthy','observability-unhealthy','source-unhealthy');
SELECT pg_temp.assess('insufficient','observability-insufficient','source-insufficient');

DO $observability_semantics$
BEGIN
  IF EXISTS (SELECT 1 FROM observability_results WHERE
    (label='fresh' AND (status<>'FRESH' OR NOT coverage_sufficient)) OR
    (label='stale' AND status<>'STALE') OR
    (label='gap' AND status<>'OBSERVATION_GAP') OR
    (label='unhealthy' AND (status<>'SOURCE_UNHEALTHY' OR coverage_sufficient)) OR
    (label='insufficient' AND (status<>'INDETERMINATE' OR coverage_sufficient))
  ) OR (SELECT count(*) FROM observability_results)<>5 THEN
    RAISE EXCEPTION 'observability status semantics failed: %',(SELECT jsonb_object_agg(label,status) FROM observability_results);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operational_observability_assessment assessment JOIN observability_results result USING(assessment_id)
    WHERE result.label='gap' AND jsonb_array_length(assessment.output->'gapIntervals')=1
      AND assessment.output->'evidenceIds' ? 'gap-evidence'
  ) THEN RAISE EXCEPTION 'explicit gap interval/evidence was omitted'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operational_observability_assessment assessment JOIN observability_results result USING(assessment_id)
    WHERE result.label='insufficient' AND assessment.evidence_snapshot->>'sufficientCoverageCount'='0'
      AND assessment.output->'evidenceIds' ? 'health-insufficient'
  ) THEN RAISE EXCEPTION 'coverage sufficiency was not kept separate from observation existence'; END IF;
END
$observability_semantics$;

DO $scope_and_immutability$
BEGIN
  BEGIN
    INSERT INTO operational_coverage_evidence(
      data_scope_key,subject_reference_key,source_authority,valid_time,coverage_sufficient,evidence_id,policy_version
    ) VALUES (
      'observability-a',(SELECT reference_key FROM observability_refs WHERE name='observability-scope-b'),
      'source-b',tstzrange(clock_timestamp(),clock_timestamp()+interval '1 minute','[)'),true,'cross-scope','coverage-v1'
    );
    RAISE EXCEPTION 'cross-scope coverage evidence was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE operational_source_health_revision SET health_status='HEALTHY' WHERE evidence_id='health-unhealthy';
    RAISE EXCEPTION 'source health revision was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    DELETE FROM operational_observability_assessment WHERE assessment_id=(SELECT assessment_id FROM observability_results WHERE label='fresh');
    RAISE EXCEPTION 'observability assessment was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$scope_and_immutability$;

SET LOCAL ROLE gowm_operational_reader;
SELECT gowm_operational_reality_v1.set_data_scope('observability-a');
DO $read_contract$
BEGIN
  IF (SELECT count(*) FROM gowm_operational_reality_v1.observability_assessment)<>5 THEN
    RAISE EXCEPTION 'observability read view omitted scoped assessments';
  END IF;
  BEGIN
    PERFORM count(*) FROM public.operational_source_health_revision;
    RAISE EXCEPTION 'operational reader accessed observability evidence base table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$read_contract$;
RESET ROLE;

ROLLBACK;
SELECT 'OPERATIONAL_OBSERVABILITY_ASSERTIONS_PASS' AS result;
