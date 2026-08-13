BEGIN;

CREATE EXTENSION IF NOT EXISTS mobilitydb;

DO $validate_runtime$
DECLARE
  mobility_version text;
  postgis_version text;
BEGIN
  SELECT extversion INTO mobility_version FROM pg_extension WHERE extname = 'mobilitydb';
  SELECT extversion INTO postgis_version FROM pg_extension WHERE extname = 'postgis';
  IF mobility_version !~ '^1\.3(\.|$)' THEN
    RAISE EXCEPTION 'GOWM+ v1.2 is pinned to MobilityDB 1.3.x stable APIs; installed=%', mobility_version;
  END IF;
  IF current_setting('server_version_num')::integer < 150000 THEN
    RAISE EXCEPTION 'GOWM+ v1.2 requires PostgreSQL >= 15; installed=%', version();
  END IF;
  IF postgis_version IS NULL THEN
    RAISE EXCEPTION 'PostGIS is required';
  END IF;
END
$validate_runtime$;

CREATE TABLE gowm_deployment_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  contract_version text NOT NULL,
  analysis_srid integer NOT NULL REFERENCES spatial_ref_sys(srid),
  mobilitydb_api_line text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO gowm_deployment_config(singleton,contract_version,analysis_srid,mobilitydb_api_line)
VALUES (true,'1.2.0',:ANALYSIS_SRID,'v1.3.x-stable');

DO $validate_analysis_srid$
DECLARE
  target_srid integer;
  srtext_value text;
  proj4_value text;
BEGIN
  SELECT analysis_srid INTO STRICT target_srid FROM gowm_deployment_config WHERE singleton;
  SELECT srtext,proj4text INTO srtext_value,proj4_value FROM spatial_ref_sys WHERE srid=target_srid;
  IF NOT FOUND OR COALESCE(srtext_value,'') !~* '(PROJCS|PROJCRS)' THEN
    RAISE EXCEPTION 'ANALYSIS_SRID % must be a registered projected CRS',target_srid;
  END IF;
  IF COALESCE(srtext_value,'') !~* '(metre|meter)' AND
     COALESCE(proj4_value,'') !~ '(^|[[:space:]])\+units=m([[:space:]]|$)' THEN
    RAISE EXCEPTION 'ANALYSIS_SRID % must use metre linear units',target_srid;
  END IF;
END
$validate_analysis_srid$;

CREATE FUNCTION gowm_analysis_srid()
RETURNS integer LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT analysis_srid FROM gowm_deployment_config WHERE singleton $$;

-- Shared foundation registry. GOWM owns these records; STAS and future spatial
-- applications consume their stable keys instead of inventing local copies.
CREATE TABLE data_scope (
  scope_key text PRIMARY KEY,
  operational_domain text NOT NULL CHECK (operational_domain IN ('REAL','SIMULATION','TEST')),
  description text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE analysis_space (
  analysis_space_key text PRIMARY KEY,
  canonical_srid integer NOT NULL REFERENCES spatial_ref_sys(srid),
  dimension_model text NOT NULL CHECK (dimension_model IN ('2D','2.5D','3D')),
  distance_model text NOT NULL CHECK (distance_model='PLANAR_METRE_V1'),
  transform_pipeline_version text NOT NULL,
  valid_area geometry(Polygon,4326),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION validate_analysis_space_crs()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  srtext_value text;
  proj4_value text;
BEGIN
  SELECT srtext,proj4text INTO srtext_value,proj4_value
  FROM spatial_ref_sys WHERE srid=NEW.canonical_srid;
  IF NOT FOUND OR COALESCE(srtext_value,'') !~* '(PROJCS|PROJCRS)' THEN
    RAISE EXCEPTION 'analysis space % requires a registered projected CRS, got SRID %',
      NEW.analysis_space_key,NEW.canonical_srid;
  END IF;
  IF COALESCE(srtext_value,'') !~* '(metre|meter)' AND
     COALESCE(proj4_value,'') !~ '(^|[[:space:]])\+units=m([[:space:]]|$)' THEN
    RAISE EXCEPTION 'analysis space % requires metre linear units',NEW.analysis_space_key;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER analysis_space_crs_validate
BEFORE INSERT OR UPDATE ON analysis_space
FOR EACH ROW EXECUTE FUNCTION validate_analysis_space_crs();

CREATE TABLE source_registry (
  source_key text PRIMARY KEY,
  data_scope_key text NOT NULL REFERENCES data_scope,
  source_type text NOT NULL,
  default_analysis_space_key text NOT NULL REFERENCES analysis_space,
  reliability_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_key,data_scope_key)
);

CREATE TABLE producer_pipeline (
  pipeline_key text PRIMARY KEY,
  source_key text NOT NULL REFERENCES source_registry,
  pipeline_version text NOT NULL,
  output_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_key,pipeline_key)
);

CREATE TABLE datastream (
  datastream_key text PRIMARY KEY,
  source_key text NOT NULL REFERENCES source_registry,
  data_scope_key text NOT NULL REFERENCES data_scope,
  pipeline_key text NOT NULL REFERENCES producer_pipeline,
  schema_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (datastream_key,source_key,data_scope_key,pipeline_key),
  FOREIGN KEY (source_key,data_scope_key) REFERENCES source_registry(source_key,data_scope_key),
  FOREIGN KEY (source_key,pipeline_key) REFERENCES producer_pipeline(source_key,pipeline_key)
);

CREATE TABLE processing_run (
  processing_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processor_name text NOT NULL,
  processor_version text NOT NULL,
  config_hash text NOT NULL,
  code_digest text,
  deterministic boolean NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (completed_at IS NULL OR completed_at>=started_at)
);

CREATE TABLE source_clock_model (
  clock_model_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL REFERENCES source_registry,
  model_version text NOT NULL,
  clock_domain text NOT NULL,
  offset_seconds double precision NOT NULL DEFAULT 0,
  drift_ppm double precision,
  residual_sigma_ms double precision NOT NULL CHECK (residual_sigma_ms>=0),
  estimation_method text NOT NULL,
  calibration_reference text,
  supersedes_clock_model_id uuid REFERENCES source_clock_model,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_key,model_version)
);

CREATE FUNCTION validate_clock_model_revision()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.supersedes_clock_model_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM source_clock_model prior
    WHERE prior.clock_model_id=NEW.supersedes_clock_model_id AND prior.source_key=NEW.source_key
  ) THEN
    RAISE EXCEPTION 'clock model may supersede only a model of the same source';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER source_clock_model_revision_validate
BEFORE INSERT OR UPDATE ON source_clock_model
FOR EACH ROW EXECUTE FUNCTION validate_clock_model_revision();

INSERT INTO data_scope(scope_key,operational_domain,description)
VALUES ('default','TEST','GOWM v1.1 compatibility scope')
ON CONFLICT DO NOTHING;

INSERT INTO analysis_space(analysis_space_key,canonical_srid,dimension_model,distance_model,transform_pipeline_version)
VALUES ('default',:ANALYSIS_SRID,'2D','PLANAR_METRE_V1','gowm-v1.2-default-proj')
ON CONFLICT DO NOTHING;

INSERT INTO processing_run(processing_run_id,processor_name,processor_version,config_hash,code_digest,deterministic,started_at,completed_at)
VALUES ('00000000-0000-0000-0000-000000000012','gowm-v1.1-migration-adapter','1.2.0','legacy-default','migration-009',true,clock_timestamp(),clock_timestamp())
ON CONFLICT DO NOTHING;

INSERT INTO source_registry(source_key,data_scope_key,source_type,default_analysis_space_key)
SELECT DISTINCT source,'default','LEGACY_GOWM_SOURCE','default' FROM world_observation
ON CONFLICT DO NOTHING;

INSERT INTO producer_pipeline(pipeline_key,source_key,pipeline_version,output_kind)
SELECT DISTINCT source||':legacy-adapter-v1.2',source,'1.2.0','CANONICAL_OBSERVATION'
FROM world_observation
ON CONFLICT DO NOTHING;

