\set ON_ERROR_STOP on

BEGIN;

DO $structure$
BEGIN
  IF to_regclass('public.network_graph_version') IS NULL OR
     to_regclass('public.network_node') IS NULL OR
     to_regclass('public.network_edge') IS NULL OR
     to_regclass('public.network_arc') IS NULL OR
     to_regclass('public.network_turn_rule') IS NULL OR
     to_regclass('public.network_turn_sequence_rule') IS NULL OR
     to_regclass('public.network_travel_profile_version') IS NULL OR
     to_regclass('public.network_cost_profile_version') IS NULL OR
     to_regclass('public.network_condition_snapshot') IS NULL OR
     to_regclass('public.network_graph_activation_event') IS NULL THEN
    RAISE EXCEPTION 'network foundation schema is incomplete';
  END IF;
END
$structure$;

INSERT INTO data_scope(scope_key, operational_domain, description) VALUES
  ('network-schema-a', 'TEST', 'Network schema test scope A'),
  ('network-schema-b', 'TEST', 'Network schema test scope B');

WITH dataset AS (
  INSERT INTO spatial_dataset(data_scope_key, dataset_scope_key, dataset_key, name)
  VALUES ('network-schema-a', 'tenant-a', 'network-roads', 'Network roads')
  RETURNING dataset_id
)
INSERT INTO spatial_dataset_version(
  dataset_id, version, dataset_kind, source_ref, source_version, schema_version,
  crs, quality, lineage, content_hash, published_at
)
SELECT dataset_id, '1', 'NETWORK', 'urn:test:network-roads', '1', '1.0',
       'EPSG:4326', '{}'::jsonb, '["source:test"]'::jsonb,
       'sha256:' || repeat('1',64), '2026-08-24T00:00:00Z'
FROM dataset;

WITH dataset AS (
  SELECT dataset_id FROM spatial_dataset
  WHERE data_scope_key='network-schema-a' AND dataset_scope_key='tenant-a'
), dataset_version AS (
  SELECT dataset_version_id, dataset_id FROM spatial_dataset_version
  WHERE dataset_id=(SELECT dataset_id FROM dataset)
), layer AS (
  INSERT INTO spatial_layer(dataset_id, data_scope_key, dataset_scope_key, layer_key, name)
  SELECT dataset_id, 'network-schema-a', 'tenant-a', 'road-centerline', 'Road centerline' FROM dataset
  RETURNING layer_id, dataset_id
), layer_version AS (
  INSERT INTO spatial_layer_version(
    layer_id, dataset_id, dataset_version_id, version, layer_type, geometry_type,
    schema_version, crs, content_hash, published_at
  )
  SELECT layer.layer_id, layer.dataset_id, dataset_version.dataset_version_id,
         '1', 'VECTOR_FEATURE', 'LineString', '1.0', 'EPSG:4326',
         'sha256:' || repeat('2',64), '2026-08-24T00:00:00Z'
  FROM layer JOIN dataset_version USING(dataset_id)
  RETURNING layer_version_id, layer_id
), feature AS (
  INSERT INTO spatial_feature_identity(
    layer_id, data_scope_key, dataset_scope_key, feature_key, feature_type, display_name
  )
  SELECT layer_id, 'network-schema-a', 'tenant-a', 'road-001', 'ROAD', 'Test road'
  FROM layer_version
  RETURNING feature_id, layer_id, reference_key
)
INSERT INTO spatial_feature_version(
  feature_id, layer_id, layer_version_id, version, geometry, properties,
  content_hash, published_at
)
SELECT feature.feature_id, feature.layer_id, layer_version.layer_version_id,
       '1', ST_GeomFromText('LINESTRING(0 0,1 0,2 0)',4326),
       '{"oneway":false}'::jsonb, 'sha256:' || repeat('3',64), '2026-08-24T00:00:00Z'
FROM feature JOIN layer_version USING(layer_id);

