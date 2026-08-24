BEGIN;

CREATE TABLE external_predicate_evaluation (
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  evaluation_id text NOT NULL CHECK (length(evaluation_id) BETWEEN 1 AND 256),
  predicate_id text NOT NULL CHECK (length(predicate_id) BETWEEN 1 AND 512),
  external_authority text NOT NULL CHECK (length(external_authority) BETWEEN 1 AND 512),
  predicate jsonb NOT NULL CHECK (jsonb_typeof(predicate)='object'),
  status text NOT NULL CHECK (status IN (
    'SUPPORTED','NOT_SUPPORTED','PARTIALLY_SUPPORTED','INDETERMINATE','NO_DATA','CONFLICTING'
  )),
  evaluated_at_world_version bigint NOT NULL CHECK (evaluated_at_world_version>=0),
  supporting_evidence_ids jsonb NOT NULL CHECK (
    jsonb_typeof(supporting_evidence_ids)='array' AND jsonb_array_length(supporting_evidence_ids)<=1000
  ),
  contradicting_evidence_ids jsonb NOT NULL CHECK (
    jsonb_typeof(contradicting_evidence_ids)='array' AND jsonb_array_length(contradicting_evidence_ids)<=1000
  ),
  evidence_snapshot jsonb NOT NULL CHECK (jsonb_typeof(evidence_snapshot)='object'),
  assumptions jsonb NOT NULL CHECK (jsonb_typeof(assumptions)='array' AND jsonb_array_length(assumptions)<=100),
  warnings jsonb NOT NULL CHECK (jsonb_typeof(warnings)='array' AND jsonb_array_length(warnings)<=100),
  method_version text NOT NULL CHECK (length(method_version) BETWEEN 1 AND 128),
  input_hash text NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  result_hash text NOT NULL CHECK (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_scope_key,evaluation_id),
  UNIQUE (data_scope_key,input_hash)
);

CREATE INDEX external_predicate_evaluation_scope_predicate_idx
  ON external_predicate_evaluation(data_scope_key,predicate_id,created_at,evaluation_id);

