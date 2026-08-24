import { Pool, type PoolClient } from "pg";
import {
  buildNetworkTopology,
  PostgresNetworkFeatureBindingWriter,
  PostgresNetworkTopologyWriter,
  sha256,
  type MaterializedNetworkBuild,
  type MaterializedNetworkFeature
} from "../../packages/network-foundation/src/index.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function feature(id: string, start: number, end: number): MaterializedNetworkFeature {
  return {
    featureReferenceKey: `wrf_${id.repeat(32)}`,
    featureVersion: "1",
    layerKey: "n04-road-centerline",
    contentHash: `sha256:${id.repeat(64)}`,
    positions: [start, end].map((longitude) => ({
      longitudeNanodegrees: longitude * 1_000_000,
      latitudeNanodegrees: 0,
      elevationMm: 0
    })),
    properties: { roadClass: "PRIMARY", surface: "ASPHALT", oneway: true }
  };
}

const runId = required("GOWM_N04_RUN_ID");
const features = [feature("7", 0, 1), feature("8", 1, 2)];
function buildFor(label: string, order = features): MaterializedNetworkBuild {
  return {
    adapterKind: "CATALOG_VECTOR_LAYER",
    dataset: {
      datasetReferenceKey: `wrf_${"f".repeat(32)}`,
      datasetVersion: "1",
      datasetKind: "NETWORK",
      contentHash: `sha256:${"f".repeat(64)}`,
      dataScopeKey: "runtime-context",
      datasetScopeKey: "n01-acceptance"
    },
    buildPolicy: {
      version: `network-build-policy-${runId}-${label}`,
      coordinatePrecisionNanodegrees: 1,
      defaultElevationMm: 0,
      connectAtGradeIntersections: true
    },
    features: order,
    sourceContentHash: sha256({ runId, label, source: "n04-activation-fixture" }),
    graphIdentityHash: sha256({ runId, label, graph: "n04-activation-fixture" }),
    warnings: []
  };
}

const replayLeft = buildNetworkTopology(buildFor("replay"));
const replayRight = buildNetworkTopology(buildFor("replay", [...features].reverse()));
if (replayLeft.topologyHash !== replayRight.topologyHash || replayLeft.contentHash !== replayRight.contentHash) {
  throw new Error("N04 topology replay diverged");
}

