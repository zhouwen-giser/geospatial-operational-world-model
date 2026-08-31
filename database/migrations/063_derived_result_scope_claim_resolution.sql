BEGIN;

-- Gateway data-scope claims are external authorization identifiers. Result
-- registry rows are bound to Foundation-local data_scope keys, so resolve the
-- boundary through the authoritative reference identity catalog.
CREATE INDEX world_reference_external_data_scope_claim_idx
  ON public.world_reference_external_identifier(
    (identifier_value COLLATE "C"), reference_key
  )
  WHERE authority = 'GOWM_GATEWAY'
    AND identifier_kind = 'DATA_SCOPE_CLAIM'
    AND confidence = 1;

CREATE FUNCTION gowm_capability.resolve_data_scope_claim(p_data_scope_claim text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_capability
AS $fn$
DECLARE
  resolved_scope_key text;
  candidate_count integer;
BEGIN
  WITH candidates AS (
    -- Preserve deployments whose Gateway claim is already the exact internal
    -- key. COLLATE "C" intentionally makes this byte- and case-sensitive.
    SELECT identity.internal_id AS scope_key
    FROM public.world_reference_identity identity
    JOIN public.data_scope scope ON scope.scope_key = identity.internal_id
    WHERE identity.entity_kind = 'DATA_SCOPE'
      AND identity.data_scope_key = identity.internal_id
      AND identity.internal_id COLLATE "C" = p_data_scope_claim COLLATE "C"

    UNION

    -- Alias claims are accepted only from the fixed Gateway authority/kind,
    -- at full confidence, inside their validity window, and only when they
    -- identify the DATA_SCOPE identity itself. normalized_value is not an
    -- authorization key.
    SELECT identity.internal_id AS scope_key
    FROM public.world_reference_external_identifier external
    JOIN public.world_reference_identity identity
      ON identity.reference_key = external.reference_key
     AND identity.data_scope_key = external.data_scope_key
    JOIN public.data_scope scope ON scope.scope_key = identity.internal_id
    WHERE identity.entity_kind = 'DATA_SCOPE'
      AND identity.data_scope_key = identity.internal_id
      AND external.authority = 'GOWM_GATEWAY'
      AND external.identifier_kind = 'DATA_SCOPE_CLAIM'
      AND external.confidence = 1
      AND external.identifier_value COLLATE "C" = p_data_scope_claim COLLATE "C"
      AND external.valid_from <= statement_timestamp()
      AND statement_timestamp() < external.valid_to
  )
  SELECT min(scope_key), count(*)::integer
  INTO resolved_scope_key, candidate_count
  FROM candidates;

  IF candidate_count IS DISTINCT FROM 1 THEN
    -- Do not reveal the external claim or candidate scopes.
    RAISE EXCEPTION 'world query data scope claim is unavailable'
      USING ERRCODE = '42501',
            CONSTRAINT = 'world_query_result_scope_claim_resolution';
  END IF;

  RETURN resolved_scope_key;
END
$fn$;

REVOKE ALL ON FUNCTION gowm_capability.resolve_data_scope_claim(text) FROM PUBLIC;

ALTER TABLE gowm_capability.world_query_job
  ADD COLUMN resolved_data_scope_key text REFERENCES public.data_scope(scope_key);

COMMENT ON COLUMN gowm_capability.world_query_job.resolved_data_scope_key IS
  'Foundation-local data_scope key resolved exactly once for a result-bearing query; never an external authorization claim.';

-- Bind every historical job whose result registry lineage already exists, not
-- just jobs whose result JSON is terminal. A derived reference or reference
-- set can legitimately point at a non-terminal source job. Every such job must
-- resolve uniquely and all already-persisted registry scopes must agree with
-- that binding, otherwise the whole migration rolls back with 42501.
DO $backfill$
DECLARE
  target_job record;
  authoritative_scope_key text;
  existing_scope_key text;
  existing_scope_count integer;
BEGIN
  FOR target_job IN
    SELECT job.query_id, job.job_id, job.data_scope_claim, job.principal_context
    FROM gowm_capability.world_query_job job
    WHERE (
      job.result IS NOT NULL
      AND job.result->>'status' IN ('COMPLETED', 'PARTIAL')
    ) OR EXISTS (
      SELECT 1 FROM public.world_query_result_reference reference
      WHERE reference.query_id = job.query_id
    ) OR EXISTS (
      SELECT 1 FROM public.derived_reference reference
      WHERE reference.source_query_id = job.query_id
    ) OR EXISTS (
      SELECT 1 FROM public.reference_set reference
      WHERE reference.source_query_id = job.query_id
    )
  LOOP
    IF target_job.principal_context->>'dataScopeClaim' IS DISTINCT FROM target_job.data_scope_claim
       OR NOT EXISTS (
         SELECT 1
         FROM gowm_capability.gateway_job gateway
         WHERE gateway.job_id = target_job.job_id
           AND gateway.data_scope_key IS NOT DISTINCT FROM target_job.data_scope_claim
       ) THEN
      RAISE EXCEPTION 'historical world query data scope copies do not agree'
        USING ERRCODE = '42501',
              CONSTRAINT = 'world_query_result_scope_claim_resolution';
    END IF;

    authoritative_scope_key :=
      gowm_capability.resolve_data_scope_claim(target_job.data_scope_claim);

    SELECT min(scope_key), count(DISTINCT scope_key)::integer
    INTO existing_scope_key, existing_scope_count
    FROM (
      SELECT reference.data_scope_key AS scope_key
      FROM public.world_query_result_reference reference
      WHERE reference.query_id = target_job.query_id
      UNION ALL
      SELECT reference.data_scope_key
      FROM public.derived_reference reference
      WHERE reference.source_query_id = target_job.query_id
      UNION ALL
      SELECT reference.data_scope_key
      FROM public.reference_set reference
      WHERE reference.source_query_id = target_job.query_id
    ) existing_scope;

    IF existing_scope_count > 1 OR
       (existing_scope_count = 1 AND
        existing_scope_key IS DISTINCT FROM authoritative_scope_key) THEN
      RAISE EXCEPTION 'historical world query result scope conflicts with authority'
        USING ERRCODE = '42501',
              CONSTRAINT = 'world_query_result_scope_claim_resolution';
    END IF;

    UPDATE gowm_capability.world_query_job
    SET resolved_data_scope_key = authoritative_scope_key
    WHERE query_id = target_job.query_id;
  END LOOP;
END
$backfill$;

CREATE FUNCTION gowm_capability.bind_terminal_world_query_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_capability
AS $fn$
DECLARE
  authoritative_scope_key text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.result IS NOT NULL
     AND OLD.result->>'status' IN ('COMPLETED', 'PARTIAL')
     AND NEW.result IS DISTINCT FROM OLD.result THEN
    RAISE EXCEPTION 'terminal world query result is immutable'
      USING ERRCODE = '42501',
            CONSTRAINT = 'world_query_result_scope_claim_resolution';
  END IF;

  IF NEW.result IS NULL OR NEW.result->>'status' NOT IN ('COMPLETED', 'PARTIAL') THEN
    IF TG_OP = 'INSERT' AND NEW.resolved_data_scope_key IS NOT NULL THEN
      RAISE EXCEPTION 'non-terminal world query cannot carry a resolved data scope'
        USING ERRCODE = '42501',
              CONSTRAINT = 'world_query_result_scope_claim_resolution';
    ELSIF TG_OP = 'UPDATE' AND (
      NEW.resolved_data_scope_key IS DISTINCT FROM OLD.resolved_data_scope_key OR
      (OLD.resolved_data_scope_key IS NOT NULL AND
       NEW.data_scope_claim IS DISTINCT FROM OLD.data_scope_claim)
    ) THEN
      RAISE EXCEPTION 'non-terminal world query data scope binding is immutable'
        USING ERRCODE = '42501',
              CONSTRAINT = 'world_query_result_scope_claim_resolution';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.principal_context->>'dataScopeClaim' IS DISTINCT FROM NEW.data_scope_claim
     OR NOT EXISTS (
       SELECT 1
       FROM gowm_capability.gateway_job gateway
       WHERE gateway.job_id = NEW.job_id
         AND gateway.data_scope_key IS NOT DISTINCT FROM NEW.data_scope_claim
     ) THEN
    RAISE EXCEPTION 'world query data scope copies do not agree'
      USING ERRCODE = '42501',
            CONSTRAINT = 'world_query_result_scope_claim_resolution';
  END IF;

  -- Serialize terminal binding with all result-lineage inserts. The lineage
  -- trigger below takes the same source-query lock before accepting an insert.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.query_id,0));

  -- Once a job has an authoritative internal binding, neither the external
  -- claim nor the binding may be rewritten. Repeated terminal persistence is
  -- idempotent even if the alias validity window later closes.
  IF TG_OP = 'UPDATE' AND OLD.resolved_data_scope_key IS NOT NULL THEN
    IF NEW.data_scope_claim IS DISTINCT FROM OLD.data_scope_claim OR
       (NEW.resolved_data_scope_key IS NOT NULL AND
        NEW.resolved_data_scope_key IS DISTINCT FROM OLD.resolved_data_scope_key) THEN
      RAISE EXCEPTION 'world query data scope binding is immutable'
        USING ERRCODE = '42501',
              CONSTRAINT = 'world_query_result_scope_claim_resolution';
    END IF;
    authoritative_scope_key := OLD.resolved_data_scope_key;
  ELSE
    authoritative_scope_key := gowm_capability.resolve_data_scope_claim(NEW.data_scope_claim);
    IF NEW.resolved_data_scope_key IS NOT NULL
       AND NEW.resolved_data_scope_key IS DISTINCT FROM authoritative_scope_key THEN
      RAISE EXCEPTION 'world query data scope binding conflicts with authority'
        USING ERRCODE = '42501',
              CONSTRAINT = 'world_query_result_scope_claim_resolution';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT reference.data_scope_key
      FROM public.world_query_result_reference reference
      WHERE reference.query_id = NEW.query_id
      UNION ALL
      SELECT reference.data_scope_key
      FROM public.derived_reference reference
      WHERE reference.source_query_id = NEW.query_id
      UNION ALL
      SELECT reference.data_scope_key
      FROM public.reference_set reference
      WHERE reference.source_query_id = NEW.query_id
    ) lineage
    WHERE lineage.data_scope_key IS DISTINCT FROM authoritative_scope_key
  ) THEN
    RAISE EXCEPTION 'world query result lineage scope conflicts with authority'
      USING ERRCODE = '42501',
            CONSTRAINT = 'world_query_result_scope_claim_resolution';
  END IF;

  NEW.resolved_data_scope_key := authoritative_scope_key;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION gowm_capability.bind_terminal_world_query_scope() FROM PUBLIC;

