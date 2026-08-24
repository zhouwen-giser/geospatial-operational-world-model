\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS mobilitydb CASCADE;
CREATE EXTENSION IF NOT EXISTS h3;
CREATE EXTENSION IF NOT EXISTS h3_postgis CASCADE;
CREATE EXTENSION IF NOT EXISTS pgrouting CASCADE;

DO $$
DECLARE
  server_num integer := current_setting('server_version_num')::integer;
  extension_versions jsonb;
BEGIN
  IF server_num < 180000 OR server_num >= 190000 THEN
    RAISE EXCEPTION 'PostgreSQL 18.x required, got %', current_setting('server_version');
  END IF;

  SELECT jsonb_object_agg(extname, extversion ORDER BY extname)
  INTO extension_versions
  FROM pg_extension
  WHERE extname IN ('postgis', 'mobilitydb', 'h3', 'h3_postgis', 'pgrouting');

  IF extension_versions ->> 'pgrouting' <> '4.0.1' THEN
    RAISE EXCEPTION 'pgRouting 4.0.1 required, got %', extension_versions ->> 'pgrouting';
  END IF;
  IF extension_versions ->> 'postgis' NOT LIKE '3.6.%' THEN
    RAISE EXCEPTION 'PostGIS 3.6.x required, got %', extension_versions ->> 'postgis';
  END IF;
  IF extension_versions ->> 'mobilitydb' NOT LIKE '1.3.%' THEN
    RAISE EXCEPTION 'MobilityDB 1.3.x required, got %', extension_versions ->> 'mobilitydb';
  END IF;
  IF extension_versions ->> 'h3' <> '4.5.0' OR extension_versions ->> 'h3_postgis' <> '4.5.0' THEN
    RAISE EXCEPTION 'h3/h3_postgis 4.5.0 required, got %', extension_versions;
  END IF;
END
$$;

DO $$
DECLARE
  terminal_cost double precision;
  traversed_edges bigint[];
BEGIN
  CREATE TEMP TABLE pgr_withpoints_fraction_one_edges ON COMMIT DROP AS
  SELECT * FROM (VALUES
    (100::bigint, 1001::bigint, 1002::bigint, 10::float8, 10::float8),
    (101::bigint, 1002::bigint, 1003::bigint, 12::float8, 12::float8),
    (102::bigint, 1002::bigint, 1003::bigint, 100::float8, 100::float8)
  ) AS edge(id, source, target, cost, reverse_cost);

  SELECT max(agg_cost) FILTER (WHERE edge < 0),
         array_agg(edge ORDER BY seq) FILTER (WHERE edge > 0)
  INTO terminal_cost, traversed_edges
  FROM pgr_withPoints(
    'SELECT * FROM pgr_withpoints_fraction_one_edges',
    'SELECT * FROM (VALUES (1, 100, 0.5), (2, 101, 1.0)) AS point(pid, edge_id, fraction)',
    -1,
    -2
  );

  IF terminal_cost <> 17::float8 THEN
    RAISE EXCEPTION 'pgr_withPoints fraction=1 regression: expected terminal cost 17, got %', terminal_cost;
  END IF;
  IF traversed_edges <> ARRAY[100, 101]::bigint[] THEN
    RAISE EXCEPTION 'pgr_withPoints fraction=1 regression: expected edges {100,101}, got %', traversed_edges;
  END IF;
END
$$;

SELECT jsonb_build_object(
  'postgres', current_setting('server_version'),
  'postgis', (SELECT extversion FROM pg_extension WHERE extname = 'postgis'),
  'mobilitydb', (SELECT extversion FROM pg_extension WHERE extname = 'mobilitydb'),
  'h3', (SELECT extversion FROM pg_extension WHERE extname = 'h3'),
  'h3_postgis', (SELECT extversion FROM pg_extension WHERE extname = 'h3_postgis'),
  'pgrouting', (SELECT extversion FROM pg_extension WHERE extname = 'pgrouting'),
  'withPointsFractionOne', 'PASS'
) AS gowm_network_database_runtime;