INSERT INTO datastream(datastream_key,source_key,data_scope_key,pipeline_key,schema_version)
SELECT DISTINCT source||':legacy-observations',source,'default',source||':legacy-adapter-v1.2','1.2'
FROM world_observation
ON CONFLICT DO NOTHING;

INSERT INTO source_clock_model(source_key,model_version,clock_domain,residual_sigma_ms,estimation_method)
SELECT DISTINCT source,'legacy-identity-v1','DECLARED_UTC',0,'LEGACY_DECLARED_UTC'
FROM world_observation
ON CONFLICT DO NOTHING;

ALTER TABLE world_object
  ADD COLUMN data_scope_key text;
UPDATE world_object SET data_scope_key='default' WHERE data_scope_key IS NULL;
ALTER TABLE world_object
  ALTER COLUMN data_scope_key SET DEFAULT 'default',
  ALTER COLUMN data_scope_key SET NOT NULL,
  ADD CONSTRAINT world_object_scope_fk FOREIGN KEY (data_scope_key) REFERENCES data_scope,
  ADD CONSTRAINT world_object_scope_identity_unique UNIQUE (data_scope_key,id);

-- world_observation remains the immutable event envelope. Measurement values,
-- corrected event time and uncertainty live in typed child tables below.
ALTER TABLE world_observation
  ADD COLUMN data_scope_key text,
  ADD COLUMN source_record_key text,
  ADD COLUMN source_revision_no integer,
  ADD COLUMN supersedes_observation_id text,
  ADD COLUMN origin_kind text,
  ADD COLUMN source_local_target_id text,
  ADD COLUMN tracker_session_id text,
  ADD COLUMN datastream_key text,
  ADD COLUMN producer_pipeline_key text,
  ADD COLUMN source_time_raw text,
  ADD COLUMN source_time_ticks numeric,
  ADD COLUMN source_time_value timestamptz,
  ADD COLUMN result_time timestamptz,
  ADD COLUMN source_emitted_time timestamptz,
  ADD COLUMN upstream_received_time timestamptz,
  ADD COLUMN source_processed_time timestamptz,
  ADD COLUMN raw_reference text,
  ADD COLUMN payload_hash text,
  ADD COLUMN quality_flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN entity_binding_status text NOT NULL DEFAULT 'DECLARED';

UPDATE world_observation
SET data_scope_key='default',
    source_record_key=observation_id,
    source_revision_no=1,
    origin_kind=CASE WHEN lower(source) LIKE '%sim%' THEN 'SIMULATION'
                     WHEN lower(source) LIKE '%operator%' OR lower(source) LIKE '%manual%' THEN 'MANUAL'
                     ELSE 'PHYSICAL_SENSOR' END,
    source_local_target_id=subject_id,
    datastream_key=source||':legacy-observations',
    producer_pipeline_key=source||':legacy-adapter-v1.2',
    upstream_received_time=received_at,
    raw_reference='inline://legacy/'||observation_id,
    payload_hash=encode(digest((to_jsonb(world_observation)-ARRAY['status','rejection_reason','projected_at','processing_time','created_at'])::text,'sha256'),'hex'),
    quality_flags=ARRAY['LEGACY_V1_1_ADAPTER']::text[]
WHERE data_scope_key IS NULL;

ALTER TABLE world_observation
  ALTER COLUMN data_scope_key SET NOT NULL,
  ALTER COLUMN source_record_key SET NOT NULL,
  ALTER COLUMN source_revision_no SET NOT NULL,
  ALTER COLUMN origin_kind SET NOT NULL,
  ALTER COLUMN source_local_target_id SET NOT NULL,
  ALTER COLUMN datastream_key SET NOT NULL,
  ALTER COLUMN producer_pipeline_key SET NOT NULL,
  ALTER COLUMN raw_reference SET NOT NULL,
  ALTER COLUMN payload_hash SET NOT NULL,
  ADD CONSTRAINT world_observation_scope_fk FOREIGN KEY (data_scope_key) REFERENCES data_scope,
  ADD CONSTRAINT world_observation_source_fk FOREIGN KEY (source) REFERENCES source_registry,
  ADD CONSTRAINT world_observation_datastream_fk FOREIGN KEY (datastream_key) REFERENCES datastream,
  ADD CONSTRAINT world_observation_pipeline_fk FOREIGN KEY (producer_pipeline_key) REFERENCES producer_pipeline,
  ADD CONSTRAINT world_observation_source_scope_fk
    FOREIGN KEY (source,data_scope_key) REFERENCES source_registry(source_key,data_scope_key),
  ADD CONSTRAINT world_observation_source_pipeline_fk
    FOREIGN KEY (source,producer_pipeline_key) REFERENCES producer_pipeline(source_key,pipeline_key),
  ADD CONSTRAINT world_observation_stream_owner_fk
    FOREIGN KEY (datastream_key,source,data_scope_key,producer_pipeline_key)
    REFERENCES datastream(datastream_key,source_key,data_scope_key,pipeline_key),
  ADD CONSTRAINT world_observation_supersedes_fk FOREIGN KEY (supersedes_observation_id) REFERENCES world_observation(observation_id),
  ADD CONSTRAINT world_observation_revision_positive CHECK (source_revision_no>0),
  ADD CONSTRAINT world_observation_origin_kind CHECK (origin_kind IN ('PHYSICAL_SENSOR','DERIVED_ALGORITHM','MANUAL','SIMULATION','EXTERNAL')),
  ADD CONSTRAINT world_observation_binding_status CHECK (entity_binding_status IN ('DECLARED','CANDIDATE','CONFIRMED'));

CREATE UNIQUE INDEX world_observation_source_revision_unique
  ON world_observation(source,source_record_key,source_revision_no);
CREATE UNIQUE INDEX world_observation_source_payload_unique
  ON world_observation(source,source_record_key,payload_hash);
CREATE UNIQUE INDEX world_observation_scope_source_identity_unique
  ON world_observation(data_scope_key,source,observation_id);
CREATE UNIQUE INDEX world_observation_source_record_identity_unique
  ON world_observation(source,source_record_key,observation_id);
CREATE INDEX world_observation_received_brin_idx ON world_observation USING brin(received_at);

CREATE TABLE world_observation_head (
  source_key text NOT NULL REFERENCES source_registry,
  source_record_key text NOT NULL,
  current_observation_id text NOT NULL REFERENCES world_observation,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_key,source_record_key),
  FOREIGN KEY (source_key,source_record_key,current_observation_id)
    REFERENCES world_observation(source,source_record_key,observation_id)
);

INSERT INTO world_observation_head(source_key,source_record_key,current_observation_id)
SELECT DISTINCT ON (source,source_record_key) source,source_record_key,observation_id
FROM world_observation ORDER BY source,source_record_key,source_revision_no DESC
ON CONFLICT DO NOTHING;

CREATE TABLE observation_time_solution (
  time_solution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id text NOT NULL REFERENCES world_observation,
  clock_model_id uuid NOT NULL REFERENCES source_clock_model,
  processing_run_id uuid NOT NULL REFERENCES processing_run,
  supersedes_time_solution_id uuid REFERENCES observation_time_solution,
  phenomenon_time_estimate timestamptz NOT NULL,
  phenomenon_time_window tstzspan NOT NULL,
  exposure_or_scan_duration interval,
  uncertainty_seconds double precision NOT NULL CHECK (uncertainty_seconds>=0),
  solution_method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (observation_id,clock_model_id,processing_run_id),
  UNIQUE (time_solution_id,observation_id),
  CHECK (lowerInc(phenomenon_time_window) AND NOT upperInc(phenomenon_time_window)),
  CHECK (lower(phenomenon_time_window)<=phenomenon_time_estimate AND phenomenon_time_estimate<upper(phenomenon_time_window)),
  CHECK (exposure_or_scan_duration IS NULL OR exposure_or_scan_duration>=interval '0')
);

