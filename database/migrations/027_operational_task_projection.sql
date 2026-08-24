BEGIN;

CREATE TABLE operational_projection_policy (
  policy_version text PRIMARY KEY CHECK (length(policy_version) BETWEEN 1 AND 128),
  source_priorities jsonb NOT NULL CHECK (jsonb_typeof(source_priorities)='object'),
  default_source_priority integer NOT NULL CHECK (default_source_priority BETWEEN 0 AND 1000),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO operational_projection_policy(policy_version,source_priorities,default_source_priority,content_hash)
VALUES (
  'operational-projection-v1',
  '{"manual":100,"operator":100,"physical-sensor":90,"provider":70,"simulation":50}',
  60,
  grounding_sha256('{"default":60,"manual":100,"operator":100,"physical-sensor":90,"provider":70,"simulation":50}')
);

CREATE TABLE operational_task (
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  operational_task_id text NOT NULL CHECK (length(operational_task_id) BETWEEN 1 AND 256),
  reference_key text NOT NULL UNIQUE REFERENCES world_reference_identity(reference_key),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_scope_key,operational_task_id)
);

CREATE TABLE operational_task_snapshot (
  data_scope_key text NOT NULL,
  operational_task_id text NOT NULL,
  reference_key text NOT NULL UNIQUE REFERENCES world_reference_identity(reference_key),
  task_type text NOT NULL CHECK (length(task_type) BETWEEN 1 AND 256),
  control_state text NOT NULL CHECK (control_state IN (
    'NO_CONTROL_EVENT','REQUESTED_OBSERVED','ACCEPTED_OBSERVED','REJECTED_OBSERVED',
    'COMPLETED_REPORTED','FAILED_REPORTED','CANCELLED_REPORTED'
  )),
  activity_state text NOT NULL CHECK (activity_state IN (
    'NOT_OBSERVED','STARTED_OBSERVED','ACTIVE_OBSERVED','PAUSED_OBSERVED','STOPPED_OBSERVED','UNKNOWN'
  )),
  outcome_verification text NOT NULL CHECK (outcome_verification IN (
    'NOT_APPLICABLE','UNVERIFIED','PARTIALLY_VERIFIED','VERIFIED','CONTRADICTED','INDETERMINATE'
  )),
  observability text NOT NULL CHECK (observability IN ('FRESH','STALE','OBSERVATION_GAP','NO_DATA')),
  actor_reference_keys jsonb NOT NULL CHECK (
    jsonb_typeof(actor_reference_keys)='array' AND jsonb_array_length(actor_reference_keys)<=100
  ),
  target_reference_keys jsonb NOT NULL CHECK (
    jsonb_typeof(target_reference_keys)='array' AND jsonb_array_length(target_reference_keys)<=100
  ),
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  last_received_at timestamptz,
  evidence_ids jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_ids)='array' AND jsonb_array_length(evidence_ids)<=1000
  ),
  correlation_claim_summary jsonb NOT NULL CHECK (jsonb_typeof(correlation_claim_summary)='object'),
  world_version bigint NOT NULL CHECK (world_version>=0),
  projection_policy_version text NOT NULL REFERENCES operational_projection_policy(policy_version),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_scope_key,operational_task_id),
  FOREIGN KEY (data_scope_key,operational_task_id)
    REFERENCES operational_task(data_scope_key,operational_task_id)
);

CREATE INDEX operational_task_snapshot_scope_state_idx
  ON operational_task_snapshot(data_scope_key,control_state,activity_state,outcome_verification,observability,updated_at DESC);
CREATE INDEX operational_task_snapshot_scope_time_idx
  ON operational_task_snapshot(data_scope_key,last_observed_at DESC,operational_task_id);

CREATE TABLE operational_projection_queue (
  data_scope_key text NOT NULL,
  event_id text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  locked_at timestamptz,
  locked_by text,
  processed_at timestamptz,
  last_error text,
  PRIMARY KEY (data_scope_key,event_id),
  FOREIGN KEY (data_scope_key,event_id)
    REFERENCES operational_task_event(data_scope_key,event_id)
);

CREATE INDEX operational_projection_queue_pending_idx
  ON operational_projection_queue(available_at,data_scope_key,event_id)
  WHERE processed_at IS NULL;

