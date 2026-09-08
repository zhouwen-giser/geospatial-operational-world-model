BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gowm_device_reader') THEN
    CREATE ROLE gowm_device_reader NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public,gowm_device,gowm_reference_v1 TO gowm_device_reader;
GRANT SELECT ON gowm_device.device,gowm_device.mqtt_endpoint,gowm_device.device_stream,
  gowm_device.device_service_binding,public.datastream,public.world_object,
  public.world_reference_identity,public.world_reference_retirement,
  gowm_reference_v1.identity TO gowm_device_reader;
GRANT EXECUTE ON FUNCTION gowm_reference_v1.current_data_scope_key() TO gowm_device_reader;
COMMIT;
