BEGIN;

CREATE SCHEMA gowm_network_v1;

CREATE FUNCTION gowm_network_v1.current_data_scope_key()
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('gowm.data_scope_key', true), '') $$;

CREATE FUNCTION gowm_network_v1.current_dataset_scope_key()
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('gowm.dataset_scope_key', true), '') $$;

CREATE FUNCTION gowm_network_v1.set_scope(p_data_scope_key text, p_dataset_scope_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_data_scope_key IS NULL OR p_dataset_scope_key IS NULL OR
     length(p_dataset_scope_key) NOT BETWEEN 1 AND 128 OR
     NOT EXISTS (
       SELECT 1 FROM public.spatial_dataset
       WHERE data_scope_key = p_data_scope_key AND dataset_scope_key = p_dataset_scope_key
     ) THEN
    RAISE EXCEPTION 'network scope is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('gowm.data_scope_key', p_data_scope_key, true);
  PERFORM set_config('gowm.dataset_scope_key', p_dataset_scope_key, true);
END
$fn$;

CREATE VIEW gowm_network_v1.graph_version WITH (security_barrier = true) AS
SELECT graph.graph_key, version.graph_version_id, version.graph_version,
       dataset.reference_key AS dataset_reference_key, dataset_version.version AS dataset_version,
       version.build_policy_version, version.source_content_hash, version.topology_hash,
       version.content_hash, version.node_count, version.edge_count, version.arc_count,
       version.turn_rule_count, version.status, version.build_receipt_id, version.created_at
FROM public.network_graph graph
JOIN public.network_graph_version version
  ON version.graph_id = graph.graph_id
 AND version.dataset_id = graph.dataset_id
 AND version.data_scope_key = graph.data_scope_key
 AND version.dataset_scope_key = graph.dataset_scope_key
JOIN public.spatial_dataset dataset
  ON dataset.dataset_id = graph.dataset_id
 AND dataset.data_scope_key = graph.data_scope_key
 AND dataset.dataset_scope_key = graph.dataset_scope_key
JOIN public.spatial_dataset_version dataset_version
  ON dataset_version.dataset_version_id = version.dataset_version_id
 AND dataset_version.dataset_id = graph.dataset_id
WHERE graph.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND graph.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

CREATE VIEW gowm_network_v1.node WITH (security_barrier = true) AS
SELECT node.graph_version_id, node.node_id, node.node_key, node.geometry,
       node.elevation_mm, node.topology_identity
FROM public.network_node node
JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
WHERE node.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

CREATE VIEW gowm_network_v1.edge WITH (security_barrier = true) AS
SELECT edge.graph_version_id, edge.edge_id, edge.edge_key, edge.source_node_id,
       edge.target_node_id, edge.source_feature_reference_key, edge.geometry,
       edge.length_mm, edge.road_class, edge.surface, edge.is_bridge, edge.is_tunnel,
       edge.layer_level, edge.width_mm, edge.height_limit_mm, edge.weight_limit_grams,
       edge.lane_count, edge.oneway, edge.access_attributes
FROM public.network_edge edge
JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
WHERE edge.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

CREATE VIEW gowm_network_v1.arc WITH (security_barrier = true) AS
SELECT arc.graph_version_id, arc.arc_id, arc.arc_key, arc.edge_id, arc.source_node_id,
       arc.target_node_id, arc.direction, arc.oriented_geometry, arc.length_mm,
       arc.default_speed_mm_per_s, arc.transit_eligible, arc.service_eligible,
       arc.access_mask, arc.profile_constraints
FROM public.network_arc arc
JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
WHERE arc.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

CREATE VIEW gowm_network_v1.turn_rule WITH (security_barrier = true) AS
SELECT rule.graph_version_id, rule.rule_key, rule.from_arc_id, rule.via_node_id,
       rule.to_arc_id, rule.rule_type, rule.penalty_units, rule.profile_filter,
       rule.evidence, rule.content_hash
FROM public.network_turn_rule rule
JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
WHERE rule.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

CREATE VIEW gowm_network_v1.turn_sequence_rule WITH (security_barrier = true) AS
SELECT rule.graph_version_id, rule.rule_key, rule.arc_sequence, rule.rule_type,
       rule.penalty_units, rule.profile_filter, rule.evidence,
       rule.automaton_hash, rule.content_hash
FROM public.network_turn_sequence_rule rule
JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
WHERE rule.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

CREATE VIEW gowm_network_v1.travel_profile WITH (security_barrier = true) AS
SELECT profile.profile_key, version.travel_profile_version_id, version.version,
       version.mode, version.required_access_mask, version.maximum_speed_mm_per_s,
       version.constraints, version.content_hash
FROM public.network_travel_profile profile
JOIN public.network_travel_profile_version version USING (travel_profile_id, data_scope_key)
WHERE profile.data_scope_key = gowm_network_v1.current_data_scope_key();

CREATE VIEW gowm_network_v1.cost_profile WITH (security_barrier = true) AS
SELECT profile.profile_key, version.cost_profile_version_id,
       version.travel_profile_version_id, version.version,
       version.distance_weight_ppm, version.duration_weight_ppm,
       version.risk_weight_ppm, version.energy_weight_ppm,
       version.formula, version.content_hash
FROM public.network_cost_profile profile
JOIN public.network_cost_profile_version version USING (cost_profile_id, travel_profile_id, data_scope_key)
WHERE profile.data_scope_key = gowm_network_v1.current_data_scope_key();

CREATE VIEW gowm_network_v1.arc_cost WITH (security_barrier = true) AS
SELECT cost.graph_version_id, cost.arc_id, cost.travel_profile_version_id,
       cost.cost_profile_version_id, cost.distance_mm, cost.duration_ms,
       cost.risk_microunits, cost.energy_millijoules,
       cost.combined_cost_units, cost.content_hash
FROM public.network_arc_cost cost
JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
WHERE cost.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

CREATE VIEW gowm_network_v1.condition_snapshot WITH (security_barrier = true) AS
SELECT snapshot.graph_version_id, snapshot.condition_snapshot_id,
       snapshot.condition_snapshot_key, snapshot.source_snapshot_version,
       snapshot.observed_at, snapshot.valid_until, snapshot.completeness,
       snapshot.source_content_hash, snapshot.content_hash, snapshot.metadata
FROM public.network_condition_snapshot snapshot
JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
WHERE snapshot.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

CREATE VIEW gowm_network_v1.arc_condition WITH (security_barrier = true) AS
SELECT condition.condition_snapshot_id, condition.graph_version_id,
       condition.arc_id, condition.traversal_allowed,
       condition.speed_override_mm_per_s, condition.penalty_units,
       condition.reason_codes, condition.evidence, condition.content_hash
FROM public.network_arc_condition condition
JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
WHERE condition.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

CREATE FUNCTION gowm_network_v1.resolve_active_graph(p_graph_key text)
RETURNS TABLE(
  graph_version_id uuid,
  graph_key text,
  graph_version text,
  topology_hash text,
  content_hash text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_network_v1
AS $fn$
  WITH target_graph AS (
    SELECT graph.graph_id, graph.graph_key
    FROM public.network_graph graph
    WHERE graph.data_scope_key = gowm_network_v1.current_data_scope_key()
      AND graph.dataset_scope_key = gowm_network_v1.current_dataset_scope_key()
      AND graph.graph_key = p_graph_key
  ), latest_event AS (
    SELECT event.*
    FROM public.network_graph_activation_event event
    JOIN target_graph graph USING (graph_id)
    WHERE event.data_scope_key = gowm_network_v1.current_data_scope_key()
      AND event.dataset_scope_key = gowm_network_v1.current_dataset_scope_key()
    ORDER BY event.created_at DESC, event.activation_event_id DESC
    LIMIT 1
  )
  SELECT version.graph_version_id, graph.graph_key, version.graph_version,
         version.topology_hash, version.content_hash
  FROM latest_event event
  JOIN target_graph graph USING (graph_id)
  JOIN public.network_graph_version version USING (graph_version_id)
  WHERE event.event_type = 'ACTIVATE'
$fn$;

CREATE FUNCTION gowm_network_v1.resolve_routing_snapshot(
  p_graph_version_id uuid,
  p_travel_profile_version_id uuid,
  p_cost_profile_version_id uuid,
  p_condition_snapshot_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_network_v1
AS $fn$
  SELECT jsonb_build_object(
    'graphVersionId', graph.graph_version_id,
    'graphContentHash', graph.content_hash,
    'topologyHash', graph.topology_hash,
    'travelProfileVersionId', travel.travel_profile_version_id,
    'travelProfileContentHash', travel.content_hash,
    'costProfileVersionId', cost.cost_profile_version_id,
    'costProfileContentHash', cost.content_hash,
    'conditionSnapshotId', condition.condition_snapshot_id,
    'conditionContentHash', condition.content_hash,
    'conditionValidUntil', condition.valid_until
  )
  FROM public.network_graph_version graph
  JOIN public.network_travel_profile_version travel
    ON travel.travel_profile_version_id = p_travel_profile_version_id
   AND travel.data_scope_key = graph.data_scope_key
  JOIN public.network_cost_profile_version cost
    ON cost.cost_profile_version_id = p_cost_profile_version_id
   AND cost.travel_profile_version_id = travel.travel_profile_version_id
   AND cost.data_scope_key = graph.data_scope_key
  JOIN public.network_condition_snapshot condition
    ON condition.condition_snapshot_id = p_condition_snapshot_id
   AND condition.graph_version_id = graph.graph_version_id
   AND condition.data_scope_key = graph.data_scope_key
  WHERE graph.graph_version_id = p_graph_version_id
    AND graph.data_scope_key = gowm_network_v1.current_data_scope_key()
    AND graph.dataset_scope_key = gowm_network_v1.current_dataset_scope_key()
$fn$;

CREATE FUNCTION gowm_network_v1.snap_candidates(
  p_graph_version_id uuid,
  p_point geometry,
  p_limit integer DEFAULT 8
)
RETURNS TABLE(
  arc_id bigint,
  arc_key text,
  fraction_ppm integer,
  distance_mm bigint,
  snapped_point geometry(Point, 4326)
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_network_v1
AS $fn$
BEGIN
  IF p_point IS NULL OR ST_IsEmpty(p_point) OR ST_SRID(p_point) <> 4326 OR
     GeometryType(p_point) <> 'POINT' OR p_limit NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'invalid network snap request' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT arc.arc_id, arc.arc_key,
         round(ST_LineLocatePoint(ST_Force2D(arc.oriented_geometry), ST_Force2D(p_point)) * 1000000)::integer,
         round(ST_Distance(
           ST_ClosestPoint(ST_Force2D(arc.oriented_geometry), ST_Force2D(p_point))::geography,
           ST_Force2D(p_point)::geography
         ) * 1000)::bigint,
         ST_ClosestPoint(ST_Force2D(arc.oriented_geometry), ST_Force2D(p_point))::geometry(Point,4326)
  FROM public.network_arc arc
  JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
  WHERE arc.graph_version_id = p_graph_version_id
    AND arc.data_scope_key = gowm_network_v1.current_data_scope_key()
    AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key()
  ORDER BY arc.oriented_geometry <-> p_point, arc.arc_key
  LIMIT p_limit;
END
$fn$;

CREATE FUNCTION gowm_network_v1.routing_arc_projection(
  p_graph_version_id uuid,
  p_travel_profile_version_id uuid,
  p_cost_profile_version_id uuid,
  p_condition_snapshot_id uuid
)
RETURNS TABLE(
  id bigint,
  source bigint,
  target bigint,
  cost float8,
  reverse_cost float8,
  arc_key text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_network_v1
AS $fn$
  SELECT arc.arc_id AS id, arc.source_node_id AS source, arc.target_node_id AS target,
         (base.combined_cost_units + COALESCE(condition.penalty_units, 0))::float8 AS cost,
         (-1)::float8 AS reverse_cost, arc.arc_key
  FROM public.network_arc arc
  JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
  JOIN public.network_arc_cost base
    ON base.graph_version_id = arc.graph_version_id AND base.arc_id = arc.arc_id
   AND base.data_scope_key = arc.data_scope_key
   AND base.travel_profile_version_id = p_travel_profile_version_id
   AND base.cost_profile_version_id = p_cost_profile_version_id
  LEFT JOIN public.network_arc_condition condition
    ON condition.condition_snapshot_id = p_condition_snapshot_id
   AND condition.graph_version_id = arc.graph_version_id
   AND condition.arc_id = arc.arc_id
   AND condition.data_scope_key = arc.data_scope_key
  WHERE arc.graph_version_id = p_graph_version_id
    AND arc.data_scope_key = gowm_network_v1.current_data_scope_key()
    AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key()
    AND COALESCE(condition.traversal_allowed, true)
$fn$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'network_provider') THEN
    CREATE ROLE network_provider NOLOGIN INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'route_planner_provider') THEN
    CREATE ROLE route_planner_provider NOLOGIN INHERIT;
  END IF;
END
$roles$;

REVOKE ALL ON SCHEMA gowm_network_v1 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA gowm_network_v1 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gowm_network_v1 FROM PUBLIC;
GRANT USAGE ON SCHEMA gowm_network_v1 TO network_builder, network_provider, route_planner_provider;
GRANT SELECT ON ALL TABLES IN SCHEMA gowm_network_v1 TO network_builder, network_provider, route_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.current_data_scope_key() TO network_builder, network_provider, route_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.current_dataset_scope_key() TO network_builder, network_provider, route_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.set_scope(text, text) TO network_builder, network_provider, route_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.resolve_active_graph(text) TO network_builder, network_provider, route_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.resolve_routing_snapshot(uuid, uuid, uuid, uuid) TO network_provider, route_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.snap_candidates(uuid, geometry, integer) TO network_provider, route_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.routing_arc_projection(uuid, uuid, uuid, uuid) TO route_planner_provider;

ALTER ROLE network_provider SET default_transaction_read_only = on;
ALTER ROLE network_provider SET statement_timeout = '10s';
ALTER ROLE route_planner_provider SET default_transaction_read_only = on;
ALTER ROLE route_planner_provider SET statement_timeout = '30s';

COMMIT;
