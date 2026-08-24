BEGIN;

ALTER FUNCTION validate_network_activation_event() SECURITY DEFINER;

CREATE FUNCTION resolve_network_build_source_feature(
  p_graph_version_id uuid,
  p_source_feature_reference_key text,
  p_source_feature_version text
)
RETURNS TABLE(source_feature_id uuid, source_feature_version_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT identity.feature_id, version.feature_version_id
  FROM public.network_graph_version graph_version
  JOIN public.spatial_layer layer
    ON layer.dataset_id = graph_version.dataset_id
   AND layer.data_scope_key = graph_version.data_scope_key
   AND layer.dataset_scope_key = graph_version.dataset_scope_key
  JOIN public.spatial_feature_identity identity
    ON identity.layer_id = layer.layer_id
   AND identity.data_scope_key = graph_version.data_scope_key
   AND identity.dataset_scope_key = graph_version.dataset_scope_key
  JOIN public.spatial_feature_version version
    ON version.feature_id = identity.feature_id
   AND version.layer_id = identity.layer_id
  WHERE graph_version.graph_version_id = p_graph_version_id
    AND identity.reference_key = p_source_feature_reference_key
    AND version.version = p_source_feature_version
$fn$;

CREATE FUNCTION activate_network_graph_version(
  p_graph_version_id uuid,
  p_activation_policy_version text,
  p_actor_reference_key text
)
RETURNS TABLE(previous_graph_version_id uuid, active_graph_version_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  target public.network_graph_version%ROWTYPE;
  previous_id uuid;
BEGIN
  SELECT * INTO STRICT target
  FROM public.network_graph_version
  WHERE graph_version_id = p_graph_version_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(target.graph_id::text, 0));

  SELECT event.graph_version_id INTO previous_id
  FROM public.network_graph_activation_event event
  WHERE event.graph_id = target.graph_id
    AND event.data_scope_key = target.data_scope_key
    AND event.dataset_scope_key = target.dataset_scope_key
  ORDER BY event.created_at DESC, event.activation_event_id DESC
  LIMIT 1;

  IF previous_id = p_graph_version_id THEN
    RETURN QUERY SELECT previous_id, p_graph_version_id;
    RETURN;
  END IF;

  IF previous_id IS NOT NULL THEN
    INSERT INTO public.network_graph_activation_event(
      graph_id,graph_version_id,previous_graph_version_id,data_scope_key,dataset_scope_key,
      event_type,activation_policy_version,actor_reference_key,event_hash
    ) VALUES (
      target.graph_id,previous_id,previous_id,target.data_scope_key,target.dataset_scope_key,
      'RETIRE',p_activation_policy_version,p_actor_reference_key,
      'sha256:' || encode(digest(concat_ws(':','RETIRE',target.graph_id::text,previous_id::text,
        p_graph_version_id::text,p_activation_policy_version,p_actor_reference_key),'sha256'),'hex')
    );
  END IF;

  INSERT INTO public.network_graph_activation_event(
    graph_id,graph_version_id,previous_graph_version_id,data_scope_key,dataset_scope_key,
    event_type,activation_policy_version,actor_reference_key,event_hash
  ) VALUES (
    target.graph_id,p_graph_version_id,previous_id,target.data_scope_key,target.dataset_scope_key,
    'ACTIVATE',p_activation_policy_version,p_actor_reference_key,
    'sha256:' || encode(digest(concat_ws(':','ACTIVATE',target.graph_id::text,p_graph_version_id::text,
      COALESCE(previous_id::text,'NONE'),p_activation_policy_version,p_actor_reference_key),'sha256'),'hex')
  );
  RETURN QUERY SELECT previous_id, p_graph_version_id;
END
$fn$;

REVOKE INSERT ON network_graph_activation_event FROM network_builder;
REVOKE ALL ON FUNCTION resolve_network_build_source_feature(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION activate_network_graph_version(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_network_build_source_feature(uuid,text,text) TO network_builder;
GRANT EXECUTE ON FUNCTION activate_network_graph_version(uuid,text,text) TO network_builder;

COMMIT;
