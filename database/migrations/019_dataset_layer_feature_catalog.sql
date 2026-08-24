BEGIN;

CREATE TABLE spatial_dataset (
  dataset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_key text NOT NULL DEFAULT ('wrf_' || replace(gen_random_uuid()::text, '-', '')) UNIQUE,
  data_scope_key text NOT NULL REFERENCES data_scope(scope_key),
  dataset_scope_key text NOT NULL CHECK (length(dataset_scope_key) BETWEEN 1 AND 128),
  dataset_key text NOT NULL CHECK (length(dataset_key) BETWEEN 1 AND 256),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (data_scope_key, dataset_scope_key, dataset_key),
  UNIQUE (dataset_id, data_scope_key, dataset_scope_key),
  CHECK (reference_key ~ '^wrf_[0-9a-f]{32}$')
);

CREATE TABLE spatial_dataset_version (
  dataset_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL REFERENCES spatial_dataset(dataset_id),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
  dataset_kind text NOT NULL CHECK (dataset_kind IN (
    'VECTOR','RASTER','ELEVATION','NETWORK','POINT_CLOUD','TILESET','CURRENT_PROJECTION'
  )),
  source_ref text,
  source_version text,
  schema_version text NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 128),
  crs text,
  valid_from timestamptz NOT NULL DEFAULT '-infinity',
  valid_to timestamptz NOT NULL DEFAULT 'infinity',
  quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  lineage jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (dataset_id, version),
  UNIQUE (dataset_id, content_hash),
  UNIQUE (dataset_version_id, dataset_id),
  CHECK (valid_to > valid_from),
  CHECK (retired_at IS NULL OR retired_at >= published_at),
  CHECK (jsonb_typeof(quality) = 'object'),
  CHECK (jsonb_typeof(lineage) = 'array')
);

CREATE INDEX spatial_dataset_version_head_idx
  ON spatial_dataset_version(dataset_id, published_at DESC, version);

CREATE TABLE spatial_layer (
  layer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_key text NOT NULL DEFAULT ('wrf_' || replace(gen_random_uuid()::text, '-', '')) UNIQUE,
  dataset_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  layer_key text NOT NULL CHECK (length(layer_key) BETWEEN 1 AND 256),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (dataset_id, data_scope_key, dataset_scope_key)
    REFERENCES spatial_dataset(dataset_id, data_scope_key, dataset_scope_key),
  UNIQUE (dataset_id, layer_key),
  UNIQUE (layer_id, dataset_id),
  UNIQUE (layer_id, data_scope_key, dataset_scope_key),
  CHECK (reference_key ~ '^wrf_[0-9a-f]{32}$')
);

CREATE TABLE spatial_layer_version (
  layer_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layer_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
  layer_type text NOT NULL CHECK (length(layer_type) BETWEEN 1 AND 128),
  geometry_type text,
  schema_version text NOT NULL CHECK (length(schema_version) BETWEEN 1 AND 128),
  crs text,
  source_ref text,
  source_version text,
  valid_from timestamptz NOT NULL DEFAULT '-infinity',
  valid_to timestamptz NOT NULL DEFAULT 'infinity',
  quality jsonb NOT NULL DEFAULT '{}'::jsonb,
  lineage jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (layer_id, dataset_id) REFERENCES spatial_layer(layer_id, dataset_id),
  FOREIGN KEY (dataset_version_id, dataset_id)
    REFERENCES spatial_dataset_version(dataset_version_id, dataset_id),
  UNIQUE (layer_id, version),
  UNIQUE (layer_id, content_hash),
  UNIQUE (layer_version_id, layer_id),
  CHECK (valid_to > valid_from),
  CHECK (retired_at IS NULL OR retired_at >= published_at),
  CHECK (jsonb_typeof(quality) = 'object'),
  CHECK (jsonb_typeof(lineage) = 'array')
);

CREATE INDEX spatial_layer_version_head_idx
  ON spatial_layer_version(layer_id, published_at DESC, version);