CREATE TABLE measurement (
  measurement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id text NOT NULL REFERENCES world_observation,
  time_solution_id uuid NOT NULL REFERENCES observation_time_solution,
  processing_run_id uuid NOT NULL REFERENCES processing_run,
  measurement_key text NOT NULL,
  measurement_stage text NOT NULL CHECK (measurement_stage IN ('PARSED_NATIVE','NORMALIZED','FUSED_DERIVED')),
  observed_property text NOT NULL,
  result_kind text NOT NULL CHECK (result_kind IN ('POSITION','NUMERIC','VECTOR','GEOMETRY_SUPPORT')),
  scalar_value double precision,
  value_unit text,
  vector_value double precision[],
  source_geometry geometry,
  native_frame text,
  measurement_model text NOT NULL,
  measurement_model_version text NOT NULL,
  calibration_version text,
  algorithm_confidence double precision CHECK (algorithm_confidence IS NULL OR algorithm_confidence BETWEEN 0 AND 1),
  quality_score double precision CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 1),
  quality_flags text[] NOT NULL DEFAULT '{}',
  continuity_token text,
  manual_cut_before boolean NOT NULL DEFAULT false,
  attributes jsonb NOT NULL DEFAULT '{}',
  command_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (observation_id,time_solution_id,processing_run_id,measurement_key),
  UNIQUE (measurement_id,observation_id,time_solution_id),
  FOREIGN KEY (time_solution_id,observation_id)
    REFERENCES observation_time_solution(time_solution_id,observation_id),
  CHECK (source_geometry IS NULL OR (ST_SRID(source_geometry)=4326 AND ST_IsValid(source_geometry))),
  CHECK ((result_kind='NUMERIC' AND scalar_value IS NOT NULL AND vector_value IS NULL) OR
         (result_kind='VECTOR' AND vector_value IS NOT NULL AND scalar_value IS NULL) OR
         (result_kind IN ('POSITION','GEOMETRY_SUPPORT') AND scalar_value IS NULL AND vector_value IS NULL))
);

CREATE TABLE position_measurement (
  measurement_id uuid PRIMARY KEY REFERENCES measurement,
  analysis_space_key text NOT NULL REFERENCES analysis_space,
  source_position geometry(Point,4326) NOT NULL,
  position geometry(Point) NOT NULL,
  h3_r7 h3index NOT NULL,
  h3_r8 h3index NOT NULL,
  h3_r9 h3index NOT NULL,
  h3_r10 h3index NOT NULL,
  altitude_m double precision,
  vertical_datum text,
  cov_xx_m2 double precision,
  cov_xy_m2 double precision,
  cov_yy_m2 double precision,
  horizontal_stddev_m double precision CHECK (horizontal_stddev_m IS NULL OR horizontal_stddev_m>=0),
  accuracy_radius_m double precision CHECK (accuracy_radius_m IS NULL OR accuracy_radius_m>=0),
  accuracy_model text NOT NULL,
  accuracy_confidence double precision CHECK (accuracy_confidence IS NULL OR accuracy_confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((cov_xx_m2 IS NULL AND cov_xy_m2 IS NULL AND cov_yy_m2 IS NULL) OR
         (cov_xx_m2 IS NOT NULL AND cov_xy_m2 IS NOT NULL AND cov_yy_m2 IS NOT NULL AND
          cov_xx_m2>=0 AND cov_yy_m2>=0 AND cov_xx_m2*cov_yy_m2>=cov_xy_m2*cov_xy_m2)),
  CHECK ((accuracy_model='HARD_RADIUS' AND accuracy_radius_m IS NOT NULL AND horizontal_stddev_m IS NULL AND cov_xx_m2 IS NULL) OR
         (accuracy_model='STDDEV' AND horizontal_stddev_m IS NOT NULL AND accuracy_radius_m IS NULL AND cov_xx_m2 IS NULL) OR
         (accuracy_model='COVARIANCE' AND cov_xx_m2 IS NOT NULL AND accuracy_radius_m IS NULL AND horizontal_stddev_m IS NULL) OR
         (accuracy_model IN ('INTERVAL','UNKNOWN') AND accuracy_radius_m IS NULL AND horizontal_stddev_m IS NULL AND cov_xx_m2 IS NULL))
);

CREATE INDEX position_measurement_position_gist_idx ON position_measurement USING gist(position);
CREATE INDEX position_measurement_source_position_gist_idx ON position_measurement USING gist(source_position);
CREATE INDEX position_measurement_h3_r7_idx ON position_measurement(h3_r7);
CREATE INDEX position_measurement_h3_r9_idx ON position_measurement(h3_r9);

CREATE TABLE observation_assertion (
  assertion_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id text NOT NULL REFERENCES world_observation,
  time_solution_id uuid NOT NULL REFERENCES observation_time_solution,
  processing_run_id uuid NOT NULL REFERENCES processing_run,
  assertion_kind text NOT NULL,
  label text NOT NULL,
  probability double precision CHECK (probability IS NULL OR probability BETWEEN 0 AND 1),
  calibration_version text,
  basis_reference text NOT NULL,
  input_measurement_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (time_solution_id,observation_id)
    REFERENCES observation_time_solution(time_solution_id,observation_id)
);

CREATE FUNCTION validate_assertion_measurements()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE invalid_count integer;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM unnest(NEW.input_measurement_ids) input_id
  LEFT JOIN measurement m ON m.measurement_id=input_id
    AND m.observation_id=NEW.observation_id
    AND m.time_solution_id=NEW.time_solution_id
  WHERE m.measurement_id IS NULL;
  IF invalid_count>0 THEN
    RAISE EXCEPTION 'assertion input measurement must belong to the same observation/time solution';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER observation_assertion_input_validate
BEFORE INSERT OR UPDATE ON observation_assertion
FOR EACH ROW EXECUTE FUNCTION validate_assertion_measurements();

CREATE TABLE entity_binding (
  binding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope,
  source_key text NOT NULL REFERENCES source_registry,
  source_local_target_id text NOT NULL,
  tracker_session_key text NOT NULL,
  world_object_id text REFERENCES world_object,
  binding_status text NOT NULL CHECK (binding_status IN ('DECLARED','CANDIDATE','CONFIRMED','REJECTED')),
  method text NOT NULL,
  method_version text NOT NULL,
  evidence_observation_id text NOT NULL REFERENCES world_observation,
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  valid_time tstzrange,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_key,tracker_session_key,source_local_target_id,world_object_id,binding_status,evidence_observation_id),
  FOREIGN KEY (source_key,data_scope_key) REFERENCES source_registry(source_key,data_scope_key),
  FOREIGN KEY (data_scope_key,world_object_id) REFERENCES world_object(data_scope_key,id),
  FOREIGN KEY (data_scope_key,source_key,evidence_observation_id)
    REFERENCES world_observation(data_scope_key,source,observation_id)
);

INSERT INTO observation_time_solution(
  observation_id,clock_model_id,processing_run_id,phenomenon_time_estimate,
  phenomenon_time_window,uncertainty_seconds,solution_method
)
SELECT o.observation_id,c.clock_model_id,'00000000-0000-0000-0000-000000000012',o.observed_at,
       span(o.observed_at,o.observed_at+interval '1 millisecond',true,false),0,'LEGACY_DECLARED_UTC'
FROM world_observation o JOIN source_clock_model c ON c.source_key=o.source AND c.model_version='legacy-identity-v1'
ON CONFLICT DO NOTHING;

INSERT INTO measurement(
  observation_id,time_solution_id,processing_run_id,measurement_key,measurement_stage,
  observed_property,result_kind,source_geometry,measurement_model,measurement_model_version,
  algorithm_confidence,quality_flags,continuity_token,attributes,command_fingerprint
)
SELECT o.observation_id,t.time_solution_id,'00000000-0000-0000-0000-000000000012','legacy-primary','NORMALIZED',
       o.observation_type,CASE WHEN GeometryType(o.geometry)='POINT' THEN 'POSITION' ELSE 'GEOMETRY_SUPPORT' END,
       o.geometry,'GOWM_V1_1_COMPATIBILITY_ADAPTER','1.2.0',o.confidence,
       ARRAY['LEGACY_UNTYPED_VALUE'],
       NULL,o.value,
       encode(digest((o.observation_id||':'||o.payload_hash)::text,'sha256'),'hex')
FROM world_observation o JOIN observation_time_solution t ON t.observation_id=o.observation_id
ON CONFLICT DO NOTHING;