const pool = new Pool({
  host: required("GOWM_N04_DATABASE_HOST"), port: 5432,
  database: required("GOWM_N04_DATABASE"), user: required("GOWM_N04_DATABASE_ROLE"),
  password: required("GOWM_N04_DATABASE_PASSWORD"), max: 4, connectionTimeoutMillis: 10_000
});
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const contextResult = await client.query<{
    graph_id: string; dataset_id: string; dataset_version_id: string;
    data_scope_key: string; dataset_scope_key: string;
  }>(`SELECT graph.graph_id::text,graph.dataset_id::text,version.dataset_version_id::text,
            graph.data_scope_key,graph.dataset_scope_key
       FROM network_graph graph
       JOIN network_graph_version version USING (graph_id,dataset_id,data_scope_key,dataset_scope_key)
       WHERE graph.graph_key='n01-graph' ORDER BY version.created_at LIMIT 1`);
  const context = contextResult.rows[0];
  if (!context) throw new Error("network graph context is unavailable");
  const graphContext = { ...context };

  async function createValidatedVersion(transaction: PoolClient, label: string): Promise<string> {
    const build = buildFor(label);
    const topology = buildNetworkTopology(build);
    const result = await transaction.query<{ graph_version_id: string }>(
      `INSERT INTO network_graph_version(
         graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,graph_version,
         build_policy_version,source_content_hash,topology_hash,content_hash,node_count,edge_count,
         arc_count,turn_rule_count,status,build_receipt
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,'VALIDATED',$14::jsonb)
       RETURNING graph_version_id::text`,
      [graphContext.graph_id, graphContext.dataset_id, graphContext.dataset_version_id, graphContext.data_scope_key,
        graphContext.dataset_scope_key, `${runId}-${label}`, build.buildPolicy.version, build.sourceContentHash,
        topology.topologyHash, topology.contentHash, topology.nodes.length, topology.edges.length,
        topology.arcs.length, JSON.stringify({ runId, stage: "N04", label })]
    );
    const graphVersionId = result.rows[0]?.graph_version_id;
    if (!graphVersionId) throw new Error("validated graph version was not returned");
    const rows = await new PostgresNetworkTopologyWriter(transaction).persist({
      graphVersionId, dataScopeKey: graphContext.data_scope_key, topology
    });
    await new PostgresNetworkFeatureBindingWriter(transaction).persist({
      graphVersionId, dataScopeKey: graphContext.data_scope_key, topology, edgeIdsByKey: rows.edgeIdsByKey
    });
    await transaction.query(
      `INSERT INTO network_build_run(
         graph_id,dataset_version_id,data_scope_key,dataset_scope_key,build_policy_version,
         adapter_kind,status,input_hash,output_hash,requested_at,started_at,finished_at,receipt
       ) VALUES ($1,$2,$3,$4,$5,'CATALOG_VECTOR_LAYER','SUCCEEDED',$6,$7,
         clock_timestamp(),clock_timestamp(),clock_timestamp(),$8::jsonb)`,
      [graphContext.graph_id, graphContext.dataset_version_id, graphContext.data_scope_key, graphContext.dataset_scope_key,
        build.buildPolicy.version, build.sourceContentHash, topology.contentHash, JSON.stringify({ runId, label })]
    );
    return graphVersionId;
  }

  const versionA = await createValidatedVersion(client, "a");
  const versionB = await createValidatedVersion(client, "b");
  await client.query("COMMIT");

  const activationResults = await Promise.all([versionA, versionB].map(async (versionId) => {
    const result = await pool.query<{ previous_graph_version_id: string | null; active_graph_version_id: string }>(
      "SELECT previous_graph_version_id::text,active_graph_version_id::text FROM activate_network_graph_version($1,$2,$3)",
      [versionId, "atomic-activation-v1", `n04-${runId}`]
    );
    return result.rows[0];
  }));
  if (activationResults.some((result) => !result)) throw new Error("atomic activation did not return both results");

  await client.query("BEGIN");
  await client.query("SELECT gowm_network_v1.set_scope($1,$2)", [graphContext.data_scope_key, graphContext.dataset_scope_key]);
  const activeResult = await client.query<{ graph_version_id: string }>(
    "SELECT graph_version_id::text FROM gowm_network_v1.resolve_active_graph('n01-graph')"
  );
  const activeVersionId = activeResult.rows[0]?.graph_version_id;
  if (!activeVersionId || ![versionA, versionB].includes(activeVersionId)) throw new Error("atomic active head is invalid");
  const retiredVersionId = activeVersionId === versionA ? versionB : versionA;
  const retainedResult = await client.query<{ count: string }>(
    "SELECT count(*)::text FROM gowm_network_v1.arc WHERE graph_version_id=$1", [retiredVersionId]
  );
  if (Number(retainedResult.rows[0]?.count) !== 2) throw new Error("retired pinned graph is not queryable");

  await client.query(
    `INSERT INTO network_build_run(
       graph_id,dataset_version_id,data_scope_key,dataset_scope_key,build_policy_version,
       adapter_kind,status,input_hash,requested_at,started_at,finished_at,receipt
     ) VALUES ($1,$2,$3,$4,$5,'CATALOG_VECTOR_LAYER','FAILED',$6,
       clock_timestamp(),clock_timestamp(),clock_timestamp(),$7::jsonb)`,
    [graphContext.graph_id, graphContext.dataset_version_id, graphContext.data_scope_key, graphContext.dataset_scope_key,
      `failed-${runId}`, sha256({ runId, failed: true }), JSON.stringify({ runId, failure: "injected" })]
  );
  const activeAfterFailure = await client.query<{ graph_version_id: string }>(
    "SELECT graph_version_id::text FROM gowm_network_v1.resolve_active_graph('n01-graph')"
  );
  if (activeAfterFailure.rows[0]?.graph_version_id !== activeVersionId) throw new Error("failed build changed active head");

  const summaryResult = await client.query<Record<string, unknown>>(
    `SELECT
       (SELECT count(*)::int FROM network_graph_activation_event WHERE graph_id=$1 AND event_type='ACTIVATE' AND graph_version_id IN ($2,$3)) AS "activateCount",
       (SELECT count(*)::int FROM network_graph_activation_event WHERE graph_id=$1 AND event_type='RETIRE' AND graph_version_id IN ($2,$3)) AS "retireCount",
       (SELECT count(*)::int FROM network_graph_version WHERE graph_version_id IN ($2,$3)) AS "retainedVersionCount",
       (SELECT count(*)::int FROM network_build_run WHERE graph_id=$1 AND status='FAILED' AND build_policy_version=$4) AS "failedBuildCount"`,
    [graphContext.graph_id, versionA, versionB, `failed-${runId}`]
  );
  const summary = summaryResult.rows[0];
  if (!summary || summary.activateCount !== 2 || summary.retireCount !== 1 ||
      summary.retainedVersionCount !== 2 || summary.failedBuildCount !== 1) {
    throw new Error(`N04 activation summary mismatch: ${JSON.stringify(summary)}`);
  }
  await client.query("COMMIT");
  process.stdout.write(`N04_CLIENT_SUMMARY ${JSON.stringify({
    ...summary, activeVersionId, retiredVersionId, retiredArcCount: 2,
    concurrentActivationResults: activationResults, failedBuildActiveHeadUnchanged: true,
    replayTopologyHash: replayLeft.topologyHash, replayContentHash: replayLeft.contentHash,
    replayHashMatch: true
  })}\n`);
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* transaction may already be closed */ }
  throw error;
} finally {
  client.release();
  await pool.end();
}
