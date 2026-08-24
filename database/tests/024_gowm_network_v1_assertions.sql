\set ON_ERROR_STOP on

BEGIN;

INSERT INTO data_scope(scope_key, operational_domain, description) VALUES
  ('network-read-a', 'TEST', 'Network read scope A'),
  ('network-read-b', 'TEST', 'Network read scope B');

WITH fixtures(scope_key,dataset_scope,dataset_key,hash_digit) AS (
  VALUES ('network-read-a','tenant-a','roads-a','1'), ('network-read-b','tenant-b','roads-b','2')
), datasets AS (
  INSERT INTO spatial_dataset(data_scope_key,dataset_scope_key,dataset_key,name)
  SELECT scope_key,dataset_scope,dataset_key,'Read contract roads' FROM fixtures
  RETURNING dataset_id,data_scope_key,dataset_scope_key
)
INSERT INTO spatial_dataset_version(
  dataset_id,version,dataset_kind,schema_version,crs,content_hash,published_at
)
SELECT dataset_id,'1','NETWORK','1.0','EPSG:4326',
       'sha256:' || repeat(CASE data_scope_key WHEN 'network-read-a' THEN '1' ELSE '2' END,64),
       '2026-08-24T00:00:00Z'
FROM datasets;

WITH dataset AS (
  SELECT dataset_id FROM spatial_dataset WHERE data_scope_key='network-read-a'
), version AS (
  SELECT dataset_version_id,dataset_id FROM spatial_dataset_version JOIN dataset USING(dataset_id)
), layer AS (
  INSERT INTO spatial_layer(dataset_id,data_scope_key,dataset_scope_key,layer_key,name)
  SELECT dataset_id,'network-read-a','tenant-a','road-centerline','Road centerline' FROM dataset
  RETURNING layer_id,dataset_id
), layer_version AS (
  INSERT INTO spatial_layer_version(
    layer_id,dataset_id,dataset_version_id,version,layer_type,geometry_type,
    schema_version,crs,content_hash,published_at
  )
  SELECT layer_id,layer.dataset_id,version.dataset_version_id,'1','VECTOR_FEATURE',
         'LineString','1.0','EPSG:4326','sha256:' || repeat('3',64),'2026-08-24T00:00:00Z'
  FROM layer JOIN version USING(dataset_id)
  RETURNING layer_version_id,layer_id
), feature AS (
  INSERT INTO spatial_feature_identity(
    layer_id,data_scope_key,dataset_scope_key,feature_key,feature_type,display_name
  ) SELECT layer_id,'network-read-a','tenant-a','road-a','ROAD','Road A' FROM layer_version
  RETURNING feature_id,layer_id
)
INSERT INTO spatial_feature_version(
  feature_id,layer_id,layer_version_id,version,geometry,content_hash,published_at
)
SELECT feature_id,feature.layer_id,layer_version_id,'1',
       ST_GeomFromText('LINESTRING(0 0,1 0)',4326),
       'sha256:' || repeat('4',64),'2026-08-24T00:00:00Z'
FROM feature JOIN layer_version USING(layer_id);

INSERT INTO network_graph(data_scope_key,dataset_scope_key,dataset_id,graph_key)
SELECT 'network-read-a','tenant-a',dataset_id,'roads'
FROM spatial_dataset WHERE data_scope_key='network-read-a';

INSERT INTO network_graph_version(
  graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,
  graph_version,build_policy_version,source_content_hash,topology_hash,content_hash,
  node_count,edge_count,arc_count,turn_rule_count,status
)
SELECT graph.graph_id,graph.dataset_id,version.dataset_version_id,
       graph.data_scope_key,graph.dataset_scope_key,'1','policy-v1',
       'sha256:' || repeat('1',64),'sha256:' || repeat('5',64),'sha256:' || repeat('6',64),
       2,1,2,0,'VALIDATED'
FROM network_graph graph JOIN spatial_dataset_version version USING(dataset_id);

INSERT INTO network_node(graph_version_id,data_scope_key,node_key,geometry)
SELECT graph_version_id,data_scope_key,node_key,ST_GeomFromText(wkt,4326)
FROM network_graph_version
CROSS JOIN (VALUES
  ('nd_' || repeat('1',64),'POINT Z (0 0 0)'),
  ('nd_' || repeat('2',64),'POINT Z (1 0 0)')
) fixture(node_key,wkt);

INSERT INTO network_edge(
  graph_version_id,data_scope_key,edge_key,source_node_id,target_node_id,
  source_feature_reference_key,geometry,length_mm,road_class,oneway
)
SELECT version.graph_version_id,version.data_scope_key,'ed_' || repeat('1',64),
       source_node.node_id,target_node.node_id,feature.reference_key,
       ST_GeomFromText('LINESTRING Z (0 0 0,1 0 0)',4326),100000,'LOCAL','BIDIRECTIONAL'
