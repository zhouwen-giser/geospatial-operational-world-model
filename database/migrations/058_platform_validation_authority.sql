BEGIN;

-- Retirement is an append-only Foundation fact tied to the existing identity.
-- The identity itself remains immutable and is never rewritten or reissued.
CREATE TABLE world_reference_retirement (
  reference_key text PRIMARY KEY REFERENCES world_reference_identity(reference_key),
  retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 2048),
  receipt_ref text NOT NULL CHECK (length(receipt_ref) BETWEEN 1 AND 2048)
);
CREATE TRIGGER world_reference_retirement_immutable BEFORE UPDATE OR DELETE ON world_reference_retirement
FOR EACH ROW EXECUTE FUNCTION reject_world_reference_mutation();
REVOKE ALL ON world_reference_retirement FROM PUBLIC;

ALTER TABLE world_query_result_reference DROP CONSTRAINT world_query_result_reference_status_check;
ALTER TABLE world_query_result_reference ADD CONSTRAINT world_query_result_reference_status_check
  CHECK (status IN ('COMPLETED','PARTIAL','NO_DATA','AMBIGUOUS','INDETERMINATE','NO_FEASIBLE_RESULT','STALE','FAILED'));

CREATE OR REPLACE FUNCTION gowm_platform_validation_v1.set_scope(p_data_scope_key text,p_dataset_scope_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF p_data_scope_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.data_scope WHERE scope_key=p_data_scope_key)
     OR (p_dataset_scope_key IS NOT NULL AND length(p_dataset_scope_key) NOT BETWEEN 1 AND 128) THEN
    RAISE EXCEPTION 'platform validation scope is unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('gowm.data_scope_key',p_data_scope_key,true);
  PERFORM set_config('gowm.dataset_scope_key',COALESCE(p_dataset_scope_key,''),true);
END
$fn$;

CREATE VIEW gowm_platform_validation_v1.reference_lifecycle WITH (security_barrier=true) AS
SELECT identity.reference_key,identity.entity_kind,
       LEAST(retirement.retired_at,object.deleted_at) <= statement_timestamp() AS retired
FROM public.world_reference_identity identity
LEFT JOIN public.world_reference_retirement retirement USING(reference_key)
LEFT JOIN public.world_object object ON identity.entity_kind='WORLD_OBJECT'
  AND object.id=identity.internal_id AND object.data_scope_key=identity.data_scope_key
WHERE identity.data_scope_key=gowm_platform_validation_v1.current_data_scope_key();

CREATE VIEW gowm_platform_validation_v1.world_reference_version WITH (security_barrier=true) AS
SELECT identity.reference_key,identity.entity_kind,descriptor.descriptor_version,
       COALESCE(state.version::text,spatial.version_no::text,descriptor.object_version,
                CASE WHEN identity.entity_kind IN ('DATA_SCOPE','OPERATIONAL_TASK') THEN '1' END) AS current_version,
       COALESCE(state.version::text,spatial.version_no::text,descriptor.object_version) AS object_version,
       COALESCE(state.version,descriptor.world_version) AS world_version,
       COALESCE(descriptor.valid_to,upper(spatial.valid_time),'infinity'::timestamptz) AS valid_to,
       COALESCE(state.updated_at,spatial.created_at,descriptor.created_at,identity.created_at) AS created_at,
       descriptor.stale,descriptor.revalidation_required,
       COALESCE(descriptor.content_hash,CASE WHEN state.object_id IS NOT NULL THEN
         'sha256:'||encode(digest(convert_to(state.state::text||':'||state.version::text,'UTF8'),'sha256'),'hex') END) AS content_hash,
       LEAST(retirement.retired_at,object.deleted_at) <= statement_timestamp() AS retired
FROM public.world_reference_identity identity
LEFT JOIN public.world_reference_retirement retirement USING(reference_key)
LEFT JOIN public.world_object object ON identity.entity_kind='WORLD_OBJECT'
  AND object.id=identity.internal_id AND object.data_scope_key=identity.data_scope_key
LEFT JOIN public.world_object_state state ON state.object_id=object.id
LEFT JOIN LATERAL (
  SELECT version.* FROM public.spatial_object_version version
  JOIN public.spatial_object source USING(spatial_object_id)
  WHERE identity.entity_kind='SPATIAL_OBJECT' AND source.spatial_object_id::text=identity.internal_id
    AND source.data_scope_key=identity.data_scope_key
  ORDER BY version.version_no DESC LIMIT 1
) spatial ON true
LEFT JOIN LATERAL (
  SELECT version.* FROM public.world_reference_descriptor_version version
  WHERE version.reference_key=identity.reference_key AND version.data_scope_key=identity.data_scope_key
  ORDER BY version.descriptor_version DESC LIMIT 1
) descriptor ON true
WHERE identity.data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
  AND identity.entity_kind IN ('WORLD_OBJECT','SPATIAL_OBJECT','DATA_SCOPE','OPERATIONAL_TASK');

