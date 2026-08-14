BEGIN;

-- Stable UUIDs preserve STAS v1's public contract without creating duplicate
-- facts. Text keys remain the GOWM authority and upgrade-compatible identity.
ALTER TABLE data_scope ADD COLUMN data_scope_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE data_scope ADD CONSTRAINT data_scope_id_unique UNIQUE (data_scope_id);
ALTER TABLE analysis_space ADD COLUMN analysis_space_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE analysis_space ADD CONSTRAINT analysis_space_id_unique UNIQUE (analysis_space_id);
ALTER TABLE source_registry ADD COLUMN source_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE source_registry ADD CONSTRAINT source_registry_id_unique UNIQUE (source_id);
ALTER TABLE producer_pipeline ADD COLUMN producer_pipeline_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE producer_pipeline ADD CONSTRAINT producer_pipeline_id_unique UNIQUE (producer_pipeline_id);
ALTER TABLE datastream ADD COLUMN datastream_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE datastream ADD CONSTRAINT datastream_id_unique UNIQUE (datastream_id);
ALTER TABLE tracklet_rule_profile ADD COLUMN rule_profile_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE tracklet_rule_profile ADD CONSTRAINT tracklet_rule_profile_id_unique UNIQUE (rule_profile_id);

CREATE INDEX mobility_tracklet_scope_space_idx
  ON mobility_tracklet(data_scope_key,analysis_space_key,tracklet_id);

CREATE TABLE measurement_relation (
  left_measurement_id uuid NOT NULL REFERENCES measurement,
  right_measurement_id uuid NOT NULL REFERENCES measurement,
  relation_type text NOT NULL CHECK (relation_type IN ('DUPLICATE_OF','SUPERSEDES','CONFLICTS_WITH','DERIVED_FROM')),
  processing_run_id uuid NOT NULL REFERENCES processing_run,
  metrics jsonb NOT NULL DEFAULT '{}',
  reason_codes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (left_measurement_id,right_measurement_id,relation_type,processing_run_id),
  CHECK (left_measurement_id<>right_measurement_id)
);

CREATE TABLE source_reliability_profile (
  source_reliability_profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL REFERENCES source_registry,
  valid_time tstzrange NOT NULL,
  object_class text,
  operating_condition text,
  reliability_prior double precision CHECK (reliability_prior IS NULL OR reliability_prior BETWEEN 0 AND 1),
  rubric_version text NOT NULL,
  basis_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE sensor (
  sensor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope,
  source_key text NOT NULL REFERENCES source_registry,
  sensor_type text NOT NULL,
  manufacturer text,
  model text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sensor_id,data_scope_key),
  FOREIGN KEY (source_key,data_scope_key) REFERENCES source_registry(source_key,data_scope_key)
);

CREATE TABLE sensor_deployment (
  sensor_deployment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope,
  sensor_id uuid NOT NULL REFERENCES sensor,
  analysis_space_key text NOT NULL REFERENCES analysis_space,
  deployment_name text NOT NULL,
  valid_time tstzrange NOT NULL,
  platform_reference text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sensor_deployment_id,data_scope_key),
  UNIQUE (sensor_deployment_id,data_scope_key,analysis_space_key),
  FOREIGN KEY (sensor_id,data_scope_key) REFERENCES sensor(sensor_id,data_scope_key)
);

CREATE TABLE sensor_pose_version (
  sensor_pose_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_deployment_id uuid NOT NULL REFERENCES sensor_deployment,
  supersedes_id uuid REFERENCES sensor_pose_version,
  valid_time tstzrange NOT NULL,
  position geometry(Point) NOT NULL,
  yaw_rad double precision,
  pitch_rad double precision,
  roll_rad double precision,
  pose_accuracy_m double precision CHECK (pose_accuracy_m IS NULL OR pose_accuracy_m>=0),
  calibration_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sensor_pose_version_id,sensor_deployment_id)
);

CREATE TABLE sensor_extrinsic_version (
  sensor_extrinsic_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_deployment_id uuid NOT NULL REFERENCES sensor_deployment,
  supersedes_id uuid REFERENCES sensor_extrinsic_version,
  valid_time tstzrange NOT NULL,
  translation_m double precision[3] NOT NULL,
  rotation_quaternion double precision[4] NOT NULL,
  calibration_version text NOT NULL,
  covariance_reference text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sensor_extrinsic_version_id,sensor_deployment_id),
  CHECK (array_length(translation_m,1)=3),
  CHECK (array_length(rotation_quaternion,1)=4)
);

