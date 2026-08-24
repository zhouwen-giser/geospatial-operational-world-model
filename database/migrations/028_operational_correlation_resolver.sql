BEGIN;

CREATE TABLE correlation_resolution_request (
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  external_authority text NOT NULL CHECK (length(external_authority) BETWEEN 1 AND 512),
  external_kind text NOT NULL CHECK (external_kind IN (
    'PLANNING_TASK','PLANNING_STEP','EXECUTION_INTENT','OPERATION_CORRELATION','PROVIDER_ACTION','DEVICE_COMMAND'
  )),
  external_value text NOT NULL CHECK (length(external_value) BETWEEN 1 AND 512),
  relation_hint text CHECK (relation_hint IS NULL OR relation_hint IN ('REPORTS_EXECUTION_OF','REALIZES','RELATED_TO')),
  hint_match_basis text NOT NULL CHECK (hint_match_basis IN (
    'PROPAGATED_CORRELATION_ID','PROVIDER_DECLARED','MANUAL_CONFIRMATION',
    'RESOURCE_AND_TIME_MATCH','SPATIOTEMPORAL_INFERENCE'
  )),
  hint_confidence double precision CHECK (hint_confidence IS NULL OR hint_confidence BETWEEN 0 AND 1),
  actor_reference_keys jsonb NOT NULL CHECK (
    jsonb_typeof(actor_reference_keys)='array' AND jsonb_array_length(actor_reference_keys)<=100
  ),
  time_from timestamptz,
  time_to timestamptz,
  evidence_world_version bigint NOT NULL CHECK (evidence_world_version>=0),
  method_version text NOT NULL CHECK (length(method_version) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (time_from IS NULL OR time_to IS NULL OR time_to>=time_from)
);

CREATE TABLE correlation_finding (
  finding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES correlation_resolution_request(request_id),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  external_authority text NOT NULL,
  external_kind text NOT NULL,
  external_value text NOT NULL,
  operational_task_reference_key text REFERENCES world_reference_identity(reference_key),
  operational_event_ids jsonb NOT NULL CHECK (
    jsonb_typeof(operational_event_ids)='array' AND jsonb_array_length(operational_event_ids)<=1000
  ),
  relation text NOT NULL CHECK (relation IN (
    'REPORTS_EXECUTION_OF','REALIZES','PARTIALLY_REALIZES','POSSIBLY_CORRESPONDS_TO',
    'NO_MATCH_FOUND','CONFLICTING_MATCHES'
  )),
  match_basis text NOT NULL CHECK (match_basis IN (
    'PROPAGATED_CORRELATION_ID','PROVIDER_DECLARED','MANUAL_CONFIRMATION',
    'RESOURCE_AND_TIME_MATCH','SPATIOTEMPORAL_INFERENCE'
  )),
  correlation_confidence double precision CHECK (correlation_confidence IS NULL OR correlation_confidence BETWEEN 0 AND 1),
  evidence_ids jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_ids)='array' AND jsonb_array_length(evidence_ids)<=1000
  ),
  candidate_count integer NOT NULL CHECK (candidate_count>=0),
  world_version bigint NOT NULL CHECK (world_version>=0),
  method_version text NOT NULL CHECK (length(method_version) BETWEEN 1 AND 128),
  resolution_hash text NOT NULL CHECK (resolution_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX correlation_finding_scope_external_idx
  ON correlation_finding(data_scope_key,external_authority,external_kind,external_value,created_at,finding_id);
CREATE INDEX correlation_finding_scope_task_idx
  ON correlation_finding(data_scope_key,operational_task_reference_key,created_at,finding_id)
  WHERE operational_task_reference_key IS NOT NULL;

CREATE TABLE correlation_finding_candidate (
  finding_id uuid NOT NULL REFERENCES correlation_finding(finding_id),
  candidate_rank integer NOT NULL CHECK (candidate_rank>0),
  operational_task_reference_key text NOT NULL REFERENCES world_reference_identity(reference_key),
  relation text NOT NULL CHECK (relation IN (
    'REPORTS_EXECUTION_OF','REALIZES','PARTIALLY_REALIZES','POSSIBLY_CORRESPONDS_TO'
  )),
  match_basis text NOT NULL,
  correlation_confidence double precision CHECK (correlation_confidence IS NULL OR correlation_confidence BETWEEN 0 AND 1),
  operational_event_ids jsonb NOT NULL CHECK (jsonb_typeof(operational_event_ids)='array'),
  evidence_ids jsonb NOT NULL CHECK (jsonb_typeof(evidence_ids)='array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (finding_id,candidate_rank),
  UNIQUE (finding_id,operational_task_reference_key)
);

CREATE TABLE correlation_resolution_replay (
  replay_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES correlation_finding(finding_id),
  expected_hash text NOT NULL CHECK (expected_hash ~ '^sha256:[0-9a-f]{64}$'),
  replay_hash text NOT NULL CHECK (replay_hash ~ '^sha256:[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('MATCH','DIFFERENCE')),
  replayed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION correlation_basis_priority(p_basis text)
RETURNS integer LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $fn$
  SELECT CASE p_basis
    WHEN 'PROPAGATED_CORRELATION_ID' THEN 500
    WHEN 'PROVIDER_DECLARED' THEN 400
    WHEN 'MANUAL_CONFIRMATION' THEN 300
    WHEN 'RESOURCE_AND_TIME_MATCH' THEN 200
    WHEN 'SPATIOTEMPORAL_INFERENCE' THEN 100
    ELSE 0 END
$fn$;

CREATE FUNCTION operational_correlation_candidates(
  p_data_scope_key text,
  p_external_authority text,
  p_external_kind text,
  p_external_value text,
  p_hint_match_basis text,
  p_hint_confidence double precision,
  p_actor_reference_keys jsonb,
  p_time_from timestamptz,
  p_time_to timestamptz,
  p_evidence_world_version bigint
)
RETURNS TABLE(
  operational_task_reference_key text,
  relation text,
  match_basis text,
  correlation_confidence double precision,
  operational_event_ids jsonb,
  evidence_ids jsonb,
  derived_candidate boolean
)
LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
  WITH exact_base AS (
    SELECT task.reference_key,event.operational_task_id,event.event_id,claim.evidence_ids,
           claim.relation_hint,claim.match_basis,claim.confidence,
           correlation_basis_priority(claim.match_basis) AS basis_priority
    FROM external_correlation_claim claim
    JOIN operational_task_event event
      ON claim.source_kind='OPERATIONAL_EVENT'
     AND event.data_scope_key=claim.data_scope_key AND event.event_id=claim.source_id
    JOIN operational_task task
      ON task.data_scope_key=event.data_scope_key AND task.operational_task_id=event.operational_task_id
    WHERE claim.data_scope_key=p_data_scope_key
      AND claim.external_authority=p_external_authority
      AND claim.external_kind=p_external_kind
      AND claim.external_value=p_external_value
      AND event.world_version<=p_evidence_world_version
  ),
  highest_exact AS (
    SELECT max(basis_priority) AS priority FROM exact_base
  ),
  exact_tasks AS (
    SELECT base.reference_key,
           CASE WHEN bool_or(base.relation_hint='REPORTS_EXECUTION_OF') THEN 'REPORTS_EXECUTION_OF'
                ELSE 'REALIZES' END AS relation,
           min(base.match_basis) AS match_basis,
           max(COALESCE(base.confidence,0)) AS correlation_confidence,
           (SELECT COALESCE(jsonb_agg(event_id ORDER BY event_id),'[]'::jsonb)
              FROM (SELECT DISTINCT item.event_id FROM exact_base item
                    WHERE item.reference_key=base.reference_key AND item.basis_priority=highest.priority
                    ORDER BY item.event_id LIMIT 1000) events) AS operational_event_ids,
           (SELECT COALESCE(jsonb_agg(evidence_id ORDER BY evidence_id),'[]'::jsonb)
              FROM (SELECT DISTINCT evidence.value AS evidence_id FROM exact_base item
                    CROSS JOIN LATERAL jsonb_array_elements_text(item.evidence_ids) evidence(value)
                    WHERE item.reference_key=base.reference_key AND item.basis_priority=highest.priority
                    UNION SELECT DISTINCT item.event_id FROM exact_base item
                    WHERE item.reference_key=base.reference_key AND item.basis_priority=highest.priority
                    ORDER BY evidence_id LIMIT 1000) evidence) AS evidence_ids
    FROM exact_base base CROSS JOIN highest_exact highest
    WHERE base.basis_priority=highest.priority
    GROUP BY base.reference_key,highest.priority
  ),
  derived_events AS (
    SELECT task.reference_key,event.event_id
    FROM operational_task_event event
    JOIN operational_task task
      ON task.data_scope_key=event.data_scope_key AND task.operational_task_id=event.operational_task_id
    WHERE event.data_scope_key=p_data_scope_key AND event.world_version<=p_evidence_world_version
      AND p_hint_match_basis IN ('RESOURCE_AND_TIME_MATCH','SPATIOTEMPORAL_INFERENCE')
      AND NOT EXISTS (SELECT 1 FROM exact_base)
      AND (p_time_from IS NULL OR event.event_time>=p_time_from)
      AND (p_time_to IS NULL OR event.event_time<=p_time_to)
      AND (p_actor_reference_keys='[]'::jsonb OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_actor_reference_keys) requested
        JOIN jsonb_array_elements(event.actor_reference_keys) observed ON requested=observed
      ))
  ),
  derived_tasks AS (
    SELECT reference_key,'POSSIBLY_CORRESPONDS_TO'::text AS relation,
           p_hint_match_basis AS match_basis,
           COALESCE(p_hint_confidence,CASE WHEN p_hint_match_basis='RESOURCE_AND_TIME_MATCH' THEN 0.5 ELSE 0.25 END) AS correlation_confidence,
           jsonb_agg(DISTINCT event_id ORDER BY event_id) AS operational_event_ids,
           jsonb_agg(DISTINCT event_id ORDER BY event_id) AS evidence_ids
    FROM derived_events GROUP BY reference_key
  )
  SELECT exact.reference_key,exact.relation,exact.match_basis,exact.correlation_confidence,
         exact.operational_event_ids,exact.evidence_ids,false FROM exact_tasks exact
  UNION ALL
  SELECT derived.reference_key,derived.relation,derived.match_basis,derived.correlation_confidence,
         derived.operational_event_ids,derived.evidence_ids,true FROM derived_tasks derived
$fn$;

CREATE FUNCTION compute_operational_correlation_resolution(
  p_data_scope_key text,
  p_external_authority text,
  p_external_kind text,
  p_external_value text,
  p_hint_match_basis text,
  p_hint_confidence double precision,
  p_actor_reference_keys jsonb,
  p_time_from timestamptz,
  p_time_to timestamptz,
  p_evidence_world_version bigint,
  p_method_version text
)
RETURNS jsonb LANGUAGE sql STABLE PARALLEL SAFE
AS $fn$
  WITH candidates AS (
    SELECT * FROM operational_correlation_candidates(
      p_data_scope_key,p_external_authority,p_external_kind,p_external_value,
      p_hint_match_basis,p_hint_confidence,p_actor_reference_keys,p_time_from,p_time_to,
      p_evidence_world_version
    )
  ),
  summary AS (
    SELECT count(*)::integer AS candidate_count,bool_or(derived_candidate) AS has_derived,
           min(match_basis) AS selected_basis,max(correlation_confidence) AS selected_confidence
    FROM candidates
  ),
  event_ids AS (
    SELECT COALESCE(jsonb_agg(event_id ORDER BY event_id),'[]'::jsonb) AS value FROM (
      SELECT DISTINCT event.value AS event_id FROM candidates
      CROSS JOIN LATERAL jsonb_array_elements_text(operational_event_ids) event(value)
      ORDER BY event_id LIMIT 1000
    ) events
  ),
  evidence AS (
    SELECT COALESCE(jsonb_agg(evidence_id ORDER BY evidence_id),'[]'::jsonb) AS value FROM (
      SELECT DISTINCT item.value AS evidence_id FROM candidates
      CROSS JOIN LATERAL jsonb_array_elements_text(evidence_ids) item(value)
      ORDER BY evidence_id LIMIT 1000
    ) items
  ),
  single_candidate AS (
    SELECT * FROM candidates LIMIT 1
  )
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'externalAuthority',p_external_authority,'externalKind',p_external_kind,'externalValue',p_external_value,
    'operationalTaskReferenceKey',CASE WHEN summary.candidate_count=1
      THEN jsonb_build_object('namespace','gowm','kind','OPERATIONAL_TASK','id',single_candidate.operational_task_reference_key,'version','1') END,
    'operationalEventIds',event_ids.value,
    'relation',CASE WHEN summary.candidate_count=0 THEN 'NO_MATCH_FOUND'
                    WHEN summary.has_derived THEN 'POSSIBLY_CORRESPONDS_TO'
                    WHEN summary.candidate_count>1 THEN 'CONFLICTING_MATCHES'
                    ELSE single_candidate.relation END,
    'matchBasis',COALESCE(summary.selected_basis,p_hint_match_basis),
    'correlationConfidence',CASE WHEN summary.candidate_count=0 THEN COALESCE(p_hint_confidence,0)
                                 ELSE summary.selected_confidence END,
    'evidenceIds',evidence.value,'candidateCount',summary.candidate_count,
    'worldVersion',p_evidence_world_version,'methodVersion',p_method_version
  ))
  FROM summary CROSS JOIN event_ids CROSS JOIN evidence LEFT JOIN single_candidate ON true