WITH dataset AS (
  SELECT dataset_id FROM spatial_dataset WHERE data_scope_key='network-schema-a'
)
INSERT INTO network_graph(data_scope_key, dataset_scope_key, dataset_id, graph_key, description)
SELECT 'network-schema-a', 'tenant-a', dataset_id, 'roads', 'Authoritative test graph' FROM dataset;

INSERT INTO network_graph_version(
  graph_id, dataset_id, dataset_version_id, data_scope_key, dataset_scope_key,
  graph_version, build_policy_version, source_content_hash, topology_hash,
  content_hash, node_count, edge_count, arc_count, turn_rule_count,
  status, build_receipt_id, build_receipt
)
SELECT graph.graph_id, graph.dataset_id, version.dataset_version_id,
       'network-schema-a', 'tenant-a', '1', 'network-build-policy-v1',
       'sha256:' || repeat('1',64), 'sha256:' || repeat('4',64),
       'sha256:' || repeat('5',64), 3, 2, 3, 2, 'VALIDATED',
       'network-build:test', '{"status":"SUCCEEDED"}'::jsonb
FROM network_graph graph
JOIN spatial_dataset_version version USING(dataset_id)
WHERE graph.data_scope_key='network-schema-a';

INSERT INTO network_node(graph_version_id, data_scope_key, node_key, geometry, elevation_mm)
SELECT graph_version_id, 'network-schema-a', node_key, ST_GeomFromText(wkt,4326), elevation_mm
FROM network_graph_version
CROSS JOIN (VALUES
  ('nd_' || repeat('1',64), 'POINT Z (0 0 0)', 0::bigint),
  ('nd_' || repeat('2',64), 'POINT Z (1 0 0)', 0::bigint),
  ('nd_' || repeat('3',64), 'POINT Z (2 0 0)', 0::bigint)
) fixture(node_key,wkt,elevation_mm)
WHERE data_scope_key='network-schema-a';

INSERT INTO network_edge(
  graph_version_id, data_scope_key, edge_key, source_node_id, target_node_id,
  source_feature_reference_key, geometry, length_mm, road_class, oneway
)
SELECT version.graph_version_id, 'network-schema-a', fixture.edge_key,
       source_node.node_id, target_node.node_id, feature.reference_key,
       ST_GeomFromText(fixture.wkt,4326), 100000, 'LOCAL', fixture.oneway
FROM network_graph_version version
JOIN spatial_feature_identity feature ON feature.data_scope_key='network-schema-a'
CROSS JOIN (VALUES
  ('ed_' || repeat('1',64), 'nd_' || repeat('1',64), 'nd_' || repeat('2',64), 'LINESTRING Z (0 0 0,1 0 0)', 'BIDIRECTIONAL'),
  ('ed_' || repeat('2',64), 'nd_' || repeat('2',64), 'nd_' || repeat('3',64), 'LINESTRING Z (1 0 0,2 0 0)', 'FORWARD_ONLY')
) fixture(edge_key,source_key,target_key,wkt,oneway)
JOIN network_node source_node ON source_node.graph_version_id=version.graph_version_id AND source_node.node_key=fixture.source_key
JOIN network_node target_node ON target_node.graph_version_id=version.graph_version_id AND target_node.node_key=fixture.target_key
WHERE version.data_scope_key='network-schema-a';

INSERT INTO network_arc(
  graph_version_id, data_scope_key, arc_key, edge_id, source_node_id,
  target_node_id, direction, oriented_geometry, length_mm,
  default_speed_mm_per_s, access_mask
)
SELECT edge.graph_version_id, 'network-schema-a', fixture.arc_key, edge.edge_id,
       source_node.node_id, target_node.node_id, fixture.direction,
       ST_GeomFromText(fixture.wkt,4326), edge.length_mm, 10000, 1