CREATE TABLE detector_model_version (
  detector_model_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producer_pipeline_key text NOT NULL REFERENCES producer_pipeline,
  model_name text NOT NULL,
  model_version text NOT NULL,
  valid_time tstzrange NOT NULL,
  object_class text NOT NULL,
  min_range_m double precision,
  max_range_m double precision,
  min_resolution double precision,
  score_threshold double precision,
  detectability_model text NOT NULL,
  calibration_reference text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (min_range_m IS NULL OR min_range_m>=0),
  CHECK (max_range_m IS NULL OR max_range_m>=min_range_m),
  CHECK (score_threshold IS NULL OR score_threshold BETWEEN 0 AND 1)
);

CREATE TABLE sensor_status_interval (
  sensor_status_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_deployment_id uuid NOT NULL REFERENCES sensor_deployment,
  producer_pipeline_key text REFERENCES producer_pipeline,
  valid_time tstzrange NOT NULL,
  capture_state text NOT NULL,
  analytic_state text NOT NULL,
  transport_state text NOT NULL,
  completeness_state text NOT NULL,
  calibration_state text NOT NULL,
  clock_health text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE pipeline_watermark_revision (
  watermark_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  datastream_key text NOT NULL REFERENCES datastream,
  producer_pipeline_key text NOT NULL REFERENCES producer_pipeline,
  processing_run_id uuid NOT NULL REFERENCES processing_run,
  clock_model_id uuid REFERENCES source_clock_model,
  supersedes_watermark_revision_id uuid REFERENCES pipeline_watermark_revision,
  time_basis text NOT NULL CHECK (time_basis IN ('CLOCK_MODEL','UPSTREAM_AUTHORITY_UTC')),
  upstream_basis_reference text,
  closed_through_event_time timestamptz,
  allowed_lateness interval NOT NULL CHECK (allowed_lateness>=interval '0'),
  last_received_time timestamptz,
  completeness_state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((time_basis='CLOCK_MODEL' AND clock_model_id IS NOT NULL) OR
         (time_basis='UPSTREAM_AUTHORITY_UTC' AND upstream_basis_reference IS NOT NULL))
);

CREATE TABLE spatial_object (
  spatial_object_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope,
  object_type text NOT NULL,
  stable_name text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (spatial_object_id,data_scope_key)
);

CREATE TABLE spatial_object_version (
  spatial_object_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spatial_object_id uuid NOT NULL REFERENCES spatial_object,
  version_no integer NOT NULL CHECK (version_no>0),
  analysis_space_key text NOT NULL REFERENCES analysis_space,
  valid_time tstzrange NOT NULL,
  geometry geometry(Geometry) NOT NULL,
  boundary_accuracy_m double precision CHECK (boundary_accuracy_m IS NULL OR boundary_accuracy_m>=0),
  attributes jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (spatial_object_id,version_no)
);

CREATE INDEX spatial_object_version_geometry_gist_idx ON spatial_object_version USING gist(geometry);

CREATE TABLE sensor_coverage_slice (
  coverage_slice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data_scope_key text NOT NULL REFERENCES data_scope,
  sensor_deployment_id uuid NOT NULL REFERENCES sensor_deployment,
  datastream_key text NOT NULL REFERENCES datastream,
  sensor_pose_version_id uuid REFERENCES sensor_pose_version,
  sensor_extrinsic_version_id uuid REFERENCES sensor_extrinsic_version,
  detector_model_id uuid REFERENCES detector_model_version,
  processing_run_id uuid NOT NULL REFERENCES processing_run,
  platform_tracklet_version_id uuid REFERENCES mobility_tracklet_version,
  input_time tstzrange NOT NULL,
  valid_time tstzrange NOT NULL,
  coverage_geometry geometry(Geometry) NOT NULL,
  min_height_m double precision,
  max_height_m double precision,
  detectable_object_class text,
  coverage_confidence double precision CHECK (coverage_confidence IS NULL OR coverage_confidence BETWEEN 0 AND 1),
  coverage_model_version text NOT NULL,
  occlusion_model_version text,
  assumptions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (sensor_deployment_id,data_scope_key)
    REFERENCES sensor_deployment(sensor_deployment_id,data_scope_key),
  CHECK (max_height_m IS NULL OR min_height_m IS NULL OR max_height_m>=min_height_m)
);

CREATE INDEX sensor_coverage_geometry_gist_idx ON sensor_coverage_slice USING gist(coverage_geometry);
CREATE INDEX sensor_coverage_valid_time_gist_idx ON sensor_coverage_slice USING gist(valid_time);

-- STAS owns only its append-only result sink.
CREATE SCHEMA stas;
CREATE TABLE stas.analysis_record (
  analysis_id uuid PRIMARY KEY,
  data_scope_key text NOT NULL REFERENCES data_scope,
  status text NOT NULL CHECK (status IN ('COMPLETE','PARTIAL','NO_DATA','INDETERMINATE')),
  tool_name text NOT NULL,
  tool_version text NOT NULL,
  algorithm text NOT NULL,
  algorithm_version text NOT NULL,
  analysis_as_of timestamptz NOT NULL,
  query_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  method_snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  supersedes_analysis_id uuid REFERENCES stas.analysis_record,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX stas_analysis_scope_tool_idx ON stas.analysis_record(data_scope_key,tool_name,analysis_as_of DESC,analysis_id);

CREATE TABLE stas.analysis_tracklet_input (
  analysis_id uuid NOT NULL REFERENCES stas.analysis_record,
  tracklet_version_id uuid NOT NULL REFERENCES mobility_tracklet_version,
  input_role text NOT NULL,
  PRIMARY KEY (analysis_id,tracklet_version_id,input_role)
);
CREATE TABLE stas.analysis_time_solution_input (
  analysis_id uuid NOT NULL REFERENCES stas.analysis_record,
  time_solution_id uuid NOT NULL REFERENCES observation_time_solution,
  input_role text NOT NULL,
  PRIMARY KEY (analysis_id,time_solution_id,input_role)
);
CREATE TABLE stas.analysis_clock_model_input (
  analysis_id uuid NOT NULL REFERENCES stas.analysis_record,
  clock_model_id uuid NOT NULL REFERENCES source_clock_model,
  input_role text NOT NULL,
  PRIMARY KEY (analysis_id,clock_model_id,input_role)
);
CREATE TABLE stas.analysis_spatial_object_input (
  analysis_id uuid NOT NULL REFERENCES stas.analysis_record,
  spatial_object_version_id uuid NOT NULL REFERENCES spatial_object_version,
  input_role text NOT NULL,
  PRIMARY KEY (analysis_id,spatial_object_version_id,input_role)
);
CREATE TABLE stas.analysis_coverage_input (
  analysis_id uuid NOT NULL REFERENCES stas.analysis_record,
  analysis_input_no integer NOT NULL CHECK (analysis_input_no>0),
  coverage_slice_id uuid REFERENCES sensor_coverage_slice,
  sensor_pose_version_id uuid REFERENCES sensor_pose_version,
  sensor_extrinsic_version_id uuid REFERENCES sensor_extrinsic_version,
  sensor_status_id uuid REFERENCES sensor_status_interval,
  detector_model_id uuid REFERENCES detector_model_version,
  watermark_revision_id uuid REFERENCES pipeline_watermark_revision,
  input_role text NOT NULL,
  PRIMARY KEY (analysis_id,analysis_input_no),
  CHECK (num_nonnulls(coverage_slice_id,sensor_pose_version_id,sensor_extrinsic_version_id,
                      sensor_status_id,detector_model_id,watermark_revision_id)=1)
);
CREATE TABLE stas.analysis_processing_input (
  analysis_id uuid NOT NULL REFERENCES stas.analysis_record,
  analysis_input_no integer NOT NULL CHECK (analysis_input_no>0),
  processing_run_id uuid REFERENCES processing_run,
  rule_profile_id uuid REFERENCES tracklet_rule_profile(rule_profile_id),
  input_role text NOT NULL,
  PRIMARY KEY (analysis_id,analysis_input_no),
  CHECK (num_nonnulls(processing_run_id,rule_profile_id)=1)
);
CREATE TABLE stas.analysis_quality_input (
  analysis_id uuid NOT NULL REFERENCES stas.analysis_record,
  source_reliability_profile_id uuid NOT NULL REFERENCES source_reliability_profile,
  input_role text NOT NULL,
  PRIMARY KEY (analysis_id,source_reliability_profile_id,input_role)
);
CREATE TABLE stas.analysis_evidence_ref (
  analysis_id uuid NOT NULL REFERENCES stas.analysis_record,
  evidence_no integer NOT NULL CHECK (evidence_no>0),
  evidence_type text NOT NULL,
  observation_id text REFERENCES world_observation,
  measurement_id uuid REFERENCES measurement,
  tracklet_version_id uuid REFERENCES mobility_tracklet_version,
  time_range tstzrange,
  summary_hash text NOT NULL,
  PRIMARY KEY (analysis_id,evidence_no),
  CHECK (num_nonnulls(observation_id,measurement_id,tracklet_version_id)>=1)
);

CREATE FUNCTION stas.validate_analysis_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,public,stas AS $fn$
DECLARE expected_scope text; actual_scope text;
BEGIN
  SELECT data_scope_key INTO STRICT expected_scope FROM stas.analysis_record WHERE analysis_id=NEW.analysis_id;
  IF TG_TABLE_NAME='analysis_tracklet_input' THEN
    SELECT t.data_scope_key INTO STRICT actual_scope FROM mobility_tracklet_version v
      JOIN mobility_tracklet t ON t.tracklet_id=v.tracklet_id WHERE v.tracklet_version_id=NEW.tracklet_version_id;
  ELSIF TG_TABLE_NAME='analysis_time_solution_input' THEN
    SELECT o.data_scope_key INTO STRICT actual_scope FROM observation_time_solution ts
      JOIN world_observation o ON o.observation_id=ts.observation_id WHERE ts.time_solution_id=NEW.time_solution_id;
  ELSE
    IF NEW.observation_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM world_observation WHERE observation_id=NEW.observation_id AND data_scope_key=expected_scope)
      THEN RAISE EXCEPTION 'analysis observation evidence crosses data scope'; END IF;
    IF NEW.measurement_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM measurement m JOIN world_observation o ON o.observation_id=m.observation_id
       WHERE m.measurement_id=NEW.measurement_id AND o.data_scope_key=expected_scope)
      THEN RAISE EXCEPTION 'analysis measurement evidence crosses data scope'; END IF;
    IF NEW.tracklet_version_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM mobility_tracklet_version v JOIN mobility_tracklet t ON t.tracklet_id=v.tracklet_id
       WHERE v.tracklet_version_id=NEW.tracklet_version_id AND t.data_scope_key=expected_scope)
      THEN RAISE EXCEPTION 'analysis tracklet evidence crosses data scope'; END IF;
    RETURN NEW;
  END IF;
  IF actual_scope IS DISTINCT FROM expected_scope THEN RAISE EXCEPTION 'analysis input crosses data scope'; END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER stas_analysis_tracklet_scope BEFORE INSERT OR UPDATE ON stas.analysis_tracklet_input FOR EACH ROW EXECUTE FUNCTION stas.validate_analysis_scope();