CREATE TABLE spatial_feature_identity (
  feature_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_key text NOT NULL DEFAULT ('wrf_' || replace(gen_random_uuid()::text, '-', '')) UNIQUE,
  layer_id uuid NOT NULL,
  data_scope_key text NOT NULL,
  dataset_scope_key text NOT NULL,
  feature_key text NOT NULL CHECK (length(feature_key) BETWEEN 1 AND 512),
  feature_type text NOT NULL CHECK (length(feature_type) BETWEEN 1 AND 128),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (layer_id, data_scope_key, dataset_scope_key)
    REFERENCES spatial_layer(layer_id, data_scope_key, dataset_scope_key),
  UNIQUE (layer_id, feature_key),
  UNIQUE (feature_id, layer_id),
  UNIQUE (feature_id, data_scope_key),
  CHECK (reference_key ~ '^wrf_[0-9a-f]{32}$')
);

CREATE TABLE spatial_feature_version (
  feature_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL,
  layer_id uuid NOT NULL,
  layer_version_id uuid NOT NULL,
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
  geometry geometry(Geometry, 4326),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_from timestamptz NOT NULL DEFAULT '-infinity',
  valid_to timestamptz NOT NULL DEFAULT 'infinity',
  source_feature_id text,
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (feature_id, layer_id) REFERENCES spatial_feature_identity(feature_id, layer_id),
  FOREIGN KEY (layer_version_id, layer_id)
    REFERENCES spatial_layer_version(layer_version_id, layer_id),
  UNIQUE (feature_id, version),
  UNIQUE (feature_id, content_hash),
  CHECK (valid_to > valid_from),
  CHECK (retired_at IS NULL OR retired_at >= published_at),
  CHECK (jsonb_typeof(properties) = 'object'),
  CHECK (geometry IS NULL OR ST_IsValid(geometry))
);

CREATE INDEX spatial_feature_version_geometry_idx
  ON spatial_feature_version USING gist(geometry);
CREATE INDEX spatial_feature_version_head_idx
  ON spatial_feature_version(feature_id, published_at DESC, version);

CREATE TABLE spatial_feature_object_binding (
  binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL,
  feature_version_id uuid NOT NULL REFERENCES spatial_feature_version(feature_version_id),
  spatial_object_id uuid NOT NULL,
  spatial_object_version_id uuid NOT NULL REFERENCES spatial_object_version(spatial_object_version_id),
  data_scope_key text NOT NULL,
  binding_kind text NOT NULL CHECK (binding_kind IN ('IDENTICAL','REPRESENTS','DERIVED_FROM')),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (feature_id, data_scope_key)
    REFERENCES spatial_feature_identity(feature_id, data_scope_key),
  FOREIGN KEY (spatial_object_id, data_scope_key)
    REFERENCES spatial_object(spatial_object_id, data_scope_key),
  UNIQUE (feature_version_id, spatial_object_version_id, binding_kind),
  CHECK (jsonb_typeof(evidence) = 'array')
);

CREATE FUNCTION register_catalog_reference_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  kind text;
  internal_key text;
BEGIN
  IF TG_TABLE_NAME = 'spatial_dataset' THEN
    kind := 'DATASET'; internal_key := NEW.dataset_id::text;
  ELSIF TG_TABLE_NAME = 'spatial_layer' THEN
    kind := 'LAYER'; internal_key := NEW.layer_id::text;
  ELSIF TG_TABLE_NAME = 'spatial_feature_identity' THEN
    kind := 'LAYER_FEATURE'; internal_key := NEW.feature_id::text;
  ELSE
    RAISE EXCEPTION 'unsupported catalog identity table';
  END IF;
  INSERT INTO public.world_reference_identity(reference_key, entity_kind, internal_id, data_scope_key)
  VALUES (NEW.reference_key, kind, internal_key, NEW.data_scope_key);
  RETURN NEW;
END
$fn$;

CREATE FUNCTION describe_catalog_reference_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  kind text;
  label text;
