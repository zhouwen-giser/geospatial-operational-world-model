\set ON_ERROR_STOP on

BEGIN;

DO $structure$
BEGIN
  IF to_regclass('gowm_evidence_v1.current_state') IS NULL OR
     to_regclass('gowm_evidence_v1.current_geometry') IS NULL OR
     to_regclass('gowm_evidence_v1.provenance') IS NULL OR
     to_regclass('gowm_evidence_v1.observation') IS NULL OR
     to_regclass('gowm_evidence_v1.world_event') IS NULL THEN
    RAISE EXCEPTION 'world evidence read-contract views are missing';
  END IF;
  IF NOT has_table_privilege('gowm_evidence_service','gowm_evidence_v1.current_state','SELECT') OR
     NOT has_table_privilege('gowm_evidence_service','gowm_result_v1.query_result','SELECT') OR
     has_table_privilege('gowm_evidence_service','public.world_object','SELECT') OR
     has_table_privilege('gowm_evidence_service','public.world_observation','SELECT') OR
     has_table_privilege('gowm_evidence_service','public.world_event','SELECT') THEN
    RAISE EXCEPTION 'world evidence provider privilege boundary is invalid';
  END IF;
END
$structure$;

INSERT INTO data_scope(scope_key,operational_domain,description) VALUES
  ('world-evidence-a','TEST','World evidence contract A'),
  ('world-evidence-b','TEST','World evidence contract B');

INSERT INTO source_registry(source_key,data_scope_key,source_type,default_analysis_space_key)
VALUES ('world-evidence-source','world-evidence-a','TEST_FIXTURE','default');
INSERT INTO producer_pipeline(pipeline_key,source_key,pipeline_version,output_kind)
VALUES ('world-evidence-pipeline','world-evidence-source','1.0','CANONICAL_OBSERVATION');
INSERT INTO datastream(datastream_key,source_key,data_scope_key,pipeline_key,schema_version)
VALUES ('world-evidence-stream','world-evidence-source','world-evidence-a','world-evidence-pipeline','1.2');

INSERT INTO world_object(id,object_type,properties,data_scope_key)
VALUES ('world-evidence-object','UGV','{"name":"Evidence test vehicle"}','world-evidence-a');
INSERT INTO world_object_state(
  object_id,state,confidence,observed_at,received_at,source,source_observation_id,version,
  evidence_kind,projection_policy_version,uncertainty_summary
) VALUES (
  'world-evidence-object','{"status":"AVAILABLE"}',0.95,
  '2026-08-24T10:00:00Z','2026-08-24T10:00:01Z','world-evidence-source','world-evidence-observation-current',10,
  'OBSERVATION','projection-v1','{"horizontalSigmaM":1.5}'
);
INSERT INTO world_object_geometry(object_id,geometry,observed_at)
VALUES ('world-evidence-object',ST_SetSRID(ST_Point(116.4,39.9),4326),'2026-08-24T10:00:00Z');

INSERT INTO world_observation(
  observation_id,observer_type,observer_id,subject_type,subject_id,observation_type,
  geometry,value,confidence,observed_at,received_at,source,correlation_id,metadata,
  schema_version,status,data_scope_key,source_record_key,source_revision_no,origin_kind,
  source_local_target_id,datastream_key,producer_pipeline_key,raw_reference,payload_hash,quality_flags
) VALUES
  ('world-evidence-observation-late','Sensor','sensor-1','UGV','world-evidence-object','position',
   ST_SetSRID(ST_Point(116.39,39.89),4326),'{"status":"STALE_READING"}',0.8,
   '2026-08-24T09:00:00Z','2026-08-24T10:01:00Z','world-evidence-source','world-evidence-correlation','{}',
   '1.2','late','world-evidence-a','late-record',1,'PHYSICAL_SENSOR','world-evidence-object',
   'world-evidence-stream','world-evidence-pipeline','inline://world-evidence/late',repeat('a',64),ARRAY['LATE_EVIDENCE']),
  ('world-evidence-observation-current','Sensor','sensor-1','UGV','world-evidence-object','position',
   ST_SetSRID(ST_Point(116.4,39.9),4326),'{"status":"AVAILABLE"}',0.95,
   '2026-08-24T10:00:00Z','2026-08-24T10:00:01Z','world-evidence-source','world-evidence-correlation','{}',
   '1.2','accepted','world-evidence-a','current-record',1,'PHYSICAL_SENSOR','world-evidence-object',
   'world-evidence-stream','world-evidence-pipeline','inline://world-evidence/current',repeat('b',64),ARRAY[]::text[]);

INSERT INTO world_event(
  event_id,event_type,subject_type,subject_id,event_time,world_version,correlation_id,causation_id,payload
) VALUES
  ('00000000-0000-0000-0000-000000000610','ProjectionChanged','UGV','world-evidence-object',
   '2026-08-24T10:00:00Z',10,'world-evidence-correlation','world-evidence-observation-current','{"status":"AVAILABLE"}'),
  ('00000000-0000-0000-0000-000000000611','LateEvidenceReceived','UGV','world-evidence-object',
   '2026-08-24T09:00:00Z',11,'world-evidence-correlation','world-evidence-observation-late','{"projectionApplied":false}');

SELECT gowm_evidence_v1.set_data_scope('world-evidence-a');
DO $semantics$
DECLARE
  reference_id text;
BEGIN
  SELECT reference_key INTO STRICT reference_id
  FROM world_reference_identity
  WHERE entity_kind='WORLD_OBJECT' AND internal_id='world-evidence-object';

  IF (SELECT world_version FROM gowm_evidence_v1.current_state WHERE reference_key=reference_id) <> 10 THEN
    RAISE EXCEPTION 'late evidence regressed the current projection';
  END IF;
  IF (SELECT count(*) FROM gowm_evidence_v1.observation WHERE reference_key=reference_id) <> 2 OR
     (SELECT observation_id FROM gowm_evidence_v1.observation WHERE reference_key=reference_id ORDER BY observed_at LIMIT 1) <> 'world-evidence-observation-late' THEN
    RAISE EXCEPTION 'observation evidence is not complete and event-time ordered';
  END IF;
  IF (SELECT count(*) FROM gowm_evidence_v1.world_event WHERE reference_key=reference_id) <> 2 OR
     NOT EXISTS (SELECT 1 FROM gowm_evidence_v1.world_event WHERE reference_key=reference_id AND world_version=11) THEN
    RAISE EXCEPTION 'late world event is not independently queryable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gowm_evidence_v1.current_geometry WHERE reference_key=reference_id AND crs='EPSG:4326') OR
     NOT EXISTS (SELECT 1 FROM gowm_evidence_v1.provenance WHERE reference_key=reference_id AND source_observation_id='world-evidence-observation-current') THEN
    RAISE EXCEPTION 'geometry or provenance view is incomplete';
  END IF;

  PERFORM gowm_evidence_v1.set_data_scope('world-evidence-b');
  IF EXISTS (SELECT 1 FROM gowm_evidence_v1.current_state) OR
     EXISTS (SELECT 1 FROM gowm_evidence_v1.observation) OR
     EXISTS (SELECT 1 FROM gowm_evidence_v1.world_event) THEN
    RAISE EXCEPTION 'world evidence leaked across data scopes';
  END IF;

  BEGIN
    UPDATE world_event SET payload='{"mutated":true}' WHERE event_id='00000000-0000-0000-0000-000000000611';
    RAISE EXCEPTION 'world event evidence was mutable';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END
$semantics$;

ROLLBACK;

SELECT 'WORLD_EVIDENCE_READ_CONTRACT_ASSERTIONS_PASS' AS result;
