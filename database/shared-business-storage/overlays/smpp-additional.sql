ALTER TABLE ugv_smpp.provider_ops_delivery DROP CONSTRAINT provider_ops_delivery_event_key_key, ADD UNIQUE(device_id,event_key);
-- A service job is not a fake device. Lease scope is an explicit resource
-- discriminator; owner never participates in its stable identity.
ALTER TABLE ugv_smpp.runtime_lease DROP CONSTRAINT runtime_lease_pkey;
ALTER TABLE ugv_smpp.runtime_lease ALTER device_id DROP NOT NULL,
 ADD service_key text,
 ADD scope_key text GENERATED ALWAYS AS (CASE WHEN device_id IS NOT NULL THEN 'DEVICE:'||device_id ELSE 'SERVICE:'||service_key END) STORED,
 ADD PRIMARY KEY(scope_key,lease_key),
 ADD CHECK((device_id IS NULL)<>(service_key IS NULL));
CREATE OR REPLACE FUNCTION gowm_device.validate_native_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b gowm_device.device_service_binding; service text;
BEGIN
 IF NEW.device_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO b FROM gowm_device.device_service_binding WHERE binding_id=NEW.gowm_binding_id AND device_id=NEW.device_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'DEVICE_BINDING_MISMATCH'; END IF;
 IF TG_TABLE_SCHEMA='ugv_sdar' THEN service=to_jsonb(NEW)->>'sdar_service_key'; IF service IS DISTINCT FROM b.sdar_service_key THEN RAISE EXCEPTION 'SDAR_SERVICE_BINDING_MISMATCH'; END IF;
 ELSE service=to_jsonb(NEW)->>'smpp_service_key'; IF service IS DISTINCT FROM b.smpp_service_key THEN RAISE EXCEPTION 'SMPP_SERVICE_BINDING_MISMATCH'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gowm_native_binding BEFORE INSERT OR UPDATE ON ugv_smpp.provider_task FOR EACH ROW EXECUTE FUNCTION gowm_device.validate_native_binding();
CREATE TRIGGER gowm_native_binding BEFORE INSERT OR UPDATE ON ugv_smpp.admission_intent FOR EACH ROW EXECUTE FUNCTION gowm_device.validate_native_binding();
CREATE TRIGGER gowm_native_binding BEFORE INSERT OR UPDATE ON ugv_smpp.ugv_execution FOR EACH ROW EXECUTE FUNCTION gowm_device.validate_native_binding();
CREATE FUNCTION gowm_execution.validate_execution_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e ugv_smpp.ugv_execution; phase text;
BEGIN
 SELECT * INTO e FROM ugv_smpp.ugv_execution WHERE task_id=NEW.provider_task_record_id AND device_id=NEW.device_id FOR KEY SHARE;
 IF NOT FOUND OR e.external_execution_id<>NEW.provider_execution_id OR e.gowm_binding_id<>NEW.binding_id OR (NEW.mcp_task_id IS NOT NULL AND e.mcp_task_id IS DISTINCT FROM NEW.mcp_task_id) THEN RAISE EXCEPTION 'EXECUTION_LINK_IDENTITY_CONFLICT'; END IF;
 SELECT j.phase INTO phase FROM ugv_smpp.ugv_mutation_journal j WHERE j.task_id=e.task_id AND j.step_id=NEW.provider_dispatch_step_id;
 IF NEW.relation_kind='CREATED' AND phase IN ('PAUSE','RESUME','CANCEL','EMERGENCY_STOP','CLEANUP') THEN RAISE EXCEPTION 'CONTROL_CANNOT_CREATE_MISSION'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gowm_execution_link BEFORE INSERT OR UPDATE ON gowm_execution.execution_mission_link FOR EACH ROW EXECUTE FUNCTION gowm_execution.validate_execution_link();
