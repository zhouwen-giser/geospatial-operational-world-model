BEGIN;

ALTER TABLE world_observation
  ADD COLUMN execution_intent_id text CHECK (execution_intent_id IS NULL OR length(execution_intent_id) BETWEEN 1 AND 512),
  ADD COLUMN operation_correlation_id text CHECK (operation_correlation_id IS NULL OR length(operation_correlation_id) BETWEEN 1 AND 512),
  ADD COLUMN external_planning_task_id text CHECK (external_planning_task_id IS NULL OR length(external_planning_task_id) BETWEEN 1 AND 512),
  ADD COLUMN external_planning_step_id text CHECK (external_planning_step_id IS NULL OR length(external_planning_step_id) BETWEEN 1 AND 512),
  ADD COLUMN provider_action_id text CHECK (provider_action_id IS NULL OR length(provider_action_id) BETWEEN 1 AND 512),
  ADD COLUMN device_command_id text CHECK (device_command_id IS NULL OR length(device_command_id) BETWEEN 1 AND 512);

ALTER TABLE world_event
  ADD COLUMN data_scope_key text,
  ADD COLUMN execution_intent_id text CHECK (execution_intent_id IS NULL OR length(execution_intent_id) BETWEEN 1 AND 512),
  ADD COLUMN operation_correlation_id text CHECK (operation_correlation_id IS NULL OR length(operation_correlation_id) BETWEEN 1 AND 512),
  ADD COLUMN external_planning_task_id text CHECK (external_planning_task_id IS NULL OR length(external_planning_task_id) BETWEEN 1 AND 512),
  ADD COLUMN external_planning_step_id text CHECK (external_planning_step_id IS NULL OR length(external_planning_step_id) BETWEEN 1 AND 512),
  ADD COLUMN provider_action_id text CHECK (provider_action_id IS NULL OR length(provider_action_id) BETWEEN 1 AND 512),
  ADD COLUMN device_command_id text CHECK (device_command_id IS NULL OR length(device_command_id) BETWEEN 1 AND 512);

-- The pre-v0.4 event envelope did not carry scope directly. Backfill it from
-- its GOWM subject while the migration transaction temporarily permits this
-- metadata-only evolution; all pre-canonical events fall back to `default`.
ALTER TABLE world_event DISABLE TRIGGER world_event_evidence_immutable;
UPDATE world_event event
SET data_scope_key=COALESCE(
  (SELECT object.data_scope_key FROM world_object object WHERE object.id=event.subject_id),
  'default'
)
WHERE event.data_scope_key IS NULL;
ALTER TABLE world_event ENABLE TRIGGER world_event_evidence_immutable;
ALTER TABLE world_event
  ALTER COLUMN data_scope_key SET DEFAULT 'default',
  ALTER COLUMN data_scope_key SET NOT NULL,
  ADD CONSTRAINT world_event_scope_fk FOREIGN KEY (data_scope_key) REFERENCES data_scope(scope_key);

CREATE INDEX world_observation_scope_operation_correlation_idx
  ON world_observation(data_scope_key,operation_correlation_id,observed_at DESC)
  WHERE operation_correlation_id IS NOT NULL;
CREATE INDEX world_event_scope_time_idx
  ON world_event(data_scope_key,event_time DESC,event_id);
CREATE INDEX world_event_scope_operation_correlation_idx
  ON world_event(data_scope_key,operation_correlation_id,event_time DESC)
  WHERE operation_correlation_id IS NOT NULL;

CREATE TABLE external_correlation_claim (
  claim_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  source_kind text NOT NULL CHECK (source_kind IN ('OBSERVATION','WORLD_EVENT','OPERATIONAL_EVENT')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 512),
  external_authority text NOT NULL CHECK (length(external_authority) BETWEEN 1 AND 512),
  external_kind text NOT NULL CHECK (external_kind IN (
    'PLANNING_TASK','PLANNING_STEP','EXECUTION_INTENT','OPERATION_CORRELATION',
    'PROVIDER_ACTION','DEVICE_COMMAND'
  )),
  external_value text NOT NULL CHECK (length(external_value) BETWEEN 1 AND 512),
  relation_hint text CHECK (relation_hint IS NULL OR relation_hint IN (
    'REPORTS_EXECUTION_OF','REALIZES','RELATED_TO'
  )),
  match_basis text NOT NULL CHECK (match_basis IN (
    'PROPAGATED_CORRELATION_ID','PROVIDER_DECLARED','MANUAL_CONFIRMATION',
    'RESOURCE_AND_TIME_MATCH','SPATIOTEMPORAL_INFERENCE'
  )),
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  evidence_ids jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_ids)='array' AND jsonb_array_length(evidence_ids)<=100
  ),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (data_scope_key,source_kind,source_id,external_authority,external_kind,external_value)
);

CREATE INDEX external_correlation_claim_lookup_idx
  ON external_correlation_claim(data_scope_key,external_authority,external_kind,external_value,observed_at DESC);
