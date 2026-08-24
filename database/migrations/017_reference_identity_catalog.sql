BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE world_reference_identity
  DROP CONSTRAINT world_reference_entity_kind,
  ADD CONSTRAINT world_reference_entity_kind CHECK (entity_kind IN (
    'WORLD_OBJECT','SPATIAL_OBJECT','DATA_SCOPE','DATASET','LAYER','LAYER_FEATURE',
    'QUERY_RESULT','DERIVED_REFERENCE','REFERENCE_SET','OPERATIONAL_TASK'
  ));

CREATE TABLE world_reference_descriptor_version (
  reference_key text NOT NULL REFERENCES world_reference_identity(reference_key),
  descriptor_version bigint GENERATED ALWAYS AS IDENTITY,
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  reference_type text NOT NULL CHECK (length(reference_type) BETWEEN 1 AND 128),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 512),
  state_confidence double precision CHECK (state_confidence BETWEEN 0 AND 1),
  freshness_ms bigint CHECK (freshness_ms >= 0),
  stale boolean,
  object_version text,
  world_version bigint CHECK (world_version IS NULL OR world_version >= 0),
  geometry_summary jsonb,
  valid_from timestamptz NOT NULL DEFAULT '-infinity',
  valid_to timestamptz NOT NULL DEFAULT 'infinity',
  revalidation_required boolean NOT NULL DEFAULT false,
  provenance jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (reference_key, descriptor_version),
  UNIQUE (reference_key, content_hash),
  CHECK (valid_to > valid_from),
  CHECK (jsonb_typeof(provenance) = 'array'),
  CHECK (geometry_summary IS NULL OR jsonb_typeof(geometry_summary) = 'object')
);

CREATE INDEX world_reference_descriptor_scope_current_idx
  ON world_reference_descriptor_version(data_scope_key, reference_key, descriptor_version DESC);

CREATE TABLE world_reference_name (
  name_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_key text NOT NULL REFERENCES world_reference_identity(reference_key),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  name_kind text NOT NULL CHECK (name_kind IN (
    'CANONICAL_NAME','ALIAS','DISPLAY_LABEL','CODE','EXTERNAL_ID','PINYIN',
    'ABBREVIATION','OPERATOR_LABEL'
  )),
  language_tag text NOT NULL DEFAULT 'und' CHECK (language_tag ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,34}$'),
  name_text text NOT NULL CHECK (length(name_text) BETWEEN 1 AND 512),
  normalized_text text NOT NULL CHECK (length(normalized_text) BETWEEN 1 AND 512),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 512),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  valid_from timestamptz NOT NULL DEFAULT '-infinity',
  valid_to timestamptz NOT NULL DEFAULT 'infinity',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_to > valid_from),
  CHECK (jsonb_typeof(evidence) = 'array')
);

CREATE INDEX world_reference_name_scope_exact_idx
  ON world_reference_name(data_scope_key, normalized_text, name_kind, reference_key);
CREATE INDEX world_reference_name_reference_idx
  ON world_reference_name(reference_key, created_at, name_id);

CREATE TABLE world_reference_external_identifier (
  external_identifier_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_key text NOT NULL REFERENCES world_reference_identity(reference_key),
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  authority text NOT NULL CHECK (length(authority) BETWEEN 1 AND 128),
  identifier_kind text NOT NULL CHECK (length(identifier_kind) BETWEEN 1 AND 128),
  identifier_value text NOT NULL CHECK (length(identifier_value) BETWEEN 1 AND 512),
  normalized_value text NOT NULL CHECK (length(normalized_value) BETWEEN 1 AND 512),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  valid_from timestamptz NOT NULL DEFAULT '-infinity',
  valid_to timestamptz NOT NULL DEFAULT 'infinity',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (data_scope_key, authority, identifier_kind, normalized_value, reference_key),
  CHECK (valid_to > valid_from),
  CHECK (jsonb_typeof(evidence) = 'array')
);

CREATE INDEX world_reference_external_scope_exact_idx
  ON world_reference_external_identifier(data_scope_key, normalized_value, authority, identifier_kind);

