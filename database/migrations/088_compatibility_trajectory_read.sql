BEGIN;
CREATE FUNCTION gowm_history_v1.compatibility_trajectory(p_scope text,p_entity text,p_options jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE candidates integer; v record; samples jsonb; gaps jsonb; lim integer=COALESCE((p_options->>'limit')::integer,10000);
 lower_time timestamptz=(p_options->>'from')::timestamptz; upper_time timestamptz=(p_options->>'to')::timestamptz;
 status text; has_evidence boolean;
BEGIN
 IF p_scope IS DISTINCT FROM gowm_history_v1.current_data_scope_key() OR p_scope IS NULL THEN
  RAISE EXCEPTION 'TRAJECTORY_SCOPE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF lim<1 OR lim>100000 OR lower_time>upper_time THEN RAISE EXCEPTION 'TRAJECTORY_QUERY_INVALID' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO candidates FROM public.mobility_tracklet t JOIN public.mobility_tracklet_head h USING(tracklet_id)
 JOIN public.mobility_tracklet_version r ON r.tracklet_version_id=h.current_version_id
 WHERE t.data_scope_key=p_scope AND t.world_object_id=p_entity
  AND (lower_time IS NULL OR r.end_event_time>=lower_time) AND (upper_time IS NULL OR r.start_event_time<=upper_time)
  AND (p_options->>'source' IS NULL OR t.source_key=p_options->>'source')
  AND (p_options->>'trackerSessionKey' IS NULL OR t.tracker_session_key=p_options->>'trackerSessionKey')
  AND (p_options->>'analysisSpaceKey' IS NULL OR t.analysis_space_key=p_options->>'analysisSpaceKey')
  AND (p_options->>'profileKey' IS NULL OR r.profile_key=p_options->>'profileKey');
 IF candidates>1 THEN RAISE EXCEPTION 'TRAJECTORY_SELECTION_AMBIGUOUS' USING ERRCODE='22023'; END IF;
 IF candidates=0 THEN
  SELECT EXISTS(SELECT 1 FROM public.world_observation o JOIN public.world_observation_head oh ON oh.current_observation_id=o.observation_id
   JOIN public.measurement m USING(observation_id) JOIN public.position_measurement pm USING(measurement_id)
   JOIN public.observation_time_solution ts ON ts.time_solution_id=m.time_solution_id
   WHERE o.data_scope_key=p_scope AND o.subject_id=p_entity
    AND (p_options->>'source' IS NULL OR o.source=p_options->>'source')
    AND (p_options->>'trackerSessionKey' IS NULL OR o.tracker_session_id=p_options->>'trackerSessionKey')
    AND (p_options->>'analysisSpaceKey' IS NULL OR pm.analysis_space_key=p_options->>'analysisSpaceKey')
    AND (lower_time IS NULL OR ts.phenomenon_time_estimate>=lower_time) AND (upper_time IS NULL OR ts.phenomenon_time_estimate<=upper_time)) INTO has_evidence;
  RETURN jsonb_build_object('status',CASE WHEN has_evidence THEN 'PENDING' ELSE 'NO_DATA' END,'points','[]'::jsonb,
   'gaps','[]'::jsonb,'truncated',false,'dataScopeKey',p_scope);
 END IF;
 SELECT t.source_key,t.tracker_session_key,t.analysis_space_key,r.* INTO v FROM public.mobility_tracklet t JOIN public.mobility_tracklet_head h USING(tracklet_id)
 JOIN public.mobility_tracklet_version r ON r.tracklet_version_id=h.current_version_id
 WHERE t.data_scope_key=p_scope AND t.world_object_id=p_entity
  AND (lower_time IS NULL OR r.end_event_time>=lower_time) AND (upper_time IS NULL OR r.start_event_time<=upper_time)
  AND (p_options->>'source' IS NULL OR t.source_key=p_options->>'source')
  AND (p_options->>'trackerSessionKey' IS NULL OR t.tracker_session_key=p_options->>'trackerSessionKey')
  AND (p_options->>'analysisSpaceKey' IS NULL OR t.analysis_space_key=p_options->>'analysisSpaceKey')
  AND (p_options->>'profileKey' IS NULL OR r.profile_key=p_options->>'profileKey');
 SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.observed_at,x.ordinal_no),'[]') INTO samples FROM (
  SELECT p_entity AS entity_id,ts.phenomenon_time_estimate AS observed_at,i.observation_id,
   public.ST_X(pm.source_position) AS longitude,public.ST_Y(pm.source_position) AS latitude,pm.altitude_m AS altitude,
   CASE WHEN (m.attributes->>'heading')~'^-?[0-9]+([.][0-9]+)?$' THEN (m.attributes->>'heading')::float8 END AS heading,
   CASE WHEN (m.attributes->>'speed')~'^-?[0-9]+([.][0-9]+)?$' THEN (m.attributes->>'speed')::float8 END AS speed,
   m.attributes AS state,v.source_key AS source,COALESCE(m.algorithm_confidence,o.confidence) AS confidence,
   i.segment_no,i.ordinal_no,i.measurement_id,i.time_solution_id
  FROM public.mobility_tracklet_input i JOIN public.observation_time_solution ts ON ts.time_solution_id=i.time_solution_id
  JOIN public.measurement m ON m.measurement_id=i.measurement_id JOIN public.position_measurement pm ON pm.measurement_id=i.measurement_id
  JOIN public.world_observation o ON o.observation_id=i.observation_id
  WHERE i.tracklet_version_id=v.tracklet_version_id
   AND (lower_time IS NULL OR ts.phenomenon_time_estimate>=lower_time) AND (upper_time IS NULL OR ts.phenomenon_time_estimate<=upper_time)
  ORDER BY ts.phenomenon_time_estimate,i.ordinal_no LIMIT lim+1
 ) x;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('gapNo',g.gap_no,'start',lower(g.gap_time),'end',upper(g.gap_time),
  'bounds',(CASE WHEN lower_inc(g.gap_time) THEN '[' ELSE '(' END)||(CASE WHEN upper_inc(g.gap_time) THEN ']' ELSE ')' END),
  'reasonCodes',g.reason_codes,'observabilityState',g.observability_state) ORDER BY g.gap_no),'[]') INTO gaps
 FROM public.mobility_tracklet_gap g WHERE g.tracklet_version_id=v.tracklet_version_id
  AND (lower_time IS NULL OR upper(g.gap_time)>=lower_time) AND (upper_time IS NULL OR lower(g.gap_time)<=upper_time);
 RETURN jsonb_build_object('status',CASE WHEN jsonb_array_length(gaps)>0 OR jsonb_array_length(samples)>lim THEN 'PARTIAL' ELSE 'AVAILABLE' END,
  'points',samples,'gaps',gaps,'truncated',jsonb_array_length(samples)>lim,'dataScopeKey',p_scope,
  'identity',jsonb_build_object('trackletId',v.tracklet_id,'trackletVersionId',v.tracklet_version_id,'version',v.version_no,
   'contentHash',v.content_hash,'source',v.source_key,'trackerSessionKey',v.tracker_session_key,'analysisSpaceKey',v.analysis_space_key,
   'profileKey',v.profile_key,'state',v.version_state,'createdAt',v.created_at),
  'versionEvidenceSampleCount',v.sample_count,'sequenceCount',v.sequence_count,
  'coverageMeaning','OBSERVED_SAMPLES_WITHIN_PINNED_SEGMENTS');
END $$;
REVOKE ALL ON FUNCTION gowm_history_v1.compatibility_trajectory(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_history_v1.compatibility_trajectory(text,text,jsonb) TO gowm_history_reader;
COMMIT;
