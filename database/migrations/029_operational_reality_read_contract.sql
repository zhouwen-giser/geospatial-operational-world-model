BEGIN;

CREATE SCHEMA gowm_operational_reality_v1;

CREATE FUNCTION gowm_operational_reality_v1.current_data_scope_key()
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('gowm.data_scope_key',true),'') $$;

CREATE FUNCTION gowm_operational_reality_v1.set_data_scope(p_scope_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
BEGIN
  IF p_scope_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.data_scope WHERE scope_key=p_scope_key) THEN
    RAISE EXCEPTION 'operational reality scope is unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('gowm.data_scope_key',p_scope_key,true);
END
$fn$;

CREATE VIEW gowm_operational_reality_v1.task_snapshot AS
SELECT snapshot.reference_key,
       jsonb_build_object('namespace','gowm','kind','OPERATIONAL_TASK','id',snapshot.reference_key,'version','1') AS reference_key_value,
       snapshot.operational_task_id,snapshot.task_type,snapshot.control_state,snapshot.activity_state,
       snapshot.outcome_verification,snapshot.observability,snapshot.actor_reference_keys,
       snapshot.target_reference_keys,snapshot.first_observed_at,snapshot.last_observed_at,
       snapshot.last_received_at,snapshot.evidence_ids,snapshot.correlation_claim_summary,
       snapshot.world_version,snapshot.projection_policy_version,snapshot.snapshot_hash,snapshot.updated_at
FROM operational_task_snapshot snapshot
WHERE snapshot.data_scope_key=gowm_operational_reality_v1.current_data_scope_key();

CREATE VIEW gowm_operational_reality_v1.task_event AS
SELECT task.reference_key,
       jsonb_build_object('namespace','gowm','kind','OPERATIONAL_TASK','id',task.reference_key,'version','1') AS operational_task_reference_key,
       event.event_id,event.operational_task_id,event.event_type,event.event_time,event.received_time,
       event.subject_reference_key,event.actor_reference_keys,event.target_reference_keys,event.geometry_ref,
       event.payload,event.confidence,event.provenance,event.correlation_claims,event.world_version,
       event.source_authority,event.source_event_key,event.source_revision_no,event.arrival_classification,
       event.created_at
FROM operational_task_event event
JOIN operational_task task
  ON task.data_scope_key=event.data_scope_key AND task.operational_task_id=event.operational_task_id
WHERE event.data_scope_key=gowm_operational_reality_v1.current_data_scope_key();

CREATE VIEW gowm_operational_reality_v1.correlation_finding AS
SELECT finding.finding_id::text,finding.external_authority,finding.external_kind,finding.external_value,
       CASE WHEN finding.operational_task_reference_key IS NULL THEN NULL ELSE
         jsonb_build_object('namespace','gowm','kind','OPERATIONAL_TASK',
                            'id',finding.operational_task_reference_key,'version','1') END AS operational_task_reference_key,
       finding.operational_event_ids,finding.relation,finding.match_basis,finding.correlation_confidence,
       finding.evidence_ids,finding.candidate_count,finding.world_version,finding.method_version,
       finding.resolution_hash,finding.created_at
FROM correlation_finding finding
WHERE finding.data_scope_key=gowm_operational_reality_v1.current_data_scope_key();

CREATE VIEW gowm_operational_reality_v1.correlation_candidate AS
SELECT candidate.finding_id::text,candidate.candidate_rank,
       jsonb_build_object('namespace','gowm','kind','OPERATIONAL_TASK',
                          'id',candidate.operational_task_reference_key,'version','1') AS operational_task_reference_key,
       candidate.relation,candidate.match_basis,candidate.correlation_confidence,
       candidate.operational_event_ids,candidate.evidence_ids,candidate.created_at
FROM correlation_finding_candidate candidate
JOIN correlation_finding finding USING(finding_id)
WHERE finding.data_scope_key=gowm_operational_reality_v1.current_data_scope_key();

CREATE FUNCTION gowm_operational_reality_v1.snapshot_context()
RETURNS TABLE(world_version bigint,scope_digest text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
  SELECT COALESCE(max(version),0),public.grounding_sha256(COALESCE(jsonb_agg(item ORDER BY item::text)::text,'[]'))
  FROM (
    SELECT snapshot.world_version AS version,
           jsonb_build_array('SNAPSHOT',snapshot.operational_task_id,snapshot.snapshot_hash) AS item
    FROM public.operational_task_snapshot snapshot
    WHERE snapshot.data_scope_key=gowm_operational_reality_v1.current_data_scope_key()
    UNION ALL
    SELECT event.world_version,jsonb_build_array('EVENT',event.event_id,event.content_hash)
    FROM public.operational_task_event event
    WHERE event.data_scope_key=gowm_operational_reality_v1.current_data_scope_key()
    UNION ALL
    SELECT finding.world_version,jsonb_build_array('FINDING',finding.finding_id,finding.resolution_hash)
    FROM public.correlation_finding finding
    WHERE finding.data_scope_key=gowm_operational_reality_v1.current_data_scope_key()
  ) evidence
$fn$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gowm_operational_reader') THEN
    CREATE ROLE gowm_operational_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gowm_operational_service') THEN
    CREATE ROLE gowm_operational_service NOLOGIN INHERIT;
  END IF;
END
$roles$;

REVOKE ALL ON SCHEMA gowm_operational_reality_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_operational_reality_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_operational_reality_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA gowm_operational_reality_v1 TO gowm_operational_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA gowm_operational_reality_v1 TO gowm_operational_reader;
GRANT EXECUTE ON FUNCTION gowm_operational_reality_v1.current_data_scope_key() TO gowm_operational_reader;
GRANT EXECUTE ON FUNCTION gowm_operational_reality_v1.set_data_scope(text) TO gowm_operational_reader;
GRANT EXECUTE ON FUNCTION gowm_operational_reality_v1.snapshot_context() TO gowm_operational_reader;
GRANT gowm_operational_reader TO gowm_operational_service;
ALTER ROLE gowm_operational_service SET default_transaction_read_only=on;
ALTER ROLE gowm_operational_service SET statement_timeout='10s';

COMMIT;