FROM network_graph_version version
JOIN network_node source_node ON source_node.graph_version_id=version.graph_version_id AND source_node.node_key='nd_' || repeat('1',64)
JOIN network_node target_node ON target_node.graph_version_id=version.graph_version_id AND target_node.node_key='nd_' || repeat('2',64)
JOIN spatial_feature_identity feature ON feature.data_scope_key=version.data_scope_key;

INSERT INTO network_arc(
  graph_version_id,data_scope_key,arc_key,edge_id,source_node_id,target_node_id,
  direction,oriented_geometry,length_mm,default_speed_mm_per_s,access_mask
)
SELECT edge.graph_version_id,edge.data_scope_key,fixture.arc_key,edge.edge_id,
       source_node.node_id,target_node.node_id,fixture.direction,
       ST_GeomFromText(fixture.wkt,4326),edge.length_mm,10000,1
FROM network_edge edge
JOIN (VALUES
  ('ar_' || repeat('1',64),'nd_' || repeat('1',64),'nd_' || repeat('2',64),'FORWARD','LINESTRING Z (0 0 0,1 0 0)'),
  ('ar_' || repeat('2',64),'nd_' || repeat('2',64),'nd_' || repeat('1',64),'REVERSE','LINESTRING Z (1 0 0,0 0 0)')
) fixture(arc_key,source_key,target_key,direction,wkt) ON true
JOIN network_node source_node ON source_node.graph_version_id=edge.graph_version_id AND source_node.node_key=fixture.source_key
JOIN network_node target_node ON target_node.graph_version_id=edge.graph_version_id AND target_node.node_key=fixture.target_key;

INSERT INTO network_feature_binding(
  graph_version_id,data_scope_key,edge_id,source_feature_id,source_feature_version_id,
  source_feature_reference_key,binding_kind,content_hash
)
SELECT edge.graph_version_id,edge.data_scope_key,edge.edge_id,feature.feature_id,
       version.feature_version_id,feature.reference_key,'IDENTICAL','sha256:' || repeat('7',64)
FROM network_edge edge
JOIN spatial_feature_identity feature ON feature.reference_key=edge.source_feature_reference_key
JOIN spatial_feature_version version USING(feature_id);

WITH profile AS (
  INSERT INTO network_travel_profile(data_scope_key,profile_key)
  VALUES ('network-read-a','car') RETURNING travel_profile_id,data_scope_key
)
INSERT INTO network_travel_profile_version(
  travel_profile_id,data_scope_key,version,mode,required_access_mask,content_hash
)
SELECT travel_profile_id,data_scope_key,'1','CAR',1,'sha256:' || repeat('8',64) FROM profile;

WITH profile AS (
  INSERT INTO network_cost_profile(travel_profile_id,data_scope_key,profile_key)
  SELECT travel_profile_id,data_scope_key,'fastest'
  FROM network_travel_profile WHERE data_scope_key='network-read-a'
  RETURNING cost_profile_id,travel_profile_id,data_scope_key
)
INSERT INTO network_cost_profile_version(
  cost_profile_id,travel_profile_id,travel_profile_version_id,data_scope_key,
  version,distance_weight_ppm,duration_weight_ppm,risk_weight_ppm,energy_weight_ppm,content_hash
)
SELECT profile.cost_profile_id,profile.travel_profile_id,travel.travel_profile_version_id,
       profile.data_scope_key,'1',0,1000000,0,0,'sha256:' || repeat('9',64)
FROM profile JOIN network_travel_profile_version travel USING(travel_profile_id,data_scope_key);

INSERT INTO network_arc_cost(
  graph_version_id,arc_id,travel_profile_version_id,cost_profile_version_id,
  data_scope_key,distance_mm,duration_ms,combined_cost_units,content_hash
)
SELECT arc.graph_version_id,arc.arc_id,travel.travel_profile_version_id,
       cost.cost_profile_version_id,arc.data_scope_key,arc.length_mm,10000,10000,
       'sha256:' || encode(digest(arc.arc_key || ':read-cost','sha256'),'hex')
FROM network_arc arc
JOIN network_travel_profile_version travel USING(data_scope_key)
JOIN network_cost_profile_version cost USING(travel_profile_version_id,data_scope_key);

INSERT INTO network_condition_snapshot(
  graph_version_id,data_scope_key,condition_snapshot_key,source_snapshot_version,
  observed_at,valid_until,completeness,source_content_hash,content_hash
)
SELECT graph_version_id,data_scope_key,'cs_' || repeat('1',64),'1',
       '2026-08-24T00:00:00Z','2026-08-25T00:00:00Z','COMPLETE',
       'sha256:' || repeat('a',64),'sha256:' || repeat('b',64)
FROM network_graph_version;

INSERT INTO network_graph_activation_event(
  graph_id,graph_version_id,data_scope_key,dataset_scope_key,event_type,
  activation_policy_version,actor_reference_key,event_hash
)
SELECT graph.graph_id,version.graph_version_id,graph.data_scope_key,graph.dataset_scope_key,
       'ACTIVATE','activation-v1','test:network-read','sha256:' || repeat('c',64)