CREATE TABLE reference_search_projection (
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  reference_key text NOT NULL REFERENCES world_reference_identity(reference_key),
  entity_kind text NOT NULL,
  search_kind text NOT NULL,
  normalized_text text NOT NULL,
  match_priority smallint NOT NULL CHECK (match_priority BETWEEN 0 AND 10),
  source_id text NOT NULL,
  source_confidence double precision NOT NULL CHECK (source_confidence BETWEEN 0 AND 1),
  projected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_scope_key, reference_key, search_kind, normalized_text, source_id)
);

CREATE INDEX reference_search_projection_scope_exact_idx
  ON reference_search_projection(data_scope_key, normalized_text, match_priority, reference_key);
CREATE INDEX reference_search_projection_trgm_idx
  ON reference_search_projection USING gin(normalized_text gin_trgm_ops);

CREATE FUNCTION normalize_reference_text(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT lower(regexp_replace(btrim(p_text), '[[:space:]]+', ' ', 'g'))
$$;

CREATE FUNCTION rebuild_reference_search_projection(p_data_scope_key text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  projected integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.data_scope WHERE scope_key = p_data_scope_key) THEN
    RAISE EXCEPTION 'unknown data scope' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.reference_search_projection
  WHERE data_scope_key = p_data_scope_key;

  INSERT INTO public.reference_search_projection(
    data_scope_key, reference_key, entity_kind, search_kind, normalized_text,
    match_priority, source_id, source_confidence
  )
  SELECT identity.data_scope_key, identity.reference_key, identity.entity_kind,
         'REFERENCE_KEY', identity.reference_key, 0, identity.reference_key, 1
  FROM public.world_reference_identity identity
  WHERE identity.data_scope_key = p_data_scope_key
  UNION ALL
  SELECT external.data_scope_key, external.reference_key, identity.entity_kind,
         'EXTERNAL_ID', external.normalized_value, 1,
         external.external_identifier_id::text, external.confidence
  FROM public.world_reference_external_identifier external
  JOIN public.world_reference_identity identity USING (reference_key)
  WHERE external.data_scope_key = p_data_scope_key
    AND clock_timestamp() <@ tstzrange(external.valid_from, external.valid_to, '[)')
  UNION ALL
  SELECT name.data_scope_key, name.reference_key, identity.entity_kind,
         name.name_kind, name.normalized_text,
         CASE name.name_kind
           WHEN 'CODE' THEN 1 WHEN 'EXTERNAL_ID' THEN 1
           WHEN 'CANONICAL_NAME' THEN 2 WHEN 'ALIAS' THEN 3
           WHEN 'PINYIN' THEN 4 ELSE 4
         END,
         name.name_id::text, name.confidence
  FROM public.world_reference_name name
  JOIN public.world_reference_identity identity USING (reference_key)
  WHERE name.data_scope_key = p_data_scope_key
    AND clock_timestamp() <@ tstzrange(name.valid_from, name.valid_to, '[)');

  GET DIAGNOSTICS projected = ROW_COUNT;
  RETURN projected;
END
$fn$;

CREATE FUNCTION reject_reference_catalog_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'reference catalog source records are append-only'
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER world_reference_descriptor_version_immutable
  BEFORE UPDATE OR DELETE ON world_reference_descriptor_version
  FOR EACH ROW EXECUTE FUNCTION reject_reference_catalog_mutation();
CREATE TRIGGER world_reference_name_immutable
  BEFORE UPDATE OR DELETE ON world_reference_name
  FOR EACH ROW EXECUTE FUNCTION reject_reference_catalog_mutation();
CREATE TRIGGER world_reference_external_identifier_immutable
  BEFORE UPDATE OR DELETE ON world_reference_external_identifier
  FOR EACH ROW EXECUTE FUNCTION reject_reference_catalog_mutation();

INSERT INTO world_reference_descriptor_version(
  reference_key, data_scope_key, reference_type, display_name, content_hash
)
SELECT identity.reference_key, identity.data_scope_key, identity.entity_kind,
       CASE identity.entity_kind
         WHEN 'WORLD_OBJECT' THEN COALESCE(
           (SELECT NULLIF(object.properties->>'name', '') FROM world_object object WHERE object.id = identity.internal_id),
           'World object ' || identity.reference_key
         )
         WHEN 'DATA_SCOPE' THEN COALESCE(
           (SELECT NULLIF(scope.description, '') FROM data_scope scope WHERE scope.scope_key = identity.internal_id),
           'Data scope ' || identity.reference_key
         )
         ELSE initcap(replace(lower(identity.entity_kind), '_', ' ')) || ' ' || identity.reference_key
       END,
       'sha256:' || encode(digest(
         identity.reference_key || ':' || identity.entity_kind || ':1', 'sha256'
       ), 'hex')
FROM world_reference_identity identity;

INSERT INTO world_reference_name(
  reference_key, data_scope_key, name_kind, language_tag, name_text,
  normalized_text, source_ref, confidence
)
SELECT descriptor.reference_key, descriptor.data_scope_key, 'CANONICAL_NAME', 'und',
       descriptor.display_name, normalize_reference_text(descriptor.display_name),
       'migration:017_reference_identity_catalog', 1
FROM world_reference_descriptor_version descriptor;

SELECT rebuild_reference_search_projection(scope_key) FROM data_scope;

CREATE SCHEMA gowm_reference_v1;

CREATE FUNCTION gowm_reference_v1.current_data_scope_key()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('gowm.data_scope_key', true), '') $$;

