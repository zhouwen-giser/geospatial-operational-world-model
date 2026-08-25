\set ON_ERROR_STOP on

INSERT INTO data_scope(scope_key,operational_domain,description)
VALUES ('coverage-gateway-runtime','TEST','G00 real Gateway coverage-planning scope');

INSERT INTO spatial_dataset(reference_key,data_scope_key,dataset_scope_key,dataset_key,name)
VALUES ('wrf_60000000000000000000000000000001','coverage-gateway-runtime','tenant-a','coverage-gateway-roads','Coverage Gateway roads');

INSERT INTO spatial_dataset_version(
  dataset_id,version,dataset_kind,source_ref,source_version,schema_version,crs,quality,lineage,content_hash,published_at
)
SELECT dataset_id,'dataset-v1','NETWORK','urn:test:coverage-gateway-roads','1','1.0','EPSG:4326','{}','[]',
       'sha256:'||repeat('d',64),'2026-08-25T00:00:00Z'
FROM spatial_dataset WHERE data_scope_key='coverage-gateway-runtime' AND dataset_scope_key='tenant-a';

INSERT INTO network_graph(data_scope_key,dataset_scope_key,dataset_id,graph_key,description)
SELECT data_scope_key,dataset_scope_key,dataset_id,'coverage-gateway-graph','G00 authoritative alternative-route graph'
FROM spatial_dataset WHERE data_scope_key='coverage-gateway-runtime' AND dataset_scope_key='tenant-a';

INSERT INTO network_graph_version(
  graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,graph_version,build_policy_version,
  source_content_hash,topology_hash,content_hash,node_count,edge_count,arc_count,turn_rule_count,status,build_receipt
)
SELECT graph.graph_id,graph.dataset_id,version.dataset_version_id,graph.data_scope_key,graph.dataset_scope_key,
       'graph-v1','network-build-policy-v1','sha256:'||repeat('d',64),'sha256:'||repeat('e',64),
       'sha256:'||repeat('1',64),5,6,6,0,'VALIDATED','{"fixture":"G00"}'
FROM network_graph graph JOIN spatial_dataset_version version USING(dataset_id)
WHERE graph.data_scope_key='coverage-gateway-runtime' AND graph.dataset_scope_key='tenant-a';

INSERT INTO network_node(graph_version_id,data_scope_key,node_key,geometry,elevation_mm)
SELECT version.graph_version_id,version.data_scope_key,'nd_'||repeat(fixture.hex,64),
       ST_GeomFromText(fixture.wkt,4326),0
FROM network_graph_version version
CROSS JOIN (VALUES
  ('1','POINT Z (-0.001 0 0)'),
  ('2','POINT Z (0 0 0)'),
  ('3','POINT Z (0.001 0.001 0)'),
  ('4','POINT Z (0.003 0 0)'),
  ('5','POINT Z (0.004 0 0)')
) fixture(hex,wkt)
WHERE version.data_scope_key='coverage-gateway-runtime';

INSERT INTO network_edge(
  graph_version_id,data_scope_key,edge_key,source_node_id,target_node_id,source_feature_reference_key,
  geometry,length_mm,road_class,oneway
)
SELECT version.graph_version_id,version.data_scope_key,'ed_'||repeat(fixture.hex,64),source.node_id,target.node_id,
       'wrf_'||repeat(fixture.hex,32),ST_GeomFromText(fixture.wkt,4326),fixture.length_mm,'LOCAL','FORWARD_ONLY'
FROM network_graph_version version
JOIN (VALUES
  ('1','1','2','LINESTRING Z (-0.001 0 0,0 0 0)',1000::bigint),
  ('2','2','4','LINESTRING Z (0 0 0,0.003 0 0)',10000::bigint),
  ('3','2','3','LINESTRING Z (0 0 0,0.001 0.001 0)',10000::bigint),
  ('4','3','4','LINESTRING Z (0.001 0.001 0,0.003 0 0)',10000::bigint),
  ('5','4','5','LINESTRING Z (0.003 0 0,0.004 0 0)',1000::bigint),
  ('6','5','2','LINESTRING Z (0.004 0 0,0 0 0)',1000::bigint)
) fixture(hex,source_hex,target_hex,wkt,length_mm) ON true
JOIN network_node source ON source.graph_version_id=version.graph_version_id AND source.node_key='nd_'||repeat(fixture.source_hex,64)
JOIN network_node target ON target.graph_version_id=version.graph_version_id AND target.node_key='nd_'||repeat(fixture.target_hex,64)
WHERE version.data_scope_key='coverage-gateway-runtime';