BEGIN
  IF TG_TABLE_NAME = 'spatial_dataset' THEN
    kind := 'DATASET'; label := NEW.name;
  ELSIF TG_TABLE_NAME = 'spatial_layer' THEN
    kind := 'LAYER'; label := NEW.name;
  ELSIF TG_TABLE_NAME = 'spatial_feature_identity' THEN
    kind := 'LAYER_FEATURE'; label := COALESCE(NULLIF(NEW.display_name, ''), NEW.feature_key);
  ELSE
    RAISE EXCEPTION 'unsupported catalog descriptor table';
  END IF;

  INSERT INTO public.world_reference_descriptor_version(
    reference_key, data_scope_key, reference_type, display_name, content_hash
  ) VALUES (
    NEW.reference_key, NEW.data_scope_key, kind, label,
    'sha256:' || encode(digest(NEW.reference_key || ':' || kind || ':' || label, 'sha256'), 'hex')
  );
  INSERT INTO public.world_reference_name(
    reference_key, data_scope_key, name_kind, language_tag, name_text,
    normalized_text, source_ref, confidence
  ) VALUES (
    NEW.reference_key, NEW.data_scope_key, 'CANONICAL_NAME', 'und', label,
    public.normalize_reference_text(label), 'catalog-identity-trigger', 1
  );
  INSERT INTO public.reference_search_projection(
    data_scope_key, reference_key, entity_kind, search_kind, normalized_text,
    match_priority, source_id, source_confidence
  ) VALUES (
    NEW.data_scope_key, NEW.reference_key, kind, 'CANONICAL_NAME',
    public.normalize_reference_text(label), 2, 'catalog:' || NEW.reference_key, 1
  );
  RETURN NEW;
END
$fn$;

CREATE FUNCTION reject_spatial_catalog_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'spatial catalog identities, versions, and bindings are append-only'
    USING ERRCODE = '55000';
END
$fn$;

CREATE TRIGGER spatial_dataset_reference_register
  BEFORE INSERT ON spatial_dataset FOR EACH ROW EXECUTE FUNCTION register_catalog_reference_identity();
CREATE TRIGGER spatial_layer_reference_register
  BEFORE INSERT ON spatial_layer FOR EACH ROW EXECUTE FUNCTION register_catalog_reference_identity();
CREATE TRIGGER spatial_feature_reference_register
  BEFORE INSERT ON spatial_feature_identity FOR EACH ROW EXECUTE FUNCTION register_catalog_reference_identity();
CREATE TRIGGER spatial_dataset_reference_describe
  AFTER INSERT ON spatial_dataset FOR EACH ROW EXECUTE FUNCTION describe_catalog_reference_identity();
CREATE TRIGGER spatial_layer_reference_describe
  AFTER INSERT ON spatial_layer FOR EACH ROW EXECUTE FUNCTION describe_catalog_reference_identity();
CREATE TRIGGER spatial_feature_reference_describe
  AFTER INSERT ON spatial_feature_identity FOR EACH ROW EXECUTE FUNCTION describe_catalog_reference_identity();

CREATE TRIGGER spatial_dataset_immutable BEFORE UPDATE OR DELETE ON spatial_dataset
  FOR EACH ROW EXECUTE FUNCTION reject_spatial_catalog_mutation();
CREATE TRIGGER spatial_dataset_version_immutable BEFORE UPDATE OR DELETE ON spatial_dataset_version
  FOR EACH ROW EXECUTE FUNCTION reject_spatial_catalog_mutation();
CREATE TRIGGER spatial_layer_immutable BEFORE UPDATE OR DELETE ON spatial_layer
  FOR EACH ROW EXECUTE FUNCTION reject_spatial_catalog_mutation();
CREATE TRIGGER spatial_layer_version_immutable BEFORE UPDATE OR DELETE ON spatial_layer_version
  FOR EACH ROW EXECUTE FUNCTION reject_spatial_catalog_mutation();
CREATE TRIGGER spatial_feature_identity_immutable BEFORE UPDATE OR DELETE ON spatial_feature_identity
  FOR EACH ROW EXECUTE FUNCTION reject_spatial_catalog_mutation();
CREATE TRIGGER spatial_feature_version_immutable BEFORE UPDATE OR DELETE ON spatial_feature_version
  FOR EACH ROW EXECUTE FUNCTION reject_spatial_catalog_mutation();
CREATE TRIGGER spatial_feature_object_binding_immutable BEFORE UPDATE OR DELETE ON spatial_feature_object_binding
  FOR EACH ROW EXECUTE FUNCTION reject_spatial_catalog_mutation();