CREATE FUNCTION gowm_reference_v1.set_data_scope(p_scope_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_scope_key IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.data_scope WHERE scope_key = p_scope_key
  ) THEN
    RAISE EXCEPTION 'data scope is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('gowm.data_scope_key', p_scope_key, true);
END
$fn$;

CREATE VIEW gowm_reference_v1.identity AS
SELECT identity.reference_key,
       identity.entity_kind,
       jsonb_build_object(
         'namespace', 'gowm',
         'kind', identity.entity_kind,
         'id', identity.reference_key,
         'version', COALESCE(descriptor.descriptor_version::text, '1')
       ) AS reference_key_value,
       identity.created_at
FROM world_reference_identity identity
LEFT JOIN LATERAL (
  SELECT version.descriptor_version
  FROM world_reference_descriptor_version version
  WHERE version.reference_key = identity.reference_key
  ORDER BY version.descriptor_version DESC
  LIMIT 1
) descriptor ON true
WHERE identity.data_scope_key = gowm_reference_v1.current_data_scope_key();

CREATE VIEW gowm_reference_v1.current_descriptor AS
SELECT DISTINCT ON (descriptor.reference_key)
       descriptor.reference_key,
       identity.entity_kind,
       descriptor.descriptor_version,
       descriptor.reference_type,
       descriptor.display_name,
       descriptor.state_confidence,
       descriptor.freshness_ms,
       descriptor.stale,
       descriptor.object_version,
       descriptor.world_version,
       descriptor.geometry_summary,
       descriptor.valid_from,
       descriptor.valid_to,
       descriptor.revalidation_required,
       descriptor.provenance,
       descriptor.content_hash,
       descriptor.created_at
FROM world_reference_descriptor_version descriptor
JOIN world_reference_identity identity USING (reference_key)
WHERE descriptor.data_scope_key = gowm_reference_v1.current_data_scope_key()
ORDER BY descriptor.reference_key, descriptor.descriptor_version DESC;

CREATE VIEW gowm_reference_v1.name_entry AS
SELECT name_id, reference_key, name_kind, language_tag, name_text,
       normalized_text, source_ref, evidence, confidence, valid_from, valid_to,
       created_at
FROM world_reference_name
WHERE data_scope_key = gowm_reference_v1.current_data_scope_key();

CREATE VIEW gowm_reference_v1.external_identifier AS
SELECT external_identifier_id, reference_key, authority, identifier_kind,
       identifier_value, normalized_value, confidence, evidence, valid_from,
       valid_to, created_at