CREATE FUNCTION compute_external_predicate_evaluation(
  p_data_scope_key text,
  p_predicate jsonb,
  p_evidence_world_version bigint,
  p_method_version text DEFAULT 'predicate-evaluator-v1'
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
DECLARE
  operator_name text := p_predicate->>'operator';
  predicate_id text := p_predicate->>'predicateId';
  subject_reference text := p_predicate#>>'{subject,id}';
  subject_kind text := p_predicate#>>'{subject,kind}';
  object_reference text := p_predicate#>>'{object,id}';
  expected_field text := COALESCE(p_predicate#>>'{object,field}',p_predicate#>>'{parameters,field}');
  expected_value jsonb := COALESCE(p_predicate#>'{object,value}',p_predicate#>'{parameters,value}');
  expected_event_type text := COALESCE(p_predicate#>>'{object,eventType}',p_predicate#>>'{parameters,eventType}');
  opposite_event_type text := p_predicate#>>'{parameters,oppositeEventType}';
  valid_from timestamptz := NULLIF(p_predicate#>>'{validTime,from}','')::timestamptz;
  valid_to timestamptz := NULLIF(p_predicate#>>'{validTime,to}','')::timestamptz;
  status_value text := 'NO_DATA';
  supporting jsonb := '[]'::jsonb;
  contradicting jsonb := '[]'::jsonb;
  assumptions_value jsonb := jsonb_build_array('predicate-evaluation-v1','external-predicate-is-not-world-fact');
  warnings_value jsonb := '[]'::jsonb;
  evidence_snapshot_value jsonb := '{}'::jsonb;
  coverage_sufficient boolean := false;
  task_snapshot record;
  subject_state record;
  object_state record;
  subject_found boolean := false;
  object_found boolean := false;
  subject_internal_id text;
  object_internal_id text;
  subject_geometry geometry;
  object_geometry geometry;
  subject_uncertainty double precision := 0;
  object_uncertainty double precision := 0;
  metric_distance double precision;
  threshold_m double precision;
  actual_value jsonb;
  matching_events jsonb := '[]'::jsonb;
  opposite_events jsonb := '[]'::jsonb;
  confirmed_events jsonb := '[]'::jsonb;
  contradicted_events jsonb := '[]'::jsonb;
  input_digest text;
  evaluation_identifier text;
  output_value jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.data_scope WHERE scope_key=p_data_scope_key) OR
     predicate_id IS NULL OR p_predicate->>'externalAuthority' IS NULL OR
     operator_name NOT IN ('IS_INSIDE','IS_NEAR','INTERSECTS','HAS_REACHED','HAS_STOPPED','HAS_OBSERVED','EVENT_OCCURRED','STATE_EQUALS') OR
     p_evidence_world_version<0 OR (valid_from IS NOT NULL AND valid_to IS NOT NULL AND valid_to<valid_from) THEN
    RAISE EXCEPTION 'external predicate request is invalid' USING ERRCODE='22023';
  END IF;
  input_digest := public.grounding_sha256(jsonb_build_object(
    'dataScopeKey',p_data_scope_key,'predicate',p_predicate,
    'evidenceWorldVersion',p_evidence_world_version,'methodVersion',p_method_version
  )::text);
  evaluation_identifier := 'pev_' || substr(input_digest,8,32);

  IF subject_reference IS NULL THEN
    warnings_value := jsonb_build_array('subject reference is unresolved');
  ELSIF subject_kind='OPERATIONAL_TASK' THEN
    SELECT * INTO task_snapshot FROM public.operational_task_snapshot
    WHERE data_scope_key=p_data_scope_key AND reference_key=subject_reference
      AND world_version<=p_evidence_world_version;
    IF FOUND THEN
      coverage_sufficient := task_snapshot.observability='FRESH';
      supporting := task_snapshot.evidence_ids;
      evidence_snapshot_value := jsonb_build_object(
        'subjectKind','OPERATIONAL_TASK','referenceKey',subject_reference,
        'taskType',task_snapshot.task_type,'controlState',task_snapshot.control_state,
        'activityState',task_snapshot.activity_state,'outcomeVerification',task_snapshot.outcome_verification,
        'observability',task_snapshot.observability,'snapshotHash',task_snapshot.snapshot_hash,
        'coverageSufficient',coverage_sufficient
      );
      SELECT COALESCE(jsonb_agg(event_id ORDER BY event_time,event_id),'[]'::jsonb) INTO confirmed_events
      FROM public.operational_task_event
      WHERE data_scope_key=p_data_scope_key AND operational_task_id=task_snapshot.operational_task_id
        AND world_version<=p_evidence_world_version AND event_type='PHYSICAL_EFFECT_CONFIRMED'
        AND (valid_from IS NULL OR event_time>=valid_from) AND (valid_to IS NULL OR event_time<=valid_to);
      SELECT COALESCE(jsonb_agg(event_id ORDER BY event_time,event_id),'[]'::jsonb) INTO contradicted_events
      FROM public.operational_task_event
      WHERE data_scope_key=p_data_scope_key AND operational_task_id=task_snapshot.operational_task_id
        AND world_version<=p_evidence_world_version AND event_type='PHYSICAL_EFFECT_CONTRADICTED'
        AND (valid_from IS NULL OR event_time>=valid_from) AND (valid_to IS NULL OR event_time<=valid_to);

      IF operator_name='HAS_STOPPED' THEN
        IF NOT coverage_sufficient THEN status_value := 'INDETERMINATE';
        ELSIF task_snapshot.activity_state='STOPPED_OBSERVED' THEN status_value := 'SUPPORTED';
        ELSIF task_snapshot.activity_state IN ('STARTED_OBSERVED','ACTIVE_OBSERVED','PAUSED_OBSERVED') THEN
          status_value := 'NOT_SUPPORTED';contradicting := task_snapshot.evidence_ids;supporting := '[]'::jsonb;
        ELSE status_value := 'INDETERMINATE'; END IF;
      ELSIF operator_name='HAS_OBSERVED' THEN
        status_value := CASE WHEN jsonb_array_length(task_snapshot.evidence_ids)>0 THEN 'SUPPORTED' ELSE 'NO_DATA' END;
      ELSIF operator_name='EVENT_OCCURRED' THEN
        IF expected_event_type IS NULL THEN RAISE EXCEPTION 'EVENT_OCCURRED requires eventType' USING ERRCODE='22023'; END IF;
        SELECT COALESCE(jsonb_agg(event_id ORDER BY event_time,event_id),'[]'::jsonb) INTO matching_events
        FROM public.operational_task_event
        WHERE data_scope_key=p_data_scope_key AND operational_task_id=task_snapshot.operational_task_id
          AND world_version<=p_evidence_world_version AND event_type=expected_event_type
          AND (valid_from IS NULL OR event_time>=valid_from) AND (valid_to IS NULL OR event_time<=valid_to);
        IF jsonb_array_length(matching_events)>0 THEN status_value := 'SUPPORTED';supporting := matching_events;
        ELSIF opposite_event_type IS NOT NULL THEN
          SELECT COALESCE(jsonb_agg(event_id ORDER BY event_time,event_id),'[]'::jsonb) INTO opposite_events
          FROM public.operational_task_event
          WHERE data_scope_key=p_data_scope_key AND operational_task_id=task_snapshot.operational_task_id
            AND world_version<=p_evidence_world_version AND event_type=opposite_event_type
            AND (valid_from IS NULL OR event_time>=valid_from) AND (valid_to IS NULL OR event_time<=valid_to);
          IF coverage_sufficient AND jsonb_array_length(opposite_events)>0 THEN
            status_value := 'NOT_SUPPORTED';supporting := '[]';contradicting := opposite_events;
          ELSE status_value := 'INDETERMINATE'; END IF;
        ELSE status_value := CASE WHEN coverage_sufficient THEN 'INDETERMINATE' ELSE 'INDETERMINATE' END; END IF;
      ELSIF operator_name='STATE_EQUALS' THEN
        IF expected_field IS NULL OR expected_value IS NULL THEN RAISE EXCEPTION 'STATE_EQUALS requires field and value' USING ERRCODE='22023'; END IF;
        actual_value := CASE expected_field
          WHEN 'taskType' THEN to_jsonb(task_snapshot.task_type)
          WHEN 'controlState' THEN to_jsonb(task_snapshot.control_state)
          WHEN 'activityState' THEN to_jsonb(task_snapshot.activity_state)
          WHEN 'outcomeVerification' THEN to_jsonb(task_snapshot.outcome_verification)
          WHEN 'observability' THEN to_jsonb(task_snapshot.observability)
          ELSE NULL END;
        IF expected_field='outcomeVerification' AND jsonb_array_length(confirmed_events)>0 AND jsonb_array_length(contradicted_events)>0 THEN
          status_value := 'CONFLICTING';supporting := confirmed_events;contradicting := contradicted_events;
        ELSIF actual_value IS NULL THEN status_value := 'NO_DATA';
        ELSIF actual_value=expected_value THEN status_value := 'SUPPORTED';
        ELSIF coverage_sufficient THEN status_value := 'NOT_SUPPORTED';contradicting := task_snapshot.evidence_ids;supporting := '[]';
        ELSE status_value := 'INDETERMINATE'; END IF;
        evidence_snapshot_value := evidence_snapshot_value || jsonb_build_object(
          'field',expected_field,'actualValue',actual_value,'expectedValue',expected_value,
          'confirmedEvidenceIds',confirmed_events,'contradictedEvidenceIds',contradicted_events
        );
      ELSE
        status_value := 'NO_DATA';warnings_value := jsonb_build_array('operator requires a spatial/world-object subject');
      END IF;
    END IF;
  ELSIF subject_kind IN ('WORLD_OBJECT','SPATIAL_OBJECT') THEN
    IF subject_kind='WORLD_OBJECT' THEN
      SELECT identity.internal_id INTO subject_internal_id FROM public.world_reference_identity identity
      WHERE identity.reference_key=subject_reference AND identity.data_scope_key=p_data_scope_key
        AND identity.entity_kind='WORLD_OBJECT';
      SELECT state.*,geometry.geometry INTO subject_state FROM public.world_object_state state
      LEFT JOIN public.world_object_geometry geometry ON geometry.object_id=state.object_id
      WHERE state.object_id=subject_internal_id AND state.version<=p_evidence_world_version;
      IF FOUND THEN
        subject_found := true;
        subject_geometry := subject_state.geometry;
        subject_uncertainty := COALESCE(
          (subject_state.uncertainty_summary->>'accuracyRadiusM')::double precision,
          (subject_state.uncertainty_summary->>'horizontalStddevM')::double precision,0
        );
        coverage_sufficient := subject_state.observed_at IS NOT NULL AND
          ((valid_from IS NOT NULL OR valid_to IS NOT NULL) OR clock_timestamp()-subject_state.observed_at<=interval '5 minutes') AND
          (valid_from IS NULL OR subject_state.observed_at>=valid_from) AND
          (valid_to IS NULL OR subject_state.observed_at<=valid_to);
        supporting := CASE WHEN subject_state.source_observation_id IS NULL THEN '[]'::jsonb
                           ELSE jsonb_build_array(subject_state.source_observation_id) END;
      END IF;
    ELSE
      SELECT identity.internal_id INTO subject_internal_id FROM public.world_reference_identity identity
      WHERE identity.reference_key=subject_reference AND identity.data_scope_key=p_data_scope_key
        AND identity.entity_kind='SPATIAL_OBJECT';
      SELECT ST_Transform(version.geometry,4326) INTO subject_geometry
      FROM public.spatial_object_version version
      WHERE version.spatial_object_id=subject_internal_id::uuid
      ORDER BY version.version_no DESC LIMIT 1;
      coverage_sufficient := subject_geometry IS NOT NULL;
      subject_found := subject_geometry IS NOT NULL;
      IF subject_found THEN supporting := jsonb_build_array('reference:' || subject_reference); END IF;
    END IF;

    IF operator_name='HAS_OBSERVED' THEN
      status_value := CASE WHEN subject_found AND subject_kind='WORLD_OBJECT' AND
        subject_state.source_observation_id IS NOT NULL THEN 'SUPPORTED' ELSE 'NO_DATA' END;
    ELSIF operator_name='STATE_EQUALS' AND subject_kind='WORLD_OBJECT' THEN
      IF expected_field IS NULL OR expected_value IS NULL THEN RAISE EXCEPTION 'STATE_EQUALS requires field and value' USING ERRCODE='22023'; END IF;
      IF subject_found THEN actual_value := subject_state.state->expected_field; END IF;
      IF actual_value IS NULL THEN status_value := 'NO_DATA';
      ELSIF actual_value=expected_value THEN status_value := 'SUPPORTED';
      ELSIF coverage_sufficient THEN status_value := 'NOT_SUPPORTED';contradicting := supporting;supporting := '[]';
      ELSE status_value := 'INDETERMINATE'; END IF;
    ELSIF operator_name IN ('IS_INSIDE','IS_NEAR','INTERSECTS','HAS_REACHED') THEN
      IF object_reference IS NULL THEN RAISE EXCEPTION 'spatial predicate requires an object ReferenceKey' USING ERRCODE='22023'; END IF;
      SELECT identity.internal_id INTO object_internal_id FROM public.world_reference_identity identity
      WHERE identity.reference_key=object_reference AND identity.data_scope_key=p_data_scope_key;
      IF EXISTS (SELECT 1 FROM public.world_reference_identity WHERE reference_key=object_reference AND data_scope_key=p_data_scope_key AND entity_kind='WORLD_OBJECT') THEN
        SELECT state.*,geometry.geometry INTO object_state FROM public.world_object_state state
        LEFT JOIN public.world_object_geometry geometry ON geometry.object_id=state.object_id
        WHERE state.object_id=object_internal_id AND state.version<=p_evidence_world_version;
        IF FOUND THEN
          object_found := true;
          object_geometry := object_state.geometry;
          object_uncertainty := COALESCE(
            (object_state.uncertainty_summary->>'accuracyRadiusM')::double precision,
            (object_state.uncertainty_summary->>'horizontalStddevM')::double precision,0
          );
          IF object_state.source_observation_id IS NOT NULL THEN supporting := supporting || jsonb_build_array(object_state.source_observation_id); END IF;
          coverage_sufficient := coverage_sufficient AND object_state.observed_at IS NOT NULL AND
            ((valid_from IS NOT NULL OR valid_to IS NOT NULL) OR clock_timestamp()-object_state.observed_at<=interval '5 minutes') AND
            (valid_from IS NULL OR object_state.observed_at>=valid_from) AND
            (valid_to IS NULL OR object_state.observed_at<=valid_to);
        END IF;
      ELSIF EXISTS (SELECT 1 FROM public.world_reference_identity WHERE reference_key=object_reference AND data_scope_key=p_data_scope_key AND entity_kind='SPATIAL_OBJECT') THEN
        SELECT ST_Transform(version.geometry,4326) INTO object_geometry
        FROM public.spatial_object_version version WHERE version.spatial_object_id=object_internal_id::uuid
        ORDER BY version.version_no DESC LIMIT 1;
        object_found := object_geometry IS NOT NULL;
        IF object_found THEN supporting := supporting || jsonb_build_array('reference:' || object_reference); END IF;
      END IF;
      IF subject_geometry IS NULL OR object_geometry IS NULL THEN status_value := 'NO_DATA';
      ELSIF operator_name='IS_INSIDE' THEN
        IF ST_Covers(object_geometry,subject_geometry) THEN status_value := 'SUPPORTED';
        ELSIF coverage_sufficient THEN status_value := 'NOT_SUPPORTED';contradicting := supporting;supporting := '[]';
        ELSE status_value := 'INDETERMINATE'; END IF;
      ELSIF operator_name='INTERSECTS' THEN
        IF ST_Intersects(subject_geometry,object_geometry) THEN status_value := 'SUPPORTED';
        ELSIF coverage_sufficient THEN status_value := 'NOT_SUPPORTED';contradicting := supporting;supporting := '[]';
        ELSE status_value := 'INDETERMINATE'; END IF;
      ELSE
        threshold_m := COALESCE((p_predicate#>>'{parameters,thresholdMeters}')::double precision,
                                CASE WHEN operator_name='HAS_REACHED' THEN 5 ELSE NULL END);
        IF threshold_m IS NULL OR threshold_m<0 THEN RAISE EXCEPTION 'metric predicate requires thresholdMeters' USING ERRCODE='22023'; END IF;
        metric_distance := ST_Distance(subject_geometry::geography,object_geometry::geography);
        IF metric_distance+subject_uncertainty+object_uncertainty<=threshold_m THEN status_value := 'SUPPORTED';
        ELSIF metric_distance-subject_uncertainty-object_uncertainty<=threshold_m THEN status_value := 'PARTIALLY_SUPPORTED';
        ELSIF coverage_sufficient THEN status_value := 'NOT_SUPPORTED';contradicting := supporting;supporting := '[]';
        ELSE status_value := 'INDETERMINATE'; END IF;
      END IF;
      evidence_snapshot_value := jsonb_build_object(
        'subjectKind',subject_kind,'subjectReferenceKey',subject_reference,'objectReferenceKey',object_reference,
        'subjectGeometry',CASE WHEN subject_geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(subject_geometry)::jsonb END,
        'objectGeometry',CASE WHEN object_geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(object_geometry)::jsonb END,
        'distanceMeters',metric_distance,'thresholdMeters',threshold_m,
        'combinedUncertaintyMeters',subject_uncertainty+object_uncertainty,'coverageSufficient',coverage_sufficient
      );
    ELSE status_value := 'NO_DATA'; END IF;
  END IF;

  IF status_value='INDETERMINATE' THEN warnings_value := warnings_value || jsonb_build_array('observability or opposite evidence is insufficient'); END IF;
  IF status_value='NOT_SUPPORTED' AND jsonb_array_length(contradicting)=0 THEN
    status_value := 'INDETERMINATE';
    warnings_value := warnings_value || jsonb_build_array('negative result withheld because explicit opposite evidence is absent');
  END IF;
  IF status_value='NO_DATA' THEN supporting := '[]';contradicting := '[]'; END IF;
  evidence_snapshot_value := evidence_snapshot_value || jsonb_build_object(
    'operator',operator_name,'coverageSufficient',coverage_sufficient,
    'evaluatedAtWorldVersion',p_evidence_world_version
  );
  output_value := jsonb_build_object(
    'evaluationId',evaluation_identifier,'predicateId',predicate_id,'status',status_value,
    'evaluatedAtWorldVersion',p_evidence_world_version,'supportingEvidenceIds',supporting,
    'contradictingEvidenceIds',contradicting,'assumptions',assumptions_value,
    'warnings',warnings_value,'methodVersion',p_method_version
  );
  RETURN jsonb_build_object(
    'output',output_value,'evidenceSnapshot',evidence_snapshot_value,'inputHash',input_digest,
    'resultHash',public.grounding_sha256(output_value::text)
  );
END
$fn$;

CREATE FUNCTION record_external_predicate_evaluation(
  p_data_scope_key text,
  p_predicate jsonb,
  p_method_version text DEFAULT 'predicate-evaluator-v1'
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
DECLARE
  evidence_version bigint;
  computed jsonb;
  output_value jsonb;
BEGIN
  SELECT last_value INTO evidence_version FROM public.world_version_seq;
  computed := public.compute_external_predicate_evaluation(
    p_data_scope_key,p_predicate,evidence_version,p_method_version
  );
  output_value := computed->'output';
  INSERT INTO public.external_predicate_evaluation(
    data_scope_key,evaluation_id,predicate_id,external_authority,predicate,status,
    evaluated_at_world_version,supporting_evidence_ids,contradicting_evidence_ids,
    evidence_snapshot,assumptions,warnings,method_version,input_hash,result_hash
  ) VALUES (
    p_data_scope_key,output_value->>'evaluationId',output_value->>'predicateId',
    p_predicate->>'externalAuthority',p_predicate,output_value->>'status',evidence_version,
    output_value->'supportingEvidenceIds',output_value->'contradictingEvidenceIds',
    computed->'evidenceSnapshot',output_value->'assumptions',output_value->'warnings',p_method_version,
    computed->>'inputHash',computed->>'resultHash'
  ) ON CONFLICT (data_scope_key,evaluation_id) DO NOTHING;
  RETURN output_value->>'evaluationId';
END
$fn$;

CREATE FUNCTION reject_predicate_evaluation_mutation()
RETURNS trigger LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'external predicate evaluation is append-only' USING ERRCODE='55000';
END
$fn$;

CREATE TRIGGER external_predicate_evaluation_immutable
  BEFORE UPDATE OR DELETE ON external_predicate_evaluation
  FOR EACH ROW EXECUTE FUNCTION reject_predicate_evaluation_mutation();

CREATE VIEW gowm_operational_reality_v1.predicate_evaluation AS
SELECT evaluation.evaluation_id,evaluation.predicate_id,evaluation.status,
       evaluation.evaluated_at_world_version,evaluation.supporting_evidence_ids,
       evaluation.contradicting_evidence_ids,evaluation.assumptions,evaluation.warnings,
       evaluation.method_version,evaluation.result_hash,evaluation.created_at
FROM external_predicate_evaluation evaluation
WHERE evaluation.data_scope_key=gowm_operational_reality_v1.current_data_scope_key();

REVOKE ALL ON FUNCTION compute_external_predicate_evaluation(text,jsonb,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_external_predicate_evaluation(text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_predicate_evaluation_mutation() FROM PUBLIC;
REVOKE ALL ON TABLE gowm_operational_reality_v1.predicate_evaluation FROM PUBLIC;
GRANT SELECT ON gowm_operational_reality_v1.predicate_evaluation TO gowm_operational_reader;
GRANT EXECUTE ON FUNCTION compute_external_predicate_evaluation(text,jsonb,bigint,text) TO gowm_operational_reader;

COMMIT;