CREATE TRIGGER world_query_terminal_scope_bind
  BEFORE INSERT OR UPDATE OF result, data_scope_claim, resolved_data_scope_key
  ON gowm_capability.world_query_job
  FOR EACH ROW EXECUTE FUNCTION gowm_capability.bind_terminal_world_query_scope();

-- Every result-lineage insertion serializes with terminal binding. This also
-- covers trusted direct inserts, rather than relying only on create_* callers.
CREATE FUNCTION gowm_capability.lock_world_query_result_lineage_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_capability
AS $fn$
DECLARE
  source_query_id text;
  row_scope_key text;
  bound_scope_key text;
BEGIN
  source_query_id := COALESCE(to_jsonb(NEW)->>'query_id',to_jsonb(NEW)->>'source_query_id');
  row_scope_key := to_jsonb(NEW)->>'data_scope_key';
  PERFORM pg_advisory_xact_lock(hashtextextended(source_query_id,0));

  SELECT job.resolved_data_scope_key
  INTO bound_scope_key
  FROM gowm_capability.world_query_job job
  WHERE job.query_id = source_query_id;

  IF bound_scope_key IS NOT NULL AND row_scope_key IS DISTINCT FROM bound_scope_key THEN
    RAISE EXCEPTION 'world query result lineage scope conflicts with authority'
      USING ERRCODE = '42501',
            CONSTRAINT = 'world_query_result_scope_claim_resolution';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION gowm_capability.lock_world_query_result_lineage_scope() FROM PUBLIC;

