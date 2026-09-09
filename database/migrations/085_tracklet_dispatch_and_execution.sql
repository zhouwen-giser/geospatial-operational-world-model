BEGIN;
-- The composite measurement FK already proves both observation and time
-- solution membership. Keep that FK and its validated upstream FKs, avoiding
-- two duplicate row checks for every sample in every immutable version.
DO $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.mobility_tracklet_input'::regclass
   AND contype='f' AND convalidated AND confrelid='public.measurement'::regclass
   AND pg_get_constraintdef(oid)='FOREIGN KEY (measurement_id, observation_id, time_solution_id) REFERENCES measurement(measurement_id, observation_id, time_solution_id)')
 OR (SELECT count(*) FROM pg_constraint WHERE conrelid='public.measurement'::regclass AND contype='f' AND convalidated
   AND ((conname='measurement_observation_id_fkey' AND confrelid='public.world_observation'::regclass)
     OR (conname='measurement_time_solution_id_fkey' AND confrelid='public.observation_time_solution'::regclass)))<>2
 THEN RAISE EXCEPTION 'validated measurement evidence FK chain is required' USING ERRCODE='23514'; END IF;
END $guard$;
ALTER TABLE public.mobility_tracklet_input
 DROP CONSTRAINT mobility_tracklet_input_observation_id_fkey,
 DROP CONSTRAINT mobility_tracklet_input_time_solution_id_fkey;

