BEGIN;

CREATE TABLE operational_source_health_revision (
  health_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  source_authority text NOT NULL,
  health_status text NOT NULL CHECK (health_status IN ('HEALTHY','DEGRADED','UNHEALTHY','UNKNOWN')),
  valid_from timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  evidence_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX operational_source_health_latest_idx
  ON operational_source_health_revision(data_scope_key,source_authority,valid_from DESC,health_revision_id);

CREATE TABLE operational_source_watermark_revision (
  watermark_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  source_authority text NOT NULL,
  closed_through_event_time timestamptz NOT NULL,
  allowed_lateness interval NOT NULL CHECK (allowed_lateness>=interval '0'),
  completeness_state text NOT NULL CHECK (completeness_state IN ('COMPLETE','PARTIAL','UNKNOWN')),
  evidence_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX operational_source_watermark_latest_idx
  ON operational_source_watermark_revision(data_scope_key,source_authority,created_at DESC,watermark_revision_id);

CREATE TABLE operational_coverage_evidence (
  coverage_evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  subject_reference_key text NOT NULL REFERENCES world_reference_identity(reference_key),
  source_authority text NOT NULL,
  valid_time tstzrange NOT NULL,
  coverage_geometry geometry(Geometry,4326),
  coverage_sufficient boolean NOT NULL,
  evidence_id text NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT isempty(valid_time))
);
CREATE INDEX operational_coverage_subject_idx
  ON operational_coverage_evidence(data_scope_key,subject_reference_key,source_authority);
CREATE INDEX operational_coverage_time_idx ON operational_coverage_evidence USING gist(valid_time);

CREATE TABLE operational_observation_gap (
  observation_gap_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  subject_reference_key text NOT NULL REFERENCES world_reference_identity(reference_key),
  source_authority text NOT NULL,
  gap_time tstzrange NOT NULL,
  evidence_id text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT isempty(gap_time))
);
CREATE INDEX operational_observation_gap_subject_idx
  ON operational_observation_gap(data_scope_key,subject_reference_key,source_authority);
CREATE INDEX operational_observation_gap_time_idx ON operational_observation_gap USING gist(gap_time);

CREATE TABLE operational_observability_assessment (
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  assessment_id text NOT NULL,
  subject_reference_key text,
  request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
  output jsonb NOT NULL CHECK (jsonb_typeof(output)='object'),
  evidence_snapshot jsonb NOT NULL CHECK (jsonb_typeof(evidence_snapshot)='object'),
  world_version bigint NOT NULL CHECK (world_version>=0),
  policy_version text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(data_scope_key,assessment_id),
  UNIQUE(data_scope_key,input_hash)
);

CREATE FUNCTION enforce_operational_observability_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.world_reference_identity identity
    WHERE identity.reference_key=NEW.subject_reference_key AND identity.data_scope_key=NEW.data_scope_key
  ) THEN RAISE EXCEPTION 'observability evidence reference is unavailable in data scope' USING ERRCODE='23503'; END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER operational_coverage_scope_guard BEFORE INSERT ON operational_coverage_evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_operational_observability_scope();
CREATE TRIGGER operational_gap_scope_guard BEFORE INSERT ON operational_observation_gap
  FOR EACH ROW EXECUTE FUNCTION enforce_operational_observability_scope();

CREATE FUNCTION reject_operational_observability_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'operational observability evidence is append-only' USING ERRCODE='55000';
END
$fn$;

CREATE TRIGGER operational_source_health_immutable BEFORE UPDATE OR DELETE ON operational_source_health_revision
  FOR EACH ROW EXECUTE FUNCTION reject_operational_observability_mutation();
CREATE TRIGGER operational_source_watermark_immutable BEFORE UPDATE OR DELETE ON operational_source_watermark_revision
  FOR EACH ROW EXECUTE FUNCTION reject_operational_observability_mutation();
