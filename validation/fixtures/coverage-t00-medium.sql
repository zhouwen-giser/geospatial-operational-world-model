\set ON_ERROR_STOP on

INSERT INTO data_scope(scope_key,operational_domain,description)
VALUES ('coverage-t00-performance','TEST','T00 bounded medium coverage profile');

INSERT INTO spatial_dataset(reference_key,data_scope_key,dataset_scope_key,dataset_key,name)
VALUES ('wrf_70000000000000000000000000000001','coverage-t00-performance','medium','coverage-t00-medium-roads','Coverage T00 medium roads');

INSERT INTO spatial_dataset_version(
  dataset_id,version,dataset_kind,source_ref,source_version,schema_version,crs,quality,lineage,content_hash,published_at
)
SELECT dataset_id,'dataset-medium-v1','NETWORK','urn:test:coverage-t00-medium','1','1.0','EPSG:4326','{}','[]',
       'sha256:'||repeat('8',64),'2026-08-25T00:00:00Z'
FROM spatial_dataset WHERE data_scope_key='coverage-t00-performance' AND dataset_scope_key='medium';

INSERT INTO network_graph(data_scope_key,dataset_scope_key,dataset_id,graph_key,description)
SELECT data_scope_key,dataset_scope_key,dataset_id,'coverage-t00-medium-graph','T00 directed cycle with twenty service obligations'
FROM spatial_dataset WHERE data_scope_key='coverage-t00-performance' AND dataset_scope_key='medium';

INSERT INTO network_graph_version(
  graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,graph_version,build_policy_version,
  source_content_hash,topology_hash,content_hash,node_count,edge_count,arc_count,turn_rule_count,status,build_receipt
)
SELECT graph.graph_id,graph.dataset_id,version.dataset_version_id,graph.data_scope_key,graph.dataset_scope_key,
       'graph-medium-v1','network-build-policy-v1','sha256:'||repeat('8',64),'sha256:'||repeat('9',64),
       'sha256:'||repeat('a',64),20,20,20,0,'VALIDATED','{"fixture":"T00_MEDIUM","bounded":true}'
FROM network_graph graph JOIN spatial_dataset_version version USING(dataset_id)
WHERE graph.data_scope_key='coverage-t00-performance' AND graph.dataset_scope_key='medium';

INSERT INTO network_node(graph_version_id,data_scope_key,node_key,geometry,elevation_mm)
SELECT version.graph_version_id,version.data_scope_key,'nd_'||lpad(to_hex(series.index+1),64,'0'),
       ST_SetSRID(ST_MakePoint(series.index::double precision/10000.0,0.01,0),4326),0
FROM network_graph_version version CROSS JOIN generate_series(0,19) AS series(index)
WHERE version.data_scope_key='coverage-t00-performance';

INSERT INTO network_edge(
  graph_version_id,data_scope_key,edge_key,source_node_id,target_node_id,source_feature_reference_key,
  geometry,length_mm,road_class,oneway
)
SELECT version.graph_version_id,version.data_scope_key,'ed_'||lpad(to_hex(series.index+1),64,'0'),
       source.node_id,target.node_id,'wrf_'||lpad(to_hex(series.index+1),32,'0'),
       ST_MakeLine(source.geometry,target.geometry),1000,'LOCAL','FORWARD_ONLY'
FROM network_graph_version version CROSS JOIN generate_series(0,19) AS series(index)
JOIN network_node source ON source.graph_version_id=version.graph_version_id
  AND source.node_key='nd_'||lpad(to_hex(series.index+1),64,'0')
JOIN network_node target ON target.graph_version_id=version.graph_version_id
  AND target.node_key='nd_'||lpad(to_hex(((series.index+1)%20)+1),64,'0')
WHERE version.data_scope_key='coverage-t00-performance';

INSERT INTO network_arc(
  graph_version_id,data_scope_key,arc_key,edge_id,source_node_id,target_node_id,direction,oriented_geometry,
  length_mm,default_speed_mm_per_s,transit_eligible,service_eligible,access_mask
)
SELECT edge.graph_version_id,edge.data_scope_key,'ar_'||substring(edge.edge_key from 4),edge.edge_id,
       edge.source_node_id,edge.target_node_id,'FORWARD',edge.geometry,edge.length_mm,10000,true,true,1
FROM network_edge edge WHERE edge.data_scope_key='coverage-t00-performance';

WITH profile AS (
  INSERT INTO network_travel_profile(data_scope_key,profile_key,description)
  VALUES ('coverage-t00-performance','service','Coverage T00 medium service vehicle')
  RETURNING travel_profile_id,data_scope_key
)
INSERT INTO network_travel_profile_version(
  travel_profile_id,data_scope_key,version,mode,required_access_mask,maximum_speed_mm_per_s,content_hash
)
SELECT travel_profile_id,data_scope_key,'travel-medium-v1','SERVICE',1,100000,'sha256:'||repeat('b',64) FROM profile;

WITH profile AS (
  INSERT INTO network_cost_profile(travel_profile_id,data_scope_key,profile_key,description)
  SELECT travel_profile_id,data_scope_key,'coverage-cost','Coverage T00 medium costs'
  FROM network_travel_profile WHERE data_scope_key='coverage-t00-performance'
  RETURNING cost_profile_id,travel_profile_id,data_scope_key
)
INSERT INTO network_cost_profile_version(
  cost_profile_id,travel_profile_id,travel_profile_version_id,data_scope_key,version,
  distance_weight_ppm,duration_weight_ppm,risk_weight_ppm,energy_weight_ppm,content_hash
)
SELECT profile.cost_profile_id,profile.travel_profile_id,travel.travel_profile_version_id,profile.data_scope_key,
       'cost-medium-v1',1000000,0,0,0,'sha256:'||repeat('c',64)
FROM profile JOIN network_travel_profile_version travel USING(travel_profile_id,data_scope_key);

INSERT INTO network_arc_cost(
  graph_version_id,arc_id,travel_profile_version_id,cost_profile_version_id,data_scope_key,
  distance_mm,duration_ms,risk_microunits,energy_millijoules,combined_cost_units,content_hash
)
SELECT arc.graph_version_id,arc.arc_id,travel.travel_profile_version_id,cost.cost_profile_version_id,arc.data_scope_key,
       arc.length_mm,1000,100,0,arc.length_mm,
       'sha256:'||encode(digest(arc.arc_key||':t00-medium-cost','sha256'),'hex')
FROM network_arc arc
JOIN network_travel_profile_version travel USING(data_scope_key)
JOIN network_cost_profile_version cost USING(travel_profile_version_id,data_scope_key)
WHERE arc.data_scope_key='coverage-t00-performance';

SELECT 'COVERAGE_T00_MEDIUM_FIXTURE_READY' AS result;
