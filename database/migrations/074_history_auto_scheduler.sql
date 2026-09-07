BEGIN;
DO $roles$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_history_scheduler') THEN CREATE ROLE gowm_history_scheduler NOLOGIN INHERIT; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_history_scheduler_service') THEN CREATE ROLE gowm_history_scheduler_service NOLOGIN INHERIT; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('gowm_history_scheduler','gowm_history_scheduler_service')
   AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)) THEN RAISE EXCEPTION 'Unsafe existing history scheduler role'; END IF;
END $roles$;
GRANT gowm_history_reader TO gowm_history_scheduler;
GRANT gowm_history_scheduler TO gowm_history_scheduler_service;
GRANT USAGE ON SCHEMA gowm_history TO gowm_history_scheduler;
-- A read-only resolver, plus precisely the enqueue/bootstrap and checkpoint
-- writes it needs. No analysis/trajectory registration or queue claim rights.
GRANT SELECT ON gowm_history.task_execution_interval,gowm_history.task_execution_interval_head,
 gowm_history.task_execution_interval_revision,gowm_history.task_execution_phase,
 gowm_history.task_execution_interval_input,gowm_history.method_profile,
 gowm_history.tracklet_finalization_revision,gowm_history.tracklet_finalization_watermark_input,
 gowm_history.historical_trajectory_projection_queue,gowm_history.historical_trajectory_outcome
 TO gowm_history_scheduler;
GRANT SELECT ON public.world_object_state,public.world_observation,public.operational_task_event,public.world_reference_identity,
 public.world_reference_descriptor_version,public.mobility_tracklet,public.mobility_tracklet_version,
 public.mobility_tracklet_segment,public.mobility_tracklet_gap,public.mobility_tracklet_input,
 public.entity_binding,public.analysis_space,public.measurement,public.observation_time_solution
 TO gowm_history_scheduler;
GRANT EXECUTE ON FUNCTION gowm_history.bootstrap_unknown_watermarks(text,text,text),
 gowm_history.enqueue_historical_trajectory_projection(text,text,text,integer,text,text,text,timestamptz,jsonb,jsonb)
 TO gowm_history_scheduler;
CREATE TABLE gowm_history.auto_checkpoint (
 data_scope_key text NOT NULL REFERENCES public.data_scope,
 candidate_key text NOT NULL, input_signature text,queue_id uuid REFERENCES gowm_history.historical_trajectory_projection_queue,
 failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),last_outcome text,
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(data_scope_key,candidate_key)
);
ALTER TABLE gowm_history.auto_checkpoint ENABLE ROW LEVEL SECURITY;
CREATE POLICY auto_checkpoint_scope ON gowm_history.auto_checkpoint TO gowm_history_scheduler
 USING(data_scope_key=gowm_history_v1.current_data_scope_key())
 WITH CHECK(data_scope_key=gowm_history_v1.current_data_scope_key());
GRANT SELECT,INSERT,UPDATE ON gowm_history.auto_checkpoint TO gowm_history_scheduler;
ALTER ROLE gowm_history_scheduler_service SET statement_timeout='15s';
ALTER ROLE gowm_history_scheduler_service SET lock_timeout='5s';
COMMIT;