FROM network_edge edge
JOIN (VALUES
  ('ed_' || repeat('1',64), 'ar_' || repeat('1',64), 'nd_' || repeat('1',64), 'nd_' || repeat('2',64), 'FORWARD', 'LINESTRING Z (0 0 0,1 0 0)'),
  ('ed_' || repeat('1',64), 'ar_' || repeat('2',64), 'nd_' || repeat('2',64), 'nd_' || repeat('1',64), 'REVERSE', 'LINESTRING Z (1 0 0,0 0 0)'),
  ('ed_' || repeat('2',64), 'ar_' || repeat('3',64), 'nd_' || repeat('2',64), 'nd_' || repeat('3',64), 'FORWARD', 'LINESTRING Z (1 0 0,2 0 0)')
) fixture(edge_key,arc_key,source_key,target_key,direction,wkt) ON fixture.edge_key=edge.edge_key
JOIN network_node source_node ON source_node.graph_version_id=edge.graph_version_id AND source_node.node_key=fixture.source_key
JOIN network_node target_node ON target_node.graph_version_id=edge.graph_version_id AND target_node.node_key=fixture.target_key;

INSERT INTO network_feature_binding(
  graph_version_id, data_scope_key, edge_id, source_feature_id,
  source_feature_version_id, source_feature_reference_key, binding_kind, content_hash
)
SELECT edge.graph_version_id, edge.data_scope_key, edge.edge_id, feature.feature_id,
       version.feature_version_id, feature.reference_key, 'SPLIT_FROM',
       'sha256:' || encode(digest(edge.edge_key, 'sha256'),'hex')
FROM network_edge edge
JOIN spatial_feature_identity feature
  ON feature.reference_key=edge.source_feature_reference_key AND feature.data_scope_key=edge.data_scope_key
JOIN spatial_feature_version version USING(feature_id);

INSERT INTO network_turn_rule(
  graph_version_id, data_scope_key, rule_key, from_arc_id, via_node_id,
  to_arc_id, rule_type, content_hash
)
SELECT version.graph_version_id, version.data_scope_key, 'tr_' || repeat('1',64),
       from_arc.arc_id, via.node_id, to_arc.arc_id, 'FORBIDDEN', 'sha256:' || repeat('6',64)
FROM network_graph_version version
JOIN network_arc from_arc ON from_arc.graph_version_id=version.graph_version_id AND from_arc.arc_key='ar_' || repeat('1',64)
JOIN network_arc to_arc ON to_arc.graph_version_id=version.graph_version_id AND to_arc.arc_key='ar_' || repeat('3',64)
JOIN network_node via ON via.graph_version_id=version.graph_version_id AND via.node_key='nd_' || repeat('2',64);

INSERT INTO network_turn_sequence_rule(
  graph_version_id, data_scope_key, rule_key, arc_sequence, rule_type,
  automaton_hash, content_hash
)
SELECT version.graph_version_id, version.data_scope_key, 'ts_' || repeat('1',64),
       ARRAY[from_arc.arc_id,to_arc.arc_id], 'FORBIDDEN',
       'sha256:' || repeat('7',64), 'sha256:' || repeat('8',64)
FROM network_graph_version version
JOIN network_arc from_arc ON from_arc.graph_version_id=version.graph_version_id AND from_arc.arc_key='ar_' || repeat('1',64)
JOIN network_arc to_arc ON to_arc.graph_version_id=version.graph_version_id AND to_arc.arc_key='ar_' || repeat('3',64);

WITH profile AS (
  INSERT INTO network_travel_profile(data_scope_key, profile_key, description)
  VALUES ('network-schema-a','car','Car travel') RETURNING travel_profile_id
)
INSERT INTO network_travel_profile_version(
  travel_profile_id, data_scope_key, version, mode, required_access_mask,
  maximum_speed_mm_per_s, content_hash
)
SELECT travel_profile_id, 'network-schema-a', '1', 'CAR', 1, 30000,
       'sha256:' || repeat('9',64) FROM profile;

