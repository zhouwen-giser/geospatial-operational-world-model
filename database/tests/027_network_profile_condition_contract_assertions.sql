\set ON_ERROR_STOP on

BEGIN;

DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='network_cost_profile_version' AND column_name='surface_weight_ppm') OR
     NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='network_arc_cost' AND column_name='energy_mwh') OR
     NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='network_arc_condition' AND column_name='risk_override_microunits') OR
     NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='network_arc_condition' AND column_name='access_override_mask') OR
     NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='network_arc_condition' AND column_name='cost_multiplier_ppm') THEN
    RAISE EXCEPTION 'network profile/condition contract columns are incomplete';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid='validate_network_cost_profile_version()'::regprocedure) THEN
    RAISE EXCEPTION 'cost profile validator cannot safely inspect profile authority';
  END IF;
  IF has_table_privilege('network_builder', 'public.spatial_dataset_version', 'SELECT') THEN
    RAISE EXCEPTION 'profile alignment widened Catalog base-table access';
  END IF;
END
$assert$;

ROLLBACK;