CREATE OR REPLACE FUNCTION gowm_rebuild_mobility_tracklet(
  p_scope text,p_source text,p_target text,p_tracker_session text,p_space text,
  p_profile text DEFAULT 'source-local-default'
)
RETURNS uuid LANGUAGE plpgsql
SET work_mem = '16MB'
SET max_parallel_workers_per_gather = 0
AS $fn$
DECLARE
  target_tracklet uuid;
  old_head uuid;
  new_version uuid := gen_random_uuid();
  next_version integer;
  temporal_value tgeompoint;
  first_point record;
  last_point record;
  total_samples integer;
  total_sequences integer;
  average_quality double precision;
  maximum_radius double precision;
  all_hard_radius boolean;
  value_hash text;
  bound_object text;
  current_binding text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(E'\x1f',p_scope,p_source,p_tracker_session,p_target,p_space),0));

  SELECT eb.world_object_id INTO bound_object FROM entity_binding eb
  WHERE eb.data_scope_key=p_scope AND eb.source_key=p_source AND eb.source_local_target_id=p_target
    AND eb.tracker_session_key=p_tracker_session
    AND eb.binding_status IN ('DECLARED','CONFIRMED')
  ORDER BY eb.created_at DESC LIMIT 1;

  SELECT tracklet_id,world_object_id INTO target_tracklet,current_binding FROM mobility_tracklet
  WHERE data_scope_key=p_scope AND source_key=p_source AND source_local_target_id=p_target
    AND tracker_session_key=p_tracker_session AND analysis_space_key=p_space;
  IF target_tracklet IS NULL THEN
  INSERT INTO mobility_tracklet(data_scope_key,source_key,source_local_target_id,tracker_session_key,world_object_id,object_class,analysis_space_key,tracklet_scope)
  SELECT p_scope,p_source,p_target,p_tracker_session,bound_object,o.subject_type,p_space,'SOURCE_LOCAL'
  FROM world_observation o
  WHERE o.data_scope_key=p_scope AND o.source=p_source AND o.source_local_target_id=p_target
    AND COALESCE(o.tracker_session_id,'__UNSCOPED__')=p_tracker_session
  ORDER BY o.received_at LIMIT 1
  ON CONFLICT (data_scope_key,source_key,tracker_session_key,source_local_target_id,analysis_space_key)
  DO UPDATE SET world_object_id=COALESCE(EXCLUDED.world_object_id,mobility_tracklet.world_object_id)
  RETURNING tracklet_id INTO target_tracklet;

  ELSIF bound_object IS NOT NULL AND current_binding IS DISTINCT FROM bound_object THEN
    UPDATE mobility_tracklet SET world_object_id=bound_object WHERE tracklet_id=target_tracklet;
  END IF;
  -- Stable identity reads must not hold a no-op UPDATE lock throughout the rebuild:
  -- finalization takes SHARE locks on this identity while checking its evidence.

  SELECT current_version_id INTO old_head FROM mobility_tracklet_head WHERE tracklet_id=target_tracklet FOR UPDATE;
  SELECT COALESCE(max(version_no),0)+1 INTO next_version FROM mobility_tracklet_version WHERE tracklet_id=target_tracklet;
  WITH candidates AS MATERIALIZED (
    SELECT * FROM gowm_tracklet_candidates(p_scope,p_source,p_target,p_tracker_session,p_space,p_profile)
  ), seqs AS MATERIALIZED (
    SELECT segment_no,tgeompointSeq(array_agg(tgeompoint(analysis_position,event_time) ORDER BY ordinal_no),'linear') seq,
      count(*) samples,min(event_time) first_time,max(event_time) last_time
    FROM candidates GROUP BY segment_no
  ), stats AS (
    SELECT count(*) samples,count(DISTINCT segment_no) sequences,avg(quality_score) quality,
      CASE WHEN bool_and(accuracy_model='HARD_RADIUS') THEN max(accuracy_radius_m) END radius,
      encode(digest(string_agg(concat_ws(':',measurement_id,time_solution_id,segment_no,ordinal_no,edge_decision,
        array_to_string(edge_reason_codes,',')),'|' ORDER BY event_time,measurement_id)||
        ':'||r.config_hash||':LINEAR','sha256'),'hex') hash
    FROM candidates CROSS JOIN tracklet_rule_profile r WHERE r.profile_key=p_profile GROUP BY r.config_hash
  ), first_point AS (SELECT * FROM candidates ORDER BY segment_no,ordinal_no LIMIT 1),
  last_point AS (SELECT * FROM candidates ORDER BY segment_no DESC,ordinal_no DESC LIMIT 1),
  temporal AS (SELECT tgeompointSeqSet(array_agg(seq ORDER BY segment_no)) trajectory FROM seqs),
  prior AS MATERIALIZED (
    SELECT v.tracklet_version_id FROM mobility_tracklet_version v,stats s WHERE v.tracklet_id=target_tracklet AND v.content_hash=s.hash
  ), inserted AS (
    INSERT INTO mobility_tracklet_version(tracklet_version_id,tracklet_id,version_no,profile_key,version_state,trajectory,extent_box,
      start_event_time,end_event_time,start_position,end_position,max_accuracy_radius_m,content_hash,sample_count,sequence_count,quality_score)
    SELECT new_version,target_tracklet,next_version,p_profile,'PROVISIONAL',t.trajectory,stbox(t.trajectory),
      f.event_time,l.event_time,f.analysis_position,l.analysis_position,s.radius,s.hash,s.samples,s.sequences,s.quality
    FROM temporal t,stats s,first_point f,last_point l WHERE t.trajectory IS NOT NULL AND NOT EXISTS(SELECT 1 FROM prior)
    RETURNING tracklet_version_id
  ), segments AS (
    INSERT INTO mobility_tracklet_segment(tracklet_version_id,segment_no,trajectory,sample_count,start_time,end_time)
    SELECT i.tracklet_version_id,s.segment_no,s.seq,s.samples,s.first_time,s.last_time FROM inserted i,seqs s RETURNING 1
  ), inputs AS (
    INSERT INTO mobility_tracklet_input(tracklet_version_id,measurement_id,observation_id,time_solution_id,segment_no,ordinal_no)
    SELECT i.tracklet_version_id,c.measurement_id,c.observation_id,c.time_solution_id,c.segment_no,c.ordinal_no FROM inserted i,candidates c RETURNING 1
  ), ends AS (SELECT DISTINCT ON(segment_no) * FROM candidates ORDER BY segment_no,ordinal_no DESC),
  gaps AS (
    INSERT INTO mobility_tracklet_gap(tracklet_version_id,gap_no,previous_segment_no,next_segment_no,gap_time,primary_reason,
      reason_codes,observability_state,left_measurement_id,right_measurement_id)
    SELECT i.tracklet_version_id,s.segment_no-1,s.segment_no-1,s.segment_no,tstzrange(e.event_time,s.event_time,'()'),
      COALESCE(s.edge_reason_codes[1],'UNKNOWN_GAP'),
      CASE WHEN cardinality(s.edge_reason_codes)=0 THEN ARRAY['UNKNOWN_GAP'] ELSE s.edge_reason_codes END,
      'UNKNOWN',e.measurement_id,s.measurement_id
    FROM inserted i,candidates s JOIN ends e ON e.segment_no=s.segment_no-1 WHERE s.ordinal_no=1 AND s.segment_no>1 RETURNING 1
  ) SELECT COALESCE((SELECT tracklet_version_id FROM inserted),(SELECT tracklet_version_id FROM prior)) INTO new_version;
  IF new_version IS NULL OR new_version=old_head THEN RETURN new_version; END IF;
  -- An existing non-head version is reused without moving the head backwards.
  IF EXISTS(SELECT 1 FROM mobility_tracklet_head h JOIN mobility_tracklet_version v ON v.tracklet_version_id=new_version
    WHERE h.tracklet_id=target_tracklet AND v.version_no<next_version) THEN RETURN new_version; END IF;
  IF old_head IS NOT NULL THEN
    INSERT INTO mobility_tracklet_lineage(parent_version_id,child_version_id,lineage_type,reason)
    VALUES(old_head,new_version,'SUPERSEDES','Deterministic rebuild after canonical evidence append');
  END IF;
  INSERT INTO mobility_tracklet_head(tracklet_id,current_version_id) VALUES(target_tracklet,new_version)
  ON CONFLICT(tracklet_id) DO UPDATE SET current_version_id=EXCLUDED.current_version_id,updated_at=clock_timestamp();
  RETURN new_version;