-- Every branch filters the authoritative dataset scope before exposing result
-- metadata. A data-only query remains data-scoped; a dataset query does not.
CREATE VIEW gowm_platform_validation_v1.result_reference WITH (security_barrier=true) AS
WITH result AS (
  SELECT reference.reference_key,'QUERY_RESULT'::text AS entity_kind,reference.data_scope_key,
         COALESCE(reference.result_record->>'status',reference.status) AS source_status,
         'gowm.result-registry'::text AS source_authority,reference.created_at,reference.valid_until,
         reference.data_snapshot_hash,reference.result_hash AS content_hash,reference.result_record
  FROM public.world_query_result_reference reference
  JOIN gowm_capability.world_query_job job ON job.query_id=reference.query_id AND job.data_scope_claim=reference.data_scope_key
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
  JOIN gowm_capability.world_query_job job ON job.query_id=reference.source_query_id AND job.data_scope_claim=reference.data_scope_key
  LEFT JOIN public.world_query_result_reference source ON source.query_id=job.query_id AND source.data_scope_key=reference.data_scope_key
  WHERE reference.data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
    AND (job.dataset_scope_claim IS NULL OR job.dataset_scope_claim=gowm_platform_validation_v1.current_dataset_scope_key())
  UNION ALL
  SELECT reference.reference_key,'REFERENCE_SET',reference.data_scope_key,
         COALESCE(source.result_record->>'status',job.result->>'status','INDETERMINATE'),
         'gowm.result-registry',reference.created_at,reference.valid_until,
         source.data_snapshot_hash,reference.content_hash,COALESCE(source.result_record,job.result,'{}'::jsonb)
  FROM public.reference_set reference
  JOIN gowm_capability.world_query_job job ON job.query_id=reference.source_query_id AND job.data_scope_claim=reference.data_scope_key
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

CREATE VIEW gowm_platform_validation_v1.scope_reference WITH (security_barrier=true) AS
SELECT identity.reference_key,'DATA_SCOPE'::text AS entity_kind,'1'::text AS reference_version
FROM public.world_reference_identity identity
LEFT JOIN public.world_reference_retirement retirement USING(reference_key)
WHERE data_scope_key=gowm_platform_validation_v1.current_data_scope_key()
  AND entity_kind='DATA_SCOPE' AND internal_id=data_scope_key
  AND (retirement.retired_at IS NULL OR retirement.retired_at>statement_timestamp());

-- A source-world pin is a scoped world version, never the global sequence value.
CREATE VIEW gowm_network_v1.source_world WITH (security_barrier=true) AS
SELECT COALESCE(max(state.version),0)::text AS world_version
FROM public.world_object object JOIN public.world_object_state state ON state.object_id=object.id
WHERE object.data_scope_key=gowm_network_v1.current_data_scope_key() AND object.deleted_at IS NULL;

REVOKE ALL ON gowm_platform_validation_v1.reference_lifecycle,gowm_platform_validation_v1.world_reference_version,
  gowm_platform_validation_v1.result_reference,gowm_platform_validation_v1.scope_reference,gowm_network_v1.source_world FROM PUBLIC;
GRANT SELECT ON gowm_platform_validation_v1.reference_lifecycle,gowm_platform_validation_v1.world_reference_version,
  gowm_platform_validation_v1.result_reference,gowm_platform_validation_v1.scope_reference TO platform_validation_provider;
GRANT SELECT ON gowm_network_v1.source_world TO network_provider,route_planner_provider,coverage_planner_provider;

-- Current public coverage publications require their real compute receipt.
-- Supersedes the old wire fallback without rewriting historical migrations.
CREATE OR REPLACE FUNCTION coverage_planner.register_coverage_result_references()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, coverage_planner, public, gowm_capability
AS $fn$
DECLARE
  request_row coverage_planner.coverage_request%ROWTYPE;
  source_query_id text;
  source_node_id text;
  alternative jsonb;
  similarity jsonb;
  alternative_reference text;
  candidate_id uuid;
  result_kind text;
  integrity_receipt jsonb;
  data_digest text;
  compute_digest text;
BEGIN
  IF NEW.result_record->'referenceKey' IS NULL THEN RETURN NEW; END IF;
  IF NEW.result_record#>>'{referenceKey,kind}' <> 'QUERY_RESULT'
     OR NEW.result_record#>>'{referenceKey,id}' <> NEW.reference_key THEN
    RAISE EXCEPTION 'coverage result QUERY_RESULT identity mismatch' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT request_row FROM coverage_planner.coverage_request
  WHERE coverage_request_id=NEW.coverage_request_id;
  SELECT query_id INTO source_query_id FROM gowm_capability.world_query_job
  WHERE job_id=request_row.gateway_job_id;
  IF NOT EXISTS (SELECT 1 FROM public.world_reference_identity WHERE reference_key=NEW.reference_key) THEN
    PERFORM public.register_result_registry_identity(
      NEW.reference_key,'QUERY_RESULT',NEW.coverage_request_id::text,NEW.data_scope_key,
      'Road coverage plan set ' || request_row.external_request_id
    );
  END IF;
  SELECT value INTO integrity_receipt
  FROM jsonb_array_elements(COALESCE(NEW.result_record->'receipts','[]'::jsonb))
  WHERE value->>'kind'='SNAPSHOT_INTEGRITY' LIMIT 1;
  data_digest := integrity_receipt->>'dataSnapshotHash';
  compute_digest := integrity_receipt->>'computeSnapshotHash';
  IF integrity_receipt IS NULL OR data_digest IS NULL OR compute_digest IS NULL
     OR integrity_receipt#>>'{computeSnapshot,snapshotHash}' IS DISTINCT FROM compute_digest
     OR integrity_receipt->'computeSnapshot'->'engines' IS NULL
     OR jsonb_array_length(integrity_receipt->'computeSnapshot'->'engines')=0
     OR data_digest !~ '^sha256:[0-9a-f]{64}$' OR compute_digest !~ '^sha256:[0-9a-f]{64}$'
     OR compute_digest=NEW.problem_hash OR compute_digest=data_digest THEN
    RAISE EXCEPTION 'invalid coverage snapshot integrity receipt' USING ERRCODE='22023';
  END IF;
  IF source_query_id IS NOT NULL THEN
    result_kind := CASE NEW.status WHEN 'SUCCEEDED' THEN 'COMPLETED' WHEN 'PARTIAL' THEN 'PARTIAL'
      WHEN 'NO_FEASIBLE_PLAN' THEN 'NO_FEASIBLE_RESULT' WHEN 'STALE' THEN 'STALE' ELSE 'FAILED' END;
    INSERT INTO public.world_query_result_reference(
      reference_key,query_id,data_scope_key,result_hash,status,data_snapshot_hash,
      compute_snapshot_hash,result_record,valid_until
    ) VALUES (
      NEW.reference_key,source_query_id,NEW.data_scope_key,NEW.result_hash,result_kind,
      data_digest,compute_digest,NEW.result_record,NEW.valid_until
    ) ON CONFLICT (query_id) DO NOTHING;
    SELECT node_id INTO source_node_id FROM gowm_capability.world_query_node_execution
    WHERE job_id=request_row.gateway_job_id AND operation_id='coverage.road.plan'
    ORDER BY node_ordinal LIMIT 1;
  END IF;

  FOR alternative IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.result_record->'alternatives','[]'::jsonb))
  LOOP
    alternative_reference := alternative#>>'{referenceKey,id}';
    IF alternative#>>'{referenceKey,kind}' <> 'DERIVED_REFERENCE'
       OR alternative_reference !~ '^wrf_[0-9a-f]{32}$'
       OR alternative->>'contentHash' !~ '^sha256:[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'coverage alternative DERIVED_REFERENCE identity mismatch' USING ERRCODE='22023';
    END IF;
    SELECT candidate.coverage_candidate_id INTO STRICT candidate_id
    FROM coverage_planner.coverage_candidate candidate
    JOIN coverage_planner.coverage_candidate_route route USING(coverage_candidate_id,data_scope_key,dataset_scope_key)
    WHERE candidate.coverage_problem_id=NEW.coverage_problem_id
      AND route.route_signature=alternative#>>'{route,routeSignature}';
    INSERT INTO coverage_planner.coverage_alternative(
      coverage_result_set_id,coverage_candidate_id,data_scope_key,dataset_scope_key,
      alternative_id,rank,reference_key,content_hash
    ) VALUES (
      NEW.coverage_result_set_id,candidate_id,NEW.data_scope_key,NEW.dataset_scope_key,
      alternative->>'alternativeId',(alternative->>'rank')::integer,alternative_reference,alternative->>'contentHash'
    );
    IF NOT EXISTS (SELECT 1 FROM public.world_reference_identity WHERE reference_key=alternative_reference) THEN
      PERFORM public.register_result_registry_identity(
        alternative_reference,'DERIVED_REFERENCE',alternative->>'alternativeId',NEW.data_scope_key,
        'Road coverage alternative ' || (alternative->>'alternativeId')
      );
    END IF;
    IF source_query_id IS NOT NULL THEN
      INSERT INTO public.derived_reference(
        reference_key,data_scope_key,derived_type,operator,source_query_id,source_node_id,
        input_reference_keys,data_snapshot_hash,compute_snapshot_hash,method_version,
        geometry_summary,artifact_ref,content_hash,valid_until,revalidation_required
      ) VALUES (
        alternative_reference,NEW.data_scope_key,'ANALYSIS_RESULT','coverage.road.plan',source_query_id,
        source_node_id,'[]'::jsonb,data_digest,compute_digest,'1.0',NULL,NULL,
        alternative->>'contentHash',NEW.valid_until,true
      ) ON CONFLICT (data_scope_key,content_hash) DO NOTHING;
    END IF;
  END LOOP;
  FOR similarity IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.result_record->'pairwiseSimilarity','[]'::jsonb))
  LOOP
    INSERT INTO coverage_planner.coverage_pairwise_similarity(
      coverage_result_set_id,data_scope_key,dataset_scope_key,left_alternative_id,right_alternative_id,
      weighted_arc_overlap_ppm,deadhead_jaccard_distance_ppm
    ) VALUES (
      NEW.coverage_result_set_id,NEW.data_scope_key,NEW.dataset_scope_key,
      LEAST(similarity->>'leftAlternativeId',similarity->>'rightAlternativeId'),
      GREATEST(similarity->>'leftAlternativeId',similarity->>'rightAlternativeId'),
      (similarity->>'weightedArcOverlapPpm')::integer,(similarity->>'deadheadJaccardDistancePpm')::integer
    );
  END LOOP;
  RETURN NEW;