INSERT INTO position_measurement(
  measurement_id,analysis_space_key,source_position,position,h3_r7,h3_r8,h3_r9,h3_r10,altitude_m,accuracy_model
)
SELECT m.measurement_id,'default',ST_Force2D(o.geometry)::geometry(Point,4326),
       ST_Transform(ST_Force2D(o.geometry),:ANALYSIS_SRID)::geometry(Point),
       h3_latlng_to_cell(ST_Force2D(o.geometry),7),h3_latlng_to_cell(ST_Force2D(o.geometry),8),
       h3_latlng_to_cell(ST_Force2D(o.geometry),9),h3_latlng_to_cell(ST_Force2D(o.geometry),10),
       o.altitude,'UNKNOWN'
FROM measurement m JOIN world_observation o ON o.observation_id=m.observation_id
WHERE m.result_kind='POSITION'
ON CONFLICT DO NOTHING;

INSERT INTO entity_binding(data_scope_key,source_key,source_local_target_id,tracker_session_key,world_object_id,binding_status,method,method_version,evidence_observation_id,confidence)
SELECT o.data_scope_key,o.source,o.source_local_target_id,COALESCE(o.tracker_session_id,'__UNSCOPED__'),
       o.subject_id,'DECLARED','GOWM_DECLARED_SUBJECT','1.2.0',o.observation_id,o.confidence
FROM world_observation o JOIN world_object w ON w.id=o.subject_id
ON CONFLICT DO NOTHING;

CREATE FUNCTION validate_position_measurement()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  expected_srid integer;
  expected_kind text;
BEGIN
  SELECT canonical_srid INTO STRICT expected_srid FROM analysis_space WHERE analysis_space_key=NEW.analysis_space_key;
  SELECT result_kind INTO STRICT expected_kind FROM measurement WHERE measurement_id=NEW.measurement_id;
  IF expected_kind<>'POSITION' THEN
    RAISE EXCEPTION 'position_measurement requires measurement.result_kind=POSITION';
  END IF;
  IF ST_SRID(NEW.source_position)<>4326 OR ST_SRID(NEW.position)<>expected_srid THEN
    RAISE EXCEPTION 'position measurement CRS mismatch: source %, analysis %, expected %',
      ST_SRID(NEW.source_position),ST_SRID(NEW.position),expected_srid;
  END IF;
  IF ST_CoordDim(NEW.position)<>2 OR ST_IsEmpty(NEW.position) OR NOT ST_IsValid(NEW.position) THEN
    RAISE EXCEPTION 'canonical analysis position must be a valid non-empty 2D point';
  END IF;
  NEW.h3_r7 := h3_latlng_to_cell(NEW.source_position,7);
  NEW.h3_r8 := h3_latlng_to_cell(NEW.source_position,8);
  NEW.h3_r9 := h3_latlng_to_cell(NEW.source_position,9);
  NEW.h3_r10 := h3_latlng_to_cell(NEW.source_position,10);
  RETURN NEW;
END
$fn$;

CREATE TRIGGER position_measurement_validate_before_write
BEFORE INSERT OR UPDATE ON position_measurement
FOR EACH ROW EXECUTE FUNCTION validate_position_measurement();

CREATE FUNCTION assert_measurement_payload()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.result_kind='POSITION' AND NOT EXISTS (
    SELECT 1 FROM position_measurement WHERE measurement_id=NEW.measurement_id
  ) THEN
    RAISE EXCEPTION 'POSITION measurement requires one typed position_measurement payload';
  END IF;
  IF NEW.result_kind<>'POSITION' AND EXISTS (
    SELECT 1 FROM position_measurement WHERE measurement_id=NEW.measurement_id
  ) THEN
    RAISE EXCEPTION 'non-POSITION measurement cannot own a position payload';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE CONSTRAINT TRIGGER measurement_payload_validate_at_commit
AFTER INSERT OR UPDATE ON measurement DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_measurement_payload();

