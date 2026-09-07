BEGIN;

CREATE SCHEMA gowm_history_v2;
REVOKE ALL ON SCHEMA gowm_history_v2 FROM PUBLIC;
GRANT USAGE ON SCHEMA gowm_history_v2 TO gowm_history_reader;

-- Matches historical-trace-core canonicalJson for the string/integer objects
-- in the frozen v1 input manifests. Never hash jsonb::text (it adds spaces).
CREATE FUNCTION gowm_history_v2.canonical_json(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
 SELECT CASE jsonb_typeof(value)
 WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_jsonb(key)::text||':'||gowm_history_v2.canonical_json(v),',' ORDER BY key COLLATE "C") FROM jsonb_each(value) e(key,v)),'')||'}'
 WHEN 'array' THEN '['||coalesce((SELECT string_agg(gowm_history_v2.canonical_json(v),',' ORDER BY n) FROM jsonb_array_elements(value) WITH ORDINALITY e(v,n)),'')||']'
 ELSE value::text END
$fn$;

CREATE FUNCTION gowm_history_v2.input_digest(members jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $fn$
 SELECT 'sha256:'||encode(public.digest(gowm_history_v2.canonical_json(coalesce(
   jsonb_agg(encoded ORDER BY encoded COLLATE "C"),'[]'::jsonb)),'sha256'),'hex')
 FROM (SELECT gowm_history_v2.canonical_json(v) encoded FROM jsonb_array_elements(members) e(v)) s
$fn$;

CREATE FUNCTION gowm_history_v2.iso_millis(value timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
 SELECT to_char(value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$fn$;

-- Additive read contract: v1 rows and hashes remain byte-for-byte untouched.
-- The cursor binds the exact revision, frozen input identity, and row ordinal.
CREATE FUNCTION gowm_history_v2.read_trajectory_samples(
 p_reference text, p_revision integer, p_captured_at timestamptz,
 p_limit integer DEFAULT 1000, p_cursor jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,gowm_history,gowm_history_v2
AS $fn$
DECLARE
 r record; pin record; versions uuid[]; track_members jsonb; time_members jsonb;
 track_digest text; time_digest text; evidence_hash text; samples jsonb;
 total bigint; offset_no bigint:=0; geometry_count bigint; last_no bigint;
BEGIN
 IF p_revision IS NULL OR p_revision<1 OR p_captured_at IS NULL
    OR p_limit IS NULL OR p_limit<1 OR p_limit>10000 THEN
   RAISE EXCEPTION 'INVALID_EVIDENCE_READ_BOUNDS' USING ERRCODE='22023';
 END IF;
 SELECT revision.*, a.analysis_as_of, identity.phase_scope
 INTO r FROM gowm_history.historical_trajectory identity
 JOIN gowm_history.historical_trajectory_revision revision USING(historical_trajectory_id)
 JOIN public.analysis_record a USING(analysis_id)
 WHERE identity.data_scope_key=gowm_history_v1.current_data_scope_key()
   AND a.data_scope_key=identity.data_scope_key AND identity.reference_key=p_reference
   AND revision.revision_no=p_revision AND revision.created_at<=p_captured_at;
 IF NOT FOUND THEN RAISE EXCEPTION 'TRAJECTORY_NOT_FOUND' USING ERRCODE='P0002'; END IF;

 SELECT array_agg(resource_id::uuid ORDER BY resource_id COLLATE "C") INTO versions
 FROM gowm_history.historical_trajectory_input
 WHERE trajectory_revision_id=r.trajectory_revision_id AND input_kind='TRACKLET_VERSION';
 IF versions IS NULL THEN RAISE EXCEPTION 'EVIDENCE_LINEAGE_UNAVAILABLE'; END IF;
 IF (SELECT count(*) FROM (SELECT 1 FROM public.mobility_tracklet_input
     WHERE tracklet_version_id=ANY(versions) LIMIT 100001) bounded)>100000 THEN
   RAISE EXCEPTION 'EVIDENCE_READ_BUDGET_EXCEEDED' USING ERRCODE='54000';
 END IF;
 FOR pin IN SELECT * FROM gowm_history.historical_trajectory_input
   WHERE trajectory_revision_id=r.trajectory_revision_id AND input_kind='TRACKLET_VERSION'
 LOOP
   IF NOT EXISTS(SELECT 1 FROM public.mobility_tracklet_version v
     JOIN public.mobility_tracklet t USING(tracklet_id)
     WHERE v.tracklet_version_id=pin.resource_id::uuid AND v.version_no::text=pin.resource_version
       AND ('sha256:'||regexp_replace(v.content_hash,'^sha256:',''))=pin.resource_content_hash
       AND t.data_scope_key=gowm_history_v1.current_data_scope_key()
       AND v.created_at<=r.analysis_as_of) THEN RAISE EXCEPTION 'EVIDENCE_TRACKLET_PIN_MISMATCH'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM gowm_history.historical_trajectory_segment s
   WHERE s.trajectory_revision_id=r.trajectory_revision_id
     AND NOT(s.source_tracklet_version_id=ANY(versions))) THEN
   RAISE EXCEPTION 'EVIDENCE_SEGMENT_PIN_MISMATCH';
 END IF;

 SELECT coalesce(jsonb_agg(jsonb_build_object(
   'trackletVersionId',i.tracklet_version_id,'measurementId',i.measurement_id,
   'observationId',i.observation_id,'timeSolutionId',i.time_solution_id,
   'segmentNo',i.segment_no,'ordinalNo',i.ordinal_no,
   'commandFingerprint',m.command_fingerprint,
   'measurementCreatedAt',gowm_history_v2.iso_millis(m.created_at))),'[]'::jsonb)
 INTO track_members FROM public.mobility_tracklet_input i
 JOIN public.measurement m USING(measurement_id)
 JOIN public.observation_time_solution ts ON ts.time_solution_id=i.time_solution_id
 WHERE i.tracklet_version_id=ANY(versions)
   AND m.created_at<=r.analysis_as_of AND ts.created_at<=r.analysis_as_of;
 SELECT coalesce(jsonb_agg(member),'[]'::jsonb) INTO time_members FROM (
   SELECT DISTINCT jsonb_build_object('timeSolutionId',ts.time_solution_id,
    'phenomenonTimeEstimate',gowm_history_v2.iso_millis(ts.phenomenon_time_estimate),
    'solutionMethod',ts.solution_method,'createdAt',gowm_history_v2.iso_millis(ts.created_at)) member
   FROM public.mobility_tracklet_input i JOIN public.measurement m USING(measurement_id)
   JOIN public.observation_time_solution ts ON ts.time_solution_id=i.time_solution_id
   WHERE i.tracklet_version_id=ANY(versions)
     AND m.created_at<=r.analysis_as_of AND ts.created_at<=r.analysis_as_of
 ) members;
 track_digest:=gowm_history_v2.input_digest(track_members);
 time_digest:=gowm_history_v2.input_digest(time_members);
 FOR pin IN SELECT * FROM (VALUES
   ('TRACKLET_INPUT_SET',track_digest,jsonb_array_length(track_members)),
   ('TIME_SOLUTION_SET',time_digest,jsonb_array_length(time_members))
 ) expected(kind,hash,count) LOOP
   IF pin.count=0 OR NOT EXISTS(
     SELECT 1 FROM public.analysis_input_set s
     JOIN gowm_history.historical_trajectory_input i
       ON i.trajectory_revision_id=r.trajectory_revision_id
       AND i.analysis_input_set_kind=s.input_set_kind AND i.input_kind=s.input_set_kind
     WHERE s.analysis_id=r.analysis_id AND s.input_set_kind=pin.kind
       AND s.item_set_digest=pin.hash AND s.item_count=pin.count
       AND i.resource_content_hash=pin.hash AND i.pinning='PINNED'
   ) THEN RAISE EXCEPTION 'EVIDENCE_INPUT_SET_MISMATCH: %',pin.kind; END IF;
 END LOOP;
 evidence_hash:=gowm_history_v2.input_digest(jsonb_build_array(
   r.content_hash,r.input_set_hash,track_digest,time_digest,'ORIGINAL_MEASUREMENT_V1'));
 IF p_cursor IS NOT NULL AND p_cursor<>'null'::jsonb THEN
   IF p_cursor->>'revisionId' IS DISTINCT FROM r.trajectory_revision_id::text
      OR p_cursor->>'evidenceHash' IS DISTINCT FROM evidence_hash
      OR coalesce(p_cursor->>'after','') !~ '^[0-9]+$' THEN
     RAISE EXCEPTION 'EVIDENCE_CURSOR_MISMATCH' USING ERRCODE='22023';
   END IF;
   offset_no:=(p_cursor->>'after')::bigint;
 END IF;

 WITH eligible AS (
   SELECT s.segment_no,i.ordinal_no,i.measurement_id,
     jsonb_build_object('sampleId',i.measurement_id,'measurementId',i.measurement_id,
       'observationId',i.observation_id,'timeSolutionId',i.time_solution_id,
       'sourceTrackletVersionId',i.tracklet_version_id,'sourceSegmentNo',i.segment_no,
       'ordinalNo',i.ordinal_no,'sequenceNo',s.segment_no,
       'observedAt',gowm_history_v2.iso_millis(ts.phenomenon_time_estimate),
       'timeUncertaintySeconds',ts.uncertainty_seconds,'clockModelId',ts.clock_model_id,
       'position',ST_AsGeoJSON(p.source_position)::jsonb,'crs','EPSG:4326',
       'qualityFlags',m.quality_flags,'qualityScore',m.quality_score,
       'sourceKey',o.source,'trackerSessionId',o.tracker_session_id,
       'sourceLocalTargetId',o.source_local_target_id,
       'receivedAt',gowm_history_v2.iso_millis(o.received_at),
       'sourceRecordKey',o.source_record_key,'sourceRevisionNo',o.source_revision_no,
       'manualCutBefore',m.manual_cut_before,'continuityToken',m.continuity_token) sample
   FROM gowm_history.historical_trajectory_segment s
   JOIN public.mobility_tracklet_segment original
     ON original.tracklet_version_id=s.source_tracklet_version_id AND original.segment_no=s.source_segment_no
   JOIN public.mobility_tracklet_input i ON i.tracklet_version_id=s.source_tracklet_version_id
     AND i.segment_no=s.source_segment_no
   JOIN public.measurement m USING(measurement_id)
   JOIN public.position_measurement p USING(measurement_id)
   JOIN public.world_observation o ON o.observation_id=i.observation_id
   JOIN public.observation_time_solution ts ON ts.time_solution_id=i.time_solution_id
   WHERE s.trajectory_revision_id=r.trajectory_revision_id
     AND m.created_at<=r.analysis_as_of AND ts.created_at<=r.analysis_as_of
     -- Restore source endpoint evidence even for legacy half-open geometry
     -- slices, but never cross the requested task/phase half-open boundary.
     AND atTime(original.trajectory,ts.phenomenon_time_estimate) IS NOT NULL
     AND ts.phenomenon_time_estimate BETWEEN s.start_time AND s.end_time
     AND r.requested_time @> ts.phenomenon_time_estimate
     AND (s.phase_no IS NULL OR EXISTS(SELECT 1 FROM gowm_history.task_execution_phase phase
       WHERE phase.interval_revision_id=s.interval_revision_id AND phase.phase_no=s.phase_no
         AND phase.phase_range @> ts.phenomenon_time_estimate))
     AND NOT EXISTS(SELECT 1 FROM gowm_history.historical_trajectory_excluded_period e
       WHERE e.trajectory_revision_id=r.trajectory_revision_id AND e.excluded_time @> ts.phenomenon_time_estimate)
 ), ordered AS (
   SELECT *,row_number() OVER(ORDER BY segment_no,ordinal_no,measurement_id) row_no FROM eligible
 )
 SELECT count(*),coalesce(jsonb_agg(sample ORDER BY row_no)
   FILTER(WHERE row_no>offset_no AND row_no<=offset_no+p_limit),'[]'::jsonb)
 INTO total,samples FROM ordered;
 IF offset_no>total THEN RAISE EXCEPTION 'EVIDENCE_CURSOR_OUT_OF_RANGE'; END IF;
 SELECT coalesce(sum(numInstants(trajectory)),0) INTO geometry_count
 FROM gowm_history.historical_trajectory_segment WHERE trajectory_revision_id=r.trajectory_revision_id;
 last_no:=offset_no+jsonb_array_length(samples);
 RETURN jsonb_build_object('contractVersion','2.0','sampleSemantics','ORIGINAL_MEASUREMENT_V1',
   'revisionId',r.trajectory_revision_id,'contentHash',r.content_hash,
   'inputSetHash',r.input_set_hash,'evidenceHash',evidence_hash,
   'trackletInputSetHash',track_digest,'timeSolutionSetHash',time_digest,
   'evidenceCapturedAt',gowm_history_v2.iso_millis(r.analysis_as_of),
   'evidenceSampleCount',total,'geometryNodeCount',geometry_count,'previewPointCount',0,
   'samples',samples,'complete',last_no=total,
   'nextCursor',CASE WHEN last_no<total THEN jsonb_build_object('revisionId',r.trajectory_revision_id,
     'evidenceHash',evidence_hash,'after',last_no) ELSE NULL END);
END
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_history_v2 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_history_v2.read_trajectory_samples(text,integer,timestamptz,integer,jsonb)
 TO gowm_history_reader;
COMMIT;