CREATE TABLE operational_projection_audit (
  projection_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL,
  operational_task_id text NOT NULL,
  triggering_event_id text,
  projection_kind text NOT NULL CHECK (projection_kind IN ('LIVE','LATE_REPLAY','FULL_REBUILD')),
  policy_version text NOT NULL REFERENCES operational_projection_policy(policy_version),
  prior_snapshot_hash text CHECK (prior_snapshot_hash IS NULL OR prior_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  world_version bigint NOT NULL CHECK (world_version>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (data_scope_key,operational_task_id)
    REFERENCES operational_task(data_scope_key,operational_task_id)
);

CREATE INDEX operational_projection_audit_task_version_idx
  ON operational_projection_audit(data_scope_key,operational_task_id,world_version,projection_id);

CREATE FUNCTION reject_operational_projection_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only',TG_TABLE_NAME USING ERRCODE='55000';
END
$fn$;

CREATE TRIGGER operational_projection_policy_immutable
  BEFORE UPDATE OR DELETE ON operational_projection_policy
  FOR EACH ROW EXECUTE FUNCTION reject_operational_projection_evidence_mutation();
CREATE TRIGGER operational_task_immutable
  BEFORE UPDATE OR DELETE ON operational_task
  FOR EACH ROW EXECUTE FUNCTION reject_operational_projection_evidence_mutation();
CREATE TRIGGER operational_projection_audit_immutable
  BEFORE UPDATE OR DELETE ON operational_projection_audit
  FOR EACH ROW EXECUTE FUNCTION reject_operational_projection_evidence_mutation();

CREATE FUNCTION protect_operational_task_snapshot_write()
RETURNS trigger LANGUAGE plpgsql
AS $fn$
BEGIN
  IF current_setting('gowm.operational_projection_write',true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'operational task snapshot is projection-owned' USING ERRCODE='42501';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END
$fn$;

CREATE TRIGGER operational_task_snapshot_projection_owned
  BEFORE INSERT OR UPDATE OR DELETE ON operational_task_snapshot
  FOR EACH ROW EXECUTE FUNCTION protect_operational_task_snapshot_write();

CREATE FUNCTION operational_source_priority(p_source_authority text,p_policy_version text)
RETURNS integer LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
  SELECT COALESCE(
    CASE WHEN policy.source_priorities ? lower(p_source_authority)
      THEN (policy.source_priorities->>lower(p_source_authority))::integer END,
    CASE WHEN position('manual' IN lower(p_source_authority))>0 THEN 100 END,
    CASE WHEN position('operator' IN lower(p_source_authority))>0 THEN 100 END,
    CASE WHEN position('sensor' IN lower(p_source_authority))>0 THEN 90 END,
    CASE WHEN position('provider' IN lower(p_source_authority))>0 THEN 70 END,
    policy.default_source_priority
  )
  FROM operational_projection_policy policy WHERE policy.policy_version=p_policy_version
$fn$;

CREATE FUNCTION compute_operational_task_snapshot(
  p_data_scope_key text,
  p_operational_task_id text,
  p_policy_version text
)
RETURNS jsonb LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
  WITH event_rows AS (
    SELECT event.*,
           operational_source_priority(event.source_authority,p_policy_version) AS source_priority,
           COALESCE(event.confidence,0) AS effective_confidence
    FROM operational_task_event event
    WHERE event.data_scope_key=p_data_scope_key
      AND event.operational_task_id=p_operational_task_id
  ),
  summary AS (
    SELECT min(event_time) AS first_observed_at,max(event_time) AS last_observed_at,
           max(received_time) AS last_received_at,count(*) AS event_count
    FROM event_rows
  ),
  control AS (
    SELECT CASE event_type
      WHEN 'CONTROL_REQUEST_OBSERVED' THEN 'REQUESTED_OBSERVED'
      WHEN 'CONTROL_ACCEPTED_OBSERVED' THEN 'ACCEPTED_OBSERVED'
      WHEN 'CONTROL_REJECTED_OBSERVED' THEN 'REJECTED_OBSERVED'
      WHEN 'CONTROL_COMPLETED_REPORTED' THEN 'COMPLETED_REPORTED'
      WHEN 'EXECUTION_FAILED_OBSERVED' THEN 'FAILED_REPORTED'
      WHEN 'EXECUTION_CANCELLED_OBSERVED' THEN 'CANCELLED_REPORTED'
    END AS value
    FROM event_rows
    WHERE event_type IN (
      'CONTROL_REQUEST_OBSERVED','CONTROL_ACCEPTED_OBSERVED','CONTROL_REJECTED_OBSERVED',
      'CONTROL_COMPLETED_REPORTED','EXECUTION_FAILED_OBSERVED','EXECUTION_CANCELLED_OBSERVED'
    )
    ORDER BY event_time DESC,source_priority DESC,effective_confidence DESC,event_id DESC LIMIT 1
  ),
  activity AS (
    SELECT CASE event_type
      WHEN 'EXECUTION_STARTED_OBSERVED' THEN 'STARTED_OBSERVED'
      WHEN 'EXECUTION_PROGRESS_OBSERVED' THEN 'ACTIVE_OBSERVED'
      WHEN 'EXECUTION_PAUSED_OBSERVED' THEN 'PAUSED_OBSERVED'
      WHEN 'EXECUTION_STOPPED_OBSERVED' THEN 'STOPPED_OBSERVED'
    END AS value
    FROM event_rows
    WHERE event_type IN (
      'EXECUTION_STARTED_OBSERVED','EXECUTION_PROGRESS_OBSERVED',
      'EXECUTION_PAUSED_OBSERVED','EXECUTION_STOPPED_OBSERVED'
    )
    ORDER BY event_time DESC,source_priority DESC,effective_confidence DESC,event_id DESC LIMIT 1
  ),
  physical_outcome AS (
    SELECT CASE event_type
      WHEN 'PHYSICAL_EFFECT_PARTIALLY_CONFIRMED' THEN 'PARTIALLY_VERIFIED'
      WHEN 'PHYSICAL_EFFECT_CONFIRMED' THEN 'VERIFIED'
      WHEN 'PHYSICAL_EFFECT_CONTRADICTED' THEN 'CONTRADICTED'
    END AS value
    FROM event_rows
    WHERE event_type IN (
      'PHYSICAL_EFFECT_PARTIALLY_CONFIRMED','PHYSICAL_EFFECT_CONFIRMED','PHYSICAL_EFFECT_CONTRADICTED'
    )
    ORDER BY event_time DESC,source_priority DESC,effective_confidence DESC,event_id DESC LIMIT 1
  ),
  gap AS (
    SELECT CASE event_type WHEN 'OBSERVATION_GAP_OPENED' THEN 'OBSERVATION_GAP' ELSE 'FRESH' END AS value
    FROM event_rows WHERE event_type IN ('OBSERVATION_GAP_OPENED','OBSERVATION_GAP_CLOSED')
    ORDER BY event_time DESC,source_priority DESC,effective_confidence DESC,event_id DESC LIMIT 1
  ),
  task_type AS (
    SELECT NULLIF(payload->>'taskType','') AS value FROM event_rows
    WHERE NULLIF(payload->>'taskType','') IS NOT NULL
    ORDER BY event_time DESC,source_priority DESC,effective_confidence DESC,event_id DESC LIMIT 1
  ),
  actors AS (
    SELECT COALESCE(jsonb_agg(item ORDER BY item::text),'[]'::jsonb) AS value FROM (
      SELECT DISTINCT actor.item FROM event_rows
      CROSS JOIN LATERAL jsonb_array_elements(actor_reference_keys) actor(item)
    ) unique_actors
  ),
  targets AS (
    SELECT COALESCE(jsonb_agg(item ORDER BY item::text),'[]'::jsonb) AS value FROM (
      SELECT DISTINCT target.item FROM event_rows
      CROSS JOIN LATERAL jsonb_array_elements(target_reference_keys) target(item)
    ) unique_targets
  ),
  evidence AS (
    SELECT COALESCE(jsonb_agg(event_id ORDER BY event_time,source_priority,effective_confidence,event_id),'[]'::jsonb) AS value
    FROM (
      SELECT * FROM event_rows
      ORDER BY event_time,source_priority,effective_confidence,event_id LIMIT 1000
    ) bounded
  ),
  claim_summary AS (
    SELECT COALESCE(jsonb_object_agg(external_kind,claim_count ORDER BY external_kind),'{}'::jsonb) AS value
    FROM (
      SELECT claim.external_kind,count(*) AS claim_count
      FROM external_correlation_claim claim
      JOIN event_rows event ON event.event_id=claim.source_id
      WHERE claim.data_scope_key=p_data_scope_key AND claim.source_kind='OPERATIONAL_EVENT'
      GROUP BY claim.external_kind
    ) counts
  )
  SELECT CASE WHEN summary.event_count=0 THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
    'referenceKey',jsonb_build_object(
      'namespace','gowm','kind','OPERATIONAL_TASK','id',task.reference_key,'version','1'
    ),
    'operationalTaskId',p_operational_task_id,
    'taskType',COALESCE(task_type.value,'OPERATIONAL_TASK'),
    'controlState',COALESCE(control.value,'NO_CONTROL_EVENT'),
    'activityState',COALESCE(activity.value,'NOT_OBSERVED'),
    'outcomeVerification',COALESCE(
      physical_outcome.value,
      CASE WHEN summary.event_count>0 THEN 'UNVERIFIED' ELSE 'NOT_APPLICABLE' END
    ),
    'observability',COALESCE(gap.value,CASE WHEN summary.event_count>0 THEN 'FRESH' ELSE 'NO_DATA' END),
    'actorReferenceKeys',actors.value,
    'targetReferenceKeys',targets.value,
    'firstObservedAt',summary.first_observed_at,
    'lastObservedAt',summary.last_observed_at,
    'lastReceivedAt',summary.last_received_at,
    'evidenceIds',evidence.value,
    'correlationClaimSummary',claim_summary.value,
    'projectionPolicyVersion',p_policy_version
  )) END
  FROM summary
  JOIN operational_task task
    ON task.data_scope_key=p_data_scope_key AND task.operational_task_id=p_operational_task_id
  CROSS JOIN actors CROSS JOIN targets CROSS JOIN evidence CROSS JOIN claim_summary
  LEFT JOIN control ON true LEFT JOIN activity ON true LEFT JOIN physical_outcome ON true
  LEFT JOIN gap ON true LEFT JOIN task_type ON true
$fn$;

CREATE FUNCTION project_operational_task(
  p_data_scope_key text,
  p_operational_task_id text,
  p_policy_version text DEFAULT 'operational-projection-v1',
  p_projection_kind text DEFAULT 'LIVE'
)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
DECLARE
  identity_row record;
  current_row record;
  semantic_snapshot jsonb;
  new_hash text;
  new_world_version bigint;
  triggering_event text;
BEGIN
  IF p_projection_kind NOT IN ('LIVE','LATE_REPLAY','FULL_REBUILD') OR
     NOT EXISTS (SELECT 1 FROM public.operational_projection_policy WHERE policy_version=p_policy_version) OR
     NOT EXISTS (
       SELECT 1 FROM public.operational_task_event
       WHERE data_scope_key=p_data_scope_key AND operational_task_id=p_operational_task_id
     ) THEN
    RAISE EXCEPTION 'operational projection request is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_data_scope_key || E'\u001f' || p_operational_task_id,0));

  SELECT reference_key,data_scope_key INTO identity_row FROM public.world_reference_identity
  WHERE entity_kind='OPERATIONAL_TASK' AND internal_id=p_operational_task_id;
  IF FOUND AND identity_row.data_scope_key<>p_data_scope_key THEN
    RAISE EXCEPTION 'operational task identity belongs to another scope' USING ERRCODE='23505';
  END IF;
  IF NOT FOUND THEN
    INSERT INTO public.world_reference_identity(entity_kind,internal_id,data_scope_key)
    VALUES ('OPERATIONAL_TASK',p_operational_task_id,p_data_scope_key)
    RETURNING reference_key,data_scope_key INTO identity_row;
    INSERT INTO public.world_reference_descriptor_version(
      reference_key,data_scope_key,reference_type,display_name,content_hash
    ) VALUES (
      identity_row.reference_key,p_data_scope_key,'OPERATIONAL_TASK',
      'Operational task ' || p_operational_task_id,
      public.grounding_sha256(identity_row.reference_key || ':OPERATIONAL_TASK:1')
    );
    INSERT INTO public.world_reference_name(
      reference_key,data_scope_key,name_kind,language_tag,name_text,normalized_text,source_ref,confidence
    ) VALUES (
      identity_row.reference_key,p_data_scope_key,'CANONICAL_NAME','und',
      'Operational task ' || p_operational_task_id,
      public.normalize_reference_text('Operational task ' || p_operational_task_id),
      'operational-projection-v1',1
    );
  END IF;
  INSERT INTO public.operational_task(data_scope_key,operational_task_id,reference_key)
  VALUES (p_data_scope_key,p_operational_task_id,identity_row.reference_key)
  ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.operational_task
  WHERE data_scope_key=p_data_scope_key AND operational_task_id=p_operational_task_id FOR UPDATE;

  semantic_snapshot := public.compute_operational_task_snapshot(
    p_data_scope_key,p_operational_task_id,p_policy_version
  );
  IF semantic_snapshot IS NULL THEN
    RAISE EXCEPTION 'operational projection has no source events' USING ERRCODE='22023';
  END IF;
  new_hash := public.grounding_sha256(semantic_snapshot::text);
  SELECT snapshot_hash,world_version INTO current_row FROM public.operational_task_snapshot
  WHERE data_scope_key=p_data_scope_key AND operational_task_id=p_operational_task_id FOR UPDATE;

  IF FOUND AND current_row.snapshot_hash=new_hash THEN
    UPDATE public.operational_projection_queue queue SET processed_at=COALESCE(processed_at,clock_timestamp()),
      locked_at=NULL,locked_by=NULL,last_error=NULL
    FROM public.operational_task_event event
    WHERE queue.data_scope_key=p_data_scope_key AND queue.processed_at IS NULL
      AND event.data_scope_key=queue.data_scope_key AND event.event_id=queue.event_id
      AND event.operational_task_id=p_operational_task_id;
    RETURN current_row.world_version;
  END IF;

  SELECT event.event_id INTO triggering_event
  FROM public.operational_projection_queue queue
  JOIN public.operational_task_event event
    ON event.data_scope_key=queue.data_scope_key AND event.event_id=queue.event_id
  WHERE queue.data_scope_key=p_data_scope_key AND queue.processed_at IS NULL
    AND event.operational_task_id=p_operational_task_id
  ORDER BY event.received_time DESC,event.event_id DESC LIMIT 1;

  new_world_version := nextval('public.world_version_seq');
  PERFORM set_config('gowm.operational_projection_write','on',true);
  INSERT INTO public.operational_task_snapshot(
    data_scope_key,operational_task_id,reference_key,task_type,control_state,activity_state,
    outcome_verification,observability,actor_reference_keys,target_reference_keys,
    first_observed_at,last_observed_at,last_received_at,evidence_ids,correlation_claim_summary,
    world_version,projection_policy_version,snapshot_hash
  ) VALUES (
    p_data_scope_key,p_operational_task_id,semantic_snapshot#>>'{referenceKey,id}',
    semantic_snapshot->>'taskType',semantic_snapshot->>'controlState',semantic_snapshot->>'activityState',
    semantic_snapshot->>'outcomeVerification',semantic_snapshot->>'observability',
    semantic_snapshot->'actorReferenceKeys',semantic_snapshot->'targetReferenceKeys',
    (semantic_snapshot->>'firstObservedAt')::timestamptz,
    (semantic_snapshot->>'lastObservedAt')::timestamptz,
    (semantic_snapshot->>'lastReceivedAt')::timestamptz,
    semantic_snapshot->'evidenceIds',semantic_snapshot->'correlationClaimSummary',
    new_world_version,p_policy_version,new_hash
  ) ON CONFLICT (data_scope_key,operational_task_id) DO UPDATE SET
    task_type=EXCLUDED.task_type,control_state=EXCLUDED.control_state,
    activity_state=EXCLUDED.activity_state,outcome_verification=EXCLUDED.outcome_verification,
    observability=EXCLUDED.observability,actor_reference_keys=EXCLUDED.actor_reference_keys,
    target_reference_keys=EXCLUDED.target_reference_keys,first_observed_at=EXCLUDED.first_observed_at,
    last_observed_at=EXCLUDED.last_observed_at,last_received_at=EXCLUDED.last_received_at,
    evidence_ids=EXCLUDED.evidence_ids,correlation_claim_summary=EXCLUDED.correlation_claim_summary,
    world_version=EXCLUDED.world_version,projection_policy_version=EXCLUDED.projection_policy_version,
    snapshot_hash=EXCLUDED.snapshot_hash,updated_at=clock_timestamp();
  PERFORM set_config('gowm.operational_projection_write','off',true);

  INSERT INTO public.operational_projection_audit(
    data_scope_key,operational_task_id,triggering_event_id,projection_kind,policy_version,
    prior_snapshot_hash,snapshot_hash,snapshot,world_version
  ) VALUES (
    p_data_scope_key,p_operational_task_id,triggering_event,p_projection_kind,p_policy_version,
    current_row.snapshot_hash,new_hash,semantic_snapshot || jsonb_build_object('worldVersion',new_world_version),new_world_version
  );
  UPDATE public.operational_projection_queue queue SET processed_at=clock_timestamp(),
    locked_at=NULL,locked_by=NULL,last_error=NULL
  FROM public.operational_task_event event
  WHERE queue.data_scope_key=p_data_scope_key AND queue.processed_at IS NULL
    AND event.data_scope_key=queue.data_scope_key AND event.event_id=queue.event_id
    AND event.operational_task_id=p_operational_task_id;
  RETURN new_world_version;
END
$fn$;

CREATE FUNCTION enqueue_operational_projection()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
BEGIN
  INSERT INTO public.operational_projection_queue(data_scope_key,event_id)
  VALUES (NEW.data_scope_key,NEW.event_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER operational_task_event_projection_queue
  AFTER INSERT ON operational_task_event
  FOR EACH ROW EXECUTE FUNCTION enqueue_operational_projection();

INSERT INTO operational_projection_queue(data_scope_key,event_id)
SELECT data_scope_key,event_id FROM operational_task_event ON CONFLICT DO NOTHING;

CREATE FUNCTION project_pending_operational_tasks(p_batch_size integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
DECLARE
  pending record;
  projected_count integer := 0;
BEGIN
  IF p_batch_size NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'operational projection batch size is invalid' USING ERRCODE='22023';
  END IF;
  FOR pending IN
    SELECT DISTINCT event.data_scope_key,event.operational_task_id
    FROM public.operational_projection_queue queue
    JOIN public.operational_task_event event
      ON event.data_scope_key=queue.data_scope_key AND event.event_id=queue.event_id
    WHERE queue.processed_at IS NULL AND queue.available_at<=clock_timestamp()
    ORDER BY event.data_scope_key,event.operational_task_id LIMIT p_batch_size
  LOOP
    PERFORM public.project_operational_task(
      pending.data_scope_key,pending.operational_task_id,'operational-projection-v1',
      CASE WHEN EXISTS (
        SELECT 1 FROM public.operational_projection_queue queue
        JOIN public.operational_task_event event
          ON event.data_scope_key=queue.data_scope_key AND event.event_id=queue.event_id
        WHERE queue.processed_at IS NULL AND event.data_scope_key=pending.data_scope_key
          AND event.operational_task_id=pending.operational_task_id
          AND event.arrival_classification='LATE'
      ) THEN 'LATE_REPLAY' ELSE 'LIVE' END
    );
    projected_count := projected_count+1;
  END LOOP;
  RETURN projected_count;
END
$fn$;

CREATE FUNCTION operational_snapshot_current_hash(p_data_scope_key text)
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
  SELECT grounding_sha256(COALESCE(jsonb_agg(
    jsonb_build_array(operational_task_id,snapshot_hash) ORDER BY operational_task_id
  )::text,'[]'))
  FROM operational_task_snapshot WHERE data_scope_key=p_data_scope_key
$fn$;

CREATE FUNCTION operational_snapshot_replay_hash(
  p_data_scope_key text,
  p_policy_version text DEFAULT 'operational-projection-v1'
)
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
  SELECT grounding_sha256(COALESCE(jsonb_agg(
    jsonb_build_array(tasks.operational_task_id,grounding_sha256(
      compute_operational_task_snapshot(p_data_scope_key,tasks.operational_task_id,p_policy_version)::text
    )) ORDER BY tasks.operational_task_id
  )::text,'[]'))
  FROM (
    SELECT DISTINCT operational_task_id FROM operational_task_event WHERE data_scope_key=p_data_scope_key
  ) tasks
$fn$;

CREATE FUNCTION rebuild_operational_task_snapshots(
  p_data_scope_key text,
  p_policy_version text DEFAULT 'operational-projection-v1'
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
DECLARE
  task record;
  rebuilt integer := 0;
BEGIN
  FOR task IN SELECT DISTINCT operational_task_id FROM public.operational_task_event
              WHERE data_scope_key=p_data_scope_key ORDER BY operational_task_id
  LOOP
    PERFORM public.project_operational_task(
      p_data_scope_key,task.operational_task_id,p_policy_version,'FULL_REBUILD'
    );
    rebuilt := rebuilt+1;
  END LOOP;
  RETURN rebuilt;
END
$fn$;

REVOKE ALL ON FUNCTION reject_operational_projection_evidence_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_operational_task_snapshot_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION operational_source_priority(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION compute_operational_task_snapshot(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION project_operational_task(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_operational_projection() FROM PUBLIC;
REVOKE ALL ON FUNCTION project_pending_operational_tasks(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION operational_snapshot_current_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION operational_snapshot_replay_hash(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rebuild_operational_task_snapshots(text,text) FROM PUBLIC;

COMMIT;