CREATE TABLE tracklet_rule_profile (
  profile_key text PRIMARY KEY,
  profile_version text NOT NULL,
  max_time_gap interval NOT NULL CHECK (max_time_gap>interval '0'),
  max_distance_gap_m double precision NOT NULL CHECK (max_distance_gap_m>0),
  max_required_speed_mps double precision NOT NULL CHECK (max_required_speed_mps>0),
  minimum_quality double precision NOT NULL CHECK (minimum_quality BETWEEN 0 AND 1),
  require_continuity_signal boolean NOT NULL,
  interpolation text NOT NULL CHECK (interpolation='LINEAR'),
  config_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO tracklet_rule_profile VALUES
  ('source-local-default','1.0',make_interval(secs=>:TRACKLET_MAX_TIME_GAP_MS/1000.0),
   :TRACKLET_MAX_DISTANCE_GAP_M,:TRACKLET_MAX_REQUIRED_SPEED_MPS,0,true,'LINEAR',
   encode(digest(concat_ws(':',:TRACKLET_MAX_TIME_GAP_MS,:TRACKLET_MAX_DISTANCE_GAP_M,
                           :TRACKLET_MAX_REQUIRED_SPEED_MPS,'q0','continuity-required','linear'),
                 'sha256'),'hex'),clock_timestamp());

CREATE TABLE mobility_tracklet (
  tracklet_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope,
  source_key text NOT NULL REFERENCES source_registry,
  source_local_target_id text NOT NULL,
  tracker_session_key text NOT NULL,
  world_object_id text REFERENCES world_object,
  object_class text,
  analysis_space_key text NOT NULL REFERENCES analysis_space,
  tracklet_scope text NOT NULL CHECK (tracklet_scope='SOURCE_LOCAL'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (data_scope_key,source_key,tracker_session_key,source_local_target_id,analysis_space_key),
  FOREIGN KEY (source_key,data_scope_key) REFERENCES source_registry(source_key,data_scope_key),
  FOREIGN KEY (data_scope_key,world_object_id) REFERENCES world_object(data_scope_key,id)
);

CREATE TABLE mobility_tracklet_version (
  tracklet_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracklet_id uuid NOT NULL REFERENCES mobility_tracklet,
  version_no integer NOT NULL CHECK (version_no>0),
  profile_key text NOT NULL REFERENCES tracklet_rule_profile,
  version_state text NOT NULL CHECK (version_state IN ('PROVISIONAL','SEALED','CONFLICTED')),
  trajectory tgeompoint(SequenceSet,Point) NOT NULL,
  extent_box stbox NOT NULL,
  start_event_time timestamptz NOT NULL,
  end_event_time timestamptz NOT NULL,
  start_position geometry(Point) NOT NULL,
  end_position geometry(Point) NOT NULL,
  max_accuracy_radius_m double precision,
  content_hash text NOT NULL,
  sample_count integer NOT NULL CHECK (sample_count>0),
  sequence_count integer NOT NULL CHECK (sequence_count>0),
  quality_score double precision CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tracklet_id,version_no),
  UNIQUE (tracklet_id,content_hash),
  UNIQUE (tracklet_version_id,tracklet_id),
  CHECK (end_event_time>=start_event_time)
);

CREATE INDEX mobility_tracklet_version_trajectory_gist_idx ON mobility_tracklet_version USING gist(trajectory);
CREATE INDEX mobility_tracklet_version_time_idx ON mobility_tracklet_version(start_event_time,end_event_time);
CREATE INDEX mobility_tracklet_version_start_position_gist_idx ON mobility_tracklet_version USING gist(start_position);
CREATE INDEX mobility_tracklet_version_end_position_gist_idx ON mobility_tracklet_version USING gist(end_position);

CREATE TABLE mobility_tracklet_segment (
  tracklet_version_id uuid NOT NULL REFERENCES mobility_tracklet_version,
  segment_no integer NOT NULL CHECK (segment_no>0),
  trajectory tgeompoint(Sequence,Point) NOT NULL,
  sample_count integer NOT NULL CHECK (sample_count>0),
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  PRIMARY KEY (tracklet_version_id,segment_no),
  CHECK (end_time>=start_time)
);

CREATE TABLE mobility_tracklet_gap (
  tracklet_version_id uuid NOT NULL REFERENCES mobility_tracklet_version,
  gap_no integer NOT NULL CHECK (gap_no>0),
  previous_segment_no integer NOT NULL,
  next_segment_no integer NOT NULL,
  gap_time tstzrange NOT NULL,
  primary_reason text NOT NULL,
  reason_codes text[] NOT NULL,
  observability_state text NOT NULL CHECK (observability_state IN ('UNKNOWN','BLIND_ZONE','SENSOR_OFFLINE','EXPECTED_OBSERVATION_MISSING')),
  left_measurement_id uuid REFERENCES position_measurement,
  right_measurement_id uuid REFERENCES position_measurement,
  PRIMARY KEY (tracklet_version_id,gap_no),
  CHECK (NOT isempty(gap_time) AND previous_segment_no+1=next_segment_no)
);

CREATE TABLE mobility_tracklet_input (
  tracklet_version_id uuid NOT NULL REFERENCES mobility_tracklet_version,
  measurement_id uuid NOT NULL REFERENCES position_measurement,
  observation_id text NOT NULL REFERENCES world_observation,
  time_solution_id uuid NOT NULL REFERENCES observation_time_solution,
  segment_no integer NOT NULL,
  ordinal_no integer NOT NULL,
  PRIMARY KEY (tracklet_version_id,measurement_id),
  UNIQUE (tracklet_version_id,segment_no,ordinal_no),
  FOREIGN KEY (measurement_id,observation_id,time_solution_id)
    REFERENCES measurement(measurement_id,observation_id,time_solution_id)
);

CREATE TABLE mobility_tracklet_lineage (
  parent_version_id uuid NOT NULL REFERENCES mobility_tracklet_version,
  child_version_id uuid NOT NULL REFERENCES mobility_tracklet_version,
  lineage_type text NOT NULL CHECK (lineage_type IN ('SUPERSEDES','LATE_DATA','CLOCK_CORRECTION','RULE_CHANGE','MANUAL_REVISION')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (parent_version_id,child_version_id,lineage_type),
  CHECK (parent_version_id<>child_version_id)
);

CREATE FUNCTION validate_tracklet_lineage()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE parent_tracklet uuid;
  child_tracklet uuid;
BEGIN
  SELECT tracklet_id INTO STRICT parent_tracklet FROM mobility_tracklet_version
  WHERE tracklet_version_id=NEW.parent_version_id;
  SELECT tracklet_id INTO STRICT child_tracklet FROM mobility_tracklet_version
  WHERE tracklet_version_id=NEW.child_version_id;
  IF parent_tracklet<>child_tracklet THEN
    RAISE EXCEPTION 'tracklet lineage cannot cross logical tracklets';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER mobility_tracklet_lineage_validate
BEFORE INSERT OR UPDATE ON mobility_tracklet_lineage
FOR EACH ROW EXECUTE FUNCTION validate_tracklet_lineage();

CREATE TABLE mobility_tracklet_head (
  tracklet_id uuid PRIMARY KEY REFERENCES mobility_tracklet,
  current_version_id uuid NOT NULL REFERENCES mobility_tracklet_version,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (current_version_id,tracklet_id)
    REFERENCES mobility_tracklet_version(tracklet_version_id,tracklet_id)
);

CREATE FUNCTION gowm_tracklet_candidates(
  p_scope text,p_source text,p_target text,p_tracker_session text,p_space text,p_profile text
)
RETURNS TABLE(
  measurement_id uuid,observation_id text,time_solution_id uuid,event_time timestamptz,
  analysis_position geometry,accuracy_model text,accuracy_radius_m double precision,quality_score double precision,
  segment_no integer,ordinal_no integer,previous_measurement_id uuid,edge_decision text,
  edge_reason_codes text[],delta_t_seconds double precision,nominal_distance_m double precision,
  minimum_required_speed_mps double precision
)
LANGUAGE sql STABLE AS $fn$
WITH profile AS (
  SELECT * FROM tracklet_rule_profile WHERE profile_key=p_profile
), ranked AS (
  SELECT m.measurement_id,m.observation_id,m.time_solution_id,ts.phenomenon_time_estimate AS event_time,
         pm.position AS analysis_position,pm.accuracy_model,pm.accuracy_radius_m,m.quality_score,m.continuity_token,m.manual_cut_before,
         row_number() OVER (PARTITION BY ts.phenomenon_time_estimate ORDER BY m.quality_score DESC NULLS LAST,m.measurement_id) AS time_rank
  FROM measurement m
  JOIN position_measurement pm ON pm.measurement_id=m.measurement_id
  JOIN observation_time_solution ts ON ts.time_solution_id=m.time_solution_id
  JOIN world_observation o ON o.observation_id=m.observation_id
  JOIN world_observation_head h ON h.current_observation_id=o.observation_id
  WHERE o.data_scope_key=p_scope AND o.source=p_source AND o.source_local_target_id=p_target
    AND COALESCE(o.tracker_session_id,'__UNSCOPED__')=p_tracker_session
    AND pm.analysis_space_key=p_space
), accepted AS (
  SELECT * FROM ranked WHERE time_rank=1
), ordered AS (
  SELECT a.*,
         row_number() OVER (ORDER BY event_time,measurement_id) AS row_no,
         lag(measurement_id) OVER (ORDER BY event_time,measurement_id) AS previous_id,
         lag(event_time) OVER (ORDER BY event_time,measurement_id) AS previous_time,
         lag(analysis_position) OVER (ORDER BY event_time,measurement_id) AS previous_position,
         lag(continuity_token) OVER (ORDER BY event_time,measurement_id) AS previous_token
  FROM accepted a CROSS JOIN profile p
  WHERE COALESCE(a.quality_score,1)>=p.minimum_quality
), metrics AS (
  SELECT o.*,p.*,
         extract(epoch FROM event_time-previous_time) AS dt,
         CASE WHEN previous_position IS NULL THEN NULL ELSE ST_Distance(previous_position,analysis_position) END AS distance_m
  FROM ordered o CROSS JOIN profile p
), decisions AS (
  SELECT m.*,
    (row_no=1 OR manual_cut_before OR
     (require_continuity_signal AND (continuity_token IS NULL OR previous_token IS NULL OR continuity_token<>previous_token)) OR
     dt>extract(epoch FROM max_time_gap) OR distance_m>max_distance_gap_m OR
     distance_m/NULLIF(dt,0)>max_required_speed_mps) AS cut_before,
    CASE WHEN row_no=1 THEN ARRAY['START']::text[] ELSE array_remove(ARRAY[
      CASE WHEN manual_cut_before THEN 'MANUAL_CUT' END,
      CASE WHEN require_continuity_signal AND (continuity_token IS NULL OR previous_token IS NULL)
           THEN 'MISSING_CONTINUITY_SIGNAL' END,
      CASE WHEN require_continuity_signal AND previous_token IS NOT NULL AND continuity_token<>previous_token THEN 'CONTINUITY_CHANGED' END,
      CASE WHEN dt>extract(epoch FROM max_time_gap) THEN 'MAX_TIME_GAP' END,
      CASE WHEN distance_m>max_distance_gap_m THEN 'MAX_DISTANCE_GAP' END,
      CASE WHEN distance_m/NULLIF(dt,0)>max_required_speed_mps THEN 'MAX_REQUIRED_SPEED' END
    ]::text[],NULL) END AS reasons
  FROM metrics m
), grouped AS (
  SELECT d.*,sum(cut_before::integer) OVER (ORDER BY event_time,measurement_id)::integer AS group_no
  FROM decisions d
), numbered AS (
  SELECT g.*,row_number() OVER (PARTITION BY group_no ORDER BY event_time,measurement_id)::integer AS point_no
  FROM grouped g
)
SELECT measurement_id,observation_id,time_solution_id,event_time,analysis_position,accuracy_model,accuracy_radius_m,quality_score,
       group_no,point_no,previous_id,CASE WHEN cut_before THEN 'CUT' ELSE 'CONNECT' END,reasons,dt,distance_m,
       distance_m/NULLIF(dt,0)
FROM numbered ORDER BY event_time,measurement_id
$fn$;

CREATE FUNCTION gowm_rebuild_mobility_tracklet(
  p_scope text,p_source text,p_target text,p_tracker_session text,p_space text,
  p_profile text DEFAULT 'source-local-default'
)
RETURNS uuid LANGUAGE plpgsql AS $fn$
DECLARE
  target_tracklet uuid;
  old_head uuid;
  new_version uuid := gen_random_uuid();
  next_version integer;
  temporal_value tgeompoint;
  first_point record;
  last_point record;
  total_samples integer;
  total_sequences integer;
  average_quality double precision;
  maximum_radius double precision;
  all_hard_radius boolean;
  value_hash text;
  bound_object text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(E'\x1f',p_scope,p_source,p_tracker_session,p_target,p_space),0));

  SELECT eb.world_object_id INTO bound_object FROM entity_binding eb
  WHERE eb.data_scope_key=p_scope AND eb.source_key=p_source AND eb.source_local_target_id=p_target
    AND eb.tracker_session_key=p_tracker_session
    AND eb.binding_status IN ('DECLARED','CONFIRMED')
  ORDER BY eb.created_at DESC LIMIT 1;

  INSERT INTO mobility_tracklet(data_scope_key,source_key,source_local_target_id,tracker_session_key,world_object_id,object_class,analysis_space_key,tracklet_scope)
  SELECT p_scope,p_source,p_target,p_tracker_session,bound_object,o.subject_type,p_space,'SOURCE_LOCAL'
  FROM world_observation o
  WHERE o.data_scope_key=p_scope AND o.source=p_source AND o.source_local_target_id=p_target
    AND COALESCE(o.tracker_session_id,'__UNSCOPED__')=p_tracker_session
  ORDER BY o.received_at LIMIT 1
  ON CONFLICT (data_scope_key,source_key,tracker_session_key,source_local_target_id,analysis_space_key)
  DO UPDATE SET world_object_id=COALESCE(EXCLUDED.world_object_id,mobility_tracklet.world_object_id)
  RETURNING tracklet_id INTO target_tracklet;

  WITH seqs AS (
    SELECT segment_no,tgeompointSeq(array_agg(tgeompoint(analysis_position,event_time) ORDER BY ordinal_no),'linear') AS seq
    FROM gowm_tracklet_candidates(p_scope,p_source,p_target,p_tracker_session,p_space,p_profile)
    GROUP BY segment_no
  )
  SELECT tgeompointSeqSet(array_agg(seq ORDER BY segment_no)) INTO temporal_value FROM seqs;
  IF temporal_value IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO STRICT first_point FROM gowm_tracklet_candidates(p_scope,p_source,p_target,p_tracker_session,p_space,p_profile)
    ORDER BY segment_no,ordinal_no LIMIT 1;
  SELECT * INTO STRICT last_point FROM gowm_tracklet_candidates(p_scope,p_source,p_target,p_tracker_session,p_space,p_profile)
    ORDER BY segment_no DESC,ordinal_no DESC LIMIT 1;
  SELECT count(*),count(DISTINCT segment_no),avg(quality_score),max(accuracy_radius_m),bool_and(accuracy_model='HARD_RADIUS')
    INTO total_samples,total_sequences,average_quality,maximum_radius,all_hard_radius
  FROM gowm_tracklet_candidates(p_scope,p_source,p_target,p_tracker_session,p_space,p_profile);
  SELECT encode(digest(string_agg(concat_ws(':',measurement_id,time_solution_id,segment_no,ordinal_no,edge_decision,
                                     array_to_string(edge_reason_codes,',')),'|' ORDER BY event_time,measurement_id)||
                              ':'||r.config_hash||':LINEAR','sha256'),'hex')
    INTO value_hash
  FROM gowm_tracklet_candidates(p_scope,p_source,p_target,p_tracker_session,p_space,p_profile) c
  CROSS JOIN tracklet_rule_profile r WHERE r.profile_key=p_profile
  GROUP BY r.config_hash;

  SELECT tracklet_version_id INTO old_head FROM mobility_tracklet_version
  WHERE tracklet_id=target_tracklet AND content_hash=value_hash;
  IF FOUND THEN RETURN old_head; END IF;

  SELECT current_version_id INTO old_head FROM mobility_tracklet_head WHERE tracklet_id=target_tracklet FOR UPDATE;
  SELECT COALESCE(max(version_no),0)+1 INTO next_version FROM mobility_tracklet_version WHERE tracklet_id=target_tracklet;

  INSERT INTO mobility_tracklet_version(
    tracklet_version_id,tracklet_id,version_no,profile_key,version_state,trajectory,extent_box,
    start_event_time,end_event_time,start_position,end_position,max_accuracy_radius_m,
    content_hash,sample_count,sequence_count,quality_score
  ) VALUES (
    new_version,target_tracklet,next_version,p_profile,'PROVISIONAL',temporal_value,stbox(temporal_value),
    first_point.event_time,last_point.event_time,first_point.analysis_position,last_point.analysis_position,
    CASE WHEN all_hard_radius THEN maximum_radius END,value_hash,total_samples,total_sequences,average_quality
  );

  INSERT INTO mobility_tracklet_segment(tracklet_version_id,segment_no,trajectory,sample_count,start_time,end_time)
  SELECT new_version,segment_no,tgeompointSeq(array_agg(tgeompoint(analysis_position,event_time) ORDER BY ordinal_no),'linear'),
         count(*),min(event_time),max(event_time)
  FROM gowm_tracklet_candidates(p_scope,p_source,p_target,p_tracker_session,p_space,p_profile)
  GROUP BY segment_no;

  INSERT INTO mobility_tracklet_input(tracklet_version_id,measurement_id,observation_id,time_solution_id,segment_no,ordinal_no)
  SELECT new_version,measurement_id,observation_id,time_solution_id,segment_no,ordinal_no
  FROM gowm_tracklet_candidates(p_scope,p_source,p_target,p_tracker_session,p_space,p_profile);

  WITH starts AS (
    SELECT * FROM gowm_tracklet_candidates(p_scope,p_source,p_target,p_tracker_session,p_space,p_profile)
    WHERE ordinal_no=1 AND segment_no>1
  ), ends AS (
    SELECT DISTINCT ON (segment_no) *
    FROM gowm_tracklet_candidates(p_scope,p_source,p_target,p_tracker_session,p_space,p_profile)
    ORDER BY segment_no,ordinal_no DESC
  )
  INSERT INTO mobility_tracklet_gap(
    tracklet_version_id,gap_no,previous_segment_no,next_segment_no,gap_time,primary_reason,
    reason_codes,observability_state,left_measurement_id,right_measurement_id
  )
  SELECT new_version,s.segment_no-1,s.segment_no-1,s.segment_no,tstzrange(e.event_time,s.event_time,'()'),
         COALESCE(s.edge_reason_codes[1],'UNKNOWN_GAP'),
         CASE WHEN cardinality(s.edge_reason_codes)=0 THEN ARRAY['UNKNOWN_GAP'] ELSE s.edge_reason_codes END,
         'UNKNOWN',e.measurement_id,s.measurement_id
  FROM starts s JOIN ends e ON e.segment_no=s.segment_no-1;

  IF old_head IS NOT NULL THEN
    INSERT INTO mobility_tracklet_lineage(parent_version_id,child_version_id,lineage_type,reason)
    VALUES (old_head,new_version,'SUPERSEDES','Deterministic rebuild after canonical evidence append');
  END IF;
  INSERT INTO mobility_tracklet_head(tracklet_id,current_version_id)
  VALUES (target_tracklet,new_version)
  ON CONFLICT (tracklet_id) DO UPDATE SET current_version_id=EXCLUDED.current_version_id,updated_at=clock_timestamp();
  RETURN new_version;