END
$fn$;

-- Result reads and validation share the source job's dataset boundary.
CREATE OR REPLACE VIEW gowm_result_v1.query_result AS
SELECT reference.reference_key,
       jsonb_build_object('namespace','gowm','kind','QUERY_RESULT','id',reference.reference_key,'version','1') AS reference_key_value,
       reference.query_id,reference.result_hash,reference.status,
       reference.data_snapshot_hash,reference.compute_snapshot_hash,
       reference.created_at,reference.valid_until,reference.artifact_refs,
       reference.result_record
FROM world_query_result_reference reference
JOIN gowm_capability.world_query_job job ON job.query_id=reference.query_id AND job.data_scope_claim=reference.data_scope_key
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
FROM derived_reference reference
JOIN gowm_capability.world_query_job job ON job.query_id=reference.source_query_id AND job.data_scope_claim=reference.data_scope_key
WHERE reference.data_scope_key=gowm_result_v1.current_data_scope_key()
  AND (job.dataset_scope_claim IS NULL OR job.dataset_scope_claim=NULLIF(current_setting('gowm.dataset_scope_key',true),''));

CREATE OR REPLACE VIEW gowm_result_v1.reference_set AS
SELECT reference.reference_set_id,reference.reference_key,
       jsonb_build_object('namespace','gowm','kind','REFERENCE_SET','id',reference.reference_key,'version','1') AS reference_key_value,
       reference.semantic_type,reference.member_count,reference.source_query_id,
       reference.created_at,reference.valid_until
