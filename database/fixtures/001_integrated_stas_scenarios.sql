\set ON_ERROR_STOP on
\if :{?ANALYSIS_SRID}
\else
  \echo 'ERROR: ANALYSIS_SRID is required.'
  \quit
\endif

BEGIN;

INSERT INTO data_scope(scope_key,operational_domain,description,data_scope_id) VALUES
 ('fixture-real','REAL','Integrated GOWM/STAS deterministic fixture','00000000-0000-4000-8000-000000000001'),
 ('fixture-simulation','SIMULATION','Integrated isolation fixture','00000000-0000-4000-8000-000000000003')
ON CONFLICT (scope_key) DO NOTHING;

INSERT INTO analysis_space(analysis_space_key,canonical_srid,dimension_model,distance_model,transform_pipeline_version,analysis_space_id)
VALUES ('fixture-metric',:ANALYSIS_SRID,'2D','PLANAR_METRE_V1','fixture-v1','00000000-0000-4000-8000-000000000002')
ON CONFLICT (analysis_space_key) DO NOTHING;

INSERT INTO source_registry(source_key,data_scope_key,source_type,default_analysis_space_key,source_id) VALUES
 ('fixture-camera','fixture-real','CAMERA','fixture-metric','00000000-0000-4000-8000-000000000004'),
 ('fixture-radar','fixture-real','RADAR','fixture-metric','00000000-0000-4000-8000-000000000005')
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO producer_pipeline(pipeline_key,source_key,pipeline_version,output_kind,producer_pipeline_id) VALUES
 ('fixture-camera-tracker','fixture-camera','1','POSITION','00000000-0000-4000-8000-000000000016'),
 ('fixture-radar-tracker','fixture-radar','1','POSITION','00000000-0000-4000-8000-000000000017')
ON CONFLICT (pipeline_key) DO NOTHING;

INSERT INTO datastream(datastream_key,source_key,data_scope_key,pipeline_key,schema_version,datastream_id) VALUES
 ('fixture-camera-detections','fixture-camera','fixture-real','fixture-camera-tracker','1','00000000-0000-4000-8000-000000000018'),
 ('fixture-radar-tracks','fixture-radar','fixture-real','fixture-radar-tracker','1','00000000-0000-4000-8000-000000000019')
ON CONFLICT (datastream_key) DO NOTHING;

INSERT INTO processing_run(processing_run_id,processor_name,processor_version,config_hash,code_digest,deterministic,started_at,completed_at) VALUES
 ('00000000-0000-4000-8000-000000000010','fixture-normalizer','1','normalize-v1','code-v1',true,'2026-08-13T00:00:00Z','2026-08-13T00:00:01Z'),
 ('00000000-0000-4000-8000-000000000011','fixture-builder','1','builder-v1','code-v1',true,'2026-08-13T00:00:00Z','2026-08-13T00:00:01Z')
ON CONFLICT (processing_run_id) DO NOTHING;

INSERT INTO source_clock_model(clock_model_id,source_key,model_version,clock_domain,offset_seconds,residual_sigma_ms,estimation_method) VALUES
 ('00000000-0000-4000-8000-000000000012','fixture-camera','1','UTC',0,50,'fixture'),
 ('00000000-0000-4000-8000-000000000013','fixture-radar','1','DEVICE',-3,200,'fixture-offset-correction')
ON CONFLICT (clock_model_id) DO NOTHING;

INSERT INTO tracklet_rule_profile(profile_key,profile_version,max_time_gap,max_distance_gap_m,max_required_speed_mps,minimum_quality,require_continuity_signal,interpolation,config_hash,rule_profile_id)
VALUES ('fixture-source-local','1',interval '2 seconds',20,20,0.5,true,'LINEAR','fixture-rule-v1','00000000-0000-4000-8000-000000000020')
ON CONFLICT (profile_key) DO NOTHING;

INSERT INTO sensor(sensor_id,data_scope_key,source_key,sensor_type) VALUES
 ('00000000-0000-4000-8000-000000000006','fixture-real','fixture-camera','CAMERA'),
 ('00000000-0000-4000-8000-000000000008','fixture-real','fixture-radar','RADAR')
ON CONFLICT (sensor_id) DO NOTHING;
INSERT INTO sensor_deployment(sensor_deployment_id,data_scope_key,sensor_id,analysis_space_key,deployment_name,valid_time) VALUES
 ('00000000-0000-4000-8000-000000000007','fixture-real','00000000-0000-4000-8000-000000000006','fixture-metric','camera-fixture','[2026-01-01,2027-01-01)'),
 ('00000000-0000-4000-8000-000000000009','fixture-real','00000000-0000-4000-8000-000000000008','fixture-metric','radar-fixture','[2026-01-01,2027-01-01)')