END
$fn$;

-- Build immutable temporal projections for any rows migrated from v1.1.
DO $rebuild_legacy$
DECLARE candidate record;
BEGIN
  FOR candidate IN
    SELECT DISTINCT data_scope_key,source,source_local_target_id,
           COALESCE(tracker_session_id,'__UNSCOPED__') AS tracker_session_key,
           'default'::text AS analysis_space_key
    FROM world_observation o WHERE EXISTS (
      SELECT 1 FROM measurement m JOIN position_measurement pm ON pm.measurement_id=m.measurement_id
      WHERE m.observation_id=o.observation_id
    )
  LOOP
    PERFORM gowm_rebuild_mobility_tracklet(candidate.data_scope_key,candidate.source,
                                            candidate.source_local_target_id,candidate.tracker_session_key,
                                            candidate.analysis_space_key);
  END LOOP;
END
$rebuild_legacy$;

-- Retain old bytes only as a migration audit artifact. The public name becomes
-- a compatibility read view over canonical measurements; no writer may insert
-- raw trajectory points after v1.2.
ALTER TABLE trajectory_point RENAME TO trajectory_point_v11_archive;

CREATE VIEW trajectory_point AS
SELECT o.subject_id AS entity_id,ts.phenomenon_time_estimate AS observed_at,o.observation_id,
       pm.source_position AS geometry,ST_Y(pm.source_position) AS latitude,ST_X(pm.source_position) AS longitude,
       pm.altitude_m AS altitude,
       CASE WHEN (m.attributes->>'heading') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (m.attributes->>'heading')::double precision END AS heading,
       CASE WHEN (m.attributes->>'speed') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (m.attributes->>'speed')::double precision END AS speed,
       m.attributes AS state,o.source,COALESCE(m.algorithm_confidence,o.confidence) AS confidence,
       pm.h3_r7,pm.h3_r8,pm.h3_r9,pm.h3_r10,
       m.measurement_id,ts.time_solution_id,pm.accuracy_model,pm.accuracy_radius_m,pm.horizontal_stddev_m
