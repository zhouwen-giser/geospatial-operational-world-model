BEGIN;

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_history_artifact_owner') THEN
  CREATE ROLE gowm_history_artifact_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_history_artifact_owner' AND
   (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
  RAISE EXCEPTION 'ARTIFACT_OWNER_ROLE_CONFLICT';
 END IF;
END $$;
CREATE SCHEMA gowm_history_artifact AUTHORIZATION gowm_history_artifact_owner;
GRANT gowm_history_reader TO gowm_history_artifact_owner;
GRANT USAGE ON SCHEMA public,gowm_history,gowm_history_v2 TO gowm_history_artifact_owner;
GRANT SELECT ON gowm_history.historical_trajectory_revision,gowm_history.historical_trajectory_segment,
 gowm_history.historical_trajectory_gap,gowm_history.historical_trajectory_excluded_period,
 gowm_history.historical_trajectory_input,gowm_history.historical_request_evaluation,
 gowm_history.historical_trajectory_projection_queue TO gowm_history_artifact_owner;
GRANT EXECUTE ON FUNCTION gowm_history_v2.canonical_json(jsonb) TO gowm_history_artifact_owner;

-- Registry contains identities and byte hashes only. Geometry remains exclusively
-- in the immutable historical revision/segments; no duplicate trajectory store.
CREATE TABLE gowm_history_artifact.registry (
 artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 data_scope_key text NOT NULL REFERENCES public.data_scope(scope_key),
 evaluation_id uuid NOT NULL REFERENCES gowm_history.historical_request_evaluation(evaluation_id),
 trajectory_revision_id uuid NOT NULL REFERENCES gowm_history.historical_trajectory_revision(trajectory_revision_id),
 full_request_hash text NOT NULL CHECK(full_request_hash ~ '^sha256:[0-9a-f]{64}$'),
 snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
 header jsonb NOT NULL,
 document_digest text NOT NULL CHECK(document_digest ~ '^sha256:[0-9a-f]{64}$'),
 document_bytes bigint NOT NULL CHECK(document_bytes>0 AND document_bytes<=67108864),
 geometry_node_count integer NOT NULL CHECK(geometry_node_count>0 AND geometry_node_count<=250000),
 page_digests text[] NOT NULL CHECK(cardinality(page_digests)>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days')
);
ALTER TABLE gowm_history_artifact.registry OWNER TO gowm_history_artifact_owner;
CREATE INDEX historical_artifact_request_idx ON gowm_history_artifact.registry
 (data_scope_key,full_request_hash,snapshot_hash,trajectory_revision_id,expires_at DESC);
CREATE FUNCTION gowm_history_artifact.protect_registry() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 RAISE EXCEPTION 'HISTORICAL_ARTIFACT_IMMUTABLE' USING ERRCODE='55000';
END $$;
CREATE TRIGGER protect_historical_artifact BEFORE UPDATE OR DELETE ON gowm_history_artifact.registry
 FOR EACH ROW EXECUTE FUNCTION gowm_history_artifact.protect_registry();

CREATE FUNCTION gowm_history_artifact.time_ranges(p_ranges tstzmultirange) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'start',to_char(lower(r) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'end',to_char(upper(r) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'bounds',(CASE WHEN lower_inc(r) THEN '[' ELSE '(' END)||(CASE WHEN upper_inc(r) THEN ']' ELSE ')' END)
 ) ORDER BY lower(r),upper(r)),'[]'::jsonb) FROM unnest(p_ranges) r
$$;

CREATE FUNCTION gowm_history_artifact.hash_text(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT 'sha256:'||encode(public.digest(convert_to(p_text,'UTF8'),'sha256'),'hex')
$$;

-- Internal byte renderer. Fixed 256-node pages preserve segment boundaries and
-- retain endpoint control nodes even when a temporal upper bound is exclusive.
CREATE FUNCTION gowm_history_artifact.point_lines(p_revision uuid,p_page integer DEFAULT NULL)
RETURNS TABLE(page_no integer,ordinal bigint,line text)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH segments AS MATERIALIZED (
  SELECT s.segment_no,s.trajectory,public.numInstants(s.trajectory) AS nodes,
   COALESCE(sum(public.numInstants(s.trajectory)) OVER(ORDER BY s.segment_no ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::bigint AS preceding
  FROM gowm_history.historical_trajectory_segment s WHERE s.trajectory_revision_id=p_revision
 ) SELECT ((s.preceding+n-1)/256+1)::integer,s.preceding+n,
  jsonb_build_object('type','point','ordinal',s.preceding+n,'segmentNo',s.segment_no,'pointNo',n,
    'observedAt',to_char(public.timestampN(s.trajectory,n) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'position',public.ST_AsGeoJSON(public.ST_Transform(public.valueN(s.trajectory,n),4326),15)::jsonb)::text||E'\n'
 FROM segments s CROSS JOIN LATERAL generate_series(
  CASE WHEN p_page IS NULL THEN 1 ELSE GREATEST(1,((p_page-1)::bigint*256+1-s.preceding)::integer) END,
  CASE WHEN p_page IS NULL THEN s.nodes ELSE LEAST(s.nodes,(p_page::bigint*256-s.preceding)::integer) END
 ) n
 WHERE p_page IS NULL OR (s.preceding<p_page::bigint*256 AND s.preceding+s.nodes>(p_page-1)::bigint*256)
 ORDER BY s.segment_no,n
$$;

CREATE FUNCTION gowm_history_artifact.open(p_query jsonb,p_snapshot jsonb,p_reference text,p_version integer,p_ttl_seconds integer DEFAULT 86400)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope_key text=gowm_history_v1.current_data_scope_key(); selected record; proof record;
 existing gowm_history_artifact.registry; h jsonb; full_hash text; nodes integer;
 body text; header_line text; hashes text[]; id uuid; now_at timestamptz=clock_timestamp();
BEGIN
 IF scope_key IS NULL OR btrim(scope_key)='' THEN RAISE EXCEPTION 'ARTIFACT_SCOPE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_ttl_seconds<1 OR p_ttl_seconds>604800 OR p_ttl_seconds IS NULL THEN RAISE EXCEPTION 'ARTIFACT_TTL_INVALID' USING ERRCODE='22023'; END IF;
 IF p_snapshot->>'manifestHash' IS DISTINCT FROM gowm_history_artifact.hash_text(gowm_history_v2.canonical_json(p_snapshot-'manifestHash')) THEN
  RAISE EXCEPTION 'ARTIFACT_SNAPSHOT_MISMATCH' USING ERRCODE='23514'; END IF;
 SELECT * INTO selected FROM gowm_history_v1.evaluated_historical_trajectory(p_query,p_snapshot);
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF selected.reference_key IS DISTINCT FROM p_reference OR selected.revision_no IS DISTINCT FROM p_version THEN
  RAISE EXCEPTION 'ARTIFACT_TRAJECTORY_MISMATCH' USING ERRCODE='23514'; END IF;
 SELECT * INTO proof FROM gowm_history_v1.historical_request_evaluation_identity(p_query,p_snapshot);
 IF NOT FOUND THEN RAISE EXCEPTION 'ARTIFACT_EVALUATION_REQUIRED' USING ERRCODE='23514'; END IF;
 full_hash=gowm_history_artifact.hash_text(gowm_history_v2.canonical_json(p_query));
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(scope_key,full_hash,p_snapshot->>'manifestHash',selected.trajectory_revision_id)::text,718090));
 SELECT * INTO existing FROM gowm_history_artifact.registry WHERE data_scope_key=scope_key
  AND full_request_hash=full_hash AND snapshot_hash=p_snapshot->>'manifestHash'
  AND trajectory_revision_id=selected.trajectory_revision_id AND expires_at>now_at ORDER BY created_at DESC LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('artifactId',existing.artifact_id,'digest',existing.document_digest,
  'mediaType','application/x-ndjson','snapshotManifestHash',existing.snapshot_hash,'fullRequestHash',existing.full_request_hash,
  'pageCount',cardinality(existing.page_digests),'byteLength',existing.document_bytes,'geometryNodeCount',existing.geometry_node_count,
  'expiresAt',to_char(existing.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'header',existing.header); END IF;
 SELECT sum(public.numInstants(trajectory))::integer INTO nodes FROM gowm_history.historical_trajectory_segment
  WHERE trajectory_revision_id=selected.trajectory_revision_id;
 IF nodes IS NULL OR nodes<1 OR nodes>250000 THEN RAISE EXCEPTION 'ARTIFACT_NODE_BUDGET_EXCEEDED' USING ERRCODE='54000'; END IF;
 h=jsonb_build_object('type','manifest','schemaVersion','1.0','encoding','PG_JSONB_NDJSON_V1','coordinateEncoding','POSTGIS_GEOJSON_15_V1',
  'trajectoryReferenceKey',jsonb_build_object('namespace','gowm','kind','HISTORICAL_TRAJECTORY','id',p_reference,'version',p_version::text),
  'trajectoryContentHash',selected.content_hash,'inputSetHash',selected.input_set_hash,'worldVersion',selected.world_version,
  'evaluationId',proof.evaluation_id,'analysisId',proof.analysis_id,'fullRequestHash',full_hash,
  'snapshotManifestHash',p_snapshot->>'manifestHash','frozenRequest',p_query,'frozenSnapshot',p_snapshot,
  'geometryNodeCount',nodes,'evidenceSampleCount',selected.sample_count,'pageSize',256,
  'finalizationState',selected.finalization_state,'temporalCoverageRatio',selected.temporal_coverage_ratio,
  'prefixComplete',selected.prefix_complete,'suffixComplete',selected.suffix_complete,
  'requestedPeriods',gowm_history_artifact.time_ranges(selected.requested_time),'definedPeriods',gowm_history_artifact.time_ranges(selected.defined_time),
  'segments',COALESCE((SELECT jsonb_agg(jsonb_build_object('segmentNo',s.segment_no,
    'sourceTrackletVersionId',s.source_tracklet_version_id,'sourceSegmentNo',s.source_segment_no,
    'geometryNodeCount',public.numInstants(s.trajectory),'evidenceSampleCount',s.sample_count,
    'start',to_char(public.startTimestamp(s.trajectory) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'end',to_char(public.endTimestamp(s.trajectory) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'lowerInclusive',public.lowerInc(s.trajectory),'upperInclusive',public.upperInc(s.trajectory),'interpolation',public.interp(s.trajectory)) ORDER BY s.segment_no)
    FROM gowm_history.historical_trajectory_segment s WHERE s.trajectory_revision_id=selected.trajectory_revision_id),'[]'::jsonb),
  'gaps',COALESCE((SELECT jsonb_agg(jsonb_build_object('gapNo',g.gap_no,'kind',g.gap_kind,'range',gowm_history_artifact.time_ranges(tstzmultirange(g.gap_time))->0,'reasonCodes',g.reason_codes) ORDER BY g.gap_no)
    FROM gowm_history.historical_trajectory_gap g WHERE g.trajectory_revision_id=selected.trajectory_revision_id),'[]'::jsonb),
  'excludedPeriods',COALESCE((SELECT jsonb_agg(jsonb_build_object('range',gowm_history_artifact.time_ranges(tstzmultirange(e.excluded_time))->0,'reason',e.exclusion_kind) ORDER BY e.excluded_no)
    FROM gowm_history.historical_trajectory_excluded_period e WHERE e.trajectory_revision_id=selected.trajectory_revision_id),'[]'::jsonb));
 header_line=h::text||E'\n';
 WITH pages AS MATERIALIZED (
  SELECT page_no,string_agg(line,'' ORDER BY ordinal) content FROM gowm_history_artifact.point_lines(selected.trajectory_revision_id) GROUP BY page_no
 ) SELECT string_agg(content,'' ORDER BY page_no),array_agg(gowm_history_artifact.hash_text(content) ORDER BY page_no) INTO body,hashes FROM pages;
 IF octet_length(header_line)+octet_length(body)>67108864 THEN RAISE EXCEPTION 'ARTIFACT_BYTE_BUDGET_EXCEEDED' USING ERRCODE='54000'; END IF;
 INSERT INTO gowm_history_artifact.registry(data_scope_key,evaluation_id,trajectory_revision_id,full_request_hash,snapshot_hash,
  header,document_digest,document_bytes,geometry_node_count,page_digests,created_at,expires_at)
 VALUES(scope_key,proof.evaluation_id,selected.trajectory_revision_id,full_hash,p_snapshot->>'manifestHash',h,
  gowm_history_artifact.hash_text(header_line||body),octet_length(header_line||body),nodes,
  ARRAY[gowm_history_artifact.hash_text(header_line)]||hashes,now_at,now_at+make_interval(secs=>p_ttl_seconds)) RETURNING artifact_id INTO id;
 RETURN jsonb_build_object('artifactId',id,'digest',gowm_history_artifact.hash_text(header_line||body),'mediaType','application/x-ndjson',
  'snapshotManifestHash',p_snapshot->>'manifestHash','fullRequestHash',full_hash,'pageCount',cardinality(hashes)+1,
  'byteLength',octet_length(header_line||body),'geometryNodeCount',nodes,
  'expiresAt',to_char((now_at+make_interval(secs=>p_ttl_seconds)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'header',h);
END $$;

CREATE FUNCTION gowm_history_artifact.read_page(p_reference jsonb,p_page integer,p_snapshot jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a gowm_history_artifact.registry; content text; scope_key text=gowm_history_v1.current_data_scope_key(); pin jsonb;
BEGIN
 IF scope_key IS NULL OR btrim(scope_key)='' THEN RAISE EXCEPTION 'ARTIFACT_SCOPE_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM gowm_history_artifact.registry WHERE artifact_id=(p_reference->>'artifactId')::uuid AND data_scope_key=scope_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'ARTIFACT_UNAVAILABLE' USING ERRCODE='P0002'; END IF;
 IF p_reference->>'digest' IS DISTINCT FROM a.document_digest OR p_reference->>'snapshotManifestHash' IS DISTINCT FROM a.snapshot_hash
  OR p_reference->>'fullRequestHash' IS DISTINCT FROM a.full_request_hash OR p_reference->>'mediaType' IS DISTINCT FROM 'application/x-ndjson'
 THEN RAISE EXCEPTION 'ARTIFACT_IDENTITY_MISMATCH' USING ERRCODE='23514'; END IF;
 IF p_snapshot->>'capturedAt' IS NULL OR jsonb_typeof(p_snapshot->'resources') IS DISTINCT FROM 'array'
  OR p_snapshot->>'manifestHash' IS DISTINCT FROM gowm_history_artifact.hash_text(gowm_history_v2.canonical_json(p_snapshot-'manifestHash'))
  OR (p_snapshot->>'capturedAt')::timestamptz<(a.header->'frozenSnapshot'->>'capturedAt')::timestamptz
 THEN RAISE EXCEPTION 'ARTIFACT_READ_SNAPSHOT_MISMATCH' USING ERRCODE='23514'; END IF;
 FOR pin IN SELECT value FROM jsonb_array_elements(p_snapshot->'resources') LOOP
  IF pin->>'resourceKind'='HISTORICAL_TRAJECTORY'
   AND pin->>'resourceId' IN (a.header->'trajectoryReferenceKey'->>'id','gowm:'||(a.header->'trajectoryReferenceKey'->>'id'))
   AND (pin->>'version' IS DISTINCT FROM a.header->'trajectoryReferenceKey'->>'version'
    OR (pin ? 'contentHash' AND pin->>'contentHash' IS DISTINCT FROM a.header->>'trajectoryContentHash')) THEN
   RAISE EXCEPTION 'ARTIFACT_READ_RESOURCE_MISMATCH' USING ERRCODE='23514'; END IF;
  IF pin->>'resourceKind'='HISTORY_INPUT_SET'
   AND pin->>'resourceId' IN ('input-set-'||substr(a.header->>'inputSetHash',8),'gowm:input-set-'||substr(a.header->>'inputSetHash',8))
   AND (pin->>'version' IS DISTINCT FROM a.header->'trajectoryReferenceKey'->>'version'
    OR (pin ? 'contentHash' AND pin->>'contentHash' IS DISTINCT FROM a.header->>'inputSetHash')) THEN
   RAISE EXCEPTION 'ARTIFACT_READ_RESOURCE_MISMATCH' USING ERRCODE='23514'; END IF;
  IF pin->>'resourceKind'=a.header->'frozenRequest'->'subjectReferenceKey'->>'kind'
   AND pin->>'resourceId' IN (a.header->'frozenRequest'->'subjectReferenceKey'->>'id',
     (a.header->'frozenRequest'->'subjectReferenceKey'->>'namespace')||':'||(a.header->'frozenRequest'->'subjectReferenceKey'->>'id'))
   AND pin->>'version' IS DISTINCT FROM a.header->'frozenRequest'->'subjectReferenceKey'->>'version' THEN
   RAISE EXCEPTION 'ARTIFACT_READ_RESOURCE_MISMATCH' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM gowm_history.historical_trajectory_input i WHERE i.trajectory_revision_id=a.trajectory_revision_id
   AND i.resource_kind=pin->>'resourceKind'
   AND pin->>'resourceId' IN (i.resource_id,i.resource_namespace||':'||i.resource_id)
   AND (i.resource_version IS DISTINCT FROM pin->>'version' OR (pin ? 'contentHash' AND i.resource_content_hash IS DISTINCT FROM pin->>'contentHash')))
  THEN RAISE EXCEPTION 'ARTIFACT_READ_RESOURCE_MISMATCH' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF a.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'ARTIFACT_EXPIRED' USING ERRCODE='P0002'; END IF;
 IF p_page IS NULL OR p_page<0 OR p_page>=cardinality(a.page_digests) THEN RAISE EXCEPTION 'ARTIFACT_PAGE_INVALID' USING ERRCODE='22023'; END IF;
 IF p_page=0 THEN content=a.header::text||E'\n';
 ELSE SELECT string_agg(line,'' ORDER BY ordinal) INTO content FROM gowm_history_artifact.point_lines(a.trajectory_revision_id,p_page); END IF;
 IF gowm_history_artifact.hash_text(content) IS DISTINCT FROM a.page_digests[p_page+1] THEN RAISE EXCEPTION 'ARTIFACT_BYTES_CHANGED' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('content',content,'pageNo',p_page,'pageDigest',a.page_digests[p_page+1],
  'nextPage',CASE WHEN p_page+1<cardinality(a.page_digests) THEN p_page+1 END,'header',a.header);
END $$;

ALTER FUNCTION gowm_history_artifact.hash_text(text) OWNER TO gowm_history_artifact_owner;
ALTER FUNCTION gowm_history_artifact.protect_registry() OWNER TO gowm_history_artifact_owner;
ALTER FUNCTION gowm_history_artifact.time_ranges(tstzmultirange) OWNER TO gowm_history_artifact_owner;
ALTER FUNCTION gowm_history_artifact.point_lines(uuid,integer) OWNER TO gowm_history_artifact_owner;
ALTER FUNCTION gowm_history_artifact.open(jsonb,jsonb,text,integer,integer) OWNER TO gowm_history_artifact_owner;
ALTER FUNCTION gowm_history_artifact.read_page(jsonb,integer,jsonb) OWNER TO gowm_history_artifact_owner;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_history_artifact FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_history_artifact FROM PUBLIC;
GRANT USAGE ON SCHEMA gowm_history_artifact TO gowm_history_reader;
GRANT EXECUTE ON FUNCTION gowm_history_artifact.open(jsonb,jsonb,text,integer,integer),gowm_history_artifact.read_page(jsonb,integer,jsonb) TO gowm_history_reader;
COMMIT;
