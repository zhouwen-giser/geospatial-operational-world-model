BEGIN;
CREATE TABLE gowm_device.ingest_runtime_profile (
 data_scope_key text NOT NULL,device_id text NOT NULL,profile_id text NOT NULL,profile_version text NOT NULL,
 profile jsonb NOT NULL CHECK(jsonb_typeof(profile)='object'),
 content_hash text NOT NULL CHECK(content_hash~'^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(data_scope_key,device_id,profile_id,profile_version),
 FOREIGN KEY(data_scope_key,device_id) REFERENCES gowm_device.device(data_scope_key,device_id),
 CHECK(profile->>'profileId'=profile_id AND profile->>'version'=profile_version
  AND profile->>'dataScopeKey'=data_scope_key AND profile->>'deviceId'=device_id)
);
CREATE FUNCTION gowm_device.protect_ingest_profile() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN RAISE EXCEPTION 'INGEST_RUNTIME_PROFILE_IMMUTABLE' USING ERRCODE='55000'; END $$;
CREATE TRIGGER protect_ingest_profile BEFORE UPDATE OR DELETE ON gowm_device.ingest_runtime_profile
 FOR EACH ROW EXECUTE FUNCTION gowm_device.protect_ingest_profile();
CREATE TABLE gowm_device.ingest_profile_activation (
 data_scope_key text NOT NULL,device_id text NOT NULL,profile_id text NOT NULL,profile_version text NOT NULL,
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(data_scope_key,device_id),
 FOREIGN KEY(data_scope_key,device_id,profile_id,profile_version)
 REFERENCES gowm_device.ingest_runtime_profile(data_scope_key,device_id,profile_id,profile_version)
);
REVOKE ALL ON gowm_device.ingest_runtime_profile FROM PUBLIC;
REVOKE ALL ON gowm_device.ingest_profile_activation FROM PUBLIC;
GRANT SELECT ON gowm_device.ingest_runtime_profile,gowm_device.ingest_profile_activation,public.analysis_space TO gowm_device_reader;
ALTER TABLE ugv_ingest.mqtt_session ADD COLUMN closed_at timestamptz,
 ADD COLUMN close_reason text CHECK(close_reason IS NULL OR length(close_reason) BETWEEN 1 AND 512);
CREATE FUNCTION ugv_ingest.protect_session_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN
 IF (NEW.session_id,NEW.client_id,NEW.broker_id,NEW.session_epoch,NEW.mapper_context_hash,NEW.mapper_context,NEW.source_schema_lock)
  IS DISTINCT FROM (OLD.session_id,OLD.client_id,OLD.broker_id,OLD.session_epoch,OLD.mapper_context_hash,OLD.mapper_context,OLD.source_schema_lock)
  THEN RAISE EXCEPTION 'MQTT_SESSION_IDENTITY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF OLD.closed_at IS NOT NULL AND (NEW.closed_at,NEW.close_reason,NEW.connected_at,NEW.disconnected_at,NEW.disconnect_reason)
  IS DISTINCT FROM (OLD.closed_at,OLD.close_reason,OLD.connected_at,OLD.disconnected_at,OLD.disconnect_reason)
  THEN RAISE EXCEPTION 'MQTT_SESSION_ALREADY_CLOSED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER protect_mqtt_session_identity BEFORE UPDATE ON ugv_ingest.mqtt_session
 FOR EACH ROW EXECUTE FUNCTION ugv_ingest.protect_session_identity();
CREATE FUNCTION ugv_ingest.require_open_session() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 DECLARE ended timestamptz;
 BEGIN
 SELECT closed_at INTO ended FROM ugv_ingest.mqtt_session WHERE session_id=NEW.session_id FOR SHARE;
 IF ended IS NOT NULL THEN RAISE EXCEPTION 'MQTT_SESSION_CLOSED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER inbox_requires_open_session BEFORE INSERT ON ugv_ingest.inbox_message
 FOR EACH ROW EXECUTE FUNCTION ugv_ingest.require_open_session();
REVOKE ALL ON FUNCTION gowm_device.protect_ingest_profile(),ugv_ingest.protect_session_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION ugv_ingest.require_open_session() FROM PUBLIC;
COMMIT;