ON CONFLICT (sensor_deployment_id) DO NOTHING;
INSERT INTO sensor_pose_version(sensor_pose_version_id,sensor_deployment_id,valid_time,position,yaw_rad,calibration_version)
VALUES ('00000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-000000000007','[2026-01-01,2027-01-01)',ST_SetSRID(ST_Point(0,-10),:ANALYSIS_SRID),0,'fixture-v1')
ON CONFLICT (sensor_pose_version_id) DO NOTHING;
INSERT INTO sensor_extrinsic_version(sensor_extrinsic_version_id,sensor_deployment_id,valid_time,translation_m,rotation_quaternion,calibration_version)
VALUES ('00000000-0000-4000-8000-000000000015','00000000-0000-4000-8000-000000000007','[2026-01-01,2027-01-01)',ARRAY[0.0,0.0,0.0],ARRAY[1.0,0.0,0.0,0.0],'fixture-v1')
ON CONFLICT (sensor_extrinsic_version_id) DO NOTHING;

INSERT INTO spatial_object(spatial_object_id,data_scope_key,object_type,stable_name)
VALUES ('00000000-0000-4000-8000-000000000021','fixture-real','REGION','fixture-region')
ON CONFLICT (spatial_object_id) DO NOTHING;
INSERT INTO spatial_object_version(spatial_object_version_id,spatial_object_id,version_no,analysis_space_key,valid_time,geometry,boundary_accuracy_m)
VALUES ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000021',1,'fixture-metric','[2026-01-01,2027-01-01)',ST_SetSRID(ST_MakeEnvelope(1,-1,4,2),:ANALYSIS_SRID),0.5)
ON CONFLICT (spatial_object_version_id) DO NOTHING;

