BEGIN;

CREATE FUNCTION gowm_network_v1.coverage_selection_candidates(
  p_graph_version_id uuid,
  p_area jsonb,
  p_mode text,
  p_road_classes text[],
  p_minimum_segment_length_mm bigint,
  p_boundary_tolerance_mm bigint,
  p_limit integer,
  p_arc_keys text[] DEFAULT NULL
)
RETURNS TABLE(
  graph_version text,
  edge_key text,
  arc_key text,
  direction text,
  oneway text,
  start_fraction_ppm integer,
  end_fraction_ppm integer,
  required_length_mm bigint,
  road_class text,
  source_feature_reference_key text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_network_v1
AS $fn$
DECLARE
  area_geometry geometry;
BEGIN
  IF p_graph_version_id IS NULL OR p_mode NOT IN (
       'FULLY_COVERED_EDGE','INTERSECTING_COMPLETE_EDGE','CLIPPED_INSIDE_AREA','MANUAL_OBLIGATIONS'
     ) OR p_road_classes IS NULL OR cardinality(p_road_classes) NOT BETWEEN 1 AND 64
     OR p_minimum_segment_length_mm < 0 OR p_boundary_tolerance_mm NOT BETWEEN 0 AND 100000
     OR p_limit NOT BETWEEN 1 AND 100001 THEN
    RAISE EXCEPTION 'invalid coverage selection request' USING ERRCODE = '22023';
  END IF;

  IF p_mode = 'MANUAL_OBLIGATIONS' THEN
    IF p_arc_keys IS NULL OR cardinality(p_arc_keys) > 100000 THEN
      RAISE EXCEPTION 'invalid manual coverage arc set' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    SELECT version.graph_version, edge.edge_key, arc.arc_key, arc.direction, edge.oneway,
           0::integer, 1000000::integer, arc.length_mm, edge.road_class,
           edge.source_feature_reference_key
    FROM public.network_graph_version version
    JOIN public.network_edge edge USING(graph_version_id,data_scope_key)
    JOIN public.network_arc arc USING(graph_version_id,edge_id,data_scope_key)
    WHERE version.graph_version_id=p_graph_version_id
      AND version.data_scope_key=gowm_network_v1.current_data_scope_key()
      AND version.dataset_scope_key=gowm_network_v1.current_dataset_scope_key()
      AND arc.arc_key=ANY(p_arc_keys)
      AND arc.service_eligible
    ORDER BY arc.arc_key
    LIMIT p_limit;
    RETURN;
  END IF;

  BEGIN
    area_geometry := public.ST_SetSRID(public.ST_GeomFromGeoJSON(p_area::text),4326);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid coverage area geometry' USING ERRCODE = '22023';
  END;
  IF area_geometry IS NULL OR public.ST_IsEmpty(area_geometry) OR NOT public.ST_IsValid(area_geometry)
     OR public.GeometryType(area_geometry) NOT IN ('POLYGON','MULTIPOLYGON')
     OR NOT public.ST_IsSimple(public.ST_Boundary(area_geometry)) THEN
    RAISE EXCEPTION 'invalid coverage area geometry' USING ERRCODE = '22023';
  END IF;
  IF p_boundary_tolerance_mm > 0 THEN
    area_geometry := public.ST_Buffer(area_geometry::geography,p_boundary_tolerance_mm/1000.0)::geometry;
  END IF;

  IF p_mode IN ('FULLY_COVERED_EDGE','INTERSECTING_COMPLETE_EDGE') THEN
    RETURN QUERY
    SELECT version.graph_version,edge.edge_key,arc.arc_key,arc.direction,edge.oneway,
           0::integer,1000000::integer,arc.length_mm,edge.road_class,edge.source_feature_reference_key
    FROM public.network_graph_version version
    JOIN public.network_edge edge USING(graph_version_id,data_scope_key)
    JOIN public.network_arc arc USING(graph_version_id,edge_id,data_scope_key)
    WHERE version.graph_version_id=p_graph_version_id
      AND version.data_scope_key=gowm_network_v1.current_data_scope_key()
      AND version.dataset_scope_key=gowm_network_v1.current_dataset_scope_key()
      AND edge.road_class=ANY(p_road_classes) AND arc.service_eligible
      AND CASE p_mode
        WHEN 'FULLY_COVERED_EDGE' THEN public.ST_Covers(area_geometry,public.ST_Force2D(edge.geometry))
        ELSE public.ST_Intersects(area_geometry,public.ST_Force2D(edge.geometry))
      END
      AND arc.length_mm>=p_minimum_segment_length_mm
    ORDER BY edge.edge_key,arc.arc_key
    LIMIT p_limit;
    RETURN;
  END IF;

  RETURN QUERY
  WITH clips AS (
    SELECT version.graph_version,edge.edge_key,arc.arc_key,arc.direction,edge.oneway,arc.length_mm,
           edge.road_class,edge.source_feature_reference_key,public.ST_Force2D(arc.oriented_geometry) AS arc_geometry,
           (public.ST_Dump(public.ST_CollectionExtract(public.ST_Intersection(
             public.ST_Force2D(arc.oriented_geometry),area_geometry
           ),2))).geom AS clip
    FROM public.network_graph_version version
    JOIN public.network_edge edge USING(graph_version_id,data_scope_key)
    JOIN public.network_arc arc USING(graph_version_id,edge_id,data_scope_key)
    WHERE version.graph_version_id=p_graph_version_id
      AND version.data_scope_key=gowm_network_v1.current_data_scope_key()
      AND version.dataset_scope_key=gowm_network_v1.current_dataset_scope_key()
      AND edge.road_class=ANY(p_road_classes) AND arc.service_eligible
      AND public.ST_Intersects(area_geometry,public.ST_Force2D(edge.geometry))
  ), fractions AS (
    SELECT clips.*,
      round(LEAST(
        public.ST_LineLocatePoint(arc_geometry,public.ST_StartPoint(clip)),
        public.ST_LineLocatePoint(arc_geometry,public.ST_EndPoint(clip))
      )*1000000)::integer AS start_fraction,
      round(GREATEST(
        public.ST_LineLocatePoint(arc_geometry,public.ST_StartPoint(clip)),
        public.ST_LineLocatePoint(arc_geometry,public.ST_EndPoint(clip))
      )*1000000)::integer AS end_fraction
    FROM clips
    WHERE NOT public.ST_IsEmpty(clip) AND public.ST_Length(clip::geography)>0
  )
  SELECT fractions.graph_version,fractions.edge_key,fractions.arc_key,fractions.direction,fractions.oneway,
         fractions.start_fraction,fractions.end_fraction,
         round(fractions.length_mm*(fractions.end_fraction-fractions.start_fraction)/1000000.0)::bigint,
         fractions.road_class,fractions.source_feature_reference_key
  FROM fractions
  WHERE fractions.end_fraction>fractions.start_fraction
    AND round(fractions.length_mm*(fractions.end_fraction-fractions.start_fraction)/1000000.0)::bigint
        >=p_minimum_segment_length_mm
  ORDER BY fractions.edge_key,fractions.arc_key,fractions.start_fraction,fractions.end_fraction
  LIMIT p_limit;
END
$fn$;

REVOKE ALL ON FUNCTION gowm_network_v1.coverage_selection_candidates(
  uuid,jsonb,text,text[],bigint,bigint,integer,text[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_network_v1.coverage_selection_candidates(
  uuid,jsonb,text,text[],bigint,bigint,integer,text[]
) TO coverage_planner_provider;

COMMIT;
