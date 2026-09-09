BEGIN;

-- Add only catalog metadata derived from an existing, same-scope operational task.
CREATE FUNCTION public.project_operational_task_reference(p_scope text,p_task_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE ref text; external_id uuid; external_added integer; search_added integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_scope || E'\u001f' || p_task_id,0));
  SELECT t.reference_key INTO ref FROM public.operational_task t
  JOIN public.world_reference_identity i ON i.reference_key=t.reference_key
    AND i.data_scope_key=t.data_scope_key AND i.internal_id=t.operational_task_id
    AND i.entity_kind='OPERATIONAL_TASK'
  WHERE t.data_scope_key=p_scope AND t.operational_task_id=p_task_id
    AND EXISTS(SELECT 1 FROM public.world_reference_descriptor_version d
      WHERE d.reference_key=t.reference_key AND d.data_scope_key=p_scope AND d.reference_type='OPERATIONAL_TASK');
  IF ref IS NULL THEN RAISE EXCEPTION 'operational task reference is not visible or consistent' USING ERRCODE='42501'; END IF;
  INSERT INTO public.world_reference_external_identifier(reference_key,data_scope_key,authority,
    identifier_kind,identifier_value,normalized_value,confidence,evidence)
  VALUES(ref,p_scope,'gowm.operational-task','TASK_ID',p_task_id,public.normalize_reference_text(p_task_id),1,
    '[{"authority":"GOWM Foundation","evidenceType":"OPERATIONAL_TASK_IDENTITY"}]'::jsonb)
  ON CONFLICT(data_scope_key,authority,identifier_kind,normalized_value,reference_key) DO NOTHING;
  GET DIAGNOSTICS external_added=ROW_COUNT;
  SELECT external_identifier_id INTO STRICT external_id FROM public.world_reference_external_identifier
    WHERE data_scope_key=p_scope AND reference_key=ref AND authority='gowm.operational-task'
      AND identifier_kind='TASK_ID' AND normalized_value=public.normalize_reference_text(p_task_id);
  INSERT INTO public.reference_search_projection(data_scope_key,reference_key,entity_kind,search_kind,
    normalized_text,match_priority,source_id,source_confidence)
  SELECT p_scope,ref,'OPERATIONAL_TASK','REFERENCE_KEY',ref,0,ref,1
  UNION ALL
  SELECT p_scope,ref,'OPERATIONAL_TASK','EXTERNAL_ID',public.normalize_reference_text(p_task_id),1,external_id::text,1
  UNION ALL
  SELECT p_scope,ref,'OPERATIONAL_TASK',n.name_kind,n.normalized_text,
    CASE n.name_kind WHEN 'CODE' THEN 1 WHEN 'EXTERNAL_ID' THEN 1 WHEN 'CANONICAL_NAME' THEN 2 WHEN 'ALIAS' THEN 3 ELSE 4 END,
    n.name_id::text,n.confidence
  FROM public.world_reference_name n WHERE n.reference_key=ref AND n.data_scope_key=p_scope
    AND clock_timestamp()<@tstzrange(n.valid_from,n.valid_to,'[)')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS search_added=ROW_COUNT;
  RETURN jsonb_build_object('externalIdentifiersAdded',external_added,'searchRowsAdded',search_added);
END $fn$;
REVOKE ALL ON FUNCTION public.project_operational_task_reference(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_operational_task_reference(text,text) TO gowm_reference_catalog_operator;

CREATE OR REPLACE FUNCTION project_operational_task(
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

  PERFORM public.project_operational_task_reference(p_data_scope_key,p_operational_task_id);

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

COMMIT;
