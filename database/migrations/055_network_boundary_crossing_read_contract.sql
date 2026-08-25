BEGIN;

CREATE FUNCTION gowm_network_v1.segment_boundary_crossings(
  p_graph_version_id uuid,
  p_area jsonb,
  p_arc_key text,
  p_start_fraction_ppm integer,
  p_end_fraction_ppm integer
)
RETURNS TABLE(
  sequence integer,
  kind text,
  arc_key text,
  fraction_ppm integer,
  direction text,
  point jsonb,
  classification text,
  evidence_hash text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_network_v1
AS $fn$
DECLARE
  v_geometry geometry;
  v_area geometry;
  v_segment geometry;
  v_boundary_intersection geometry;
BEGIN
  IF p_start_fraction_ppm NOT BETWEEN 0 AND 1000000 OR
     p_end_fraction_ppm NOT BETWEEN 0 AND 1000000 OR
     p_start_fraction_ppm >= p_end_fraction_ppm OR
     p_area IS NULL OR jsonb_typeof(p_area) <> 'object' THEN
    RAISE EXCEPTION 'invalid boundary crossing request' USING ERRCODE = '22023';
  END IF;

  SELECT arc.oriented_geometry
  INTO v_geometry
  FROM gowm_network_v1.arc arc
  WHERE arc.graph_version_id = p_graph_version_id
    AND arc.arc_key = CASE WHEN p_arc_key ~ '^arc_[0-9a-f]{32,64}$' THEN 'ar_' || substr(p_arc_key, 5) ELSE p_arc_key END
  ORDER BY arc.arc_id
  LIMIT 1;
  IF v_geometry IS NULL THEN
    RAISE EXCEPTION 'versioned network Arc is unavailable' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_area := public.ST_Transform(
      public.ST_SetSRID(public.ST_GeomFromGeoJSON(COALESCE(p_area->'geometry', p_area)::text), 4326),
      public.ST_SRID(v_geometry)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'boundary area is invalid GeoJSON' USING ERRCODE = '22023';
  END;
  IF public.ST_IsEmpty(v_area) OR NOT public.ST_IsValid(v_area) OR GeometryType(v_area) NOT IN ('POLYGON','MULTIPOLYGON') THEN
    RAISE EXCEPTION 'boundary area must be a valid non-empty Polygon or MultiPolygon' USING ERRCODE = '22023';
  END IF;

  v_segment := public.ST_LineSubstring(v_geometry, p_start_fraction_ppm / 1000000.0, p_end_fraction_ppm / 1000000.0);
  v_boundary_intersection := public.ST_Intersection(v_segment, public.ST_Boundary(v_area));
  IF public.ST_Dimension(v_boundary_intersection) = 1 THEN
    RAISE EXCEPTION 'route overlaps the area boundary and cannot be classified deterministically' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH points AS (
    SELECT DISTINCT public.ST_LineLocatePoint(v_geometry, (dumped).geom) AS fraction,
           (dumped).geom AS crossing_point
    FROM public.ST_Dump(public.ST_CollectionExtract(v_boundary_intersection, 1)) dumped
  ), classified AS (
    SELECT points.*,
           round(points.fraction * 1000000)::integer AS fraction_value,
           public.ST_Covers(v_area, public.ST_LineInterpolatePoint(v_geometry, greatest(0.0, points.fraction - 0.000001))) AS before_inside,
           public.ST_Covers(v_area, public.ST_LineInterpolatePoint(v_geometry, least(1.0, points.fraction + 0.000001))) AS after_inside
    FROM points
    WHERE round(points.fraction * 1000000)::integer BETWEEN p_start_fraction_ppm AND p_end_fraction_ppm
  ), crossings AS (
    SELECT * FROM classified WHERE before_inside <> after_inside
  )
  SELECT row_number() OVER (ORDER BY crossings.fraction_value, crossings.crossing_point::text)::integer,
         CASE WHEN crossings.after_inside THEN 'ENTRY' ELSE 'EXIT' END,
         CASE WHEN p_arc_key ~ '^arc_' THEN p_arc_key ELSE 'arc_' || substr(p_arc_key, 4) END,
         crossings.fraction_value,
         arc.direction,
         public.ST_AsGeoJSON(public.ST_Transform(crossings.crossing_point, 4326))::jsonb,
         'CROSSING',
         'sha256:' || encode(public.digest(concat_ws('|', p_graph_version_id::text, p_arc_key, crossings.fraction_value::text, CASE WHEN crossings.after_inside THEN 'ENTRY' ELSE 'EXIT' END), 'sha256'), 'hex')
  FROM crossings
  CROSS JOIN LATERAL (
    SELECT value.direction
    FROM gowm_network_v1.arc value
    WHERE value.graph_version_id = p_graph_version_id
      AND value.arc_key = CASE WHEN p_arc_key ~ '^arc_[0-9a-f]{32,64}$' THEN 'ar_' || substr(p_arc_key, 5) ELSE p_arc_key END
    ORDER BY value.arc_id LIMIT 1
  ) arc
  ORDER BY crossings.fraction_value, kind;
END
$fn$;

CREATE FUNCTION gowm_network_v1.route_boundary_crossings(
  p_graph_version_id uuid,
  p_area jsonb,
  p_segments jsonb
)
RETURNS TABLE(
  sequence integer,
  route_sequence integer,
  kind text,
  arc_key text,
  fraction_ppm integer,
  direction text,
  point jsonb,
  classification text,
  evidence_hash text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_network_v1
AS $fn$
BEGIN
  IF p_segments IS NULL OR jsonb_typeof(p_segments) <> 'array' OR jsonb_array_length(p_segments) > 100000 THEN
    RAISE EXCEPTION 'route boundary segments must be a bounded array' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH segments AS (
    SELECT value, ordinality::integer AS route_sequence
    FROM jsonb_array_elements(p_segments) WITH ORDINALITY item(value, ordinality)
  ), events AS (
    SELECT segments.route_sequence, crossing.*
    FROM segments
    CROSS JOIN LATERAL gowm_network_v1.segment_boundary_crossings(
      p_graph_version_id,
      p_area,
      segments.value->>'arcKey',
      (segments.value->>'startFractionPpm')::integer,
      (segments.value->>'endFractionPpm')::integer
    ) crossing
  )
  SELECT row_number() OVER (ORDER BY events.route_sequence, events.fraction_ppm, events.kind)::integer,
         events.route_sequence, events.kind, events.arc_key, events.fraction_ppm,
         events.direction, events.point, events.classification, events.evidence_hash
  FROM events
  ORDER BY events.route_sequence, events.fraction_ppm, events.kind;
END
$fn$;

REVOKE ALL ON FUNCTION gowm_network_v1.segment_boundary_crossings(uuid,jsonb,text,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION gowm_network_v1.route_boundary_crossings(uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_network_v1.segment_boundary_crossings(uuid,jsonb,text,integer,integer) TO network_provider, route_planner_provider, coverage_planner_provider;
GRANT EXECUTE ON FUNCTION gowm_network_v1.route_boundary_crossings(uuid,jsonb,jsonb) TO network_provider, route_planner_provider, coverage_planner_provider;

COMMIT;