FROM world_observation o
JOIN world_observation_head h ON h.current_observation_id=o.observation_id
JOIN observation_time_solution ts ON ts.observation_id=o.observation_id
JOIN measurement m ON m.observation_id=o.observation_id AND m.time_solution_id=ts.time_solution_id
JOIN position_measurement pm ON pm.measurement_id=m.measurement_id;

CREATE VIEW mobility_trajectory_current AS
SELECT t.tracklet_id,t.data_scope_key,t.source_key,t.source_local_target_id,t.tracker_session_key,
       t.world_object_id,t.analysis_space_key,
       v.tracklet_version_id,v.version_no,v.version_state,v.start_event_time,v.end_event_time,
       v.sample_count,v.sequence_count,v.quality_score,v.max_accuracy_radius_m,
       asMFJSON(v.trajectory)::jsonb AS trajectory_json,getTime(v.trajectory) AS defined_time
FROM mobility_tracklet t
JOIN mobility_tracklet_head h ON h.tracklet_id=t.tracklet_id
JOIN mobility_tracklet_version v ON v.tracklet_version_id=h.current_version_id;

-- Stable, read-only database contracts for the STAS application layer. They
-- expose frozen evidence IDs and typed values without granting ownership of
-- GOWM tables. A separately deployed STAS may consume equivalent API/outbox
-- payloads when it does not share this PostgreSQL database.
CREATE VIEW gowm_stas_position_observation_v1 AS
SELECT o.data_scope_key,o.observation_id,o.source,o.source_record_key,o.source_revision_no,
       o.supersedes_observation_id,o.source_local_target_id,o.tracker_session_id,
       o.datastream_key,o.producer_pipeline_key,o.origin_kind,o.raw_reference,o.payload_hash,
       o.received_at,o.source_time_value,o.source_time_raw,o.source_time_ticks,
       o.result_time,o.source_emitted_time,o.upstream_received_time,o.source_processed_time,
       ts.time_solution_id,ts.clock_model_id,ts.processing_run_id,ts.supersedes_time_solution_id,
       ts.phenomenon_time_estimate,ts.phenomenon_time_window,ts.uncertainty_seconds,ts.solution_method,
       m.measurement_id,m.measurement_key,m.measurement_stage,m.observed_property,
       m.measurement_model,m.measurement_model_version,m.calibration_version,
       m.algorithm_confidence,m.quality_score,m.quality_flags,m.continuity_token,m.manual_cut_before,
       pm.analysis_space_key,pm.source_position,pm.position,pm.altitude_m,pm.vertical_datum,
       pm.accuracy_model,pm.accuracy_radius_m,pm.horizontal_stddev_m,
       pm.cov_xx_m2,pm.cov_xy_m2,pm.cov_yy_m2,pm.accuracy_confidence
FROM world_observation o
JOIN world_observation_head h ON h.current_observation_id=o.observation_id
JOIN observation_time_solution ts ON ts.observation_id=o.observation_id
JOIN measurement m ON m.observation_id=o.observation_id AND m.time_solution_id=ts.time_solution_id
JOIN position_measurement pm ON pm.measurement_id=m.measurement_id;

CREATE VIEW gowm_stas_tracklet_version_v1 AS
SELECT t.tracklet_id,t.data_scope_key,t.source_key,t.source_local_target_id,t.tracker_session_key,
       t.world_object_id,t.object_class,t.analysis_space_key,t.tracklet_scope,
       v.tracklet_version_id,v.version_no,v.profile_key,v.version_state,v.trajectory,v.extent_box,
       v.start_event_time,v.end_event_time,v.start_position,v.end_position,
       v.max_accuracy_radius_m,v.content_hash,v.sample_count,v.sequence_count,v.quality_score,v.created_at,
       (h.current_version_id=v.tracklet_version_id) AS is_current
FROM mobility_tracklet t
JOIN mobility_tracklet_version v ON v.tracklet_id=t.tracklet_id
LEFT JOIN mobility_tracklet_head h ON h.tracklet_id=t.tracklet_id;

ALTER TABLE world_object_state
  ADD COLUMN time_solution_id uuid REFERENCES observation_time_solution,
  ADD COLUMN position_measurement_id uuid REFERENCES position_measurement,
  ADD COLUMN projection_policy_version text NOT NULL DEFAULT 'gowm-projection-v1.1',
  ADD COLUMN uncertainty_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN evidence_kind text NOT NULL DEFAULT 'DECLARED';

DROP VIEW world_object_current;
CREATE VIEW world_object_current AS
SELECT o.id,o.data_scope_key,o.object_type,o.subtype,o.properties,s.state,s.confidence,
       s.observed_at,s.received_at,s.source,s.source_observation_id,s.time_solution_id,
       s.position_measurement_id,s.projection_policy_version,s.uncertainty_summary,s.evidence_kind,
       s.version,s.updated_at,g.geometry,g.h3_r7,g.h3_r8,g.h3_r9,g.h3_r10
FROM world_object o
JOIN world_object_state s ON s.object_id=o.id
LEFT JOIN world_object_geometry g ON g.object_id=o.id
WHERE o.deleted_at IS NULL;

CREATE TABLE analysis_record (
  analysis_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope,
  service_name text NOT NULL,
  tool_name text NOT NULL,
  tool_version text NOT NULL,
  algorithm text NOT NULL,
  algorithm_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('COMPLETE','PARTIAL','NO_DATA','INDETERMINATE','TOO_MANY_CANDIDATES','FAILED')),
  analysis_as_of timestamptz NOT NULL,
  query_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  method_snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  supersedes_analysis_id uuid REFERENCES analysis_record,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX analysis_record_scope_tool_idx
  ON analysis_record(data_scope_key,tool_name,analysis_as_of DESC,analysis_id);
CREATE INDEX analysis_record_snapshot_idx
  ON analysis_record(data_scope_key,tool_name,tool_version,snapshot_hash);

CREATE TABLE analysis_tracklet_input (
  analysis_id uuid NOT NULL REFERENCES analysis_record,
  tracklet_version_id uuid NOT NULL REFERENCES mobility_tracklet_version,
  input_role text NOT NULL,
  PRIMARY KEY (analysis_id,tracklet_version_id,input_role)
);

CREATE TABLE analysis_time_solution_input (
  analysis_id uuid NOT NULL REFERENCES analysis_record,
  time_solution_id uuid NOT NULL REFERENCES observation_time_solution,
  input_role text NOT NULL,
  PRIMARY KEY (analysis_id,time_solution_id,input_role)
);