CREATE TRIGGER stas_analysis_time_scope BEFORE INSERT OR UPDATE ON stas.analysis_time_solution_input FOR EACH ROW EXECUTE FUNCTION stas.validate_analysis_scope();
CREATE TRIGGER stas_analysis_evidence_scope BEFORE INSERT OR UPDATE ON stas.analysis_evidence_ref FOR EACH ROW EXECUTE FUNCTION stas.validate_analysis_scope();

CREATE FUNCTION stas.assert_analysis_record_invariants(p_analysis_id uuid)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM stas.analysis_record WHERE analysis_id=p_analysis_id) THEN
    RAISE EXCEPTION 'analysis record % does not exist',p_analysis_id;
  END IF;
END
$fn$;

CREATE FUNCTION stas.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION '% is append-only',TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME; END
$fn$;
CREATE TRIGGER stas_analysis_record_immutable BEFORE UPDATE OR DELETE ON stas.analysis_record FOR EACH ROW EXECUTE FUNCTION stas.reject_mutation();
CREATE TRIGGER stas_analysis_tracklet_input_immutable BEFORE UPDATE OR DELETE ON stas.analysis_tracklet_input FOR EACH ROW EXECUTE FUNCTION stas.reject_mutation();
CREATE TRIGGER stas_analysis_time_solution_input_immutable BEFORE UPDATE OR DELETE ON stas.analysis_time_solution_input FOR EACH ROW EXECUTE FUNCTION stas.reject_mutation();
CREATE TRIGGER stas_analysis_evidence_ref_immutable BEFORE UPDATE OR DELETE ON stas.analysis_evidence_ref FOR EACH ROW EXECUTE FUNCTION stas.reject_mutation();