REVOKE ALL ON FUNCTION register_catalog_reference_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION describe_catalog_reference_identity() FROM PUBLIC;

CREATE SCHEMA gowm_catalog_v1;

CREATE FUNCTION gowm_catalog_v1.current_data_scope_key()
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('gowm.data_scope_key', true), '') $$;

CREATE FUNCTION gowm_catalog_v1.current_dataset_scope_key()
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('gowm.dataset_scope_key', true), '') $$;

CREATE FUNCTION gowm_catalog_v1.set_scope(p_data_scope_key text, p_dataset_scope_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_data_scope_key IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.data_scope WHERE scope_key = p_data_scope_key
  ) OR p_dataset_scope_key IS NULL OR length(p_dataset_scope_key) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'catalog scope is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('gowm.data_scope_key', p_data_scope_key, true);
  PERFORM set_config('gowm.dataset_scope_key', p_dataset_scope_key, true);
END
$fn$;

CREATE VIEW gowm_catalog_v1.dataset AS
SELECT dataset.reference_key,
       jsonb_build_object('namespace','gowm','kind','DATASET','id',dataset.reference_key,'version',version.version) AS reference_key_value,
       dataset.dataset_key, dataset.name, version.version, version.dataset_kind,
       version.source_ref, version.source_version, version.schema_version,
       version.crs, version.valid_from, version.valid_to, version.quality,
       version.lineage, version.content_hash, version.published_at,
       version.retired_at
FROM spatial_dataset dataset
JOIN LATERAL (
  SELECT candidate.* FROM spatial_dataset_version candidate
  WHERE candidate.dataset_id = dataset.dataset_id
  ORDER BY candidate.published_at DESC, candidate.version DESC
  LIMIT 1
) version ON true
WHERE dataset.data_scope_key = gowm_catalog_v1.current_data_scope_key()
  AND dataset.dataset_scope_key = gowm_catalog_v1.current_dataset_scope_key();

CREATE VIEW gowm_catalog_v1.dataset_version AS
SELECT dataset.reference_key, version.version, version.dataset_kind,
       version.source_ref, version.source_version, version.schema_version,
       version.crs, version.valid_from, version.valid_to, version.quality,
       version.lineage, version.content_hash, version.published_at,
       version.retired_at
FROM spatial_dataset dataset
JOIN spatial_dataset_version version USING (dataset_id)
WHERE dataset.data_scope_key = gowm_catalog_v1.current_data_scope_key()
  AND dataset.dataset_scope_key = gowm_catalog_v1.current_dataset_scope_key();

CREATE VIEW gowm_catalog_v1.layer AS
SELECT layer.reference_key, dataset.reference_key AS dataset_reference_key,
       jsonb_build_object('namespace','gowm','kind','LAYER','id',layer.reference_key,'version',version.version) AS reference_key_value,
       layer.layer_key, layer.name, version.version, version.layer_type,
       version.geometry_type, version.schema_version, version.crs,
       version.source_ref, version.source_version, version.valid_from,
       version.valid_to, version.quality, version.lineage,
       version.content_hash, version.published_at, version.retired_at
FROM spatial_layer layer
JOIN spatial_dataset dataset USING (dataset_id)
JOIN LATERAL (
  SELECT candidate.* FROM spatial_layer_version candidate
  WHERE candidate.layer_id = layer.layer_id
  ORDER BY candidate.published_at DESC, candidate.version DESC
  LIMIT 1
) version ON true
WHERE layer.data_scope_key = gowm_catalog_v1.current_data_scope_key()
  AND layer.dataset_scope_key = gowm_catalog_v1.current_dataset_scope_key();

CREATE VIEW gowm_catalog_v1.layer_version AS
SELECT layer.reference_key, dataset.reference_key AS dataset_reference_key,
       version.version, version.layer_type, version.geometry_type,
       version.schema_version, version.crs, version.source_ref,
       version.source_version, version.valid_from, version.valid_to,
       version.quality, version.lineage, version.content_hash,
       version.published_at, version.retired_at
FROM spatial_layer layer
JOIN spatial_dataset dataset USING (dataset_id)
JOIN spatial_layer_version version USING (layer_id)
WHERE layer.data_scope_key = gowm_catalog_v1.current_data_scope_key()
  AND layer.dataset_scope_key = gowm_catalog_v1.current_dataset_scope_key();