END
$fn$;

-- Parallelism is owned by bounded worker slots. In particular, the legacy
-- lineage joins must not allocate an additional parallel hash arena per slot.
ALTER FUNCTION gowm_history.classify_tracklet_lineage(uuid,uuid)
 SET max_parallel_workers_per_gather = 0;
ALTER FUNCTION gowm_history.classify_tracklet_lineage(uuid,uuid)
 SET work_mem = '16MB';

CREATE FUNCTION gowm_history.tracklet_dispatch_key(p_scope text,p_source text,p_target text,p_session text,p_space text,p_profile text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $fn$
 SELECT public.grounding_sha256(jsonb_build_array(p_scope,p_source,p_target,p_session,p_space,p_profile)::text)
$fn$;
CREATE TABLE gowm_history.tracklet_dispatch (
 key text PRIMARY KEY, pending_since timestamptz,
 active_queue_id uuid REFERENCES gowm_history.tracklet_projection_queue(queue_id)
);
REVOKE ALL ON gowm_history.tracklet_dispatch FROM PUBLIC;
CREATE FUNCTION gowm_history.note_tracklet_pending() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,gowm_history AS $fn$
BEGIN
 IF NEW.state IN ('QUEUED','FAILED') AND NEW.attempts<10 THEN
  INSERT INTO gowm_history.tracklet_dispatch(key,pending_since)
   VALUES(gowm_history.tracklet_dispatch_key(NEW.data_scope_key,NEW.source_key,NEW.source_local_target_id,NEW.tracker_session_key,NEW.analysis_space_key,NEW.profile_key),clock_timestamp())
  ON CONFLICT(key) DO UPDATE SET pending_since=coalesce(gowm_history.tracklet_dispatch.pending_since,EXCLUDED.pending_since);
 END IF;
 RETURN NEW;
END
$fn$;
CREATE TRIGGER tracklet_dispatch_pending AFTER INSERT OR UPDATE OF state ON gowm_history.tracklet_projection_queue
FOR EACH ROW EXECUTE FUNCTION gowm_history.note_tracklet_pending();
-- Dispatch metadata only: queue identity, attempts and outcomes are not changed.
INSERT INTO gowm_history.tracklet_dispatch(key,pending_since)
 SELECT gowm_history.tracklet_dispatch_key(q.data_scope_key,q.source_key,q.source_local_target_id,q.tracker_session_key,q.analysis_space_key,q.profile_key),min(q.created_at)
 FROM gowm_history.tracklet_projection_queue q WHERE q.attempts<10 AND q.state IN('QUEUED','FAILED','RUNNING') GROUP BY 1;
CREATE OR REPLACE FUNCTION gowm_history.claim_tracklet_projection(p_worker_id text,p_batch_size integer DEFAULT 100,p_lease interval DEFAULT interval '30 seconds')
RETURNS SETOF gowm_history.tracklet_projection_queue LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,gowm_history AS $fn$
DECLARE d record; q gowm_history.tracklet_projection_queue;
BEGIN
 IF length(btrim(p_worker_id)) NOT BETWEEN 1 AND 128 OR p_batch_size NOT BETWEEN 1 AND 1000
   OR p_lease<=interval '0' OR p_lease>interval '15 minutes' THEN RAISE EXCEPTION 'invalid tracklet claim' USING ERRCODE='22023'; END IF;
 FOR d IN SELECT dispatch.* FROM gowm_history.tracklet_dispatch dispatch
 LEFT JOIN gowm_history.tracklet_projection_queue active ON active.queue_id=dispatch.active_queue_id
 WHERE (dispatch.pending_since<=clock_timestamp()-interval '1 second'
     OR (active.state='RUNNING' AND active.attempts<10 AND active.lease_until<=clock_timestamp())
     OR (active.state='FAILED' AND active.attempts<10 AND active.available_at<=clock_timestamp()))
 AND EXISTS(SELECT 1 FROM gowm_history.tracklet_projection_queue eligible
   WHERE gowm_history.tracklet_dispatch_key(eligible.data_scope_key,eligible.source_key,eligible.source_local_target_id,eligible.tracker_session_key,eligible.analysis_space_key,eligible.profile_key)=dispatch.key
     AND eligible.attempts<10 AND eligible.available_at<=clock_timestamp()
     AND (eligible.state IN('QUEUED','FAILED') OR (eligible.state='RUNNING' AND eligible.lease_until<=clock_timestamp())))
 AND NOT EXISTS(SELECT 1 FROM gowm_history.tracklet_projection_queue running
   WHERE gowm_history.tracklet_dispatch_key(running.data_scope_key,running.source_key,running.source_local_target_id,running.tracker_session_key,running.analysis_space_key,running.profile_key)=dispatch.key AND running.state='RUNNING' AND running.lease_until>clock_timestamp())
 ORDER BY dispatch.pending_since NULLS FIRST,dispatch.key FOR UPDATE OF dispatch SKIP LOCKED LIMIT p_batch_size
 LOOP
  SELECT queue.* INTO q FROM gowm_history.tracklet_projection_queue queue
  WHERE gowm_history.tracklet_dispatch_key(queue.data_scope_key,queue.source_key,queue.source_local_target_id,queue.tracker_session_key,queue.analysis_space_key,queue.profile_key)=d.key AND queue.attempts<10 AND queue.available_at<=clock_timestamp()
    AND (queue.state IN('QUEUED','FAILED') OR (queue.state='RUNNING' AND queue.lease_until<=clock_timestamp()))
  ORDER BY (queue.state='RUNNING') DESC,queue.available_at,queue.created_at,queue.queue_id
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF FOUND THEN
   UPDATE gowm_history.tracklet_projection_queue SET state='RUNNING',generation=generation+1,attempts=attempts+1,
     locked_at=clock_timestamp(),lease_until=clock_timestamp()+p_lease,locked_by=p_worker_id,
     rebuilt_tracklet_version_id=NULL,processed_at=NULL WHERE queue_id=q.queue_id RETURNING * INTO q;
   UPDATE gowm_history.tracklet_dispatch SET pending_since=CASE WHEN EXISTS(
     SELECT 1 FROM gowm_history.tracklet_projection_queue waiting WHERE waiting.queue_id<>q.queue_id
       AND waiting.state IN('QUEUED','FAILED') AND waiting.attempts<10
       AND gowm_history.tracklet_dispatch_key(waiting.data_scope_key,waiting.source_key,waiting.source_local_target_id,waiting.tracker_session_key,waiting.analysis_space_key,waiting.profile_key)=d.key
   ) THEN coalesce(pending_since,clock_timestamp()) ELSE NULL END,active_queue_id=q.queue_id WHERE key=d.key;
   RETURN NEXT q;
  END IF;
 END LOOP;
END
$fn$;
CREATE INDEX tracklet_dispatch_queue_idx ON gowm_history.tracklet_projection_queue
 (gowm_history.tracklet_dispatch_key(data_scope_key,source_key,source_local_target_id,tracker_session_key,analysis_space_key,profile_key),state,available_at) WHERE attempts<10;

-- Serialize evaluations of one immutable tracklet version across containers.
CREATE OR REPLACE FUNCTION gowm_history.claim_tracklet_finalization(p_worker_id text,p_batch_size integer DEFAULT 100,p_lease interval DEFAULT interval '30 seconds')
RETURNS SETOF gowm_history.tracklet_finalization_queue LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,gowm_history AS $fn$
DECLARE candidate record; claimed gowm_history.tracklet_finalization_queue;
BEGIN
 IF p_worker_id IS NULL OR length(btrim(p_worker_id)) NOT BETWEEN 1 AND 128
  OR p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 1000 OR p_lease IS NULL
  OR p_lease<=interval '0' OR p_lease>interval '15 minutes'
 THEN RAISE EXCEPTION 'invalid finalization claim' USING ERRCODE='22023'; END IF;
 FOR candidate IN SELECT version.tracklet_version_id FROM public.mobility_tracklet_version version
 JOIN (SELECT queue.tracklet_version_id,min(queue.created_at) first_pending
   FROM gowm_history.tracklet_finalization_queue queue WHERE queue.attempts<10 AND queue.available_at<=clock_timestamp()
    AND (queue.state IN('QUEUED','FAILED') OR (queue.state='RUNNING' AND queue.lease_until<=clock_timestamp()))
   GROUP BY queue.tracklet_version_id) pending USING(tracklet_version_id)
 WHERE NOT EXISTS(SELECT 1 FROM gowm_history.tracklet_finalization_queue active WHERE active.tracklet_version_id=version.tracklet_version_id
    AND active.state='RUNNING' AND active.lease_until>clock_timestamp())
 ORDER BY pending.first_pending,version.tracklet_version_id FOR UPDATE OF version SKIP LOCKED LIMIT p_batch_size
 LOOP
  IF EXISTS(SELECT 1 FROM gowm_history.tracklet_finalization_queue active WHERE active.tracklet_version_id=candidate.tracklet_version_id
    AND active.state='RUNNING' AND active.lease_until>clock_timestamp()) THEN CONTINUE; END IF;
  SELECT queue.* INTO claimed FROM gowm_history.tracklet_finalization_queue queue
  WHERE queue.tracklet_version_id=candidate.tracklet_version_id AND queue.attempts<10 AND queue.available_at<=clock_timestamp()
    AND (queue.state IN('QUEUED','FAILED') OR (queue.state='RUNNING' AND queue.lease_until<=clock_timestamp()))
  ORDER BY (queue.state='RUNNING') DESC,queue.created_at,queue.queue_id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF FOUND THEN
   UPDATE gowm_history.tracklet_finalization_queue SET state='RUNNING',generation=generation+1,attempts=attempts+1,
     locked_at=clock_timestamp(),lease_until=clock_timestamp()+p_lease,locked_by=p_worker_id,finalization_revision_id=NULL,processed_at=NULL
   WHERE queue_id=claimed.queue_id RETURNING * INTO claimed;
   RETURN NEXT claimed;
  END IF;
 END LOOP;
END
$fn$;
CREATE INDEX tracklet_finalization_execution_lookup ON gowm_history.tracklet_finalization_queue(tracklet_version_id,state,available_at) WHERE attempts<10;

CREATE FUNCTION gowm_history.renew_tracklet_projection(
  p_queue_id uuid, p_worker_id text, p_generation bigint, p_lease interval
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
BEGIN
  IF p_lease IS NULL OR p_lease <= interval '0' OR p_lease > interval '15 minutes' THEN
    RAISE EXCEPTION 'historical trajectory renewal lease is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE gowm_history.tracklet_projection_queue
  SET lease_until=clock_timestamp()+p_lease
  WHERE queue_id=p_queue_id AND state='RUNNING'
    AND locked_by=p_worker_id AND generation=p_generation
    AND lease_until>clock_timestamp();
  RETURN FOUND;
END
$fn$;
REVOKE ALL ON FUNCTION gowm_history.renew_tracklet_projection(uuid,text,bigint,interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_history.renew_tracklet_projection(uuid,text,bigint,interval) TO gowm_history_worker;

CREATE FUNCTION gowm_history.renew_tracklet_finalization(
  p_queue_id uuid, p_worker_id text, p_generation bigint, p_lease interval
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_history
AS $fn$
BEGIN
  IF p_lease IS NULL OR p_lease <= interval '0' OR p_lease > interval '15 minutes' THEN
    RAISE EXCEPTION 'historical trajectory renewal lease is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE gowm_history.tracklet_finalization_queue
  SET lease_until=clock_timestamp()+p_lease
  WHERE queue_id=p_queue_id AND state='RUNNING'
    AND locked_by=p_worker_id AND generation=p_generation
    AND lease_until>clock_timestamp();
  RETURN FOUND;
END
$fn$;
REVOKE ALL ON FUNCTION gowm_history.renew_tracklet_finalization(uuid,text,bigint,interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_history.renew_tracklet_finalization(uuid,text,bigint,interval) TO gowm_history_worker;

REVOKE ALL ON FUNCTION gowm_history.tracklet_dispatch_key(text,text,text,text,text,text), gowm_history.note_tracklet_pending() FROM PUBLIC;
COMMIT;
