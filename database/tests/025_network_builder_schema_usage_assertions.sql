\set ON_ERROR_STOP on

BEGIN;

DO $assert$
BEGIN
  IF NOT has_schema_privilege('network_builder', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'network_builder cannot resolve its explicitly granted network tables';
  END IF;
  IF NOT has_table_privilege('network_builder', 'public.network_node', 'SELECT') OR
     NOT has_table_privilege('network_builder', 'public.network_node', 'INSERT') THEN
    RAISE EXCEPTION 'network_builder lacks required topology build grants';
  END IF;
  IF has_table_privilege('network_builder', 'public.network_node', 'UPDATE') OR
     has_table_privilege('network_builder', 'public.network_node', 'DELETE') THEN
    RAISE EXCEPTION 'network_builder received mutable topology authority';
  END IF;
END
$assert$;

ROLLBACK;