CREATE TRIGGER world_query_result_scope_lock
  BEFORE INSERT ON public.world_query_result_reference
  FOR EACH ROW EXECUTE FUNCTION gowm_capability.lock_world_query_result_lineage_scope();
CREATE TRIGGER derived_reference_source_scope_lock
  BEFORE INSERT ON public.derived_reference
  FOR EACH ROW EXECUTE FUNCTION gowm_capability.lock_world_query_result_lineage_scope();
CREATE TRIGGER reference_set_source_scope_lock
  BEFORE INSERT ON public.reference_set
  FOR EACH ROW EXECUTE FUNCTION gowm_capability.lock_world_query_result_lineage_scope();

CREATE OR REPLACE FUNCTION public.register_completed_world_query_result()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_capability
AS $fn$
DECLARE
  public_reference_key text;
  result_hash_value text;
  data_hash text;
  compute_hash text;
  existing_scope_key text;
  existing_status text;
  existing_result_hash text;
  existing_result_record jsonb;
  existing_data_hash text;
  existing_compute_hash text;
BEGIN
  IF NEW.result IS NULL OR NEW.data_scope_claim IS NULL OR
     NEW.result->>'status' NOT IN ('COMPLETED','PARTIAL') THEN
    RETURN NEW;
  END IF;
  IF NEW.resolved_data_scope_key IS NULL THEN
    RAISE EXCEPTION 'terminal world query has no authoritative data scope binding'
      USING ERRCODE = '42501',
              CONSTRAINT = 'world_query_result_scope_claim_resolution';
  END IF;
  result_hash_value := COALESCE(
    NEW.result->>'outputHash',
    'sha256:' || encode(digest(convert_to(NEW.result::text,'UTF8'),'sha256'),'hex')
  );
  data_hash := 'sha256:' || encode(digest(convert_to(
    jsonb_path_query_array(NEW.result,'$.nodes[*].result.dataSnapshot')::text,'UTF8'
  ),'sha256'),'hex');
  compute_hash := 'sha256:' || encode(digest(convert_to(
    jsonb_path_query_array(NEW.result,'$.nodes[*].result.computeSnapshot')::text,'UTF8'
  ),'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.query_id,0));
  SELECT reference.data_scope_key,reference.status,reference.result_hash,
         reference.result_record,reference.data_snapshot_hash,reference.compute_snapshot_hash
  INTO existing_scope_key,existing_status,existing_result_hash,
       existing_result_record,existing_data_hash,existing_compute_hash
  FROM public.world_query_result_reference reference
  WHERE reference.query_id = NEW.query_id;
  IF FOUND THEN
    IF existing_scope_key IS DISTINCT FROM NEW.resolved_data_scope_key OR
       existing_status IS DISTINCT FROM NEW.result->>'status' OR
       existing_result_hash IS DISTINCT FROM result_hash_value OR
       existing_result_record IS DISTINCT FROM NEW.result OR
       existing_data_hash IS DISTINCT FROM data_hash OR
       existing_compute_hash IS DISTINCT FROM compute_hash THEN
      RAISE EXCEPTION 'existing world query result conflicts with terminal result authority'
        USING ERRCODE = '42501',
              CONSTRAINT = 'world_query_result_scope_claim_resolution';
    END IF;
    RETURN NEW;
  END IF;
  public_reference_key := 'wrf_' || replace(gen_random_uuid()::text,'-','');
  PERFORM public.register_result_registry_identity(
    public_reference_key,'QUERY_RESULT',NEW.query_id,NEW.resolved_data_scope_key,'Query result ' || NEW.query_id
  );
  INSERT INTO public.world_query_result_reference(
    reference_key,query_id,data_scope_key,result_hash,status,data_snapshot_hash,
    compute_snapshot_hash,result_record,valid_until
  ) VALUES (
    public_reference_key,NEW.query_id,NEW.resolved_data_scope_key,result_hash_value,
    NEW.result->>'status',data_hash,compute_hash,NEW.result,
    clock_timestamp() + interval '24 hours'
  );
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.register_completed_world_query_result() FROM PUBLIC;

-- Persisted internal bindings keep result visibility stable after an external
-- claim expires while preserving the source job's dataset boundary.
CREATE OR REPLACE VIEW gowm_result_v1.query_result AS
SELECT reference.reference_key,
       jsonb_build_object('namespace','gowm','kind','QUERY_RESULT','id',reference.reference_key,'version','1') AS reference_key_value,
       reference.query_id,reference.result_hash,reference.status,
       reference.data_snapshot_hash,reference.compute_snapshot_hash,
       reference.created_at,reference.valid_until,reference.artifact_refs,
       reference.result_record
FROM public.world_query_result_reference reference
JOIN gowm_capability.world_query_job job
  ON job.query_id=reference.query_id
 AND job.resolved_data_scope_key=reference.data_scope_key
WHERE reference.data_scope_key=gowm_result_v1.current_data_scope_key()
  AND (job.dataset_scope_claim IS NULL OR job.dataset_scope_claim=NULLIF(current_setting('gowm.dataset_scope_key',true),''));

CREATE OR REPLACE VIEW gowm_result_v1.derived_reference AS
SELECT reference.reference_key,
       jsonb_build_object('namespace','gowm','kind','DERIVED_REFERENCE','id',reference.reference_key,'version','1') AS reference_key_value,
       reference.derived_type,reference.operator,reference.source_query_id,
       reference.source_node_id,reference.input_reference_keys,
       reference.data_snapshot_hash,reference.compute_snapshot_hash,
       reference.method_version,reference.geometry_summary,reference.artifact_ref,
       reference.created_at,reference.valid_until,reference.revalidation_required
FROM public.derived_reference reference
JOIN gowm_capability.world_query_job job
  ON job.query_id=reference.source_query_id
 AND job.resolved_data_scope_key=reference.data_scope_key
WHERE reference.data_scope_key=gowm_result_v1.current_data_scope_key()
  AND (job.dataset_scope_claim IS NULL OR job.dataset_scope_claim=NULLIF(current_setting('gowm.dataset_scope_key',true),''));

CREATE OR REPLACE VIEW gowm_result_v1.reference_set AS
SELECT reference.reference_set_id,reference.reference_key,
       jsonb_build_object('namespace','gowm','kind','REFERENCE_SET','id',reference.reference_key,'version','1') AS reference_key_value,
       reference.semantic_type,reference.member_count,reference.source_query_id,
       reference.created_at,reference.valid_until
FROM public.reference_set reference
JOIN gowm_capability.world_query_job job
  ON job.query_id=reference.source_query_id
 AND job.resolved_data_scope_key=reference.data_scope_key
WHERE reference.data_scope_key=gowm_result_v1.current_data_scope_key()
  AND (job.dataset_scope_claim IS NULL OR job.dataset_scope_claim=NULLIF(current_setting('gowm.dataset_scope_key',true),''));

CREATE OR REPLACE VIEW gowm_platform_validation_v1.result_reference
WITH (security_barrier=true) AS
WITH result AS (
  SELECT reference.reference_key,'QUERY_RESULT'::text AS entity_kind,reference.data_scope_key,
         COALESCE(reference.result_record->>'status',reference.status) AS source_status,
         'gowm.result-registry'::text AS source_authority,reference.created_at,reference.valid_until,
         reference.data_snapshot_hash,reference.result_hash AS content_hash,reference.result_record
  FROM public.world_query_result_reference reference
  JOIN gowm_capability.world_query_job job
    ON job.query_id=reference.query_id
   AND job.resolved_data_scope_key=reference.data_scope_key
  WHERE reference.data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
    AND (job.dataset_scope_claim IS NULL OR job.dataset_scope_claim=gowm_platform_validation_v1.current_dataset_scope_key())
  UNION ALL
  SELECT reference.reference_key,'QUERY_RESULT',reference.data_scope_key,
         reference.result_record->>'status','gowm.route-planning',reference.created_at,reference.valid_until,
         reference.routing_snapshot_hash,reference.result_hash,reference.result_record
  FROM route_planner_runtime.route_query_result_reference reference
  WHERE reference.data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
    AND reference.dataset_scope_key=gowm_platform_validation_v1.current_dataset_scope_key()
  UNION ALL
  SELECT reference.reference_key,'QUERY_RESULT',reference.data_scope_key,
         reference.status,'gowm.road-coverage-planning',reference.created_at,reference.valid_until,
         reference.routing_snapshot_hash,reference.result_hash,reference.result_record
  FROM coverage_planner.coverage_result_set reference
  WHERE reference.data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
    AND reference.dataset_scope_key=gowm_platform_validation_v1.current_dataset_scope_key()
    AND NOT EXISTS (SELECT 1 FROM public.world_query_result_reference registered WHERE registered.reference_key=reference.reference_key)
  UNION ALL
  SELECT reference.reference_key,'DERIVED_REFERENCE',reference.data_scope_key,
         COALESCE(source.result_record->>'status',job.result->>'status','INDETERMINATE'),
         'gowm.result-registry',reference.created_at,reference.valid_until,
         reference.data_snapshot_hash,reference.content_hash,COALESCE(source.result_record,job.result,'{}'::jsonb)
  FROM public.derived_reference reference
  JOIN gowm_capability.world_query_job job
    ON job.query_id=reference.source_query_id
   AND job.resolved_data_scope_key=reference.data_scope_key
  LEFT JOIN public.world_query_result_reference source ON source.query_id=job.query_id AND source.data_scope_key=reference.data_scope_key
  WHERE reference.data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
    AND (job.dataset_scope_claim IS NULL OR job.dataset_scope_claim=gowm_platform_validation_v1.current_dataset_scope_key())
  UNION ALL
  SELECT reference.reference_key,'REFERENCE_SET',reference.data_scope_key,
         COALESCE(source.result_record->>'status',job.result->>'status','INDETERMINATE'),
         'gowm.result-registry',reference.created_at,reference.valid_until,
         source.data_snapshot_hash,reference.content_hash,COALESCE(source.result_record,job.result,'{}'::jsonb)
  FROM public.reference_set reference
  JOIN gowm_capability.world_query_job job
    ON job.query_id=reference.source_query_id
   AND job.resolved_data_scope_key=reference.data_scope_key
  LEFT JOIN public.world_query_result_reference source ON source.query_id=job.query_id AND source.data_scope_key=reference.data_scope_key
  WHERE reference.data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
    AND (job.dataset_scope_claim IS NULL OR job.dataset_scope_claim=gowm_platform_validation_v1.current_dataset_scope_key())
)
SELECT result.reference_key,result.entity_kind,'1'::text AS reference_version,
       result.source_status,result.source_authority,result.created_at,
       LEAST(result.valid_until,descriptor.valid_to) AS valid_until,
       result.data_snapshot_hash,result.content_hash,result.result_record,
       retirement.retired_at <= statement_timestamp() AS retired,
       COALESCE(descriptor.stale,false) OR COALESCE(descriptor.revalidation_required,false) AS descriptor_stale
FROM result
JOIN public.world_reference_identity identity USING(reference_key,data_scope_key)
LEFT JOIN public.world_reference_retirement retirement USING(reference_key)
LEFT JOIN LATERAL (
  SELECT version.stale,version.revalidation_required,version.valid_to
  FROM public.world_reference_descriptor_version version
  WHERE version.reference_key=result.reference_key AND version.data_scope_key=result.data_scope_key
  ORDER BY version.descriptor_version DESC LIMIT 1
) descriptor ON true;

-- Replay terminal rows only after the authoritative bindings, trigger, and
-- registration function are installed. This creates missing registry rows and
-- checks existing rows through the same fail-closed path.
UPDATE gowm_capability.world_query_job
SET result = result
WHERE result IS NOT NULL
  AND resolved_data_scope_key IS NOT NULL
  AND result->>'status' IN ('COMPLETED', 'PARTIAL');

COMMIT;