WITH x(n,t,x,y,target,source_key,stream_key,pipeline_key,clock_id,acc) AS (VALUES
 (1,'2026-08-13T01:00:00Z'::timestamptz,0.0,0.0,'A','fixture-camera','fixture-camera-detections','fixture-camera-tracker','00000000-0000-4000-8000-000000000012'::uuid,5.0),
 (2,'2026-08-13T01:00:01Z',1.0,0.0,'A','fixture-camera','fixture-camera-detections','fixture-camera-tracker','00000000-0000-4000-8000-000000000012',5.0),
 (3,'2026-08-13T01:00:05Z',5.0,0.0,'A','fixture-camera','fixture-camera-detections','fixture-camera-tracker','00000000-0000-4000-8000-000000000012',5.0),
 (4,'2026-08-13T01:00:06Z',6.0,0.0,'A','fixture-camera','fixture-camera-detections','fixture-camera-tracker','00000000-0000-4000-8000-000000000012',5.0),
 (5,'2026-08-13T01:00:00Z',0.0,4.0,'B','fixture-camera','fixture-camera-detections','fixture-camera-tracker','00000000-0000-4000-8000-000000000012',3.0),
 (6,'2026-08-13T01:00:06Z',6.0,4.0,'B','fixture-camera','fixture-camera-detections','fixture-camera-tracker','00000000-0000-4000-8000-000000000012',3.0),
 (7,'2026-08-13T01:00:08Z',8.0,0.0,'C','fixture-radar','fixture-radar-tracks','fixture-radar-tracker','00000000-0000-4000-8000-000000000013',1.0),
 (8,'2026-08-13T01:00:09Z',9.0,0.0,'C','fixture-radar','fixture-radar-tracks','fixture-radar-tracker','00000000-0000-4000-8000-000000000013',1.0)
), obs AS (
 INSERT INTO world_observation(observation_id,observer_type,observer_id,subject_type,subject_id,observation_type,geometry,value,confidence,observed_at,received_at,source,correlation_id,metadata,schema_version,data_scope_key,source_record_key,source_revision_no,origin_kind,source_local_target_id,tracker_session_id,datastream_key,producer_pipeline_key,source_time_value,upstream_received_time,raw_reference,payload_hash)
 SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0')),'Sensor',source_key,'PERSON',target,'position',ST_Transform(ST_SetSRID(ST_Point(x,y),:ANALYSIS_SRID),4326),'{}',0.9,t,t+interval '1 second',source_key,'fixture','{}','1','fixture-real','fixture-'||n,1,'PHYSICAL_SENSOR',target,'fixture-session',stream_key,pipeline_key,t,t+interval '1 second','inline://fixture/'||n,lpad(to_hex(n),64,'0')
 FROM x ON CONFLICT (observation_id) DO NOTHING RETURNING observation_id,source,source_record_key
), heads AS (
 INSERT INTO world_observation_head(source_key,source_record_key,current_observation_id)
 SELECT source,source_record_key,observation_id FROM obs ON CONFLICT DO NOTHING RETURNING current_observation_id
), ts AS (
 INSERT INTO observation_time_solution(time_solution_id,observation_id,clock_model_id,processing_run_id,phenomenon_time_estimate,phenomenon_time_window,uncertainty_seconds,solution_method)
 SELECT ('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('10000000-0000-4000-8000-'||lpad(n::text,12,'0')),clock_id,'00000000-0000-4000-8000-000000000010',t,span(t-interval '100 milliseconds',t+interval '100 milliseconds',true,false),0.1,'fixture' FROM x
 ON CONFLICT (time_solution_id) DO NOTHING RETURNING time_solution_id,observation_id
)
INSERT INTO measurement(measurement_id,observation_id,time_solution_id,processing_run_id,measurement_key,measurement_stage,observed_property,result_kind,measurement_model,measurement_model_version,quality_score,continuity_token,command_fingerprint)
SELECT ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('10000000-0000-4000-8000-'||lpad(n::text,12,'0')),('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'00000000-0000-4000-8000-000000000010','position','NORMALIZED','POSITION','POSITION','fixture','1',0.9,source_key||':'||target,'fixture-'||n FROM x
ON CONFLICT (measurement_id) DO NOTHING;

WITH x(n,x,y,acc) AS (VALUES
 (1,0.0,0.0,5.0),(2,1.0,0.0,5.0),(3,5.0,0.0,5.0),(4,6.0,0.0,5.0),
 (5,0.0,4.0,3.0),(6,6.0,4.0,3.0),(7,8.0,0.0,1.0),(8,9.0,0.0,1.0)
)
INSERT INTO position_measurement(measurement_id,analysis_space_key,source_position,position,accuracy_radius_m,accuracy_model,accuracy_confidence)
SELECT ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'fixture-metric',ST_Transform(ST_SetSRID(ST_Point(x,y),:ANALYSIS_SRID),4326),ST_SetSRID(ST_Point(x,y),:ANALYSIS_SRID),acc,'HARD_RADIUS',0.95 FROM x
ON CONFLICT (measurement_id) DO NOTHING;

INSERT INTO mobility_tracklet(tracklet_id,data_scope_key,source_key,source_local_target_id,tracker_session_key,object_class,analysis_space_key,tracklet_scope) VALUES
 ('40000000-0000-4000-8000-000000000001','fixture-real','fixture-camera','A','fixture-session','PERSON','fixture-metric','SOURCE_LOCAL'),
 ('40000000-0000-4000-8000-000000000002','fixture-real','fixture-camera','B','fixture-session','PERSON','fixture-metric','SOURCE_LOCAL'),
 ('40000000-0000-4000-8000-000000000003','fixture-real','fixture-radar','C','fixture-session','PERSON','fixture-metric','SOURCE_LOCAL')
ON CONFLICT (tracklet_id) DO NOTHING;

SELECT gowm_rebuild_mobility_tracklet('fixture-real','fixture-camera','A','fixture-session','fixture-metric','fixture-source-local');
SELECT gowm_rebuild_mobility_tracklet('fixture-real','fixture-camera','B','fixture-session','fixture-metric','fixture-source-local');
SELECT gowm_rebuild_mobility_tracklet('fixture-real','fixture-radar','C','fixture-session','fixture-metric','fixture-source-local');

INSERT INTO sensor_coverage_slice(coverage_slice_id,data_scope_key,sensor_deployment_id,datastream_key,sensor_pose_version_id,sensor_extrinsic_version_id,processing_run_id,input_time,valid_time,coverage_geometry,detectable_object_class,coverage_confidence,coverage_model_version)
VALUES ('00000000-0000-4000-8000-000000000023','fixture-real','00000000-0000-4000-8000-000000000007','fixture-camera-detections','00000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-000000000015','00000000-0000-4000-8000-000000000010','[2026-08-13 01:00:00+00,2026-08-13 01:01:00+00)','[2026-08-13 01:00:00+00,2026-08-13 01:01:00+00)',ST_SetSRID(ST_MakeEnvelope(-2,-2,10,10),:ANALYSIS_SRID),'person',0.95,'fixture-v1')
ON CONFLICT (coverage_slice_id) DO NOTHING;

COMMIT;

SELECT t.tracklet_id,h.current_version_id,v.sample_count,v.sequence_count
FROM mobility_tracklet t JOIN mobility_tracklet_head h USING(tracklet_id)
JOIN mobility_tracklet_version v ON v.tracklet_version_id=h.current_version_id
WHERE t.tracklet_id IN ('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000003')
ORDER BY t.tracklet_id;
