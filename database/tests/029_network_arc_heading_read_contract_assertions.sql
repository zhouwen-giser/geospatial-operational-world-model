BEGIN;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'gowm_network_v1' AND table_name = 'arc'
      AND column_name = 'heading_microdegrees' AND data_type = 'bigint'
  ) THEN
    RAISE EXCEPTION 'gowm_network_v1.arc heading is unavailable';
  END IF;
  IF has_schema_privilege('network_provider', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'network_provider must not gain public schema usage for heading calculation';
  END IF;
  IF NOT has_table_privilege('network_provider', 'gowm_network_v1.arc', 'SELECT') THEN
    RAISE EXCEPTION 'network_provider lost arc read-contract access';
  END IF;
  IF NOT has_function_privilege('network_provider', 'gowm_network_v1.snap_candidates_wgs84(uuid,double precision,double precision,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'network_provider lacks controlled WGS84 snapping access';
  END IF;
  IF has_function_privilege('public', 'gowm_network_v1.snap_candidates_wgs84(uuid,double precision,double precision,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'controlled WGS84 snapping is executable by PUBLIC';
  END IF;
END
$assert$;

ROLLBACK;