-- Versioned read-only adapter. Every view is derived from GOWM-owned tables.
CREATE SCHEMA gowm_stas_v1;
CREATE VIEW gowm_stas_v1.deployment_config AS
SELECT singleton,contract_version AS schema_contract_version,analysis_srid FROM gowm_deployment_config;
CREATE VIEW gowm_stas_v1.data_scope AS
SELECT data_scope_id,scope_key AS tenant_key,scope_key AS dataset_key,NULL::text AS case_key,operational_domain,created_at FROM data_scope;
CREATE VIEW gowm_stas_v1.analysis_space AS
SELECT analysis_space_id,analysis_space_key AS name,canonical_srid,NULL::text AS horizontal_datum,NULL::text AS vertical_datum,
       dimension_model,distance_model,valid_area,transform_pipeline_version,created_at FROM analysis_space;
CREATE VIEW gowm_stas_v1.source AS
SELECT s.source_id,d.data_scope_id,s.source_type,s.source_key AS name,a.analysis_space_id AS default_analysis_space_id,s.created_at
FROM source_registry s JOIN data_scope d ON d.scope_key=s.data_scope_key
JOIN analysis_space a ON a.analysis_space_key=s.default_analysis_space_key;
CREATE VIEW gowm_stas_v1.processing_run AS SELECT * FROM processing_run;
CREATE VIEW gowm_stas_v1.source_clock_model AS
SELECT c.clock_model_id,s.source_id,c.supersedes_clock_model_id,c.clock_domain,NULL::numrange AS valid_source_ticks,
       NULL::timestamptz AS source_epoch,1::double precision AS scale_to_seconds,c.offset_seconds,c.drift_ppm,
       c.residual_sigma_ms,c.estimation_method,c.model_version,c.calibration_reference,c.created_at
