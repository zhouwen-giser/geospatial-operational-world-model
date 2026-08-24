import { Pool } from "pg";
import {
  buildNetworkTopology,
  PostgresNetworkTopologyWriter,
  type MaterializedNetworkBuild,
  type MaterializedNetworkFeature
} from "../../packages/network-foundation/src/index.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function feature(id: string, coordinates: Array<[number, number, number?]>, properties: Record<string, unknown> = {}): MaterializedNetworkFeature {
  return {
    featureReferenceKey: `wrf_${id.repeat(32)}`,
    featureVersion: "1",
    layerKey: "road-centerline",
    contentHash: `sha256:${id.repeat(64)}`,
    positions: coordinates.map(([longitude, latitude, elevation = 0]) => ({
      longitudeNanodegrees: Math.round(longitude * 1_000_000_000),
      latitudeNanodegrees: Math.round(latitude * 1_000_000_000),
      elevationMm: Math.round(elevation * 1000)
    })),
    properties
  };
}

const features = [
  feature("1", [[120, 30], [120.002, 30]]),
  feature("2", [[120.001, 29.999], [120.001, 30.001]]),
  feature("3", [[120.01, 30], [120.012, 30]], { bridge: true }),
  feature("4", [[120.011, 29.999], [120.011, 30.001]]),
  feature("5", [[120.02, 30], [120.022, 30]], { tunnel: true }),
  feature("6", [[120.021, 29.999], [120.021, 30.001]]),
  feature("7", [[120.03, 30], [120.032, 30]], { layerLevel: 1 }),
  feature("8", [[120.031, 29.999], [120.031, 30.001]], { layerLevel: 0 }),
  feature("9", [[120.04, 30], [120.042, 30]]),
  feature("a", [[120.04, 30.0001], [120.042, 30.0001]]),
  feature("b", [[120.05, 30], [120.052, 30]], { oneway: true }),
  feature("c", [[120.06, 30], [120.062, 30]])
];
const dataScopeKey = required("GOWM_N01_DATA_SCOPE_KEY");
const graphVersionId = required("GOWM_N01_GRAPH_VERSION_ID");
const build: MaterializedNetworkBuild = {
  adapterKind: "CATALOG_VECTOR_LAYER",
  dataset: {
    datasetReferenceKey: `wrf_${"f".repeat(32)}`,
    datasetVersion: "1",
    datasetKind: "NETWORK",
    contentHash: `sha256:${"f".repeat(64)}`,
    dataScopeKey,
    datasetScopeKey: "n01-acceptance"
  },
  buildPolicy: {
    version: "network-build-policy-v1",
    coordinatePrecisionNanodegrees: 1,
    defaultElevationMm: 0,
    connectAtGradeIntersections: true
  },
  features,
  sourceContentHash: `sha256:${"e".repeat(64)}`,
  graphIdentityHash: `sha256:${"d".repeat(64)}`,
  warnings: []
};
const topology = buildNetworkTopology(build);
const pool = new Pool({
  host: required("GOWM_N01_DATABASE_HOST"),
  port: 5432,
  database: required("GOWM_N01_DATABASE"),
  user: required("GOWM_N01_DATABASE_ROLE"),
  password: required("GOWM_N01_DATABASE_PASSWORD"),
  max: 1,
  connectionTimeoutMillis: 10_000
});
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await new PostgresNetworkTopologyWriter(client).persist({ graphVersionId, dataScopeKey, topology });
  const result = await client.query<Record<string, unknown>>(
    `SELECT
       (SELECT count(*)::int FROM network_node WHERE graph_version_id=$1) AS "nodeCount",
       (SELECT count(*)::int FROM network_edge WHERE graph_version_id=$1) AS "edgeCount",
       (SELECT count(*)::int FROM network_arc WHERE graph_version_id=$1) AS "arcCount",
       (SELECT count(*)::int FROM network_arc arc JOIN network_edge edge USING (graph_version_id,edge_id)
         WHERE arc.graph_version_id=$1 AND edge.source_feature_reference_key=$2) AS "onewayArcCount",
       (SELECT count(*)::int FROM network_arc arc JOIN network_edge edge USING (graph_version_id,edge_id)
         WHERE arc.graph_version_id=$1 AND edge.source_feature_reference_key=$3) AS "bidirectionalArcCount",
       (SELECT bool_and(ST_Equals(ST_Force2D(ST_StartPoint(arc.oriented_geometry)),ST_Force2D(source.geometry))
                  AND ST_Equals(ST_Force2D(ST_EndPoint(arc.oriented_geometry)),ST_Force2D(target.geometry)))
          FROM network_arc arc JOIN network_node source ON source.node_id=arc.source_node_id
            JOIN network_node target ON target.node_id=arc.target_node_id WHERE arc.graph_version_id=$1) AS "allArcsOriented"`,
    [graphVersionId, `wrf_${"b".repeat(32)}`, `wrf_${"c".repeat(32)}`]
  );
  const summary = result.rows[0];
  if (!summary || summary.nodeCount !== topology.nodes.length || summary.edgeCount !== topology.edges.length ||
      summary.arcCount !== topology.arcs.length || summary.onewayArcCount !== 1 ||
      summary.bidirectionalArcCount !== 2 || summary.allArcsOriented !== true) {
    throw new Error(`database topology summary mismatch: ${JSON.stringify(summary)}`);
  }
  await client.query("COMMIT");
  process.stdout.write(`N01_CLIENT_SUMMARY ${JSON.stringify(summary)}\n`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
