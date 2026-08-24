BEGIN;

CREATE TABLE operational_task_event (
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 256),
  operational_task_id text NOT NULL CHECK (length(operational_task_id) BETWEEN 1 AND 256),
  event_type text NOT NULL CHECK (event_type IN (
    'CONTROL_REQUEST_OBSERVED','CONTROL_ACCEPTED_OBSERVED','CONTROL_REJECTED_OBSERVED',
    'EXECUTION_STARTED_OBSERVED','EXECUTION_PROGRESS_OBSERVED','EXECUTION_PAUSED_OBSERVED',
    'EXECUTION_STOPPED_OBSERVED','CONTROL_COMPLETED_REPORTED',
    'PHYSICAL_EFFECT_PARTIALLY_CONFIRMED','PHYSICAL_EFFECT_CONFIRMED',
    'PHYSICAL_EFFECT_CONTRADICTED','EXECUTION_FAILED_OBSERVED',
    'EXECUTION_CANCELLED_OBSERVED','OBSERVATION_GAP_OPENED','OBSERVATION_GAP_CLOSED'
  )),
  event_time timestamptz NOT NULL,
  received_time timestamptz NOT NULL,
  subject_reference_key jsonb CHECK (
    subject_reference_key IS NULL OR jsonb_typeof(subject_reference_key)='object'
  ),
  actor_reference_keys jsonb NOT NULL CHECK (
    jsonb_typeof(actor_reference_keys)='array' AND jsonb_array_length(actor_reference_keys)<=100
  ),
  target_reference_keys jsonb NOT NULL CHECK (
    jsonb_typeof(target_reference_keys)='array' AND jsonb_array_length(target_reference_keys)<=100
  ),
  geometry_ref text CHECK (geometry_ref IS NULL OR length(geometry_ref) BETWEEN 1 AND 2048),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  provenance jsonb NOT NULL CHECK (
    jsonb_typeof(provenance)='array' AND jsonb_array_length(provenance) BETWEEN 1 AND 100
  ),
  correlation_claims jsonb NOT NULL DEFAULT '[]' CHECK (
    jsonb_typeof(correlation_claims)='array' AND jsonb_array_length(correlation_claims)<=32
  ),
  world_version bigint NOT NULL CHECK (world_version>=0),
  source_authority text NOT NULL CHECK (length(source_authority) BETWEEN 1 AND 128),
  source_event_key text NOT NULL CHECK (length(source_event_key) BETWEEN 1 AND 256),
  source_revision_no integer NOT NULL CHECK (source_revision_no>0),
  arrival_classification text NOT NULL CHECK (arrival_classification IN ('CURRENT','LATE')),
  projection_disposition text NOT NULL CHECK (projection_disposition IN ('PENDING','PENDING_LATE_REPLAY')),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_scope_key,event_id),
  UNIQUE (data_scope_key,source_authority,source_event_key,source_revision_no)
);

CREATE INDEX operational_task_event_timeline_idx
  ON operational_task_event(data_scope_key,operational_task_id,event_time,received_time,event_id);
CREATE INDEX operational_task_event_pending_idx
  ON operational_task_event(data_scope_key,projection_disposition,event_time,received_time,event_id);
CREATE INDEX operational_task_event_received_brin_idx
  ON operational_task_event USING brin(received_time);

CREATE TABLE operational_event_outbox (
  data_scope_key text NOT NULL,
  event_id text NOT NULL,
  topic text NOT NULL CHECK (length(topic) BETWEEN 1 AND 512),
  event_payload jsonb NOT NULL CHECK (jsonb_typeof(event_payload)='object'),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  locked_at timestamptz,
  locked_by text,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_scope_key,event_id),
  FOREIGN KEY (data_scope_key,event_id)
    REFERENCES operational_task_event(data_scope_key,event_id)
);

CREATE INDEX operational_event_outbox_pending_idx
  ON operational_event_outbox(available_at,data_scope_key,event_id)
  WHERE published_at IS NULL;

CREATE FUNCTION reject_operational_task_event_mutation()
RETURNS trigger LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'operational task event is append-only' USING ERRCODE='55000';
END
$fn$;

CREATE TRIGGER operational_task_event_immutable
  BEFORE UPDATE OR DELETE ON operational_task_event
  FOR EACH ROW EXECUTE FUNCTION reject_operational_task_event_mutation();