FROM world_reference_external_identifier
WHERE data_scope_key = gowm_reference_v1.current_data_scope_key();

CREATE VIEW gowm_reference_v1.search_projection AS
SELECT reference_key, entity_kind, search_kind, normalized_text, match_priority,
       source_confidence, projected_at
FROM reference_search_projection
WHERE data_scope_key = gowm_reference_v1.current_data_scope_key();

CREATE FUNCTION gowm_reference_v1.resolve(
  p_surface_text text,
  p_expected_kinds text[] DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_similarity_threshold double precision DEFAULT 0.3,
  p_candidate_budget integer DEFAULT 1000
)
RETURNS TABLE(
  reference_key text,
  entity_kind text,
  matched_by text,
  match_score double precision,
  state_confidence double precision,
  descriptor_version bigint,
  display_name text
)
LANGUAGE sql
STABLE
AS $fn$
  WITH trusted AS (
    SELECT projection.*
    FROM public.reference_search_projection projection
    WHERE projection.data_scope_key = gowm_reference_v1.current_data_scope_key()
      AND (p_expected_kinds IS NULL OR projection.entity_kind = ANY(p_expected_kinds))
  ), bounded AS (
    SELECT trusted.*,
           similarity(trusted.normalized_text, public.normalize_reference_text(p_surface_text)) AS fuzzy_score,
           trusted.normalized_text = public.normalize_reference_text(p_surface_text) AS exact
    FROM trusted
    WHERE trusted.normalized_text = public.normalize_reference_text(p_surface_text)
       OR trusted.normalized_text % public.normalize_reference_text(p_surface_text)
    ORDER BY trusted.match_priority, trusted.reference_key
    LIMIT LEAST(GREATEST(p_candidate_budget, 1), 5000)
  ), ranked AS (
    SELECT bounded.reference_key, bounded.entity_kind,
           CASE WHEN bounded.exact THEN bounded.search_kind ELSE 'FUZZY_NAME' END AS matched_by,
           CASE WHEN bounded.exact THEN 1::double precision
                ELSE bounded.fuzzy_score * bounded.source_confidence END AS match_score,
           bounded.match_priority
    FROM bounded
    WHERE bounded.exact OR bounded.fuzzy_score >= p_similarity_threshold
  )
  SELECT ranked.reference_key, ranked.entity_kind, ranked.matched_by,
         ranked.match_score, descriptor.state_confidence,
         descriptor.descriptor_version, descriptor.display_name
  FROM ranked
  JOIN LATERAL (
    SELECT current_descriptor.*
    FROM public.world_reference_descriptor_version current_descriptor
    WHERE current_descriptor.reference_key = ranked.reference_key
    ORDER BY current_descriptor.descriptor_version DESC
    LIMIT 1
  ) descriptor ON true
  ORDER BY ranked.match_priority, ranked.match_score DESC, ranked.reference_key
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
$fn$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_reference_reader') THEN
    CREATE ROLE gowm_reference_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_reference_service') THEN
    CREATE ROLE gowm_reference_service NOLOGIN INHERIT;
  END IF;
END
$roles$;

REVOKE ALL ON SCHEMA gowm_reference_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_reference_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_reference_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA gowm_reference_v1 TO gowm_reference_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA gowm_reference_v1 TO gowm_reference_reader;
GRANT EXECUTE ON FUNCTION gowm_reference_v1.current_data_scope_key() TO gowm_reference_reader;
GRANT EXECUTE ON FUNCTION gowm_reference_v1.set_data_scope(text) TO gowm_reference_reader;
GRANT EXECUTE ON FUNCTION gowm_reference_v1.resolve(text,text[],integer,double precision,integer)
  TO gowm_reference_reader;
GRANT gowm_reference_reader TO gowm_reference_service;
ALTER ROLE gowm_reference_service SET default_transaction_read_only = on;
ALTER ROLE gowm_reference_service SET statement_timeout = '10s';

REVOKE ALL ON FUNCTION rebuild_reference_search_projection(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION normalize_reference_text(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION normalize_reference_text(text) TO gowm_reference_reader;

COMMIT;
