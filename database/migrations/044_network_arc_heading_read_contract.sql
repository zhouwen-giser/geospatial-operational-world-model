BEGIN;

CREATE OR REPLACE VIEW gowm_network_v1.arc WITH (security_barrier = true) AS
SELECT arc.graph_version_id, arc.arc_id, arc.arc_key, arc.edge_id, arc.source_node_id,
       arc.target_node_id, arc.direction, arc.oriented_geometry, arc.length_mm,
       arc.default_speed_mm_per_s, arc.transit_eligible, arc.service_eligible,
       arc.access_mask, arc.profile_constraints,
       round(degrees(ST_Azimuth(
         ST_StartPoint(ST_Force2D(arc.oriented_geometry)),
         ST_EndPoint(ST_Force2D(arc.oriented_geometry))
       )) * 1000000)::bigint AS heading_microdegrees
FROM public.network_arc arc
JOIN public.network_graph_version version USING (graph_version_id, data_scope_key)
WHERE arc.data_scope_key = gowm_network_v1.current_data_scope_key()
  AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key();

CREATE FUNCTION gowm_network_v1.snap_candidates_wgs84(
  p_graph_version_id uuid,
  p_longitude float8,
  p_latitude float8,
  p_limit integer DEFAULT 8
)
RETURNS TABLE(
  arc_id bigint,
  arc_key text,
  fraction_ppm integer,
  distance_mm bigint,
  snapped_point geometry(Point, 4326)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_network_v1
AS $fn$
  SELECT *
  FROM gowm_network_v1.snap_candidates(
    p_graph_version_id,
    ST_SetSRID(ST_MakePoint(p_longitude, p_latitude), 4326),
    p_limit
  )
$fn$;

REVOKE ALL ON FUNCTION gowm_network_v1.snap_candidates_wgs84(uuid, float8, float8, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_network_v1.snap_candidates_wgs84(uuid, float8, float8, integer) TO network_provider, route_planner_provider;

COMMIT;