INSERT INTO network_arc(
  graph_version_id,data_scope_key,arc_key,edge_id,source_node_id,target_node_id,direction,oriented_geometry,
  length_mm,default_speed_mm_per_s,transit_eligible,service_eligible,access_mask
)
SELECT edge.graph_version_id,edge.data_scope_key,'ar_'||repeat(fixture.hex,64),edge.edge_id,
       edge.source_node_id,edge.target_node_id,'FORWARD',edge.geometry,edge.length_mm,10000,true,
       fixture.service_eligible,1
FROM network_edge edge
JOIN (VALUES
  ('1',false),('2',false),('3',false),('4',false),('5',true),('6',false)
) fixture(hex,service_eligible) ON edge.edge_key='ed_'||repeat(fixture.hex,64);

WITH profile AS (
  INSERT INTO network_travel_profile(data_scope_key,profile_key,description)
  VALUES ('coverage-gateway-runtime','service','Coverage service vehicle')
  RETURNING travel_profile_id,data_scope_key
)
INSERT INTO network_travel_profile_version(
  travel_profile_id,data_scope_key,version,mode,required_access_mask,maximum_speed_mm_per_s,content_hash
)
SELECT travel_profile_id,data_scope_key,'travel-v1','SERVICE',1,100000,'sha256:'||repeat('7',64) FROM profile;

WITH profile AS (
  INSERT INTO network_cost_profile(travel_profile_id,data_scope_key,profile_key,description)
  SELECT travel_profile_id,data_scope_key,'coverage-cost','Coverage alternative costs'
  FROM network_travel_profile WHERE data_scope_key='coverage-gateway-runtime'
  RETURNING cost_profile_id,travel_profile_id,data_scope_key
)
INSERT INTO network_cost_profile_version(
  cost_profile_id,travel_profile_id,travel_profile_version_id,data_scope_key,version,
  distance_weight_ppm,duration_weight_ppm,risk_weight_ppm,energy_weight_ppm,content_hash
)
SELECT profile.cost_profile_id,profile.travel_profile_id,travel.travel_profile_version_id,profile.data_scope_key,
       'cost-v1',0,1000000,0,0,'sha256:'||repeat('2',64)
FROM profile JOIN network_travel_profile_version travel USING(travel_profile_id,data_scope_key);

INSERT INTO network_arc_cost(
  graph_version_id,arc_id,travel_profile_version_id,cost_profile_version_id,data_scope_key,
  distance_mm,duration_ms,risk_microunits,energy_millijoules,combined_cost_units,content_hash
)
SELECT arc.graph_version_id,arc.arc_id,travel.travel_profile_version_id,cost.cost_profile_version_id,arc.data_scope_key,
       arc.length_mm,
       CASE arc.arc_key
         WHEN 'ar_'||repeat('2',64) THEN 100000
         WHEN 'ar_'||repeat('3',64) THEN 10000
         WHEN 'ar_'||repeat('4',64) THEN 10000
         ELSE 1000
       END,
       CASE arc.arc_key WHEN 'ar_'||repeat('2',64) THEN 10000 ELSE 1000 END,
       0,
       CASE arc.arc_key
         WHEN 'ar_'||repeat('2',64) THEN 100000
         WHEN 'ar_'||repeat('3',64) THEN 10000
         WHEN 'ar_'||repeat('4',64) THEN 10000
         ELSE 1000
       END,
       'sha256:'||encode(digest(arc.arc_key||':g00-cost','sha256'),'hex')
FROM network_arc arc
JOIN network_travel_profile_version travel USING(data_scope_key)
JOIN network_cost_profile_version cost USING(travel_profile_version_id,data_scope_key);

SELECT 'COVERAGE_GATEWAY_FIXTURE_READY' AS result;
