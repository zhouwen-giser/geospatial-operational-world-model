BEGIN;

CREATE TABLE world_query_result_reference (
  result_reference_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_key text NOT NULL UNIQUE REFERENCES world_reference_identity(reference_key),
  query_id text NOT NULL UNIQUE REFERENCES gowm_capability.world_query_job(query_id),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  result_hash text NOT NULL CHECK (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('COMPLETED','PARTIAL','NO_DATA','INDETERMINATE')),
  data_snapshot_hash text NOT NULL CHECK (data_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  compute_snapshot_hash text NOT NULL CHECK (compute_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  result_record jsonb NOT NULL CHECK (jsonb_typeof(result_record)='object'),
  artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artifact_refs)='array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz NOT NULL,
  CHECK (valid_until > created_at)
);

CREATE INDEX world_query_result_reference_scope_idx
  ON world_query_result_reference(data_scope_key, reference_key);

CREATE TABLE world_query_artifact (
  artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_reference_id uuid NOT NULL REFERENCES world_query_result_reference(result_reference_id),
  artifact_ref text NOT NULL CHECK (length(artifact_ref) BETWEEN 1 AND 2048),
  content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^sha256:[0-9a-f]{64}$'),
  media_type text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (result_reference_id, artifact_ref)
);

CREATE TABLE derived_reference (
  derived_reference_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_key text NOT NULL UNIQUE REFERENCES world_reference_identity(reference_key),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  derived_type text NOT NULL CHECK (derived_type IN ('GEOMETRY','REFERENCE_SET','RANKED_REFERENCE_SET','ANALYSIS_RESULT')),
  operator text NOT NULL CHECK (length(operator) BETWEEN 1 AND 256),
  source_query_id text NOT NULL REFERENCES gowm_capability.world_query_job(query_id),
  source_node_id text,
  input_reference_keys jsonb NOT NULL CHECK (jsonb_typeof(input_reference_keys)='array'),
  data_snapshot_hash text NOT NULL CHECK (data_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  compute_snapshot_hash text NOT NULL CHECK (compute_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  method_version text NOT NULL CHECK (length(method_version) BETWEEN 1 AND 128),
  geometry_summary jsonb CHECK (geometry_summary IS NULL OR jsonb_typeof(geometry_summary)='object'),
  artifact_ref text,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz NOT NULL,
  revalidation_required boolean NOT NULL DEFAULT false,
  UNIQUE (data_scope_key, content_hash),
  CHECK (valid_until > created_at)
);

CREATE TABLE reference_set (
  reference_set_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_key text NOT NULL UNIQUE REFERENCES world_reference_identity(reference_key),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  semantic_type text NOT NULL CHECK (length(semantic_type) BETWEEN 1 AND 128),
  member_count integer NOT NULL CHECK (member_count >= 0),
  source_query_id text NOT NULL REFERENCES gowm_capability.world_query_job(query_id),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz NOT NULL,
  UNIQUE (data_scope_key, content_hash),
  CHECK (valid_until > created_at)
);

CREATE TABLE reference_set_member (
  reference_set_id uuid NOT NULL REFERENCES reference_set(reference_set_id),
  member_ordinal integer NOT NULL CHECK (member_ordinal >= 0),
  member_reference_key text NOT NULL REFERENCES world_reference_identity(reference_key),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (reference_set_id, member_ordinal),
  UNIQUE (reference_set_id, member_reference_key)
);

CREATE FUNCTION register_result_registry_identity(
  p_reference_key text,
  p_entity_kind text,
  p_internal_id text,
  p_data_scope_key text,
  p_display_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  INSERT INTO public.world_reference_identity(reference_key,entity_kind,internal_id,data_scope_key)
  VALUES (p_reference_key,p_entity_kind,p_internal_id,p_data_scope_key);
  INSERT INTO public.world_reference_descriptor_version(
    reference_key,data_scope_key,reference_type,display_name,content_hash
  ) VALUES (
    p_reference_key,p_data_scope_key,p_entity_kind,p_display_name,
    'sha256:' || encode(digest(convert_to(p_reference_key || ':' || p_entity_kind || ':' || p_display_name,'UTF8'),'sha256'),'hex')
  );
  INSERT INTO public.world_reference_name(
    reference_key,data_scope_key,name_kind,language_tag,name_text,normalized_text,source_ref,confidence
  ) VALUES (
    p_reference_key,p_data_scope_key,'CANONICAL_NAME','und',p_display_name,
    public.normalize_reference_text(p_display_name),'result-registry',1
  );
  INSERT INTO public.reference_search_projection(
    data_scope_key,reference_key,entity_kind,search_kind,normalized_text,
    match_priority,source_id,source_confidence
  ) VALUES (
    p_data_scope_key,p_reference_key,p_entity_kind,'CANONICAL_NAME',
    public.normalize_reference_text(p_display_name),2,'result-registry:' || p_reference_key,1
  );
END
$fn$;

CREATE FUNCTION register_completed_world_query_result()
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
BEGIN
  IF NEW.result IS NULL OR NEW.data_scope_claim IS NULL OR
     NEW.result->>'status' NOT IN ('COMPLETED','PARTIAL') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.query_id,0));
  IF EXISTS (SELECT 1 FROM public.world_query_result_reference WHERE query_id=NEW.query_id) THEN
    RETURN NEW;
  END IF;
  public_reference_key := 'wrf_' || replace(gen_random_uuid()::text,'-','');
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
  PERFORM public.register_result_registry_identity(
    public_reference_key,'QUERY_RESULT',NEW.query_id,NEW.data_scope_claim,'Query result ' || NEW.query_id
  );
  INSERT INTO public.world_query_result_reference(
    reference_key,query_id,data_scope_key,result_hash,status,data_snapshot_hash,
    compute_snapshot_hash,result_record,valid_until
  ) VALUES (
    public_reference_key,NEW.query_id,NEW.data_scope_claim,result_hash_value,
    NEW.result->>'status',data_hash,compute_hash,NEW.result,
    clock_timestamp() + interval '24 hours'
  );
  RETURN NEW;
END
$fn$;

CREATE TRIGGER world_query_result_reference_register
  AFTER INSERT OR UPDATE OF result ON gowm_capability.world_query_job
  FOR EACH ROW EXECUTE FUNCTION register_completed_world_query_result();

-- Upgrade-safe backfill: replay the same immutable terminal result through the
-- registration trigger without changing its public query identity or payload.
UPDATE gowm_capability.world_query_job
SET result=result
WHERE result IS NOT NULL
  AND data_scope_claim IS NOT NULL
  AND result->>'status' IN ('COMPLETED','PARTIAL');

CREATE FUNCTION create_derived_reference(
  p_data_scope_key text,
  p_derived_type text,
  p_operator text,
  p_source_query_id text,
  p_source_node_id text,
  p_input_reference_keys text[],
  p_data_snapshot_hash text,
  p_compute_snapshot_hash text,
  p_method_version text,
  p_geometry_summary jsonb,
  p_artifact_ref text,
  p_valid_until timestamptz,
  p_revalidation_required boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  public_reference_key text;
  content_hash_value text;
  existing_key text;
BEGIN
  IF p_valid_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'derived reference validUntil must be in the future' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_input_reference_keys,ARRAY[]::text[])) input_key
    LEFT JOIN public.world_reference_identity identity
      ON identity.reference_key=input_key AND identity.data_scope_key=p_data_scope_key
    WHERE identity.reference_key IS NULL
  ) THEN
    RAISE EXCEPTION 'derived reference input scope is unavailable' USING ERRCODE='42501';
  END IF;
  content_hash_value := 'sha256:' || encode(digest(convert_to(
    jsonb_build_object(
      'type',p_derived_type,'operator',p_operator,'query',p_source_query_id,
      'node',p_source_node_id,'inputs',COALESCE(p_input_reference_keys,ARRAY[]::text[]),
      'data',p_data_snapshot_hash,'compute',p_compute_snapshot_hash,
      'method',p_method_version,'geometry',p_geometry_summary,'artifact',p_artifact_ref
    )::text,'UTF8'
  ),'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(p_data_scope_key || ':' || content_hash_value,0));
  SELECT reference_key INTO existing_key FROM public.derived_reference
  WHERE data_scope_key=p_data_scope_key AND content_hash=content_hash_value;
  IF existing_key IS NOT NULL THEN RETURN existing_key; END IF;
  public_reference_key := 'wrf_' || replace(gen_random_uuid()::text,'-','');
  PERFORM public.register_result_registry_identity(
    public_reference_key,'DERIVED_REFERENCE',gen_random_uuid()::text,p_data_scope_key,
    'Derived ' || p_derived_type || ' from ' || p_source_query_id
  );
  INSERT INTO public.derived_reference(
    reference_key,data_scope_key,derived_type,operator,source_query_id,source_node_id,
    input_reference_keys,data_snapshot_hash,compute_snapshot_hash,method_version,
    geometry_summary,artifact_ref,content_hash,valid_until,revalidation_required
  ) VALUES (
    public_reference_key,p_data_scope_key,p_derived_type,p_operator,p_source_query_id,p_source_node_id,
    to_jsonb(COALESCE(p_input_reference_keys,ARRAY[]::text[])),p_data_snapshot_hash,p_compute_snapshot_hash,
    p_method_version,p_geometry_summary,p_artifact_ref,content_hash_value,p_valid_until,p_revalidation_required
  );
  RETURN public_reference_key;
END
$fn$;

CREATE FUNCTION create_reference_set(
  p_data_scope_key text,
  p_semantic_type text,
  p_source_query_id text,
  p_member_reference_keys text[],
  p_valid_until timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  public_reference_key text;
  set_id uuid;
  content_hash_value text;
  existing_key text;
  distinct_count integer;
BEGIN
  IF p_valid_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'reference set validUntil must be in the future' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_member_reference_keys,ARRAY[]::text[])) member_key
    LEFT JOIN public.world_reference_identity identity
      ON identity.reference_key=member_key AND identity.data_scope_key=p_data_scope_key
    WHERE identity.reference_key IS NULL
  ) THEN
    RAISE EXCEPTION 'reference set member scope is unavailable' USING ERRCODE='42501';
  END IF;
  SELECT count(DISTINCT member_key) INTO distinct_count
  FROM unnest(COALESCE(p_member_reference_keys,ARRAY[]::text[])) member_key;
  content_hash_value := 'sha256:' || encode(digest(convert_to(
    jsonb_build_object(
      'semanticType',p_semantic_type,'query',p_source_query_id,
      'members',(SELECT jsonb_agg(member_key ORDER BY member_key)
                 FROM (SELECT DISTINCT member_key FROM unnest(COALESCE(p_member_reference_keys,ARRAY[]::text[])) member_key) members)
    )::text,'UTF8'
  ),'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended(p_data_scope_key || ':' || content_hash_value,0));
  SELECT reference_key INTO existing_key FROM public.reference_set
  WHERE data_scope_key=p_data_scope_key AND content_hash=content_hash_value;
  IF existing_key IS NOT NULL THEN RETURN existing_key; END IF;
  public_reference_key := 'wrf_' || replace(gen_random_uuid()::text,'-','');
  set_id := gen_random_uuid();
  PERFORM public.register_result_registry_identity(
    public_reference_key,'REFERENCE_SET',set_id::text,p_data_scope_key,
    p_semantic_type || ' reference set from ' || p_source_query_id
  );
  INSERT INTO public.reference_set(
    reference_set_id,reference_key,data_scope_key,semantic_type,member_count,
    source_query_id,content_hash,valid_until
  ) VALUES (
    set_id,public_reference_key,p_data_scope_key,p_semantic_type,distinct_count,
    p_source_query_id,content_hash_value,p_valid_until
  );
  INSERT INTO public.reference_set_member(reference_set_id,member_ordinal,member_reference_key)
  SELECT set_id,row_number() OVER (ORDER BY first_ordinal)-1,member_reference_key
  FROM (
    SELECT member_reference_key,min(ordinality) AS first_ordinal
    FROM unnest(COALESCE(p_member_reference_keys,ARRAY[]::text[])) WITH ORDINALITY AS input(member_reference_key,ordinality)
    GROUP BY member_reference_key
  ) members
  ORDER BY first_ordinal;
  RETURN public_reference_key;
END
$fn$;

CREATE FUNCTION reject_result_registry_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'result registry records are append-only' USING ERRCODE='55000';
END
$fn$;

CREATE TRIGGER world_query_result_reference_immutable BEFORE UPDATE OR DELETE ON world_query_result_reference
  FOR EACH ROW EXECUTE FUNCTION reject_result_registry_mutation();
CREATE TRIGGER world_query_artifact_immutable BEFORE UPDATE OR DELETE ON world_query_artifact
  FOR EACH ROW EXECUTE FUNCTION reject_result_registry_mutation();
CREATE TRIGGER derived_reference_immutable BEFORE UPDATE OR DELETE ON derived_reference
  FOR EACH ROW EXECUTE FUNCTION reject_result_registry_mutation();
CREATE TRIGGER reference_set_immutable BEFORE UPDATE OR DELETE ON reference_set
  FOR EACH ROW EXECUTE FUNCTION reject_result_registry_mutation();
CREATE TRIGGER reference_set_member_immutable BEFORE UPDATE OR DELETE ON reference_set_member
  FOR EACH ROW EXECUTE FUNCTION reject_result_registry_mutation();

CREATE SCHEMA gowm_result_v1;

CREATE FUNCTION gowm_result_v1.current_data_scope_key()
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('gowm.data_scope_key',true),'') $$;

CREATE FUNCTION gowm_result_v1.set_data_scope(p_scope_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
BEGIN
  IF p_scope_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.data_scope WHERE scope_key=p_scope_key) THEN
    RAISE EXCEPTION 'result scope is unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('gowm.data_scope_key',p_scope_key,true);
END
$fn$;

CREATE VIEW gowm_result_v1.query_result AS
SELECT reference.reference_key,
       jsonb_build_object('namespace','gowm','kind','QUERY_RESULT','id',reference.reference_key,'version','1') AS reference_key_value,
       reference.query_id,reference.result_hash,reference.status,
       reference.data_snapshot_hash,reference.compute_snapshot_hash,
       reference.created_at,reference.valid_until,reference.artifact_refs,
       reference.result_record
FROM world_query_result_reference reference
WHERE reference.data_scope_key=gowm_result_v1.current_data_scope_key();

CREATE VIEW gowm_result_v1.derived_reference AS
SELECT reference.reference_key,
       jsonb_build_object('namespace','gowm','kind','DERIVED_REFERENCE','id',reference.reference_key,'version','1') AS reference_key_value,
       reference.derived_type,reference.operator,reference.source_query_id,
       reference.source_node_id,reference.input_reference_keys,
       reference.data_snapshot_hash,reference.compute_snapshot_hash,
       reference.method_version,reference.geometry_summary,reference.artifact_ref,
       reference.created_at,reference.valid_until,reference.revalidation_required
FROM derived_reference reference
WHERE reference.data_scope_key=gowm_result_v1.current_data_scope_key();

CREATE VIEW gowm_result_v1.reference_set AS
SELECT reference.reference_set_id,reference.reference_key,
       jsonb_build_object('namespace','gowm','kind','REFERENCE_SET','id',reference.reference_key,'version','1') AS reference_key_value,
       reference.semantic_type,reference.member_count,reference.source_query_id,
       reference.created_at,reference.valid_until
FROM reference_set reference
WHERE reference.data_scope_key=gowm_result_v1.current_data_scope_key();

CREATE VIEW gowm_result_v1.reference_set_member AS
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
WHERE set_record.data_scope_key=gowm_result_v1.current_data_scope_key();

CREATE VIEW gowm_result_v1.scope_resource AS
SELECT identity.reference_key,
       jsonb_build_object('namespace','gowm','kind','DATA_SCOPE','id',identity.reference_key,'version','1') AS reference_key_value
FROM world_reference_identity identity
WHERE identity.entity_kind='DATA_SCOPE'
  AND identity.data_scope_key=gowm_result_v1.current_data_scope_key();

CREATE FUNCTION gowm_result_v1.validate(p_reference_key text,p_reference_version text,p_at timestamptz DEFAULT clock_timestamp())
RETURNS TABLE(status text,revalidation_required boolean)
LANGUAGE sql STABLE
AS $fn$
  SELECT CASE
    WHEN candidate.reference_key IS NULL THEN 'NOT_FOUND'
    WHEN p_reference_version <> '1' THEN 'VERSION_CONFLICT'
    WHEN candidate.valid_until <= p_at THEN 'EXPIRED'
    WHEN candidate.revalidation_required THEN 'STALE'
    ELSE 'VALID'
  END,
  CASE
    WHEN candidate.reference_key IS NULL OR p_reference_version <> '1' OR
         candidate.valid_until <= p_at OR candidate.revalidation_required THEN true
    ELSE false
  END
  FROM (VALUES (1)) seed(value)
  LEFT JOIN (
    SELECT reference_key,valid_until,false AS revalidation_required FROM gowm_result_v1.query_result
    UNION ALL
    SELECT reference_key,valid_until,revalidation_required FROM gowm_result_v1.derived_reference
    UNION ALL
    SELECT reference_key,valid_until,false FROM gowm_result_v1.reference_set
  ) candidate ON candidate.reference_key=p_reference_key
$fn$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gowm_result_reader') THEN CREATE ROLE gowm_result_reader NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gowm_result_service') THEN CREATE ROLE gowm_result_service NOLOGIN INHERIT; END IF;
END
$roles$;

REVOKE ALL ON FUNCTION register_result_registry_identity(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION register_completed_world_query_result() FROM PUBLIC;
REVOKE ALL ON FUNCTION create_derived_reference(text,text,text,text,text,text[],text,text,text,jsonb,text,timestamptz,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_reference_set(text,text,text,text[],timestamptz) FROM PUBLIC;
REVOKE ALL ON SCHEMA gowm_result_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_result_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_result_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA gowm_result_v1 TO gowm_result_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA gowm_result_v1 TO gowm_result_reader;
GRANT EXECUTE ON FUNCTION gowm_result_v1.current_data_scope_key() TO gowm_result_reader;
GRANT EXECUTE ON FUNCTION gowm_result_v1.set_data_scope(text) TO gowm_result_reader;
GRANT EXECUTE ON FUNCTION gowm_result_v1.validate(text,text,timestamptz) TO gowm_result_reader;
GRANT gowm_result_reader TO gowm_result_service;
ALTER ROLE gowm_result_service SET default_transaction_read_only=on;
ALTER ROLE gowm_result_service SET statement_timeout='10s';

COMMIT;