CREATE FUNCTION protect_operational_event_outbox_payload()
RETURNS trigger LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'operational event outbox evidence is append-only' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['available_at','attempts','locked_at','locked_by','published_at','last_error']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['available_at','attempts','locked_at','locked_by','published_at','last_error']) THEN
    RAISE EXCEPTION 'operational event outbox payload is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER operational_event_outbox_payload_immutable
  BEFORE UPDATE OR DELETE ON operational_event_outbox
  FOR EACH ROW EXECUTE FUNCTION protect_operational_event_outbox_payload();

CREATE FUNCTION enqueue_operational_task_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
BEGIN
  INSERT INTO public.operational_event_outbox(data_scope_key,event_id,topic,event_payload)
  VALUES (
    NEW.data_scope_key,NEW.event_id,
    'gowm/' || NEW.data_scope_key || '/operational-task-events',
    jsonb_strip_nulls(jsonb_build_object(
      'eventId',NEW.event_id,
      'operationalTaskId',NEW.operational_task_id,
      'eventType',NEW.event_type,
      'eventTime',NEW.event_time,
      'receivedTime',NEW.received_time,
      'subjectReferenceKey',NEW.subject_reference_key,
      'actorReferenceKeys',NEW.actor_reference_keys,
      'targetReferenceKeys',NEW.target_reference_keys,
      'geometryRef',NEW.geometry_ref,
      'payload',NEW.payload,
      'confidence',NEW.confidence,
      'provenance',NEW.provenance,
      'correlationClaims',CASE WHEN NEW.correlation_claims='[]'::jsonb THEN NULL ELSE NEW.correlation_claims END,
      'worldVersion',NEW.world_version
    ))
  );
  RETURN NEW;
END
$fn$;

CREATE TRIGGER operational_task_event_outbox
  AFTER INSERT ON operational_task_event
  FOR EACH ROW EXECUTE FUNCTION enqueue_operational_task_event();

CREATE FUNCTION capture_operational_event_correlation_claims()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
BEGIN
  INSERT INTO public.external_correlation_claim(
    data_scope_key,source_kind,source_id,external_authority,external_kind,external_value,
    relation_hint,match_basis,confidence,observed_at,received_at,evidence_ids,content_hash
  )
  SELECT NEW.data_scope_key,'OPERATIONAL_EVENT',NEW.event_id,
         claim->>'externalAuthority',claim->>'externalKind',claim->>'externalValue',
         claim->>'relationHint',claim->>'matchBasis',
         CASE WHEN claim ? 'confidence' THEN (claim->>'confidence')::double precision ELSE NULL END,
         (claim->>'observedAt')::timestamptz,(claim->>'receivedAt')::timestamptz,
         claim->'evidenceIds',
         'sha256:' || encode(digest(convert_to(concat_ws(E'\u001f',NEW.data_scope_key,
           'OPERATIONAL_EVENT',NEW.event_id,claim->>'claimId',claim->>'externalAuthority',
           claim->>'externalKind',claim->>'externalValue',claim->>'matchBasis'),'UTF8'),'sha256'),'hex')
  FROM jsonb_array_elements(NEW.correlation_claims) claim
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER operational_task_event_correlation_claims
  AFTER INSERT ON operational_task_event
  FOR EACH ROW EXECUTE FUNCTION capture_operational_event_correlation_claims();