CREATE VIEW gowm_catalog_v1.feature AS
SELECT feature.reference_key, layer.reference_key AS layer_reference_key,
       jsonb_build_object('namespace','gowm','kind','LAYER_FEATURE','id',feature.reference_key,'version',version.version) AS reference_key_value,
       feature.feature_key, feature.feature_type, feature.display_name,
       version.version, ST_AsGeoJSON(version.geometry)::jsonb AS geometry,
       CASE WHEN version.geometry IS NULL THEN NULL ELSE jsonb_build_object(
         'geometryType', GeometryType(version.geometry),
         'bbox', jsonb_build_array(ST_XMin(Box2D(version.geometry)), ST_YMin(Box2D(version.geometry)), ST_XMax(Box2D(version.geometry)), ST_YMax(Box2D(version.geometry))),
         'crs', 'EPSG:4326'
       ) END AS geometry_summary,
       version.properties, version.valid_from, version.valid_to,
       version.source_feature_id, version.content_hash, version.published_at,
       version.retired_at
FROM spatial_feature_identity feature
JOIN spatial_layer layer USING (layer_id)
JOIN LATERAL (
  SELECT candidate.* FROM spatial_feature_version candidate
  WHERE candidate.feature_id = feature.feature_id
  ORDER BY candidate.published_at DESC, candidate.version DESC
  LIMIT 1
) version ON true
WHERE feature.data_scope_key = gowm_catalog_v1.current_data_scope_key()
  AND feature.dataset_scope_key = gowm_catalog_v1.current_dataset_scope_key();

CREATE VIEW gowm_catalog_v1.feature_version AS
SELECT feature.reference_key, layer.reference_key AS layer_reference_key,
       version.version, ST_AsGeoJSON(version.geometry)::jsonb AS geometry,
       version.properties, version.valid_from, version.valid_to,
       version.source_feature_id, version.content_hash, version.published_at,
       version.retired_at
FROM spatial_feature_identity feature
JOIN spatial_layer layer USING (layer_id)
JOIN spatial_feature_version version USING (feature_id)
WHERE feature.data_scope_key = gowm_catalog_v1.current_data_scope_key()
  AND feature.dataset_scope_key = gowm_catalog_v1.current_dataset_scope_key();

CREATE VIEW gowm_catalog_v1.feature_object_binding AS
SELECT feature.reference_key AS feature_reference_key,
       identity.reference_key AS spatial_object_reference_key,
       binding.binding_kind, binding.evidence, binding.created_at
FROM spatial_feature_object_binding binding
JOIN spatial_feature_identity feature USING (feature_id)
JOIN world_reference_identity identity
  ON identity.entity_kind = 'SPATIAL_OBJECT'
 AND identity.internal_id = binding.spatial_object_id::text
WHERE binding.data_scope_key = gowm_catalog_v1.current_data_scope_key()
  AND feature.dataset_scope_key = gowm_catalog_v1.current_dataset_scope_key();

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_catalog_reader') THEN
    CREATE ROLE gowm_catalog_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gowm_catalog_service') THEN
    CREATE ROLE gowm_catalog_service NOLOGIN INHERIT;
  END IF;
END
$roles$;

REVOKE ALL ON SCHEMA gowm_catalog_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_catalog_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_catalog_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA gowm_catalog_v1 TO gowm_catalog_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA gowm_catalog_v1 TO gowm_catalog_reader;
GRANT EXECUTE ON FUNCTION gowm_catalog_v1.current_data_scope_key() TO gowm_catalog_reader;
GRANT EXECUTE ON FUNCTION gowm_catalog_v1.current_dataset_scope_key() TO gowm_catalog_reader;
GRANT EXECUTE ON FUNCTION gowm_catalog_v1.set_scope(text,text) TO gowm_catalog_reader;
GRANT gowm_catalog_reader TO gowm_catalog_service;
ALTER ROLE gowm_catalog_service SET default_transaction_read_only = on;
ALTER ROLE gowm_catalog_service SET statement_timeout = '10s';

COMMIT;