CREATE INDEX external_correlation_claim_source_idx
  ON external_correlation_claim(data_scope_key,source_kind,source_id,created_at);

CREATE FUNCTION insert_external_correlation_claims(
  p_data_scope_key text,
  p_source_kind text,
  p_source_id text,
  p_external_authority text,
  p_observed_at timestamptz,
  p_received_at timestamptz,
  p_execution_intent_id text,
  p_operation_correlation_id text,
  p_external_planning_task_id text,
  p_external_planning_step_id text,
  p_provider_action_id text,
  p_device_command_id text
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
DECLARE
  inserted_count integer;
BEGIN
  IF p_data_scope_key IS NULL OR p_source_kind NOT IN ('OBSERVATION','WORLD_EVENT','OPERATIONAL_EVENT') OR
     p_source_id IS NULL OR p_external_authority IS NULL OR p_observed_at IS NULL OR p_received_at IS NULL THEN
    RAISE EXCEPTION 'external correlation claim source is incomplete' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.external_correlation_claim(
    data_scope_key,source_kind,source_id,external_authority,external_kind,external_value,
    relation_hint,match_basis,confidence,observed_at,received_at,evidence_ids,content_hash
  )
  SELECT p_data_scope_key,p_source_kind,p_source_id,p_external_authority,claim.external_kind,
         claim.external_value,claim.relation_hint,claim.match_basis,1,p_observed_at,p_received_at,
         jsonb_build_array(p_source_id),
         'sha256:' || encode(digest(convert_to(concat_ws(E'\u001f',p_data_scope_key,p_source_kind,p_source_id,
           p_external_authority,claim.external_kind,claim.external_value,claim.relation_hint,
           claim.match_basis,p_observed_at::text,p_received_at::text),'UTF8'),'sha256'),'hex')
  FROM (VALUES
    ('EXECUTION_INTENT',p_execution_intent_id,'REALIZES','PROPAGATED_CORRELATION_ID'),
    ('OPERATION_CORRELATION',p_operation_correlation_id,'RELATED_TO','PROPAGATED_CORRELATION_ID'),
    ('PLANNING_TASK',p_external_planning_task_id,'REPORTS_EXECUTION_OF','PROPAGATED_CORRELATION_ID'),
    ('PLANNING_STEP',p_external_planning_step_id,'REALIZES','PROPAGATED_CORRELATION_ID'),
    ('PROVIDER_ACTION',p_provider_action_id,'RELATED_TO','PROVIDER_DECLARED'),
    ('DEVICE_COMMAND',p_device_command_id,'RELATED_TO','PROVIDER_DECLARED')
  ) AS claim(external_kind,external_value,relation_hint,match_basis)
  WHERE claim.external_value IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN inserted_count;
END
$fn$;

CREATE FUNCTION capture_observation_external_correlation_claims()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
BEGIN
  PERFORM public.insert_external_correlation_claims(
    NEW.data_scope_key,'OBSERVATION',NEW.observation_id,NEW.source,NEW.observed_at,NEW.received_at,
    NEW.execution_intent_id,NEW.operation_correlation_id,NEW.external_planning_task_id,
    NEW.external_planning_step_id,NEW.provider_action_id,NEW.device_command_id
  );
  RETURN NEW;
END
$fn$;

CREATE FUNCTION capture_world_event_external_correlation_claims()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
BEGIN
  PERFORM public.insert_external_correlation_claims(
    NEW.data_scope_key,'WORLD_EVENT',NEW.event_id::text,
    COALESCE(NULLIF(NEW.payload->>'sourceAuthority',''),'gowm-world-event'),
    NEW.event_time,NEW.created_at,NEW.execution_intent_id,NEW.operation_correlation_id,
    NEW.external_planning_task_id,NEW.external_planning_step_id,NEW.provider_action_id,NEW.device_command_id
  );
  RETURN NEW;
END
$fn$;

CREATE TRIGGER world_observation_external_correlation_claims
  AFTER INSERT ON world_observation
  FOR EACH ROW EXECUTE FUNCTION capture_observation_external_correlation_claims();
CREATE TRIGGER world_event_external_correlation_claims
  AFTER INSERT ON world_event
  FOR EACH ROW EXECUTE FUNCTION capture_world_event_external_correlation_claims();

CREATE FUNCTION reject_external_correlation_claim_mutation()
RETURNS trigger LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'external correlation claim is append-only' USING ERRCODE='55000';
END
$fn$;

CREATE TRIGGER external_correlation_claim_immutable
  BEFORE UPDATE OR DELETE ON external_correlation_claim
  FOR EACH ROW EXECUTE FUNCTION reject_external_correlation_claim_mutation();

REVOKE ALL ON FUNCTION insert_external_correlation_claims(
  text,text,text,text,timestamptz,timestamptz,text,text,text,text,text,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION capture_observation_external_correlation_claims() FROM PUBLIC;
REVOKE ALL ON FUNCTION capture_world_event_external_correlation_claims() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_external_correlation_claim_mutation() FROM PUBLIC;

COMMIT;
