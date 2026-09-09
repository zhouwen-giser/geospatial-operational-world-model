BEGIN;
CREATE TABLE gowm_history.reset_ack_policy (
 data_scope_key text NOT NULL, device_id text NOT NULL,
 targets text[] NOT NULL CHECK(cardinality(targets)>0),
 policy_version text NOT NULL DEFAULT 'RESET_ACK_ACCEPTED_COMPLETE_V1'
   CHECK(policy_version='RESET_ACK_ACCEPTED_COMPLETE_V1'),
 PRIMARY KEY(data_scope_key,device_id),
 FOREIGN KEY(data_scope_key,device_id) REFERENCES gowm_device.device(data_scope_key,device_id)
);
CREATE TABLE gowm_history.reset_ack_evidence (
 message_id uuid PRIMARY KEY REFERENCES ugv_ingest.inbox_message,
 session_id uuid NOT NULL REFERENCES ugv_ingest.mqtt_session,
 data_scope_key text NOT NULL, source_key text NOT NULL, device_id text NOT NULL,
 target text NOT NULL, source_timestamp numeric NOT NULL, content_hash text NOT NULL,
 receiver_boundary timestamptz NOT NULL, inbox_boundary bigint NOT NULL,
 mapper_context_hash text NOT NULL,
 policy_version text NOT NULL DEFAULT 'RESET_ACK_ACCEPTED_COMPLETE_V1',
 allows_loss boolean NOT NULL DEFAULT true CHECK(allows_loss),
 state text NOT NULL CHECK(state IN('PENDING','APPLIED','IGNORED')),
 reason text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),applied_at timestamptz,
 UNIQUE(data_scope_key,source_key,device_id,target,source_timestamp)
);
CREATE TABLE gowm_history.reset_ack_watermark_input (
 message_id uuid NOT NULL REFERENCES gowm_history.reset_ack_evidence,
 watermark_revision_id uuid PRIMARY KEY REFERENCES public.pipeline_watermark_revision,
 event_boundary timestamptz NOT NULL
);
REVOKE ALL ON gowm_history.reset_ack_policy,gowm_history.reset_ack_evidence,
 gowm_history.reset_ack_watermark_input FROM PUBLIC;

