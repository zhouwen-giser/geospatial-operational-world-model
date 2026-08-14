\set ON_ERROR_STOP on
\if :{?ANALYSIS_SRID}
\else
  \echo 'ERROR: ANALYSIS_SRID is required.'
  \quit
\endif

BEGIN;
INSERT INTO data_scope(scope_key,operational_domain,description,data_scope_id)
VALUES ('fixture-cap-10001','TEST','10,001-tracklet candidate-cap validation','00000000-0000-4000-8000-000000000030')
ON CONFLICT (scope_key) DO NOTHING;
INSERT INTO source_registry(source_key,data_scope_key,source_type,default_analysis_space_key,source_id)
VALUES ('fixture-cap-source','fixture-cap-10001','CAMERA','fixture-metric','00000000-0000-4000-8000-000000000031')
ON CONFLICT (source_key) DO NOTHING;
INSERT INTO spatial_object(spatial_object_id,data_scope_key,object_type,stable_name)
VALUES ('00000000-0000-4000-8000-000000000032','fixture-cap-10001','REGION','candidate-cap-region')
ON CONFLICT (spatial_object_id) DO NOTHING;
INSERT INTO spatial_object_version(spatial_object_version_id,spatial_object_id,version_no,analysis_space_key,valid_time,geometry,boundary_accuracy_m)
VALUES ('00000000-0000-4000-8000-000000000033','00000000-0000-4000-8000-000000000032',1,'fixture-metric','[2026-01-01,2027-01-01)',ST_SetSRID(ST_MakeEnvelope(-1,-1,7,1),:ANALYSIS_SRID),0)
ON CONFLICT (spatial_object_version_id) DO NOTHING;

WITH template AS (
  SELECT v.* FROM mobility_tracklet_head h JOIN mobility_tracklet_version v ON v.tracklet_version_id=h.current_version_id
  WHERE h.tracklet_id='40000000-0000-4000-8000-000000000001'
), inserted AS (
  INSERT INTO mobility_tracklet(tracklet_id,data_scope_key,source_key,source_local_target_id,tracker_session_key,object_class,analysis_space_key,tracklet_scope)
  SELECT gen_random_uuid(),'fixture-cap-10001','fixture-cap-source','cap-'||g,'cap-session','PERSON','fixture-metric','SOURCE_LOCAL'
  FROM generate_series(1,10001) g
  ON CONFLICT (data_scope_key,source_key,tracker_session_key,source_local_target_id,analysis_space_key) DO NOTHING
  RETURNING tracklet_id,source_local_target_id
), versions AS (
  INSERT INTO mobility_tracklet_version(tracklet_version_id,tracklet_id,version_no,profile_key,version_state,trajectory,extent_box,start_event_time,end_event_time,start_position,end_position,max_accuracy_radius_m,content_hash,sample_count,sequence_count,quality_score)
  SELECT gen_random_uuid(),i.tracklet_id,1,'fixture-source-local','SEALED',t.trajectory,t.extent_box,t.start_event_time,t.end_event_time,t.start_position,t.end_position,t.max_accuracy_radius_m,
         encode(digest(i.tracklet_id::text||':candidate-cap','sha256'),'hex'),t.sample_count,t.sequence_count,t.quality_score
  FROM inserted i CROSS JOIN template t
  RETURNING tracklet_version_id,tracklet_id
)
INSERT INTO mobility_tracklet_head(tracklet_id,current_version_id)
SELECT tracklet_id,tracklet_version_id FROM versions ON CONFLICT (tracklet_id) DO NOTHING;
COMMIT;

SELECT count(*) AS candidate_tracklet_count
FROM mobility_tracklet WHERE data_scope_key='fixture-cap-10001';
