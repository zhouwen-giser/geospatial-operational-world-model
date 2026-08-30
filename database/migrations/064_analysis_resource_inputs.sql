BEGIN;

CREATE TABLE public.analysis_resource_input (
  analysis_id uuid NOT NULL REFERENCES public.analysis_record(analysis_id),
  input_no integer NOT NULL CHECK (input_no > 0),
  input_role text NOT NULL CHECK (length(btrim(input_role)) BETWEEN 1 AND 128),
  resource_namespace text NOT NULL
    CHECK (resource_namespace ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  resource_kind text NOT NULL
    CHECK (resource_kind ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  resource_id text NOT NULL
    CHECK (length(btrim(resource_id)) BETWEEN 1 AND 256),
  resource_version text NOT NULL
    CHECK (length(btrim(resource_version)) BETWEEN 1 AND 128),
  resource_content_hash text
    CHECK (resource_content_hash IS NULL OR resource_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  resource_world_version bigint
    CHECK (resource_world_version IS NULL OR resource_world_version >= 0),
  pinning text NOT NULL CHECK (pinning IN ('PINNED','AT_LEAST','BEST_EFFORT')),
  authority text NOT NULL CHECK (length(btrim(authority)) BETWEEN 1 AND 128),
  world_reference_key text REFERENCES public.world_reference_identity(reference_key),
  source_analysis_id uuid REFERENCES public.analysis_record(analysis_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (analysis_id, input_no),
  UNIQUE (
    analysis_id,
    input_role,
    resource_namespace,
    resource_kind,
    resource_id
  ),
  CHECK (source_analysis_id IS NULL OR source_analysis_id <> analysis_id)
);

CREATE INDEX analysis_resource_input_resource_idx
  ON public.analysis_resource_input(
    resource_namespace,
    resource_kind,
    resource_id,
    resource_version,
    analysis_id
  );
CREATE INDEX analysis_resource_input_source_analysis_idx
  ON public.analysis_resource_input(source_analysis_id)
  WHERE source_analysis_id IS NOT NULL;

CREATE TABLE public.analysis_input_set (
  analysis_id uuid NOT NULL REFERENCES public.analysis_record(analysis_id),
  input_set_kind text NOT NULL
    CHECK (input_set_kind ~ '^[A-Z][A-Z0-9_]{1,127}$'),
  item_count bigint NOT NULL CHECK (item_count >= 0),
  item_set_digest text NOT NULL CHECK (item_set_digest ~ '^sha256:[0-9a-f]{64}$'),
  manifest_artifact_ref text
    CHECK (manifest_artifact_ref IS NULL OR length(btrim(manifest_artifact_ref)) BETWEEN 1 AND 2048),
  authority text NOT NULL CHECK (length(btrim(authority)) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (analysis_id, input_set_kind)
);

COMMENT ON TABLE public.analysis_resource_input IS
  'Append-only, version-pinned logical resources consumed by a platform-owned analysis record.';
COMMENT ON TABLE public.analysis_input_set IS
  'Append-only deterministic summaries of large, ordered analysis input sets whose members do not fit a query snapshot.';
COMMENT ON COLUMN public.analysis_input_set.item_set_digest IS
  'SHA-256 digest computed by the writer over deterministically sorted (kind,id,version,hash) members.';

CREATE FUNCTION public.validate_analysis_resource_input_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  parent_scope text;
  source_scope text;
  reference_scope text;
  reference_kind text;
  reference_version text;
BEGIN
  SELECT analysis.data_scope_key
  INTO STRICT parent_scope
  FROM public.analysis_record analysis
  WHERE analysis.analysis_id = NEW.analysis_id;

  IF NEW.source_analysis_id IS NOT NULL THEN
    SELECT analysis.data_scope_key
    INTO STRICT source_scope
    FROM public.analysis_record analysis
    WHERE analysis.analysis_id = NEW.source_analysis_id;
    IF source_scope IS DISTINCT FROM parent_scope THEN
      RAISE EXCEPTION 'analysis resource source crosses data scope'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.world_reference_key IS NOT NULL THEN
    SELECT identity.data_scope_key, identity.entity_kind
    INTO STRICT reference_scope, reference_kind
    FROM public.world_reference_identity identity
    WHERE identity.reference_key = NEW.world_reference_key;
    IF reference_scope IS DISTINCT FROM parent_scope THEN
      RAISE EXCEPTION 'analysis world reference crosses data scope'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.resource_namespace <> 'gowm'
       OR NEW.resource_kind <> reference_kind
       OR NEW.resource_id <> NEW.world_reference_key THEN
      RAISE EXCEPTION 'analysis resource identity conflicts with its world reference'
        USING ERRCODE = '23514';
    END IF;

    SELECT descriptor.object_version
    INTO reference_version
    FROM public.world_reference_descriptor_version descriptor
    WHERE descriptor.reference_key = NEW.world_reference_key
      AND descriptor.object_version IS NOT NULL
    ORDER BY descriptor.descriptor_version DESC
    LIMIT 1;
    IF reference_version IS NOT NULL
       AND NEW.resource_version IS DISTINCT FROM reference_version THEN
      RAISE EXCEPTION 'analysis resource version conflicts with its world reference descriptor'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER analysis_resource_input_scope_validate
  BEFORE INSERT ON public.analysis_resource_input
  FOR EACH ROW EXECUTE FUNCTION public.validate_analysis_resource_input_scope();

CREATE FUNCTION public.reject_analysis_input_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  RAISE EXCEPTION 'analysis input evidence is append-only'
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER analysis_resource_input_immutable
  BEFORE UPDATE OR DELETE ON public.analysis_resource_input
  FOR EACH ROW EXECUTE FUNCTION public.reject_analysis_input_mutation();
CREATE TRIGGER analysis_input_set_immutable
  BEFORE UPDATE OR DELETE ON public.analysis_input_set
  FOR EACH ROW EXECUTE FUNCTION public.reject_analysis_input_mutation();

CREATE FUNCTION public.register_analysis_resource_input(
  p_analysis_id uuid,
  p_input_no integer,
  p_input_role text,
  p_resource_namespace text,
  p_resource_kind text,
  p_resource_id text,
  p_resource_version text,
  p_resource_content_hash text,
  p_resource_world_version bigint,
  p_pinning text,
  p_authority text,
  p_world_reference_key text,
  p_source_analysis_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  parent_scope text;
  source_scope text;
  reference_scope text;
  existing public.analysis_resource_input%ROWTYPE;
  inserted_count integer;
BEGIN
  SELECT analysis.data_scope_key
  INTO STRICT parent_scope
  FROM public.analysis_record analysis
  WHERE analysis.analysis_id = p_analysis_id
  FOR SHARE;

  IF p_source_analysis_id IS NOT NULL THEN
    SELECT analysis.data_scope_key
    INTO STRICT source_scope
    FROM public.analysis_record analysis
    WHERE analysis.analysis_id = p_source_analysis_id;
    IF source_scope IS DISTINCT FROM parent_scope THEN
      RAISE EXCEPTION 'analysis resource source crosses data scope'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_world_reference_key IS NOT NULL THEN
    SELECT identity.data_scope_key
    INTO STRICT reference_scope
    FROM public.world_reference_identity identity
    WHERE identity.reference_key = p_world_reference_key;
    IF reference_scope IS DISTINCT FROM parent_scope THEN
      RAISE EXCEPTION 'analysis world reference crosses data scope'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.analysis_resource_input(
    analysis_id,
    input_no,
    input_role,
    resource_namespace,
    resource_kind,
    resource_id,
    resource_version,
    resource_content_hash,
    resource_world_version,
    pinning,
    authority,
    world_reference_key,
    source_analysis_id
  ) VALUES (
    p_analysis_id,
    p_input_no,
    p_input_role,
    p_resource_namespace,
    p_resource_kind,
    p_resource_id,
    p_resource_version,
    p_resource_content_hash,
    p_resource_world_version,
    p_pinning,
    p_authority,
    p_world_reference_key,
    p_source_analysis_id
  ) ON CONFLICT (analysis_id, input_no) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 1 THEN
    RETURN true;
  END IF;

  SELECT input.*
  INTO STRICT existing
  FROM public.analysis_resource_input input
  WHERE input.analysis_id = p_analysis_id
    AND input.input_no = p_input_no;
  IF existing.input_role = p_input_role
     AND existing.resource_namespace = p_resource_namespace
     AND existing.resource_kind = p_resource_kind
     AND existing.resource_id = p_resource_id
     AND existing.resource_version = p_resource_version
     AND existing.resource_content_hash IS NOT DISTINCT FROM p_resource_content_hash
     AND existing.resource_world_version IS NOT DISTINCT FROM p_resource_world_version
     AND existing.pinning = p_pinning
     AND existing.authority = p_authority
     AND existing.world_reference_key IS NOT DISTINCT FROM p_world_reference_key
     AND existing.source_analysis_id IS NOT DISTINCT FROM p_source_analysis_id THEN
    RETURN false;
  END IF;
  RAISE EXCEPTION 'analysis resource input idempotency conflict'
    USING ERRCODE = '23505';
END
$fn$;

CREATE FUNCTION public.register_analysis_input_set(
  p_analysis_id uuid,
  p_input_set_kind text,
  p_item_count bigint,
  p_item_set_digest text,
  p_manifest_artifact_ref text,
  p_authority text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  existing public.analysis_input_set%ROWTYPE;
  inserted_count integer;
BEGIN
  PERFORM 1
  FROM public.analysis_record analysis
  WHERE analysis.analysis_id = p_analysis_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'analysis record is unavailable'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.analysis_input_set(
    analysis_id,
    input_set_kind,
    item_count,
    item_set_digest,
    manifest_artifact_ref,
    authority
  ) VALUES (
    p_analysis_id,
    p_input_set_kind,
    p_item_count,
    p_item_set_digest,
    p_manifest_artifact_ref,
    p_authority
  ) ON CONFLICT (analysis_id, input_set_kind) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 1 THEN
    RETURN true;
  END IF;

  SELECT input_set.*
  INTO STRICT existing
  FROM public.analysis_input_set input_set
  WHERE input_set.analysis_id = p_analysis_id
    AND input_set.input_set_kind = p_input_set_kind;
  IF existing.item_count = p_item_count
     AND existing.item_set_digest = p_item_set_digest
     AND existing.manifest_artifact_ref IS NOT DISTINCT FROM p_manifest_artifact_ref
     AND existing.authority = p_authority THEN
    RETURN false;
  END IF;
  RAISE EXCEPTION 'analysis input set idempotency conflict'
    USING ERRCODE = '23505';
END
$fn$;

CREATE SCHEMA gowm_analysis_v1;

CREATE FUNCTION gowm_analysis_v1.current_data_scope_key()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('gowm.data_scope_key', true), '')
$$;

CREATE FUNCTION gowm_analysis_v1.set_data_scope(p_scope_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_scope_key IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM public.data_scope scope
       WHERE scope.scope_key = p_scope_key
     ) THEN
    RAISE EXCEPTION 'analysis scope is unavailable'
      USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('gowm.data_scope_key', p_scope_key, true);
END
$fn$;

CREATE VIEW gowm_analysis_v1.analysis_resource_input
WITH (security_barrier = true)
AS
SELECT
  input.analysis_id,
  input.input_no,
  input.input_role,
  input.resource_namespace,
  input.resource_kind,
  input.resource_id,
  input.resource_version,
  input.resource_content_hash,
  input.resource_world_version,
  input.pinning,
  input.authority,
  input.world_reference_key,
  input.source_analysis_id,
  input.created_at
FROM public.analysis_resource_input input
JOIN public.analysis_record analysis USING (analysis_id)
WHERE analysis.data_scope_key = gowm_analysis_v1.current_data_scope_key();

CREATE VIEW gowm_analysis_v1.analysis_input_set
WITH (security_barrier = true)
AS
SELECT
  input_set.analysis_id,
  input_set.input_set_kind,
  input_set.item_count,
  input_set.item_set_digest,
  input_set.manifest_artifact_ref,
  input_set.authority,
  input_set.created_at
FROM public.analysis_input_set input_set
JOIN public.analysis_record analysis USING (analysis_id)
WHERE analysis.data_scope_key = gowm_analysis_v1.current_data_scope_key();

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_analysis_reader') THEN
    CREATE ROLE gowm_analysis_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_analysis_writer') THEN
    CREATE ROLE gowm_analysis_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_analysis_service') THEN
    CREATE ROLE gowm_analysis_service NOLOGIN INHERIT;
  END IF;
END
$roles$;

REVOKE ALL ON TABLE public.analysis_resource_input, public.analysis_input_set
  FROM PUBLIC, gowm_analysis_reader, gowm_analysis_writer, gowm_analysis_service;
REVOKE ALL ON FUNCTION public.validate_analysis_resource_input_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_analysis_input_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_analysis_resource_input(
  uuid, integer, text, text, text, text, text, text, bigint, text, text, text, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_analysis_input_set(
  uuid, text, bigint, text, text, text
) FROM PUBLIC;
REVOKE ALL ON SCHEMA gowm_analysis_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_analysis_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_analysis_v1 FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO gowm_analysis_writer;
GRANT EXECUTE ON FUNCTION public.register_analysis_resource_input(
  uuid, integer, text, text, text, text, text, text, bigint, text, text, text, uuid
) TO gowm_analysis_writer;
GRANT EXECUTE ON FUNCTION public.register_analysis_input_set(
  uuid, text, bigint, text, text, text
) TO gowm_analysis_writer;

GRANT USAGE ON SCHEMA gowm_analysis_v1 TO gowm_analysis_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA gowm_analysis_v1 TO gowm_analysis_reader;
GRANT EXECUTE ON FUNCTION gowm_analysis_v1.current_data_scope_key() TO gowm_analysis_reader;
GRANT EXECUTE ON FUNCTION gowm_analysis_v1.set_data_scope(text) TO gowm_analysis_reader;

GRANT gowm_analysis_reader, gowm_analysis_writer TO gowm_analysis_service;
ALTER ROLE gowm_analysis_service SET statement_timeout = '30s';

COMMENT ON ROLE gowm_analysis_reader IS
  'NOLOGIN, scope-before-read access to the generic analysis input evidence contract.';
COMMENT ON ROLE gowm_analysis_writer IS
  'NOLOGIN, controlled append-only generic analysis input registration; no base-table mutation privileges.';
COMMENT ON ROLE gowm_analysis_service IS
  'NOLOGIN service group inheriting controlled analysis input write and scoped read contracts.';

COMMIT;