CREATE FUNCTION ingest_operational_task_event(
  p_data_scope_key text,
  p_source_authority text,
  p_source_event_key text,
  p_source_revision_no integer,
  p_event_id text,
  p_operational_task_id text,
  p_event_type text,
  p_event_time timestamptz,
  p_received_time timestamptz,
  p_subject_reference_key jsonb,
  p_actor_reference_keys jsonb,
  p_target_reference_keys jsonb,
  p_geometry_ref text,
  p_payload jsonb,
  p_confidence double precision,
  p_provenance jsonb,
  p_correlation_claims jsonb,
  p_max_future_skew_ms bigint,
  p_max_late_arrival_ms bigint
)
RETURNS TABLE(
  ingest_status text,
  stored_world_version bigint,
  stored_arrival_classification text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
DECLARE
  existing record;
  semantic_hash text;
  classification text;
  assigned_world_version bigint;
BEGIN
  IF p_data_scope_key IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.data_scope WHERE scope_key=p_data_scope_key
     ) OR p_received_time IS NULL OR p_event_time IS NULL OR
     p_max_future_skew_ms<0 OR p_max_late_arrival_ms<0 THEN
    RAISE EXCEPTION 'operational event ingest parameters are invalid' USING ERRCODE='22023';
  END IF;
  IF p_correlation_claims IS NULL THEN p_correlation_claims := '[]'::jsonb; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_correlation_claims) claim
    WHERE claim->>'externalValue'=p_operational_task_id
  ) THEN
    RAISE EXCEPTION 'operational task identity must differ from external correlation values' USING ERRCODE='22023';
  END IF;

  semantic_hash := 'sha256:' || encode(digest(convert_to(jsonb_build_object(
    'dataScopeKey',p_data_scope_key,'sourceAuthority',p_source_authority,
    'sourceEventKey',p_source_event_key,'sourceRevisionNo',p_source_revision_no,
    'eventId',p_event_id,'operationalTaskId',p_operational_task_id,'eventType',p_event_type,
    'eventTimeEpoch',extract(epoch FROM p_event_time),'subjectReferenceKey',p_subject_reference_key,
    'actorReferenceKeys',p_actor_reference_keys,'targetReferenceKeys',p_target_reference_keys,
    'geometryRef',p_geometry_ref,'payload',p_payload,'confidence',p_confidence,
    'provenance',p_provenance,'correlationClaims',p_correlation_claims
  )::text,'UTF8'),'sha256'),'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_data_scope_key || E'\u001f' || p_event_id,0));
  SELECT event_id,content_hash,world_version,arrival_classification INTO existing
  FROM public.operational_task_event
  WHERE data_scope_key=p_data_scope_key AND event_id=p_event_id;
  IF FOUND THEN
    IF existing.content_hash<>semantic_hash THEN
      RAISE EXCEPTION 'idempotency conflict: immutable operational event differs' USING ERRCODE='23505';
    END IF;
    RETURN QUERY SELECT 'DUPLICATE',existing.world_version,existing.arrival_classification;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(E'\u001f',p_data_scope_key,
    p_source_authority,p_source_event_key,p_source_revision_no::text),0));
  SELECT event_id INTO existing FROM public.operational_task_event
  WHERE data_scope_key=p_data_scope_key AND source_authority=p_source_authority
    AND source_event_key=p_source_event_key AND source_revision_no=p_source_revision_no;
  IF FOUND THEN
    RAISE EXCEPTION 'stable source event revision was retried with a different event id' USING ERRCODE='23505';
  END IF;

  IF p_event_time>p_received_time+make_interval(secs=>p_max_future_skew_ms/1000.0) THEN
    RAISE EXCEPTION 'operational event exceeds future-skew policy' USING ERRCODE='22007';
  END IF;
  classification := CASE
    WHEN p_received_time-p_event_time>make_interval(secs=>p_max_late_arrival_ms/1000.0) THEN 'LATE'
    ELSE 'CURRENT'
  END;
  assigned_world_version := nextval('public.world_version_seq');

  INSERT INTO public.operational_task_event(
    data_scope_key,event_id,operational_task_id,event_type,event_time,received_time,
    subject_reference_key,actor_reference_keys,target_reference_keys,geometry_ref,payload,
    confidence,provenance,correlation_claims,world_version,source_authority,source_event_key,
    source_revision_no,arrival_classification,projection_disposition,content_hash
  ) VALUES (
    p_data_scope_key,p_event_id,p_operational_task_id,p_event_type,p_event_time,p_received_time,
    p_subject_reference_key,p_actor_reference_keys,p_target_reference_keys,p_geometry_ref,p_payload,
    p_confidence,p_provenance,p_correlation_claims,assigned_world_version,p_source_authority,
    p_source_event_key,p_source_revision_no,classification,
    CASE WHEN classification='LATE' THEN 'PENDING_LATE_REPLAY' ELSE 'PENDING' END,
    semantic_hash
  );

  RETURN QUERY SELECT 'ACCEPTED',assigned_world_version,classification;
END
$fn$;

REVOKE ALL ON FUNCTION reject_operational_task_event_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_operational_event_outbox_payload() FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_operational_task_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION capture_operational_event_correlation_claims() FROM PUBLIC;
REVOKE ALL ON FUNCTION ingest_operational_task_event(
  text,text,text,integer,text,text,text,timestamptz,timestamptz,jsonb,jsonb,jsonb,text,
  jsonb,double precision,jsonb,jsonb,bigint,bigint
) FROM PUBLIC;

COMMIT;
