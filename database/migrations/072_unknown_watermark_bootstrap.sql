BEGIN;
-- A policy row is optional. With no declared lateness, zero is only a storage
-- placeholder under UNKNOWN and never a completeness/zero-loss guarantee.
CREATE TABLE gowm_history.stream_bootstrap_policy (
 datastream_key text PRIMARY KEY REFERENCES public.datastream,
 allowed_lateness interval NOT NULL CHECK(allowed_lateness>=interval '0'),
 policy_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON gowm_history.stream_bootstrap_policy FROM PUBLIC;

CREATE FUNCTION gowm_history.bootstrap_unknown_for_measurement(p_measurement uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,gowm_history AS $fn$
DECLARE e record; run_id uuid;
BEGIN
 SELECT o.datastream_key,o.producer_pipeline_key,o.received_at,ts.clock_model_id,
   coalesce(policy.allowed_lateness,interval '0') lateness,
   coalesce(policy.policy_version,'UNDECLARED_UNKNOWN_ONLY') policy_version
 INTO e FROM public.measurement m JOIN public.position_measurement p USING(measurement_id)
 JOIN public.world_observation o USING(observation_id)
 JOIN public.observation_time_solution ts ON ts.time_solution_id=m.time_solution_id
 JOIN public.source_clock_model clock ON clock.clock_model_id=ts.clock_model_id AND clock.source_key=o.source
 JOIN public.datastream ds ON ds.datastream_key=o.datastream_key
   AND ds.data_scope_key=o.data_scope_key AND ds.source_key=o.source AND ds.pipeline_key=o.producer_pipeline_key
 LEFT JOIN gowm_history.stream_bootstrap_policy policy ON policy.datastream_key=o.datastream_key
 WHERE m.measurement_id=p_measurement;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('gowm:unknown-watermark:'||e.datastream_key,0));
 -- Never supersede an existing authority revision, including old UNKNOWN.
 -- A clock change is resolved by the ordinary watermark producer, not startup.
 IF EXISTS(SELECT 1 FROM public.pipeline_watermark_revision w WHERE w.datastream_key=e.datastream_key) THEN RETURN false; END IF;
 INSERT INTO public.processing_run(processor_name,processor_version,config_hash,deterministic,started_at,completed_at)
 VALUES('gowm-unknown-watermark-bootstrap','1.0',public.grounding_sha256(
   jsonb_build_array(e.datastream_key,e.clock_model_id,e.policy_version,e.lateness)::text),true,clock_timestamp(),clock_timestamp())
 RETURNING processing_run_id INTO run_id;
 INSERT INTO public.pipeline_watermark_revision(datastream_key,producer_pipeline_key,processing_run_id,
   clock_model_id,time_basis,closed_through_event_time,allowed_lateness,last_received_time,completeness_state)
 VALUES(e.datastream_key,e.producer_pipeline_key,run_id,e.clock_model_id,'CLOCK_MODEL',NULL,e.lateness,e.received_at,'UNKNOWN');
 RETURN true;
END $fn$;

CREATE FUNCTION gowm_history.bootstrap_position_watermark_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,gowm_history AS $fn$
BEGIN
 PERFORM gowm_history.bootstrap_unknown_for_measurement(NEW.measurement_id);
 RETURN NEW;
END $fn$;
CREATE TRIGGER position_unknown_watermark_bootstrap AFTER INSERT ON public.position_measurement
 FOR EACH ROW EXECUTE FUNCTION gowm_history.bootstrap_position_watermark_trigger();

-- Controlled retrofit for streams already present before this migration.
CREATE FUNCTION gowm_history.bootstrap_unknown_watermarks(p_scope text,p_source text,p_device text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,gowm_history AS $fn$
DECLARE e record; added integer:=0;
BEGIN
 IF p_scope IS DISTINCT FROM gowm_history_v1.current_data_scope_key() THEN
   RAISE EXCEPTION 'WATERMARK_SCOPE_MISMATCH' USING ERRCODE='42501';
 END IF;
 FOR e IN SELECT DISTINCT ON(o.datastream_key) m.measurement_id
 FROM public.world_observation o JOIN public.measurement m USING(observation_id)
 JOIN public.position_measurement p USING(measurement_id)
 JOIN public.observation_time_solution ts ON ts.time_solution_id=m.time_solution_id
 WHERE o.data_scope_key=p_scope AND o.source=p_source AND o.source_local_target_id=p_device
   AND ts.clock_model_id IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM public.pipeline_watermark_revision w WHERE w.datastream_key=o.datastream_key)
 ORDER BY o.datastream_key,o.created_at DESC,m.measurement_id DESC
 LOOP
   IF gowm_history.bootstrap_unknown_for_measurement(e.measurement_id) THEN added:=added+1; END IF;
 END LOOP;
 RETURN added;
END $fn$;
REVOKE ALL ON FUNCTION gowm_history.bootstrap_unknown_for_measurement(uuid),
 gowm_history.bootstrap_position_watermark_trigger(),
 gowm_history.bootstrap_unknown_watermarks(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_history.bootstrap_unknown_watermarks(text,text,text) TO gowm_history_worker;
COMMIT;
