BEGIN;

CREATE OR REPLACE FUNCTION gowm_reference_v1.resolve(
  p_surface_text text,
  p_expected_kinds text[] DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_similarity_threshold double precision DEFAULT 0.3,
  p_candidate_budget integer DEFAULT 1000
)
RETURNS TABLE(
  reference_key text,
  entity_kind text,
  matched_by text,
  match_score double precision,
  state_confidence double precision,
  descriptor_version bigint,
  display_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, gowm_reference_v1
AS $fn$
  WITH trusted AS (
    SELECT projection.*
    FROM public.reference_search_projection projection
    WHERE projection.data_scope_key = gowm_reference_v1.current_data_scope_key()
      AND (p_expected_kinds IS NULL OR projection.entity_kind = ANY(p_expected_kinds))
  ), scored AS (
    SELECT trusted.*,
           similarity(trusted.normalized_text, public.normalize_reference_text(p_surface_text)) AS fuzzy_score,
           trusted.normalized_text = public.normalize_reference_text(p_surface_text) AS exact
    FROM trusted
    WHERE trusted.normalized_text = public.normalize_reference_text(p_surface_text)
       OR trusted.normalized_text % public.normalize_reference_text(p_surface_text)
  ), bounded AS (
    SELECT * FROM scored
    ORDER BY exact DESC, match_priority, reference_key, normalized_text
    LIMIT LEAST(GREATEST(p_candidate_budget, 1), 5000)
  ), ranked AS (
    SELECT bounded.reference_key, bounded.entity_kind, bounded.exact,
           CASE WHEN bounded.exact THEN bounded.search_kind ELSE 'FUZZY_NAME' END AS matched_by,
           CASE WHEN bounded.exact THEN 1::double precision
                ELSE bounded.fuzzy_score * bounded.source_confidence END AS match_score,
           bounded.match_priority
    FROM bounded
    WHERE bounded.exact OR bounded.fuzzy_score >= p_similarity_threshold
  ), deduplicated AS (
    SELECT DISTINCT ON (ranked.reference_key)
           ranked.reference_key, ranked.entity_kind, ranked.exact,
           ranked.matched_by, ranked.match_score, ranked.match_priority
    FROM ranked
    ORDER BY ranked.reference_key, ranked.exact DESC, ranked.match_priority,
             ranked.match_score DESC, ranked.matched_by
  )
  SELECT deduplicated.reference_key, deduplicated.entity_kind,
         deduplicated.matched_by, deduplicated.match_score,
         descriptor.state_confidence, descriptor.descriptor_version,
         descriptor.display_name
  FROM deduplicated
  JOIN LATERAL (
    SELECT current_descriptor.*
    FROM public.world_reference_descriptor_version current_descriptor
    WHERE current_descriptor.reference_key = deduplicated.reference_key
    ORDER BY current_descriptor.descriptor_version DESC
    LIMIT 1
  ) descriptor ON true
  ORDER BY deduplicated.exact DESC, deduplicated.match_priority,
           deduplicated.match_score DESC, deduplicated.reference_key
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
$fn$;

REVOKE ALL ON FUNCTION gowm_reference_v1.resolve(text,text[],integer,double precision,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gowm_reference_v1.resolve(text,text[],integer,double precision,integer)
  TO gowm_reference_reader;

COMMIT;