WITH profile AS (
  INSERT INTO network_cost_profile(travel_profile_id, data_scope_key, profile_key, description)
  SELECT travel_profile_id, data_scope_key, 'fastest', 'Fastest route'
  FROM network_travel_profile WHERE data_scope_key='network-schema-a'
  RETURNING cost_profile_id, travel_profile_id, data_scope_key
)
INSERT INTO network_cost_profile_version(
  cost_profile_id, travel_profile_id, travel_profile_version_id, data_scope_key,
  version, distance_weight_ppm, duration_weight_ppm, risk_weight_ppm,
  energy_weight_ppm, content_hash
)
SELECT profile.cost_profile_id, profile.travel_profile_id, travel.travel_profile_version_id,
       profile.data_scope_key, '1', 0, 1000000, 0, 0, 'sha256:' || repeat('a',64)
FROM profile JOIN network_travel_profile_version travel USING(travel_profile_id, data_scope_key);

INSERT INTO network_arc_cost(
  graph_version_id, arc_id, travel_profile_version_id, cost_profile_version_id,
  data_scope_key, distance_mm, duration_ms, combined_cost_units, content_hash
)
SELECT arc.graph_version_id, arc.arc_id, travel.travel_profile_version_id,
       cost.cost_profile_version_id, arc.data_scope_key, arc.length_mm, 10000,
       10000, 'sha256:' || encode(digest(arc.arc_key || ':cost','sha256'),'hex')
FROM network_arc arc
JOIN network_travel_profile_version travel USING(data_scope_key)
JOIN network_cost_profile_version cost USING(travel_profile_version_id, data_scope_key);

WITH snapshot AS (
  INSERT INTO network_condition_snapshot(
    graph_version_id, data_scope_key, condition_snapshot_key, source_snapshot_version,
    observed_at, valid_until, completeness, source_content_hash, content_hash
  )
  SELECT graph_version_id, data_scope_key, 'cs_' || repeat('1',64), '1',
         '2026-08-24T00:00:00Z', '2026-08-25T00:00:00Z', 'COMPLETE',
         'sha256:' || repeat('b',64), 'sha256:' || repeat('c',64)
  FROM network_graph_version WHERE data_scope_key='network-schema-a'
  RETURNING condition_snapshot_id, graph_version_id, data_scope_key
)
INSERT INTO network_arc_condition(
  condition_snapshot_id, graph_version_id, arc_id, data_scope_key,
  traversal_allowed, penalty_units, reason_codes, content_hash
)
SELECT snapshot.condition_snapshot_id, snapshot.graph_version_id, arc.arc_id,
       snapshot.data_scope_key, true, 50, ARRAY['TEST_DELAY'],
       'sha256:' || repeat('d',64)
FROM snapshot JOIN network_arc arc USING(graph_version_id, data_scope_key)
WHERE arc.arc_key='ar_' || repeat('3',64);

INSERT INTO network_build_run(
  graph_id, dataset_version_id, data_scope_key, dataset_scope_key,
  build_policy_version, adapter_kind, status, input_hash, output_hash,
  requested_at, started_at, finished_at, receipt
)
SELECT graph.graph_id, version.dataset_version_id, graph.data_scope_key,
       graph.dataset_scope_key, 'network-build-policy-v1', 'CATALOG_VECTOR_LAYER',
       'SUCCEEDED', 'sha256:' || repeat('1',64), 'sha256:' || repeat('5',64),
       '2026-08-24T00:00:00Z', '2026-08-24T00:00:01Z', '2026-08-24T00:00:02Z',
       '{"status":"SUCCEEDED"}'::jsonb
FROM network_graph graph JOIN spatial_dataset_version version USING(dataset_id)
WHERE graph.data_scope_key='network-schema-a';

INSERT INTO network_validation_issue(
  build_run_id, graph_version_id, data_scope_key, severity, issue_code,
  activation_blocking, details
)
SELECT run.build_run_id, version.graph_version_id, run.data_scope_key,
       'WARNING', 'TEST_WARNING', false, '{"fixture":true}'::jsonb