FROM source_clock_model c JOIN source_registry s ON s.source_key=c.source_key;
CREATE VIEW gowm_stas_v1.producer_pipeline AS
SELECT p.producer_pipeline_id,s.source_id,p.pipeline_key AS pipeline_name,p.pipeline_version,p.output_kind,p.created_at
FROM producer_pipeline p JOIN source_registry s ON s.source_key=p.source_key;
CREATE VIEW gowm_stas_v1.datastream AS
SELECT ds.datastream_id,s.source_id,d.data_scope_id,p.producer_pipeline_id,ds.datastream_key AS stream_key,ds.schema_version,ds.created_at
FROM datastream ds JOIN source_registry s ON s.source_key=ds.source_key
JOIN data_scope d ON d.scope_key=ds.data_scope_key JOIN producer_pipeline p ON p.pipeline_key=ds.pipeline_key;
CREATE VIEW gowm_stas_v1.source_reliability_profile AS
SELECT r.source_reliability_profile_id,s.source_id,r.valid_time,r.object_class,r.operating_condition,
       r.reliability_prior,r.rubric_version,r.basis_reference,r.created_at
FROM source_reliability_profile r JOIN source_registry s ON s.source_key=r.source_key;
CREATE VIEW gowm_stas_v1.observation_time_solution AS
SELECT ts.*,s.source_id FROM observation_time_solution ts JOIN world_observation o ON o.observation_id=ts.observation_id
JOIN source_registry s ON s.source_key=o.source;
CREATE VIEW gowm_stas_v1.measurement AS SELECT * FROM measurement;
CREATE VIEW gowm_stas_v1.position_measurement AS
SELECT pm.*,a.analysis_space_id,NULL::geometry AS support_geometry
FROM position_measurement pm JOIN analysis_space a ON a.analysis_space_key=pm.analysis_space_key;
CREATE VIEW gowm_stas_v1.measurement_relation AS SELECT * FROM measurement_relation;
CREATE VIEW gowm_stas_v1.tracklet_rule_profile AS
SELECT rule_profile_id,profile_key AS profile_name,profile_version,NULL::text AS source_type,NULL::text AS object_class,
       max_time_gap,max_distance_gap_m,max_required_speed_mps,minimum_quality,NULL::interval AS expected_sample_period,
       NULL::integer AS allowed_missed_samples,interval '365 days' AS max_tracklet_duration,1000000 AS max_tracklet_instants,
       1073741824::bigint AS max_tracklet_serialized_bytes,require_continuity_signal,interpolation,config_hash,created_at
