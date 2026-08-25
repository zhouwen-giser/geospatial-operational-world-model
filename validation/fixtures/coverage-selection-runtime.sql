\set ON_ERROR_STOP on

INSERT INTO data_scope(scope_key,operational_domain,description)
VALUES ('coverage-selection-runtime','TEST','B00 real PostGIS selection scope');

INSERT INTO spatial_dataset(reference_key,data_scope_key,dataset_scope_key,dataset_key,name)
VALUES ('wrf_11111111111111111111111111111111','coverage-selection-runtime','tenant-a','coverage-roads','Coverage selection roads');

INSERT INTO spatial_dataset_version(
  dataset_id,version,dataset_kind,source_ref,source_version,schema_version,crs,quality,lineage,content_hash,published_at
)
SELECT dataset_id,'dataset-v1','NETWORK','urn:test:coverage-roads','1','1.0','EPSG:4326','{}','[]',
       'sha256:'||repeat('d',64),'2026-08-25T00:00:00Z'
FROM spatial_dataset WHERE data_scope_key='coverage-selection-runtime' AND dataset_scope_key='tenant-a';

INSERT INTO network_graph(data_scope_key,dataset_scope_key,dataset_id,graph_key,description)
SELECT data_scope_key,dataset_scope_key,dataset_id,'coverage-graph','B00 authoritative fixture graph'
FROM spatial_dataset WHERE data_scope_key='coverage-selection-runtime' AND dataset_scope_key='tenant-a';

INSERT INTO network_graph_version(
  graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,graph_version,build_policy_version,
  source_content_hash,topology_hash,content_hash,node_count,edge_count,arc_count,turn_rule_count,status,build_receipt
)
SELECT graph.graph_id,graph.dataset_id,version.dataset_version_id,graph.data_scope_key,graph.dataset_scope_key,
       'graph-v1','network-build-policy-v1','sha256:'||repeat('d',64),'sha256:'||repeat('e',64),
       'sha256:'||repeat('1',64),12,6,11,0,'VALIDATED','{"fixture":"B00"}'
FROM network_graph graph JOIN spatial_dataset_version version USING(dataset_id)
WHERE graph.data_scope_key='coverage-selection-runtime' AND graph.dataset_scope_key='tenant-a';

INSERT INTO network_node(graph_version_id,data_scope_key,node_key,geometry,elevation_mm)
SELECT version.graph_version_id,version.data_scope_key,'nd_'||repeat(fixture.hex,64),
       ST_GeomFromText(fixture.wkt,4326),0
FROM network_graph_version version
CROSS JOIN (VALUES
  ('1','POINT Z (0 5 0)'),('2','POINT Z (10 5 0)'),
  ('3','POINT Z (1 1 0)'),('4','POINT Z (3 1 0)'),
  ('5','POINT Z (20 20 0)'),('6','POINT Z (21 20 0)'),
  ('7','POINT Z (0 0 0)'),('8','POINT Z (10 0 0)'),
  ('9','POINT Z (1 2 0)'),('a','POINT Z (3 2 0)'),
  ('b','POINT Z (1 3 0)'),('c','POINT Z (3 3 0)')
) fixture(hex,wkt)
WHERE version.data_scope_key='coverage-selection-runtime';

INSERT INTO network_edge(
  graph_version_id,data_scope_key,edge_key,source_node_id,target_node_id,source_feature_reference_key,
  geometry,length_mm,road_class,oneway
)
SELECT version.graph_version_id,version.data_scope_key,'ed_'||repeat(fixture.hex,64),source.node_id,target.node_id,
       'wrf_'||repeat(fixture.hex,32),ST_GeomFromText(fixture.wkt,4326),fixture.length_mm,fixture.road_class,fixture.oneway
FROM network_graph_version version
JOIN (VALUES
  ('1','1','2','LINESTRING Z (0 5 0,10 5 0)',10000000::bigint,'LOCAL','BIDIRECTIONAL'),
  ('2','3','4','LINESTRING Z (1 1 0,3 1 0)',2000000::bigint,'LOCAL','FORWARD_ONLY'),
  ('3','5','6','LINESTRING Z (20 20 0,21 20 0)',1000000::bigint,'LOCAL','BIDIRECTIONAL'),
  ('4','7','8','LINESTRING Z (0 0 0,10 0 0)',10000000::bigint,'LOCAL','BIDIRECTIONAL'),
  ('5','9','a','LINESTRING Z (1 2 0,3 2 0)',2000000::bigint,'LOCAL','BIDIRECTIONAL'),
  ('6','b','c','LINESTRING Z (1 3 0,3 3 0)',2000000::bigint,'PRIMARY','BIDIRECTIONAL')
) fixture(hex,source_hex,target_hex,wkt,length_mm,road_class,oneway) ON true
JOIN network_node source ON source.graph_version_id=version.graph_version_id AND source.node_key='nd_'||repeat(fixture.source_hex,64)
JOIN network_node target ON target.graph_version_id=version.graph_version_id AND target.node_key='nd_'||repeat(fixture.target_hex,64)
WHERE version.data_scope_key='coverage-selection-runtime';

INSERT INTO network_arc(
  graph_version_id,data_scope_key,arc_key,edge_id,source_node_id,target_node_id,direction,oriented_geometry,
  length_mm,default_speed_mm_per_s,transit_eligible,service_eligible,access_mask
)
SELECT edge.graph_version_id,edge.data_scope_key,'ar_'||repeat(fixture.arc_hex,64),edge.edge_id,
       CASE fixture.direction WHEN 'FORWARD' THEN edge.source_node_id ELSE edge.target_node_id END,
       CASE fixture.direction WHEN 'FORWARD' THEN edge.target_node_id ELSE edge.source_node_id END,
       fixture.direction,
       CASE fixture.direction WHEN 'FORWARD' THEN edge.geometry ELSE ST_Reverse(edge.geometry) END,
       edge.length_mm,10000,true,fixture.service_eligible,1
FROM network_edge edge
JOIN (VALUES
  ('1','1','FORWARD',true),('1','2','REVERSE',true),
  ('2','3','FORWARD',true),
  ('3','4','FORWARD',true),('3','5','REVERSE',true),
  ('4','6','FORWARD',true),('4','7','REVERSE',true),
  ('5','8','FORWARD',false),('5','9','REVERSE',false),
  ('6','a','FORWARD',true),('6','b','REVERSE',true)
) fixture(edge_hex,arc_hex,direction,service_eligible)
  ON edge.edge_key='ed_'||repeat(fixture.edge_hex,64);

SELECT 'COVERAGE_SELECTION_FIXTURE_READY' AS result;