CREATE TABLE analysis_evidence_reference (
  analysis_id uuid NOT NULL REFERENCES analysis_record,
  evidence_no integer NOT NULL CHECK (evidence_no>0),
  evidence_type text NOT NULL,
  observation_id text REFERENCES world_observation,
  measurement_id uuid REFERENCES measurement,
  tracklet_version_id uuid REFERENCES mobility_tracklet_version,
  evidence_time tstzrange,
  summary_hash text NOT NULL,
  PRIMARY KEY (analysis_id,evidence_no),
  CHECK (num_nonnulls(observation_id,measurement_id,tracklet_version_id)>=1)
);

CREATE FUNCTION validate_analysis_scope()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE expected_scope text;
  actual_scope text;
BEGIN
  SELECT data_scope_key INTO STRICT expected_scope FROM analysis_record WHERE analysis_id=NEW.analysis_id;
  IF TG_TABLE_NAME='analysis_tracklet_input' THEN
    SELECT t.data_scope_key INTO STRICT actual_scope
    FROM mobility_tracklet_version v JOIN mobility_tracklet t ON t.tracklet_id=v.tracklet_id
    WHERE v.tracklet_version_id=NEW.tracklet_version_id;
  ELSIF TG_TABLE_NAME='analysis_time_solution_input' THEN
    SELECT o.data_scope_key INTO STRICT actual_scope
    FROM observation_time_solution ts JOIN world_observation o ON o.observation_id=ts.observation_id
    WHERE ts.time_solution_id=NEW.time_solution_id;
  ELSE
    IF NEW.observation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM world_observation WHERE observation_id=NEW.observation_id AND data_scope_key=expected_scope
    ) THEN RAISE EXCEPTION 'analysis observation evidence crosses data scope'; END IF;
    IF NEW.measurement_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM measurement m JOIN world_observation o ON o.observation_id=m.observation_id
      WHERE m.measurement_id=NEW.measurement_id AND o.data_scope_key=expected_scope
    ) THEN RAISE EXCEPTION 'analysis measurement evidence crosses data scope'; END IF;
    IF NEW.tracklet_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM mobility_tracklet_version v JOIN mobility_tracklet t ON t.tracklet_id=v.tracklet_id
      WHERE v.tracklet_version_id=NEW.tracklet_version_id AND t.data_scope_key=expected_scope
    ) THEN RAISE EXCEPTION 'analysis tracklet evidence crosses data scope'; END IF;
    RETURN NEW;
  END IF;
  IF actual_scope IS DISTINCT FROM expected_scope THEN
    RAISE EXCEPTION 'analysis input/evidence crosses data scope';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION validate_analysis_record_revision()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.supersedes_analysis_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM analysis_record prior
    WHERE prior.analysis_id=NEW.supersedes_analysis_id AND prior.data_scope_key=NEW.data_scope_key
  ) THEN
    RAISE EXCEPTION 'analysis result may supersede only a result in the same data scope';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER analysis_record_revision_validate
BEFORE INSERT OR UPDATE ON analysis_record
FOR EACH ROW EXECUTE FUNCTION validate_analysis_record_revision();

CREATE TRIGGER analysis_tracklet_scope_validate BEFORE INSERT OR UPDATE ON analysis_tracklet_input
FOR EACH ROW EXECUTE FUNCTION validate_analysis_scope();
CREATE TRIGGER analysis_time_scope_validate BEFORE INSERT OR UPDATE ON analysis_time_solution_input
FOR EACH ROW EXECUTE FUNCTION validate_analysis_scope();
CREATE TRIGGER analysis_evidence_scope_validate BEFORE INSERT OR UPDATE ON analysis_evidence_reference
FOR EACH ROW EXECUTE FUNCTION validate_analysis_scope();

CREATE FUNCTION validate_observation_revision()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE prior world_observation%ROWTYPE;
BEGIN
  IF NEW.source_revision_no>1 AND NEW.supersedes_observation_id IS NULL THEN
    RAISE EXCEPTION 'source revision >1 must explicitly supersede an earlier observation';
  END IF;
  IF NEW.supersedes_observation_id IS NOT NULL THEN
    SELECT * INTO prior FROM world_observation WHERE observation_id=NEW.supersedes_observation_id;
    IF NOT FOUND OR prior.source IS DISTINCT FROM NEW.source OR
       prior.source_record_key IS DISTINCT FROM NEW.source_record_key OR
       prior.data_scope_key IS DISTINCT FROM NEW.data_scope_key OR
       prior.source_revision_no>=NEW.source_revision_no THEN
      RAISE EXCEPTION 'superseded observation must be an earlier revision of the same scope/source/record';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER world_observation_revision_validate
BEFORE INSERT ON world_observation
FOR EACH ROW EXECUTE FUNCTION validate_observation_revision();

CREATE FUNCTION validate_time_solution_revision()
RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE prior_observation text;
  superseded_observation text;
BEGIN
  IF NEW.supersedes_time_solution_id IS NOT NULL THEN
    SELECT observation_id INTO prior_observation FROM observation_time_solution
    WHERE time_solution_id=NEW.supersedes_time_solution_id;
    SELECT supersedes_observation_id INTO superseded_observation
    FROM world_observation WHERE observation_id=NEW.observation_id;
    IF prior_observation IS DISTINCT FROM NEW.observation_id AND
       prior_observation IS DISTINCT FROM superseded_observation THEN
      RAISE EXCEPTION 'time solution may supersede only the same event or its explicit observation predecessor';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER observation_time_solution_revision_validate
BEFORE INSERT ON observation_time_solution
FOR EACH ROW EXECUTE FUNCTION validate_time_solution_revision();

-- Append-only canonical evidence and temporal versions. Corrections create new
-- observation/time/tracklet versions; operational projection status is the
-- only mutable part of the event envelope.
CREATE FUNCTION protect_world_observation_evidence()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'world_observation is append-only'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','rejection_reason','projected_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','rejection_reason','projected_at']) THEN
    RAISE EXCEPTION 'canonical observation evidence is immutable; publish a new revision';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER world_observation_evidence_immutable
BEFORE UPDATE OR DELETE ON world_observation
FOR EACH ROW EXECUTE FUNCTION protect_world_observation_evidence();

CREATE FUNCTION reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only',TG_TABLE_NAME;
END
$fn$;

CREATE TRIGGER observation_time_solution_immutable BEFORE UPDATE OR DELETE ON observation_time_solution FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER measurement_immutable BEFORE UPDATE OR DELETE ON measurement FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER position_measurement_immutable BEFORE UPDATE OR DELETE ON position_measurement FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER observation_assertion_immutable BEFORE UPDATE OR DELETE ON observation_assertion FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER mobility_tracklet_version_immutable BEFORE UPDATE OR DELETE ON mobility_tracklet_version FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER mobility_tracklet_segment_immutable BEFORE UPDATE OR DELETE ON mobility_tracklet_segment FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER mobility_tracklet_gap_immutable BEFORE UPDATE OR DELETE ON mobility_tracklet_gap FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER mobility_tracklet_input_immutable BEFORE UPDATE OR DELETE ON mobility_tracklet_input FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER analysis_space_immutable BEFORE UPDATE OR DELETE ON analysis_space FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER source_clock_model_immutable BEFORE UPDATE OR DELETE ON source_clock_model FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER processing_run_immutable BEFORE UPDATE OR DELETE ON processing_run FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER producer_pipeline_immutable BEFORE UPDATE OR DELETE ON producer_pipeline FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER datastream_immutable BEFORE UPDATE OR DELETE ON datastream FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER tracklet_rule_profile_immutable BEFORE UPDATE OR DELETE ON tracklet_rule_profile FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER analysis_record_immutable BEFORE UPDATE OR DELETE ON analysis_record FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER analysis_tracklet_input_immutable BEFORE UPDATE OR DELETE ON analysis_tracklet_input FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER analysis_time_solution_input_immutable BEFORE UPDATE OR DELETE ON analysis_time_solution_input FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER analysis_evidence_reference_immutable BEFORE UPDATE OR DELETE ON analysis_evidence_reference FOR EACH ROW EXECUTE FUNCTION reject_mutation();

COMMIT;