FROM reference_set reference
JOIN gowm_capability.world_query_job job ON job.query_id=reference.source_query_id AND job.data_scope_claim=reference.data_scope_key
WHERE reference.data_scope_key=gowm_result_v1.current_data_scope_key()
  AND (job.dataset_scope_claim IS NULL OR job.dataset_scope_claim=NULLIF(current_setting('gowm.dataset_scope_key',true),''));


CREATE OR REPLACE VIEW gowm_result_v1.reference_set_member AS
SELECT set_record.reference_key AS set_reference_key,member.member_ordinal,
       identity.reference_key,
       jsonb_build_object('namespace','gowm','kind',identity.entity_kind,'id',identity.reference_key,'version',
         COALESCE(descriptor.descriptor_version::text,'1')) AS reference_key_value
FROM reference_set_member member
JOIN reference_set set_record USING(reference_set_id)
JOIN world_reference_identity identity ON identity.reference_key=member.member_reference_key
LEFT JOIN LATERAL (
  SELECT version.descriptor_version FROM world_reference_descriptor_version version
  WHERE version.reference_key=identity.reference_key ORDER BY version.descriptor_version DESC LIMIT 1
) descriptor ON true
WHERE set_record.data_scope_key=gowm_result_v1.current_data_scope_key()
  AND EXISTS (SELECT 1 FROM gowm_result_v1.reference_set visible WHERE visible.reference_set_id=set_record.reference_set_id);


COMMIT;
