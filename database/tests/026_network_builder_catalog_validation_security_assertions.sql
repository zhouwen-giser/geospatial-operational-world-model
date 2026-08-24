\set ON_ERROR_STOP on

BEGIN;

DO $assert$
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid='validate_network_graph_version_source()'::regprocedure) OR
     NOT (SELECT prosecdef FROM pg_proc WHERE oid='validate_network_feature_binding()'::regprocedure) THEN
    RAISE EXCEPTION 'network catalog validation triggers are not controlled definer functions';
  END IF;
  IF has_table_privilege('network_builder', 'public.spatial_dataset_version', 'SELECT') OR
     has_table_privilege('network_builder', 'public.spatial_feature_version', 'SELECT') THEN
    RAISE EXCEPTION 'network_builder received direct Catalog base-table read authority';
  END IF;
END
$assert$;

ROLLBACK;