FROM network_build_run run
JOIN network_graph_version version USING(data_scope_key, dataset_scope_key)
WHERE run.data_scope_key='network-schema-a';

INSERT INTO network_graph_activation_event(
  graph_id, graph_version_id, data_scope_key, dataset_scope_key, event_type,
  activation_policy_version, actor_reference_key, event_hash
)
SELECT graph.graph_id, version.graph_version_id, graph.data_scope_key,
       graph.dataset_scope_key, 'ACTIVATE', 'activation-policy-v1',
       'test:network-schema', 'sha256:' || repeat('e',64)
FROM network_graph graph JOIN network_graph_version version USING(graph_id, data_scope_key, dataset_scope_key)
WHERE graph.data_scope_key='network-schema-a';

DO $semantics$
DECLARE
  test_graph_version_id uuid;
  first_arc bigint;
BEGIN
  SELECT graph_version_id INTO STRICT test_graph_version_id
  FROM network_graph_version WHERE data_scope_key='network-schema-a';
  SELECT min(arc_id) INTO STRICT first_arc FROM network_arc WHERE graph_version_id=test_graph_version_id;

  IF (SELECT dataset_kind FROM spatial_dataset_version WHERE dataset_version_id=(
       SELECT dataset_version_id FROM network_graph_version WHERE graph_version_id=test_graph_version_id
     )) <> 'NETWORK' THEN RAISE EXCEPTION 'graph does not pin a NETWORK dataset'; END IF;
  IF (SELECT count(*) FROM network_feature_binding WHERE graph_version_id=test_graph_version_id) <> 2 THEN
    RAISE EXCEPTION 'every edge must retain an authorized source feature binding';
  END IF;
  IF (SELECT count(*) FROM network_graph_activation_event WHERE graph_version_id=test_graph_version_id AND event_type='ACTIVATE') <> 1 THEN
    RAISE EXCEPTION 'validated graph activation event is missing';
  END IF;
  IF (SELECT default_speed_mm_per_s FROM network_arc WHERE arc_id=first_arc) <> 10000 THEN
    RAISE EXCEPTION 'condition snapshot mutated a base arc';
  END IF;

  BEGIN UPDATE network_graph_version SET graph_version='mutated' WHERE graph_version_id=test_graph_version_id;
    RAISE EXCEPTION 'graph version update succeeded'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN DELETE FROM network_node WHERE graph_version_id=test_graph_version_id;
    RAISE EXCEPTION 'node delete succeeded'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN UPDATE network_edge SET length_mm=1 WHERE graph_version_id=test_graph_version_id;
    RAISE EXCEPTION 'edge update succeeded'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN DELETE FROM network_arc WHERE graph_version_id=test_graph_version_id;
    RAISE EXCEPTION 'arc delete succeeded'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN UPDATE network_turn_rule SET penalty_units=1 WHERE graph_version_id=test_graph_version_id;
    RAISE EXCEPTION 'turn update succeeded'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN DELETE FROM network_travel_profile_version WHERE data_scope_key='network-schema-a';
    RAISE EXCEPTION 'profile version delete succeeded'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;

  BEGIN
    INSERT INTO network_node(graph_version_id,data_scope_key,node_key,geometry)
    VALUES (test_graph_version_id,'network-schema-b','nd_' || repeat('f',64),ST_GeomFromText('POINT Z (9 9 0)',4326));
    RAISE EXCEPTION 'cross-scope node insert succeeded';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  IF NOT has_table_privilege('network_builder','public.network_graph','INSERT') OR
     has_table_privilege('network_builder','public.spatial_dataset','INSERT') THEN
    RAISE EXCEPTION 'network role/base-table privilege boundary is invalid';
  END IF;
END
$semantics$;

ROLLBACK;

SELECT 'NETWORK_SCHEMA_ASSERTIONS_PASS' AS result;