$fn$;

CREATE FUNCTION resolve_operational_correlation(
  p_data_scope_key text,
  p_external_authority text,
  p_external_kind text,
  p_external_value text,
  p_relation_hint text,
  p_hint_match_basis text,
  p_hint_confidence double precision,
  p_actor_reference_keys jsonb DEFAULT '[]'::jsonb,
  p_time_from timestamptz DEFAULT NULL,
  p_time_to timestamptz DEFAULT NULL,
  p_method_version text DEFAULT 'correlation-resolver-v1'
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
DECLARE
  evidence_version bigint;
  request_digest text;
  stored_request_id uuid;
  stored_finding_id uuid;
  resolution jsonb;
  resolution_digest text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.data_scope WHERE scope_key=p_data_scope_key) OR
     p_external_kind NOT IN ('PLANNING_TASK','PLANNING_STEP','EXECUTION_INTENT','OPERATION_CORRELATION','PROVIDER_ACTION','DEVICE_COMMAND') OR
     p_hint_match_basis NOT IN ('PROPAGATED_CORRELATION_ID','PROVIDER_DECLARED','MANUAL_CONFIRMATION','RESOURCE_AND_TIME_MATCH','SPATIOTEMPORAL_INFERENCE') OR
     p_actor_reference_keys IS NULL OR jsonb_typeof(p_actor_reference_keys)<>'array' OR
     (p_time_from IS NOT NULL AND p_time_to IS NOT NULL AND p_time_to<p_time_from) THEN
    RAISE EXCEPTION 'correlation resolution request is invalid' USING ERRCODE='22023';
  END IF;
  SELECT last_value INTO evidence_version FROM public.world_version_seq;
  request_digest := public.grounding_sha256(jsonb_build_object(
    'dataScopeKey',p_data_scope_key,'externalAuthority',p_external_authority,'externalKind',p_external_kind,
    'externalValue',p_external_value,'relationHint',p_relation_hint,'hintMatchBasis',p_hint_match_basis,
    'hintConfidence',p_hint_confidence,'actorReferenceKeys',p_actor_reference_keys,
    'timeFrom',p_time_from,'timeTo',p_time_to,'evidenceWorldVersion',evidence_version,
    'methodVersion',p_method_version
  )::text);
  INSERT INTO public.correlation_resolution_request(
    data_scope_key,external_authority,external_kind,external_value,relation_hint,hint_match_basis,
    hint_confidence,actor_reference_keys,time_from,time_to,evidence_world_version,method_version,request_hash
  ) VALUES (
    p_data_scope_key,p_external_authority,p_external_kind,p_external_value,p_relation_hint,p_hint_match_basis,
    p_hint_confidence,p_actor_reference_keys,p_time_from,p_time_to,evidence_version,p_method_version,request_digest
  ) RETURNING request_id INTO stored_request_id;

  resolution := public.compute_operational_correlation_resolution(
    p_data_scope_key,p_external_authority,p_external_kind,p_external_value,p_hint_match_basis,
    p_hint_confidence,p_actor_reference_keys,p_time_from,p_time_to,evidence_version,p_method_version
  );
  resolution_digest := public.grounding_sha256(resolution::text);
  INSERT INTO public.correlation_finding(
    request_id,data_scope_key,external_authority,external_kind,external_value,
    operational_task_reference_key,operational_event_ids,relation,match_basis,
    correlation_confidence,evidence_ids,candidate_count,world_version,method_version,resolution_hash
  ) VALUES (
    stored_request_id,p_data_scope_key,p_external_authority,p_external_kind,p_external_value,
    resolution#>>'{operationalTaskReferenceKey,id}',resolution->'operationalEventIds',
    resolution->>'relation',resolution->>'matchBasis',(resolution->>'correlationConfidence')::double precision,
    resolution->'evidenceIds',(resolution->>'candidateCount')::integer,evidence_version,p_method_version,resolution_digest
  ) RETURNING finding_id INTO stored_finding_id;

  INSERT INTO public.correlation_finding_candidate(
    finding_id,candidate_rank,operational_task_reference_key,relation,match_basis,
    correlation_confidence,operational_event_ids,evidence_ids
  )
  SELECT stored_finding_id,row_number() OVER (
           ORDER BY correlation_basis_priority(candidate.match_basis) DESC,
                    candidate.correlation_confidence DESC,candidate.operational_task_reference_key
         ),
         candidate.operational_task_reference_key,candidate.relation,candidate.match_basis,
         candidate.correlation_confidence,candidate.operational_event_ids,candidate.evidence_ids
  FROM public.operational_correlation_candidates(
    p_data_scope_key,p_external_authority,p_external_kind,p_external_value,p_hint_match_basis,
    p_hint_confidence,p_actor_reference_keys,p_time_from,p_time_to,evidence_version
  ) candidate;
  RETURN stored_finding_id;