FROM tracklet_rule_profile;
CREATE VIEW gowm_stas_v1.tracklet AS
SELECT t.tracklet_id,d.data_scope_id,s.source_id,NULL::uuid AS sensor_deployment_id,t.tracker_session_key AS tracker_session_id,
       NULL::text AS tracker_algorithm,NULL::text AS tracker_algorithm_version,t.source_local_target_id,t.object_class,
       a.analysis_space_id,t.tracklet_scope,t.created_at
FROM mobility_tracklet t JOIN data_scope d ON d.scope_key=t.data_scope_key
JOIN source_registry s ON s.source_key=t.source_key JOIN analysis_space a ON a.analysis_space_key=t.analysis_space_key;
CREATE VIEW gowm_stas_v1.tracklet_version AS
SELECT v.tracklet_version_id,v.tracklet_id,v.version_no,
       (SELECT m.processing_run_id FROM mobility_tracklet_input i JOIN measurement m ON m.measurement_id=i.measurement_id
        WHERE i.tracklet_version_id=v.tracklet_version_id ORDER BY i.segment_no,i.ordinal_no LIMIT 1) AS build_run_id,
       rp.rule_profile_id,v.version_state,v.trajectory,v.extent_box,v.start_event_time,v.end_event_time,
       v.start_event_time AS start_time_lower,v.start_event_time AS start_time_upper,
       v.end_event_time AS end_time_lower,v.end_event_time AS end_time_upper,
       (SELECT i.time_solution_id FROM mobility_tracklet_input i WHERE i.tracklet_version_id=v.tracklet_version_id ORDER BY i.segment_no,i.ordinal_no LIMIT 1) AS start_time_solution_id,
       (SELECT i.time_solution_id FROM mobility_tracklet_input i WHERE i.tracklet_version_id=v.tracklet_version_id ORDER BY i.segment_no DESC,i.ordinal_no DESC LIMIT 1) AS end_time_solution_id,
       v.start_position,v.end_position,NULL::double precision AS start_speed_mps,NULL::double precision AS end_speed_mps,
       NULL::double precision AS start_heading_rad,NULL::double precision AS end_heading_rad,
       v.max_accuracy_radius_m AS start_accuracy_radius_m,v.max_accuracy_radius_m AS end_accuracy_radius_m,
       v.max_accuracy_radius_m,v.content_hash,v.sample_count,v.sequence_count,v.quality_score,v.created_at
FROM mobility_tracklet_version v JOIN tracklet_rule_profile rp ON rp.profile_key=v.profile_key;
CREATE VIEW gowm_stas_v1.tracklet_segment AS
SELECT s.tracklet_version_id,s.segment_no,s.trajectory,'LINEAR'::text AS interpolation,s.sample_count,s.start_time,s.end_time
FROM mobility_tracklet_segment s;
CREATE VIEW gowm_stas_v1.tracklet_gap AS
SELECT g.*,NULL::double precision AS reason_confidence,'{}'::jsonb AS details FROM mobility_tracklet_gap g;
CREATE VIEW gowm_stas_v1.tracklet_input AS
SELECT i.tracklet_version_id,i.measurement_id,i.observation_id,i.time_solution_id,i.segment_no,i.ordinal_no,
       'INCLUDED'::text AS inclusion_role,NULL::text AS exclusion_reason FROM mobility_tracklet_input i;
CREATE VIEW gowm_stas_v1.tracklet_head AS SELECT * FROM mobility_tracklet_head;
CREATE VIEW gowm_stas_v1.spatial_object AS
SELECT so.spatial_object_id,d.data_scope_id,so.object_type,so.stable_name,so.created_at
FROM spatial_object so JOIN data_scope d ON d.scope_key=so.data_scope_key;
CREATE VIEW gowm_stas_v1.spatial_object_version AS
SELECT sv.spatial_object_version_id,sv.spatial_object_id,sv.version_no,a.analysis_space_id,sv.valid_time,
       sv.geometry,sv.boundary_accuracy_m,sv.attributes,sv.created_at