FROM network_graph graph JOIN network_graph_version version USING(graph_id,data_scope_key,dataset_scope_key);

SET LOCAL ROLE network_provider;
SELECT gowm_network_v1.set_scope('network-read-a','tenant-a');

DO $provider_scope$
DECLARE
  graph_version uuid;
  travel_version uuid;
  cost_version uuid;
  condition_snapshot uuid;
  snapshot jsonb;
BEGIN
  SELECT graph_version_id INTO STRICT graph_version FROM gowm_network_v1.graph_version;
  SELECT travel_profile_version_id INTO STRICT travel_version FROM gowm_network_v1.travel_profile;
  SELECT cost_profile_version_id INTO STRICT cost_version FROM gowm_network_v1.cost_profile;
  SELECT condition_snapshot_id INTO STRICT condition_snapshot FROM gowm_network_v1.condition_snapshot;

  IF (SELECT count(*) FROM gowm_network_v1.node) <> 2 OR
     (SELECT count(*) FROM gowm_network_v1.edge) <> 1 OR
     (SELECT count(*) FROM gowm_network_v1.arc) <> 2 OR
     (SELECT count(*) FROM gowm_network_v1.snap_candidates(
       graph_version,(SELECT geometry FROM gowm_network_v1.node ORDER BY node_key LIMIT 1),8
     )) <> 2 THEN
    RAISE EXCEPTION 'network read views or directed snap candidates are incomplete';
  END IF;

  IF (SELECT active.graph_version_id FROM gowm_network_v1.resolve_active_graph('roads') active) <> graph_version THEN
    RAISE EXCEPTION 'active graph resolution failed';
  END IF;
  snapshot := gowm_network_v1.resolve_routing_snapshot(
    graph_version,travel_version,cost_version,condition_snapshot
  );
  IF snapshot IS NULL OR snapshot->>'graphContentHash' <> 'sha256:' || repeat('6',64) OR
     snapshot->>'conditionContentHash' <> 'sha256:' || repeat('b',64) THEN
    RAISE EXCEPTION 'routing snapshot is incomplete';
  END IF;

  BEGIN PERFORM count(*) FROM public.network_arc;
    RAISE EXCEPTION 'network Provider accessed a base table';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM * FROM gowm_network_v1.routing_arc_projection(
    graph_version,travel_version,cost_version,condition_snapshot
  ); RAISE EXCEPTION 'network Provider accessed route planner projection';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END
$provider_scope$;

SELECT gowm_network_v1.set_scope('network-read-b','tenant-b');
DO $scope_isolation$
BEGIN
  IF EXISTS (SELECT 1 FROM gowm_network_v1.graph_version) OR
     EXISTS (SELECT 1 FROM gowm_network_v1.node) OR
     EXISTS (SELECT 1 FROM gowm_network_v1.arc) OR
     EXISTS (SELECT 1 FROM gowm_network_v1.resolve_active_graph('roads')) THEN
    RAISE EXCEPTION 'network read contract leaked another DataScope/DatasetScope';
  END IF;
END
$scope_isolation$;

RESET ROLE;
SET LOCAL ROLE route_planner_provider;
SELECT gowm_network_v1.set_scope('network-read-a','tenant-a');

DO $route_projection$
DECLARE
  graph_version uuid;
  travel_version uuid;
  cost_version uuid;
  condition_snapshot uuid;
BEGIN
  SELECT graph_version_id INTO STRICT graph_version FROM gowm_network_v1.graph_version;
  SELECT travel_profile_version_id INTO STRICT travel_version FROM gowm_network_v1.travel_profile;
  SELECT cost_profile_version_id INTO STRICT cost_version FROM gowm_network_v1.cost_profile;
  SELECT condition_snapshot_id INTO STRICT condition_snapshot FROM gowm_network_v1.condition_snapshot;
  IF (SELECT count(*) FROM gowm_network_v1.routing_arc_projection(
       graph_version,travel_version,cost_version,condition_snapshot
     )) <> 2 OR EXISTS (
       SELECT 1 FROM gowm_network_v1.routing_arc_projection(
         graph_version,travel_version,cost_version,condition_snapshot
       ) WHERE reverse_cost <> -1 OR cost <> 10000
     ) THEN
    RAISE EXCEPTION 'route planner projection did not preserve directed fixed costs';
  END IF;
  BEGIN INSERT INTO public.network_graph(data_scope_key,dataset_scope_key,dataset_id,graph_key)
    SELECT 'network-read-a','tenant-a',dataset_id,'forbidden'
    FROM public.spatial_dataset WHERE data_scope_key='network-read-a';
    RAISE EXCEPTION 'route planner Provider wrote a base table';
  EXCEPTION WHEN insufficient_privilege OR read_only_sql_transaction THEN NULL; END;
END
$route_projection$;

RESET ROLE;
ROLLBACK;

SELECT 'GOWM_NETWORK_V1_ASSERTIONS_PASS' AS result;