END
$fn$;

CREATE FUNCTION replay_operational_correlation(p_finding_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
DECLARE
  stored record;
  computed jsonb;
  replay_digest text;
  stored_replay_id uuid;
BEGIN
  SELECT finding.resolution_hash,request.* INTO STRICT stored
  FROM public.correlation_finding finding
  JOIN public.correlation_resolution_request request USING(request_id)
  WHERE finding.finding_id=p_finding_id;
  computed := public.compute_operational_correlation_resolution(
    stored.data_scope_key,stored.external_authority,stored.external_kind,stored.external_value,
    stored.hint_match_basis,stored.hint_confidence,stored.actor_reference_keys,
    stored.time_from,stored.time_to,stored.evidence_world_version,stored.method_version
  );
  replay_digest := public.grounding_sha256(computed::text);
  INSERT INTO public.correlation_resolution_replay(finding_id,expected_hash,replay_hash,outcome)
  VALUES (p_finding_id,stored.resolution_hash,replay_digest,
          CASE WHEN stored.resolution_hash=replay_digest THEN 'MATCH' ELSE 'DIFFERENCE' END)
  RETURNING replay_id INTO stored_replay_id;
  RETURN stored_replay_id;
END
$fn$;

CREATE FUNCTION reject_correlation_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only',TG_TABLE_NAME USING ERRCODE='55000';
END
$fn$;

CREATE TRIGGER correlation_resolution_request_immutable
  BEFORE UPDATE OR DELETE ON correlation_resolution_request
  FOR EACH ROW EXECUTE FUNCTION reject_correlation_evidence_mutation();
CREATE TRIGGER correlation_finding_immutable
  BEFORE UPDATE OR DELETE ON correlation_finding
  FOR EACH ROW EXECUTE FUNCTION reject_correlation_evidence_mutation();
CREATE TRIGGER correlation_finding_candidate_immutable
  BEFORE UPDATE OR DELETE ON correlation_finding_candidate
  FOR EACH ROW EXECUTE FUNCTION reject_correlation_evidence_mutation();
CREATE TRIGGER correlation_resolution_replay_immutable
  BEFORE UPDATE OR DELETE ON correlation_resolution_replay
  FOR EACH ROW EXECUTE FUNCTION reject_correlation_evidence_mutation();

REVOKE ALL ON FUNCTION correlation_basis_priority(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION operational_correlation_candidates(text,text,text,text,text,double precision,jsonb,timestamptz,timestamptz,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION compute_operational_correlation_resolution(text,text,text,text,text,double precision,jsonb,timestamptz,timestamptz,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_operational_correlation(text,text,text,text,text,text,double precision,jsonb,timestamptz,timestamptz,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION replay_operational_correlation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_correlation_evidence_mutation() FROM PUBLIC;

COMMIT;
