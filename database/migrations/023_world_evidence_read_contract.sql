BEGIN;

CREATE FUNCTION protect_world_event_evidence()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'world_event is append-only' USING ERRCODE='55000'; END IF;
  IF (to_jsonb(NEW)-'published_at') IS DISTINCT FROM (to_jsonb(OLD)-'published_at') THEN
    RAISE EXCEPTION 'world event evidence is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER world_event_evidence_immutable
  BEFORE UPDATE OR DELETE ON world_event
  FOR EACH ROW EXECUTE FUNCTION protect_world_event_evidence();

CREATE SCHEMA gowm_evidence_v1;

CREATE FUNCTION gowm_evidence_v1.current_data_scope_key()
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('gowm.data_scope_key',true),'') $$;

CREATE FUNCTION gowm_evidence_v1.set_data_scope(p_scope_key text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $fn$
BEGIN
  IF p_scope_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.data_scope WHERE scope_key=p_scope_key) THEN
    RAISE EXCEPTION 'evidence scope is unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('gowm.data_scope_key',p_scope_key,true);
END
$fn$;

CREATE VIEW gowm_evidence_v1.current_state AS
SELECT identity.reference_key,
       jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',identity.reference_key,'version',state.version::text) AS reference_key_value,
       object.object_type,object.subtype,object.properties,state.state,
       state.confidence,state.observed_at,state.received_at,state.source,
       state.source_observation_id,state.version AS world_version,state.updated_at,
       CASE WHEN state.observed_at IS NULL THEN NULL ELSE
         GREATEST(0,floor(extract(epoch FROM (clock_timestamp()-state.observed_at))*1000))::bigint END AS freshness_ms,
       state.evidence_kind,state.projection_policy_version,state.time_solution_id,
       state.position_measurement_id,state.uncertainty_summary
FROM world_object object
JOIN world_object_state state ON state.object_id=object.id
JOIN world_reference_identity identity
  ON identity.entity_kind='WORLD_OBJECT' AND identity.internal_id=object.id
WHERE object.deleted_at IS NULL
  AND object.data_scope_key=gowm_evidence_v1.current_data_scope_key();

CREATE VIEW gowm_evidence_v1.current_geometry AS
SELECT identity.reference_key,
       jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',identity.reference_key,'version',state.version::text) AS reference_key_value,
       ST_AsGeoJSON(geometry.geometry)::jsonb AS geometry,
       GeometryType(geometry.geometry) AS geometry_type,
       jsonb_build_array(ST_XMin(Box2D(geometry.geometry)),ST_YMin(Box2D(geometry.geometry)),
                         ST_XMax(Box2D(geometry.geometry)),ST_YMax(Box2D(geometry.geometry))) AS bbox,
       'EPSG:4326'::text AS crs,state.version AS world_version,
       geometry.observed_at,geometry.updated_at
FROM world_object object
JOIN world_object_state state ON state.object_id=object.id
JOIN world_object_geometry geometry ON geometry.object_id=object.id
JOIN world_reference_identity identity
  ON identity.entity_kind='WORLD_OBJECT' AND identity.internal_id=object.id
WHERE object.deleted_at IS NULL
  AND object.data_scope_key=gowm_evidence_v1.current_data_scope_key();

CREATE VIEW gowm_evidence_v1.provenance AS
SELECT identity.reference_key,
       jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',identity.reference_key,'version',state.version::text) AS reference_key_value,
       state.version AS world_version,state.source,state.source_observation_id,
       state.evidence_kind,state.projection_policy_version,state.time_solution_id,
       state.position_measurement_id,state.uncertainty_summary,state.confidence,
       state.observed_at,state.received_at,state.updated_at
FROM world_object object
JOIN world_object_state state ON state.object_id=object.id
JOIN world_reference_identity identity
  ON identity.entity_kind='WORLD_OBJECT' AND identity.internal_id=object.id
WHERE object.deleted_at IS NULL
  AND object.data_scope_key=gowm_evidence_v1.current_data_scope_key();

