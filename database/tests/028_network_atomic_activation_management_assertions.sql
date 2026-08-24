\set ON_ERROR_STOP on

BEGIN;

DO $assert$
BEGIN
  IF has_table_privilege('network_builder','public.network_graph_activation_event','INSERT') THEN
    RAISE EXCEPTION 'network_builder can bypass atomic activation management';
  END IF;
  IF NOT has_function_privilege('network_builder','activate_network_graph_version(uuid,text,text)','EXECUTE') OR
     NOT has_function_privilege('network_builder','resolve_network_build_source_feature(uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'network builder controlled management functions are unavailable';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid='activate_network_graph_version(uuid,text,text)'::regprocedure) OR
     NOT (SELECT prosecdef FROM pg_proc WHERE oid='resolve_network_build_source_feature(uuid,text,text)'::regprocedure) THEN
    RAISE EXCEPTION 'network management functions do not preserve authority boundaries';
  END IF;
END
$assert$;

ROLLBACK;
