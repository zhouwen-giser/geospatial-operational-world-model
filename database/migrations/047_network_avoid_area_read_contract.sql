BEGIN;

CREATE FUNCTION gowm_network_v1.arcs_intersecting_areas(
  p_graph_version_id uuid,
  p_areas jsonb
)
RETURNS TABLE(arc_key text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_network_v1
AS $fn$
  SELECT DISTINCT arc.arc_key
  FROM public.network_arc arc
  JOIN public.network_graph_version version
    ON version.graph_version_id = arc.graph_version_id
   AND version.data_scope_key = arc.data_scope_key
  CROSS JOIN LATERAL jsonb_array_elements(p_areas) area
  WHERE arc.graph_version_id = p_graph_version_id
    AND arc.data_scope_key = gowm_network_v1.current_data_scope_key()
    AND version.dataset_scope_key = gowm_network_v1.current_dataset_scope_key()
    AND public.ST_Intersects(
      arc.oriented_geometry,
      public.ST_Transform(
        public.ST_SetSRID(
          public.ST_GeomFromGeoJSON(COALESCE(area->'geometry', area)::text),
          4326
        ),
        public.ST_SRID(arc.oriented_geometry)
      )
    )
  ORDER BY arc.arc_key
$fn$;

REVOKE ALL ON FUNCTION gowm_network_v1.arcs_intersecting_areas(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_network_v1.arcs_intersecting_areas(uuid, jsonb) TO route_planner_provider;

COMMIT;