CREATE VIEW gowm_evidence_v1.observation AS
SELECT identity.reference_key,
       jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',identity.reference_key,'version',
         COALESCE(descriptor.descriptor_version::text,'1')) AS reference_key_value,
       observation.observation_id,observation.observer_type,observation.observer_id,
       observation.subject_type,observation.observation_type,
       CASE WHEN observation.geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(observation.geometry)::jsonb END AS geometry,
       observation.value,observation.confidence,observation.observed_at,
       observation.received_at,observation.source,observation.correlation_id,
       observation.metadata,observation.schema_version,observation.status,
       observation.origin_kind,observation.source_record_key,
       observation.source_revision_no,observation.supersedes_observation_id,
       observation.raw_reference,observation.payload_hash,observation.quality_flags,
       observation.created_at
FROM world_observation observation
JOIN world_reference_identity identity
  ON identity.entity_kind='WORLD_OBJECT' AND identity.internal_id=observation.subject_id
LEFT JOIN LATERAL (
  SELECT version.descriptor_version FROM world_reference_descriptor_version version
  WHERE version.reference_key=identity.reference_key ORDER BY version.descriptor_version DESC LIMIT 1
) descriptor ON true
WHERE observation.data_scope_key=gowm_evidence_v1.current_data_scope_key();

CREATE VIEW gowm_evidence_v1.world_event AS
SELECT identity.reference_key,
       jsonb_build_object('namespace','gowm','kind','WORLD_OBJECT','id',identity.reference_key,'version',
         COALESCE(descriptor.descriptor_version::text,'1')) AS reference_key_value,
       event.event_id::text,event.event_type,event.subject_type,event.event_time,
       CASE WHEN event.geometry IS NULL THEN NULL ELSE ST_AsGeoJSON(event.geometry)::jsonb END AS geometry,
       event.world_version,event.correlation_id,event.causation_id,event.payload,
       event.schema_version,event.published_at,event.created_at
FROM world_event event
JOIN world_object object ON object.id=event.subject_id
JOIN world_reference_identity identity
  ON identity.entity_kind='WORLD_OBJECT' AND identity.internal_id=object.id
LEFT JOIN LATERAL (
  SELECT version.descriptor_version FROM world_reference_descriptor_version version
  WHERE version.reference_key=identity.reference_key ORDER BY version.descriptor_version DESC LIMIT 1
) descriptor ON true
WHERE object.data_scope_key=gowm_evidence_v1.current_data_scope_key();

CREATE VIEW gowm_evidence_v1.scope_resource AS
SELECT identity.reference_key,
       jsonb_build_object('namespace','gowm','kind','DATA_SCOPE','id',identity.reference_key,'version','1') AS reference_key_value
FROM world_reference_identity identity
WHERE identity.entity_kind='DATA_SCOPE'
  AND identity.data_scope_key=gowm_evidence_v1.current_data_scope_key();

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gowm_evidence_reader') THEN CREATE ROLE gowm_evidence_reader NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gowm_evidence_service') THEN CREATE ROLE gowm_evidence_service NOLOGIN INHERIT; END IF;
END
$roles$;

REVOKE ALL ON FUNCTION protect_world_event_evidence() FROM PUBLIC;
REVOKE ALL ON SCHEMA gowm_evidence_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_evidence_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_evidence_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA gowm_evidence_v1 TO gowm_evidence_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA gowm_evidence_v1 TO gowm_evidence_reader;
GRANT EXECUTE ON FUNCTION gowm_evidence_v1.current_data_scope_key() TO gowm_evidence_reader;
GRANT EXECUTE ON FUNCTION gowm_evidence_v1.set_data_scope(text) TO gowm_evidence_reader;
GRANT gowm_evidence_reader,gowm_result_reader TO gowm_evidence_service;
ALTER ROLE gowm_evidence_service SET default_transaction_read_only=on;
ALTER ROLE gowm_evidence_service SET statement_timeout='10s';

COMMIT;