CREATE TRIGGER operational_coverage_evidence_immutable BEFORE UPDATE OR DELETE ON operational_coverage_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_operational_observability_mutation();
CREATE TRIGGER operational_observation_gap_immutable BEFORE UPDATE OR DELETE ON operational_observation_gap
  FOR EACH ROW EXECUTE FUNCTION reject_operational_observability_mutation();
CREATE TRIGGER operational_observability_assessment_immutable BEFORE UPDATE OR DELETE ON operational_observability_assessment
  FOR EACH ROW EXECUTE FUNCTION reject_operational_observability_mutation();

CREATE FUNCTION compute_operational_observability(
  p_data_scope_key text,p_subject_reference_key text,p_valid_from timestamptz,p_valid_to timestamptz,
  p_expected_sources jsonb,p_freshness_sla_seconds integer,p_world_version bigint,
  p_policy_version text DEFAULT 'operational-observability-v1'
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
DECLARE
  request_value jsonb;
  input_digest text;
  assessment_identifier text;
  entity_kind_value text;
  internal_id_value text;
  last_reliable timestamptz;
  observation_evidence jsonb := '[]'::jsonb;
  sources jsonb := COALESCE(p_expected_sources,'[]'::jsonb);
  expected_count integer;
  healthy_count integer := 0;
  unhealthy_count integer := 0;
  complete_watermark_count integer := 0;
  sufficient_coverage_count integer := 0;
  gap_intervals jsonb := '[]'::jsonb;
  evidence_ids jsonb := '[]'::jsonb;
  coverage_sufficient_value boolean := false;
  status_value text := 'NO_DATA';
  warnings_value jsonb := '[]'::jsonb;
  output_value jsonb;
  evidence_snapshot_value jsonb;
BEGIN
  IF p_freshness_sla_seconds<=0 OR p_world_version<0 OR p_valid_to<p_valid_from OR
     jsonb_typeof(sources)<>'array' OR jsonb_array_length(sources)>100 THEN
    RAISE EXCEPTION 'operational observability request is invalid' USING ERRCODE='22023';
  END IF;
  request_value := jsonb_build_object(
    'dataScopeKey',p_data_scope_key,'subjectReferenceKey',p_subject_reference_key,
    'validFrom',p_valid_from,'validTo',p_valid_to,'expectedSources',sources,
    'freshnessSlaSeconds',p_freshness_sla_seconds,'worldVersion',p_world_version,
    'policyVersion',p_policy_version
  );
  input_digest := public.grounding_sha256(request_value::text);
  assessment_identifier := 'oas_'||substr(input_digest,8,32);

  SELECT entity_kind,internal_id INTO entity_kind_value,internal_id_value
  FROM public.world_reference_identity
  WHERE reference_key=p_subject_reference_key AND data_scope_key=p_data_scope_key;
  IF FOUND THEN
    IF entity_kind_value='WORLD_OBJECT' THEN
      SELECT state.observed_at,
             CASE WHEN state.source_observation_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(state.source_observation_id) END,
             CASE WHEN jsonb_array_length(sources)=0 AND state.source IS NOT NULL THEN jsonb_build_array(state.source) ELSE sources END
      INTO last_reliable,observation_evidence,sources
      FROM public.world_object_state state
      WHERE state.object_id=internal_id_value AND state.version<=p_world_version;
    ELSIF entity_kind_value='OPERATIONAL_TASK' THEN
      SELECT snapshot.last_observed_at,snapshot.evidence_ids INTO last_reliable,observation_evidence
      FROM public.operational_task_snapshot snapshot
      WHERE snapshot.data_scope_key=p_data_scope_key AND snapshot.reference_key=p_subject_reference_key
        AND snapshot.world_version<=p_world_version;
      IF jsonb_array_length(sources)=0 THEN
        SELECT COALESCE(jsonb_agg(source_authority ORDER BY source_authority),'[]'::jsonb) INTO sources
        FROM (SELECT DISTINCT source_authority FROM public.operational_task_event
              WHERE data_scope_key=p_data_scope_key AND operational_task_id=internal_id_value
                AND world_version<=p_world_version) authority;
      END IF;
    END IF;
  END IF;
  expected_count := jsonb_array_length(sources);

  IF expected_count>0 THEN
    WITH expected AS (SELECT jsonb_array_elements_text(sources) AS source_authority),
    latest AS (
      SELECT DISTINCT ON (health.source_authority) health.*
      FROM public.operational_source_health_revision health JOIN expected USING(source_authority)
      WHERE health.data_scope_key=p_data_scope_key AND health.valid_from<=p_valid_to
      ORDER BY health.source_authority,health.valid_from DESC,health.health_revision_id DESC
    )
    SELECT count(*) FILTER (WHERE health_status='HEALTHY'),
           count(*) FILTER (WHERE health_status IN ('DEGRADED','UNHEALTHY')),
           COALESCE(jsonb_agg(evidence_id ORDER BY source_authority),'[]'::jsonb)
    INTO healthy_count,unhealthy_count,evidence_ids FROM latest;

    WITH expected AS (SELECT jsonb_array_elements_text(sources) AS source_authority),
    latest AS (
      SELECT DISTINCT ON (watermark.source_authority) watermark.*
      FROM public.operational_source_watermark_revision watermark JOIN expected USING(source_authority)
      WHERE watermark.data_scope_key=p_data_scope_key
      ORDER BY watermark.source_authority,watermark.created_at DESC,watermark.watermark_revision_id DESC
    )
    SELECT count(*) FILTER (WHERE completeness_state='COMPLETE' AND closed_through_event_time>=p_valid_to),
           evidence_ids || COALESCE(jsonb_agg(evidence_id ORDER BY source_authority),'[]'::jsonb)
    INTO complete_watermark_count,evidence_ids FROM latest;

    WITH expected AS (SELECT jsonb_array_elements_text(sources) AS source_authority),
    covered AS (
      SELECT DISTINCT coverage.source_authority,coverage.evidence_id
      FROM public.operational_coverage_evidence coverage JOIN expected USING(source_authority)
      WHERE coverage.data_scope_key=p_data_scope_key AND coverage.subject_reference_key=p_subject_reference_key
        AND coverage.coverage_sufficient AND coverage.valid_time @> tstzrange(p_valid_from,p_valid_to,'[)')
    )
    SELECT count(*),evidence_ids || COALESCE(jsonb_agg(evidence_id ORDER BY source_authority),'[]'::jsonb)
    INTO sufficient_coverage_count,evidence_ids FROM covered;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('from',lower(gap_time),'to',upper(gap_time)) ORDER BY lower(gap_time),observation_gap_id),'[]'::jsonb),
         evidence_ids || COALESCE(jsonb_agg(evidence_id ORDER BY lower(gap_time),observation_gap_id),'[]'::jsonb)
  INTO gap_intervals,evidence_ids
  FROM public.operational_observation_gap
  WHERE data_scope_key=p_data_scope_key AND subject_reference_key=p_subject_reference_key
    AND gap_time && tstzrange(p_valid_from,p_valid_to,'[]');

  evidence_ids := (SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb)
                   FROM (SELECT DISTINCT value FROM jsonb_array_elements_text(evidence_ids||observation_evidence)) values);
  coverage_sufficient_value := expected_count>0 AND healthy_count=expected_count AND
    complete_watermark_count=expected_count AND sufficient_coverage_count=expected_count;

  IF internal_id_value IS NULL OR last_reliable IS NULL THEN status_value := 'NO_DATA';
  ELSIF unhealthy_count>0 THEN status_value := 'SOURCE_UNHEALTHY';
  ELSIF jsonb_array_length(gap_intervals)>0 THEN status_value := 'OBSERVATION_GAP';
  ELSIF p_valid_to-last_reliable>make_interval(secs=>p_freshness_sla_seconds) THEN status_value := 'STALE';
  ELSIF NOT coverage_sufficient_value THEN status_value := 'INDETERMINATE';
  ELSE status_value := 'FRESH'; END IF;
  IF NOT coverage_sufficient_value THEN warnings_value := jsonb_build_array('coverage, watermark, or source health prerequisites are incomplete'); END IF;

  output_value := jsonb_strip_nulls(jsonb_build_object(
    'assessmentId',assessment_identifier,'status',status_value,
    'coverageSufficient',coverage_sufficient_value,'lastReliableObservationAt',last_reliable,
    'gapIntervals',gap_intervals,'evidenceIds',evidence_ids,'policyVersion',p_policy_version,
    'worldVersion',p_world_version,'warnings',warnings_value
  ));
  evidence_snapshot_value := jsonb_build_object(
    'expectedSources',sources,'healthySourceCount',healthy_count,'unhealthySourceCount',unhealthy_count,
    'completeWatermarkCount',complete_watermark_count,'sufficientCoverageCount',sufficient_coverage_count,
    'requestedSourceCount',expected_count
  );
  RETURN jsonb_build_object('output',output_value,'request',request_value,'evidenceSnapshot',evidence_snapshot_value,
    'inputHash',input_digest,'resultHash',public.grounding_sha256(output_value::text));