-- Resolves only persisted MQTT identities. No caller-supplied scope, device,
-- event time, completeness flag, or arbitrary SQL is accepted.
CREATE FUNCTION gowm_history.process_reset_ack(p_client text,p_broker text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,gowm_history,ugv_ingest AS $fn$
#variable_conflict use_variable
<<reset_work>>
DECLARE m record; e record; prior record; stream record; task record;
 scope_key text; source_key text; device_key text; external_id text; targets text[];
 body jsonb; digest text; run_id uuid; watermark_id uuid; reason text; matched integer:=0;
BEGIN
 SELECT i.*,s.mapper_context,s.mapper_context_hash,s.connected_at INTO m
 FROM ugv_ingest.inbox_message i JOIN ugv_ingest.mqtt_session s USING(session_id)
 WHERE s.client_id=p_client AND s.broker_id=p_broker AND i.topic='/sim/reset_ack'
   AND i.processing_state IN('RECEIVED','VALIDATED') AND i.next_processing_at<=clock_timestamp()
 ORDER BY i.ingest_sequence LIMIT 1 FOR UPDATE OF i SKIP LOCKED;
 IF NOT FOUND THEN RETURN 'IDLE'; END IF;
 body:=m.decoded_payload;
 scope_key:=m.mapper_context->>'dataScopeKey';source_key:=m.mapper_context->>'sourceKey';
 IF scope_key IS DISTINCT FROM gowm_history_v1.current_data_scope_key() THEN RAISE EXCEPTION 'RESET_SCOPE_MISMATCH' USING ERRCODE='42501'; END IF;
 device_key:=m.mapper_context#>>'{deviceContext,deviceId}';external_id:=m.mapper_context->>'deviceId';
 reason:=NULL;
 IF m.retained_flag THEN reason:='RETAINED_RESET_IGNORED';
 ELSIF m.qos<>1 OR m.validation_state<>'VALID' THEN reason:='INVALID_RESET';
 ELSIF body->>'ok'<>'true' THEN reason:='RESET_FAILED';
 ELSIF NOT EXISTS(SELECT 1 FROM gowm_device.device d WHERE d.device_id=device_key AND d.data_scope_key=scope_key
   AND d.device_identifier=external_id AND d.enabled) THEN reason:='DEVICE_UNAVAILABLE';
 END IF;
 SELECT p.targets INTO targets FROM gowm_history.reset_ack_policy p
 WHERE p.data_scope_key=scope_key AND p.device_id=device_key;
 -- Fixed default device only; additional devices require an explicit mapping.
 IF targets IS NULL AND external_id='ugv' THEN targets:=ARRAY['ugv','red','all']; END IF;
 IF reason IS NULL AND NOT coalesce(body->>'target'=ANY(targets),false) THEN reason:='TARGET_NOT_BOUND'; END IF;
 IF reason IS NULL AND (to_timestamp((body->>'ts')::double precision)<m.connected_at
   OR abs(extract(epoch FROM(m.adapter_received_at-to_timestamp((body->>'ts')::double precision))))>60)
 THEN reason:='RESET_CLOCK_OR_SESSION_MISMATCH'; END IF;
 IF reason IS NOT NULL THEN
   UPDATE ugv_ingest.inbox_message SET processing_state='IGNORED_BY_POLICY',last_error=reason,
     completed_at=clock_timestamp() WHERE message_id=m.message_id;
   RETURN reason;
 END IF;
 digest:=public.grounding_sha256(body::text);
 PERFORM pg_advisory_xact_lock(hashtextextended('reset-watermark:'||scope_key||':'||source_key||':'||device_key,0));
 SELECT * INTO prior FROM gowm_history.reset_ack_evidence r WHERE r.data_scope_key=scope_key AND r.source_key=source_key
   AND r.device_id=device_key AND r.target=body->>'target' AND r.source_timestamp=(body->>'ts')::numeric;
 IF FOUND AND prior.message_id<>m.message_id THEN
   UPDATE ugv_ingest.inbox_message SET processing_state=CASE WHEN prior.content_hash=digest THEN 'IGNORED_BY_POLICY' ELSE 'DEAD_LETTER' END::ugv_ingest.processing_state,
     last_error=CASE WHEN prior.content_hash=digest THEN 'RESET_DUPLICATE' ELSE 'RESET_CONTENT_CONFLICT' END,
     completed_at=clock_timestamp() WHERE message_id=m.message_id;
   RETURN 'DUPLICATE_OR_CONFLICT';
 END IF;
 INSERT INTO gowm_history.reset_ack_evidence(message_id,session_id,data_scope_key,source_key,device_id,target,source_timestamp,
   content_hash,receiver_boundary,inbox_boundary,mapper_context_hash,state)
 VALUES(m.message_id,m.session_id,scope_key,source_key,device_key,body->>'target',(body->>'ts')::numeric,
   digest,m.adapter_received_at,m.ingest_sequence,m.mapper_context_hash,'PENDING') ON CONFLICT(message_id) DO NOTHING;
 IF EXISTS(SELECT 1 FROM gowm_history.reset_ack_evidence r WHERE r.data_scope_key=scope_key AND r.source_key=source_key
   AND r.device_id=device_key AND r.state='APPLIED' AND r.source_timestamp>(body->>'ts')::numeric) THEN
   reason:='RESET_OUT_OF_ORDER';
 ELSIF EXISTS(SELECT 1 FROM ugv_ingest.inbox_message i WHERE i.session_id=m.session_id
   AND i.ingest_sequence<m.ingest_sequence AND i.topic<>'/sim/reset_ack'
   AND i.processing_state IN('RECEIVED','VALIDATED','MAPPED','OUTBOXED')) THEN reason:='INBOX_DRAIN_PENDING';
 END IF;
 IF reason IS NOT NULL THEN
   UPDATE gowm_history.reset_ack_evidence SET reason=reset_work.reason,
     state=CASE WHEN reason='RESET_OUT_OF_ORDER' THEN 'IGNORED' ELSE 'PENDING' END WHERE message_id=m.message_id;
   UPDATE ugv_ingest.inbox_message SET next_processing_at=clock_timestamp()+interval '5 seconds',
     processing_state=CASE WHEN reason='RESET_OUT_OF_ORDER' THEN 'IGNORED_BY_POLICY' ELSE 'RECEIVED' END::ugv_ingest.processing_state,
     last_error=reason WHERE message_id=m.message_id;
   RETURN reason;
 END IF;
 PERFORM gowm_history_v1.set_data_scope(scope_key);
 -- Freeze the input prefix using durable inbox identity, not current world state.
 -- The source uses the established adapter-wall-clock proxy. Other clocks must
 -- receive a dedicated conversion before this policy can apply to them.
 IF EXISTS(SELECT 1 FROM public.world_observation o
   JOIN ugv_ingest.inbox_message i ON o.raw_reference='ugv-inbox://'||i.message_id::text
   JOIN public.observation_time_solution ts USING(observation_id)
   JOIN public.source_clock_model c USING(clock_model_id)
   WHERE i.session_id=m.session_id AND i.ingest_sequence<m.ingest_sequence
     AND o.data_scope_key=scope_key AND o.source=source_key
     AND (c.model_version<>'mqtt-arrival-proxy-v1' OR c.clock_domain<>'ADAPTER_WALL_CLOCK')) THEN
   reason:='TIME_MODEL_UNSUPPORTED';
 ELSE
   FOR stream IN
     SELECT o.datastream_key,o.producer_pipeline_key,ts.clock_model_id,
       max(ts.phenomenon_time_estimate) boundary,max(o.received_at) received
     FROM public.world_observation o
     JOIN ugv_ingest.inbox_message i ON o.raw_reference='ugv-inbox://'||i.message_id::text
     JOIN public.observation_time_solution ts USING(observation_id)
     JOIN public.source_clock_model c USING(clock_model_id)
     WHERE i.session_id=m.session_id AND i.ingest_sequence<m.ingest_sequence
       AND o.data_scope_key=scope_key AND o.source=source_key
       AND c.model_version='mqtt-arrival-proxy-v1' AND c.clock_domain='ADAPTER_WALL_CLOCK'
       AND ts.phenomenon_time_estimate<=m.adapter_received_at
     GROUP BY o.datastream_key,o.producer_pipeline_key,ts.clock_model_id
   LOOP
     IF EXISTS(SELECT 1 FROM public.pipeline_watermark_revision w WHERE w.datastream_key=stream.datastream_key
       AND w.closed_through_event_time>stream.boundary) THEN CONTINUE; END IF;
     INSERT INTO public.processing_run(processor_name,processor_version,config_hash,deterministic,started_at,completed_at)
     VALUES('reset-ack-accepted-complete','1.0',digest,true,clock_timestamp(),clock_timestamp()) RETURNING processing_run_id INTO run_id;
     INSERT INTO public.pipeline_watermark_revision(datastream_key,producer_pipeline_key,processing_run_id,clock_model_id,
       time_basis,closed_through_event_time,allowed_lateness,last_received_time,completeness_state)
     VALUES(stream.datastream_key,stream.producer_pipeline_key,run_id,stream.clock_model_id,'CLOCK_MODEL',stream.boundary,
       interval '0',stream.received,'COMPLETE') RETURNING watermark_revision_id INTO watermark_id;
     INSERT INTO gowm_history.reset_ack_watermark_input VALUES(m.message_id,watermark_id,stream.boundary);
     matched:=matched+1;
   END LOOP;
 END IF;
 IF matched=0 THEN
   UPDATE gowm_history.reset_ack_evidence SET reason=coalesce(reset_work.reason,'OBSERVATIONS_PENDING') WHERE message_id=m.message_id;
   UPDATE ugv_ingest.inbox_message SET next_processing_at=clock_timestamp()+interval '60 seconds' WHERE message_id=m.message_id;
   RETURN coalesce(reason,'OBSERVATIONS_PENDING');
 END IF;
 -- Source-authority watermarks are not device-scoped. Do not close a shared
 -- authority when another device has evidence in the same scope.
 FOR task IN
   SELECT ev.source_authority,max(ev.event_time) boundary
   FROM public.operational_task_event ev
   CROSS JOIN LATERAL jsonb_array_elements(ev.provenance) proof
   JOIN public.world_observation o ON o.observation_id=proof->>'evidenceId'
   JOIN ugv_ingest.inbox_message i ON o.raw_reference='ugv-inbox://'||i.message_id::text
   WHERE ev.data_scope_key=scope_key AND i.session_id=m.session_id AND i.ingest_sequence<m.ingest_sequence
   GROUP BY ev.source_authority
 LOOP
   IF NOT EXISTS(SELECT 1 FROM public.operational_task_event ev WHERE ev.data_scope_key=scope_key
     AND ev.source_authority=task.source_authority AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(ev.actor_reference_keys) actor
       WHERE actor->>'id'=m.mapper_context#>>'{deviceContext,actorReferenceKey,id}'
         AND actor->>'kind'='WORLD_OBJECT' AND actor->>'namespace'='gowm')) THEN
     INSERT INTO public.operational_source_watermark_revision(data_scope_key,source_authority,closed_through_event_time,
       allowed_lateness,completeness_state,evidence_id)
     SELECT scope_key,task.source_authority,task.boundary,interval '0','COMPLETE','reset-ack:'||m.message_id
     WHERE NOT EXISTS(SELECT 1 FROM public.operational_source_watermark_revision w WHERE w.data_scope_key=scope_key
       AND w.source_authority=task.source_authority AND w.closed_through_event_time>task.boundary);
   END IF;
 END LOOP;
 FOR task IN SELECT v.tracklet_version_id FROM public.mobility_tracklet t JOIN public.mobility_tracklet_version v USING(tracklet_id)
   WHERE t.data_scope_key=scope_key AND t.source_key=source_key AND t.world_object_id=device_key
     AND t.tracker_session_key=m.mapper_context->>'trackerSessionKey'
 LOOP PERFORM gowm_history.enqueue_tracklet_finalization(task.tracklet_version_id,clock_timestamp(),digest); END LOOP;
 FOR task IN SELECT DISTINCT ev.operational_task_id FROM public.operational_task_event ev
   CROSS JOIN LATERAL jsonb_array_elements(ev.provenance) proof
   JOIN public.world_observation o ON o.observation_id=proof->>'evidenceId'
   JOIN ugv_ingest.inbox_message i ON o.raw_reference='ugv-inbox://'||i.message_id::text
   WHERE ev.data_scope_key=scope_key AND i.session_id=m.session_id AND i.ingest_sequence<m.ingest_sequence
 LOOP PERFORM gowm_history.enqueue_task_interval_projection(scope_key,task.operational_task_id); END LOOP;
 UPDATE gowm_history.reset_ack_evidence SET state='APPLIED',reason='RESET_ACK_ACCEPTED_COMPLETE_V1',applied_at=clock_timestamp() WHERE message_id=m.message_id;
 UPDATE ugv_ingest.inbox_message SET processing_state='DELIVERED',completed_at=clock_timestamp() WHERE message_id=m.message_id;
 RETURN 'APPLIED';
END $fn$;
REVOKE ALL ON FUNCTION gowm_history.process_reset_ack(text,text) FROM PUBLIC;
DO $role$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_reset_ingest') THEN CREATE ROLE gowm_reset_ingest NOLOGIN; END IF;
IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_reset_ingest' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN RAISE EXCEPTION 'Unsafe reset ingest role'; END IF; END $role$;
GRANT USAGE ON SCHEMA gowm_history,gowm_history_v1 TO gowm_reset_ingest;
GRANT EXECUTE ON FUNCTION gowm_history_v1.set_data_scope(text) TO gowm_reset_ingest;
GRANT EXECUTE ON FUNCTION gowm_history.process_reset_ack(text,text) TO gowm_reset_ingest;
CREATE VIEW gowm_history_v1.reset_ack_status WITH(security_barrier=true) AS
 SELECT message_id,data_scope_key,source_key,device_id,target,receiver_boundary,policy_version,
   allows_loss,state,reason,created_at,applied_at FROM gowm_history.reset_ack_evidence
 WHERE data_scope_key=gowm_history_v1.current_data_scope_key();
GRANT SELECT ON gowm_history_v1.reset_ack_status TO gowm_history_reader;
COMMIT;