FROM spatial_object_version sv JOIN analysis_space a ON a.analysis_space_key=sv.analysis_space_key;
CREATE VIEW gowm_stas_v1.sensor AS
SELECT se.sensor_id,d.data_scope_id,s.source_id,se.sensor_type,se.manufacturer,se.model,se.created_at
FROM sensor se JOIN data_scope d ON d.scope_key=se.data_scope_key JOIN source_registry s ON s.source_key=se.source_key;
CREATE VIEW gowm_stas_v1.sensor_deployment AS
SELECT sd.sensor_deployment_id,d.data_scope_id,sd.sensor_id,a.analysis_space_id,sd.deployment_name,sd.valid_time,sd.platform_reference,sd.created_at
FROM sensor_deployment sd JOIN data_scope d ON d.scope_key=sd.data_scope_key JOIN analysis_space a ON a.analysis_space_key=sd.analysis_space_key;
CREATE VIEW gowm_stas_v1.sensor_pose_version AS SELECT * FROM sensor_pose_version;
CREATE VIEW gowm_stas_v1.sensor_extrinsic_version AS SELECT * FROM sensor_extrinsic_version;
CREATE VIEW gowm_stas_v1.detector_model_version AS
SELECT dm.detector_model_id,p.producer_pipeline_id,dm.model_name,dm.model_version,dm.valid_time,dm.object_class,
       dm.min_range_m,dm.max_range_m,dm.min_resolution,dm.score_threshold,dm.detectability_model,dm.calibration_reference,dm.created_at
FROM detector_model_version dm JOIN producer_pipeline p ON p.pipeline_key=dm.producer_pipeline_key;
CREATE VIEW gowm_stas_v1.sensor_status_interval AS
SELECT ss.sensor_status_id,ss.sensor_deployment_id,p.producer_pipeline_id,ss.valid_time,ss.capture_state,ss.analytic_state,
       ss.transport_state,ss.completeness_state,ss.calibration_state,ss.clock_health,ss.details,ss.created_at
FROM sensor_status_interval ss LEFT JOIN producer_pipeline p ON p.pipeline_key=ss.producer_pipeline_key;
CREATE VIEW gowm_stas_v1.pipeline_watermark_revision AS
SELECT w.watermark_revision_id,d.datastream_id,p.producer_pipeline_id,w.processing_run_id,w.clock_model_id,
       w.supersedes_watermark_revision_id,w.time_basis,w.upstream_basis_reference,w.closed_through_event_time,
       w.allowed_lateness,w.last_received_time,w.completeness_state,w.created_at
FROM pipeline_watermark_revision w JOIN datastream d ON d.datastream_key=w.datastream_key
JOIN producer_pipeline p ON p.pipeline_key=w.producer_pipeline_key;
CREATE VIEW gowm_stas_v1.sensor_coverage_slice AS
SELECT cs.coverage_slice_id,d.data_scope_id,cs.sensor_deployment_id,ds.datastream_id,cs.sensor_pose_version_id,
       cs.sensor_extrinsic_version_id,cs.detector_model_id,cs.processing_run_id,cs.platform_tracklet_version_id,
       cs.input_time,cs.valid_time,cs.coverage_geometry,cs.min_height_m,cs.max_height_m,cs.detectable_object_class,
       cs.coverage_confidence,cs.coverage_model_version,cs.occlusion_model_version,cs.assumptions,cs.created_at
FROM sensor_coverage_slice cs JOIN data_scope d ON d.scope_key=cs.data_scope_key
JOIN datastream ds ON ds.datastream_key=cs.datastream_key;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gowm_migration_owner') THEN CREATE ROLE gowm_migration_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gowm_ingestion_writer') THEN CREATE ROLE gowm_ingestion_writer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gowm_projector') THEN CREATE ROLE gowm_projector NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='stas_runtime') THEN CREATE ROLE stas_runtime NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gowm_diagnostic') THEN CREATE ROLE gowm_diagnostic NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='stas_app') THEN CREATE ROLE stas_app LOGIN; END IF;
END
$roles$;
GRANT stas_runtime TO stas_app;
REVOKE ALL ON SCHEMA public,gowm_stas_v1,stas FROM PUBLIC;
-- MobilityDB/PostGIS/H3 install callable functions and types in public. Schema
-- usage resolves those symbols; it does not grant access to GOWM base tables.
GRANT USAGE ON SCHEMA public,gowm_stas_v1,stas TO stas_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA gowm_stas_v1 TO stas_runtime;
GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA stas TO stas_runtime;
GRANT EXECUTE ON FUNCTION stas.assert_analysis_record_invariants(uuid) TO stas_runtime;
GRANT USAGE ON SCHEMA public,gowm_stas_v1,stas TO gowm_diagnostic;
GRANT SELECT ON ALL TABLES IN SCHEMA public,gowm_stas_v1,stas TO gowm_diagnostic;

COMMIT;