END
$fn$;

CREATE FUNCTION record_operational_observability(
  p_data_scope_key text,p_subject_reference_key text,p_valid_from timestamptz,p_valid_to timestamptz,
  p_expected_sources jsonb,p_freshness_sla_seconds integer,p_policy_version text DEFAULT 'operational-observability-v1'
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE evidence_version bigint;computed jsonb;output_value jsonb;
BEGIN
  SELECT last_value INTO evidence_version FROM public.world_version_seq;
  computed := public.compute_operational_observability(
    p_data_scope_key,p_subject_reference_key,p_valid_from,p_valid_to,p_expected_sources,
    p_freshness_sla_seconds,evidence_version,p_policy_version);
  output_value := computed->'output';
  INSERT INTO public.operational_observability_assessment(
    data_scope_key,assessment_id,subject_reference_key,request,output,evidence_snapshot,
    world_version,policy_version,input_hash,result_hash
  ) VALUES (
    p_data_scope_key,output_value->>'assessmentId',p_subject_reference_key,computed->'request',output_value,
    computed->'evidenceSnapshot',evidence_version,p_policy_version,computed->>'inputHash',computed->>'resultHash'
  ) ON CONFLICT(data_scope_key,assessment_id) DO NOTHING;
  RETURN output_value->>'assessmentId';
END
$fn$;

CREATE VIEW gowm_operational_reality_v1.observability_assessment AS
SELECT assessment_id,subject_reference_key,output,evidence_snapshot,world_version,
       policy_version,result_hash,created_at
FROM operational_observability_assessment assessment
WHERE assessment.data_scope_key=gowm_operational_reality_v1.current_data_scope_key();

ALTER TABLE external_predicate_evaluation ADD COLUMN observability_assessment jsonb;

CREATE OR REPLACE FUNCTION record_external_predicate_evaluation(
  p_data_scope_key text,p_predicate jsonb,p_method_version text DEFAULT 'predicate-evaluator-v1'
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE
  evidence_version bigint;computed jsonb;output_value jsonb;assessment_id_value text;
  assessment_value jsonb;assessment_snapshot jsonb;subject_reference text:=p_predicate#>>'{subject,id}';
  sla_seconds integer:=COALESCE((p_predicate#>>'{parameters,freshnessSlaSeconds}')::integer,300);
  valid_from_value timestamptz:=COALESCE(NULLIF(p_predicate#>>'{validTime,from}','')::timestamptz,clock_timestamp()-make_interval(secs=>sla_seconds));
  valid_to_value timestamptz:=COALESCE(NULLIF(p_predicate#>>'{validTime,to}','')::timestamptz,clock_timestamp());
  expected_sources jsonb:=COALESCE(p_predicate#>'{parameters,expectedSources}','[]'::jsonb);
BEGIN
  SELECT last_value INTO evidence_version FROM public.world_version_seq;
  computed:=public.compute_external_predicate_evaluation(p_data_scope_key,p_predicate,evidence_version,p_method_version);
  output_value:=computed->'output';
  assessment_id_value:=public.record_operational_observability(
    p_data_scope_key,subject_reference,valid_from_value,valid_to_value,expected_sources,sla_seconds,'operational-observability-v1');
  SELECT output,evidence_snapshot INTO assessment_value,assessment_snapshot
  FROM public.operational_observability_assessment
  WHERE data_scope_key=p_data_scope_key AND assessment_id=assessment_id_value;
  output_value:=output_value||jsonb_build_object('observabilityAssessment',assessment_value);
  IF output_value->>'status'='NOT_SUPPORTED' AND (
    COALESCE((assessment_value->>'coverageSufficient')::boolean,false)=false OR assessment_value->>'status'<>'FRESH'
  ) THEN
    output_value:=jsonb_set(output_value,'{status}','"INDETERMINATE"'::jsonb);
    output_value:=jsonb_set(output_value,'{warnings}',
      (output_value->'warnings')||jsonb_build_array('negative result withheld by observability assessment'));
  END IF;
  INSERT INTO public.external_predicate_evaluation(
    data_scope_key,evaluation_id,predicate_id,external_authority,predicate,status,
    evaluated_at_world_version,supporting_evidence_ids,contradicting_evidence_ids,
    evidence_snapshot,observability_assessment,assumptions,warnings,method_version,input_hash,result_hash
  ) VALUES (
    p_data_scope_key,output_value->>'evaluationId',output_value->>'predicateId',p_predicate->>'externalAuthority',
    p_predicate,output_value->>'status',evidence_version,output_value->'supportingEvidenceIds',
    output_value->'contradictingEvidenceIds',(computed->'evidenceSnapshot')||jsonb_build_object('observability',assessment_snapshot),
    assessment_value,output_value->'assumptions',output_value->'warnings',p_method_version,
    computed->>'inputHash',public.grounding_sha256(output_value::text)
  ) ON CONFLICT(data_scope_key,evaluation_id) DO NOTHING;
  RETURN output_value->>'evaluationId';
END
$fn$;

CREATE OR REPLACE VIEW gowm_operational_reality_v1.predicate_evaluation AS
SELECT evaluation.evaluation_id,evaluation.predicate_id,evaluation.status,
       evaluation.evaluated_at_world_version,evaluation.supporting_evidence_ids,
       evaluation.contradicting_evidence_ids,evaluation.assumptions,evaluation.warnings,
       evaluation.method_version,evaluation.result_hash,evaluation.created_at,
       evaluation.observability_assessment
FROM external_predicate_evaluation evaluation
WHERE evaluation.data_scope_key=gowm_operational_reality_v1.current_data_scope_key();

REVOKE ALL ON FUNCTION reject_operational_observability_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_operational_observability_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION compute_operational_observability(text,text,timestamptz,timestamptz,jsonb,integer,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_operational_observability(text,text,timestamptz,timestamptz,jsonb,integer,text) FROM PUBLIC;
REVOKE ALL ON TABLE gowm_operational_reality_v1.observability_assessment FROM PUBLIC;
GRANT SELECT ON gowm_operational_reality_v1.observability_assessment TO gowm_operational_reader;
GRANT EXECUTE ON FUNCTION compute_operational_observability(text,text,timestamptz,timestamptz,jsonb,integer,bigint,text) TO gowm_operational_reader;

COMMIT;
