import { Pool } from "pg";
import {
  buildNetworkTopology,
  compileTurnRestrictions,
  PostgresNetworkTopologyWriter,
  PostgresNetworkTurnWriter,
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
    layerKey: "road-centerline",
    contentHash: `sha256:${id.repeat(64)}`,
    positions: [start, end].map((longitude) => ({
      longitudeNanodegrees: longitude * 1_000_000,
      latitudeNanodegrees: 0,
      elevationMm: 0
    })),
    properties: { oneway: true }
  };
}

const runId = required("GOWM_N02_RUN_ID");
const features = [feature("1", 0, 1), feature("2", 1, 2), feature("3", 2, 3)];
const build: MaterializedNetworkBuild = {
  adapterKind: "CATALOG_VECTOR_LAYER",
  dataset: {
    datasetReferenceKey: `wrf_${"f".repeat(32)}`,
    datasetVersion: "1",
    datasetKind: "NETWORK",
    contentHash: `sha256:${"f".repeat(64)}`,
    dataScopeKey: `n02-${runId}`,
    datasetScopeKey: "n01-acceptance"
  },
  buildPolicy: {
    version: "network-build-policy-v1-n02",
    coordinatePrecisionNanodegrees: 1,
    defaultElevationMm: 0,
    connectAtGradeIntersections: true
  },
  features,
  sourceContentHash: sha256({ runId, source: "n02-turn-fixture" }),
  graphIdentityHash: sha256({ runId, graph: "n02-turn-fixture" }),
  warnings: []
};
const topology = buildNetworkTopology(build);
const viaNodeKey = topology.nodes.find((node) => node.position.longitudeNanodegrees === 1_000_000)?.nodeKey;
if (!viaNodeKey) throw new Error("N02 via node is unavailable");
const pairwise = [
  {
    restrictionReferenceKey: "restriction:n02:pairwise",
    fromFeatureReferenceKey: features[0]!.featureReferenceKey,
    viaNodeKey,
    toFeatureReferenceKey: features[1]!.featureReferenceKey,
    ruleType: "FORBIDDEN" as const
  },
  {
    restrictionReferenceKey: "restriction:n02:unresolved-hard",
    fromFeatureReferenceKey: features[0]!.featureReferenceKey,
    viaNodeKey,
    toFeatureReferenceKey: `wrf_${"a".repeat(32)}`,
    ruleType: "ALLOWED_ONLY" as const
  }
];
const sequences = [
  {
    restrictionReferenceKey: "restriction:n02:sequence-forbidden",
    featureReferenceKeys: features.map((item) => item.featureReferenceKey),
    ruleType: "FORBIDDEN" as const
  },
  {
    restrictionReferenceKey: "restriction:n02:sequence-penalty",
    featureReferenceKeys: features.slice(1).map((item) => item.featureReferenceKey),
    ruleType: "PENALTY" as const,
    penaltyUnits: 7
  },
  {
    restrictionReferenceKey: "restriction:n02:unresolved-soft",
    featureReferenceKeys: [features[0]!.featureReferenceKey, `wrf_${"a".repeat(32)}`],
    ruleType: "PENALTY" as const,
    penaltyUnits: 5
  }
];
const compiled = compileTurnRestrictions({ topology, pairwise, sequences });
const replay = compileTurnRestrictions({
  topology,
  pairwise: [...pairwise].reverse(),
  sequences: [...sequences].reverse()
});
if (compiled.contentHash !== replay.contentHash || compiled.automaton.automatonHash !== replay.automaton.automatonHash) {
  throw new Error("N02 restriction replay diverged");
}

const pool = new Pool({
  host: required("GOWM_N02_DATABASE_HOST"),
  port: 5432,
  database: required("GOWM_N02_DATABASE"),
  user: required("GOWM_N02_DATABASE_ROLE"),
  password: required("GOWM_N02_DATABASE_PASSWORD"),
  max: 1,
  connectionTimeoutMillis: 10_000
});
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const contextResult = await client.query<{
    graph_id: string;
    dataset_id: string;
    dataset_version_id: string;
    data_scope_key: string;
    dataset_scope_key: string;
  }>(`SELECT graph.graph_id::text,graph.dataset_id::text,version.dataset_version_id::text,
            graph.data_scope_key,graph.dataset_scope_key
       FROM network_graph graph
       JOIN network_graph_version version USING (graph_id,dataset_id,data_scope_key,dataset_scope_key)
       WHERE graph.graph_key='n01-graph'
       ORDER BY version.created_at LIMIT 1`);
  const context = contextResult.rows[0];
  if (!context) throw new Error("N01 graph context is unavailable in cloned database");
  const versionResult = await client.query<{ graph_version_id: string }>(
    `INSERT INTO network_graph_version(
       graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,graph_version,
       build_policy_version,source_content_hash,topology_hash,content_hash,node_count,edge_count,
       arc_count,turn_rule_count,status,build_receipt
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'VALIDATED',$15::jsonb)
     RETURNING graph_version_id::text`,
    [context.graph_id, context.dataset_id, context.dataset_version_id, context.data_scope_key,
      context.dataset_scope_key, runId, build.buildPolicy.version, build.sourceContentHash,
      topology.topologyHash, sha256({ topology: topology.contentHash, turns: compiled.contentHash }),
      topology.nodes.length, topology.edges.length, topology.arcs.length,
      compiled.pairwiseRules.length + compiled.sequenceRules.length,
      JSON.stringify({ runId, stage: "N02", restrictionHash: compiled.contentHash })]
  );
  const graphVersionId = versionResult.rows[0]?.graph_version_id;
  if (!graphVersionId) throw new Error("N02 graph version was not returned");
  const persisted = await new PostgresNetworkTopologyWriter(client).persist({
    graphVersionId,
    dataScopeKey: context.data_scope_key,
    topology
  });
  await new PostgresNetworkTurnWriter(client).persist({
    graphVersionId,
    dataScopeKey: context.data_scope_key,
    compiled,
    nodeIdsByKey: persisted.nodeIdsByKey,
    arcIdsByKey: persisted.arcIdsByKey
  });
  const buildRunResult = await client.query<{ build_run_id: string }>(
    `INSERT INTO network_build_run(
       graph_id,dataset_version_id,data_scope_key,dataset_scope_key,build_policy_version,
       adapter_kind,status,input_hash,requested_at,started_at,finished_at,receipt
     ) VALUES ($1,$2,$3,$4,$5,'CATALOG_VECTOR_LAYER','REJECTED',$6,
       clock_timestamp(),clock_timestamp(),clock_timestamp(),$7::jsonb)
     RETURNING build_run_id::text`,
    [context.graph_id, context.dataset_version_id, context.data_scope_key, context.dataset_scope_key,
      build.buildPolicy.version, build.sourceContentHash, JSON.stringify({ runId, diagnostics: compiled.diagnostics.length })]
  );
  const buildRunId = buildRunResult.rows[0]?.build_run_id;
  if (!buildRunId) throw new Error("N02 build run was not returned");
  for (const item of compiled.diagnostics) {
    await client.query(
      `INSERT INTO network_validation_issue(
         build_run_id,graph_version_id,data_scope_key,severity,issue_code,activation_blocking,
         entity_kind,entity_key_hash,details
       ) VALUES ($1,$2,$3,$4,$5,$6,'TURN_RULE',$7,$8::jsonb)`,
      [buildRunId, graphVersionId, context.data_scope_key, item.severity, item.issueCode,
        item.activationBlocking, sha256(item.restrictionReferenceKey), JSON.stringify(item)]
    );
  }

  let activationBlocked = false;
  let activationError = "";
  await client.query("SAVEPOINT activation_probe");
  try {
    await client.query(
      `INSERT INTO network_graph_activation_event(
         graph_id,graph_version_id,data_scope_key,dataset_scope_key,event_type,
         activation_policy_version,actor_reference_key,event_hash
       ) VALUES ($1,$2,$3,$4,'ACTIVATE','n02-activation-policy','n02-runtime-gate',$5)`,
      [context.graph_id, graphVersionId, context.data_scope_key, context.dataset_scope_key,
        sha256({ runId, activation: "probe" })]
    );
  } catch (error) {
    activationError = error instanceof Error ? error.message : String(error);
    activationBlocked = activationError.includes("activation-blocking validation issues");
    await client.query("ROLLBACK TO SAVEPOINT activation_probe");
  }
  if (!activationBlocked) throw new Error(`unresolved hard rule did not block activation: ${activationError}`);

  const summaryResult = await client.query<Record<string, unknown>>(
    `SELECT
       (SELECT count(*)::int FROM network_turn_rule WHERE graph_version_id=$1) AS "pairwiseRuleCount",
       (SELECT count(*)::int FROM network_turn_sequence_rule WHERE graph_version_id=$1) AS "sequenceRuleCount",
       (SELECT count(*)::int FROM network_validation_issue WHERE graph_version_id=$1 AND severity='FATAL') AS "fatalCount",
       (SELECT count(*)::int FROM network_validation_issue WHERE graph_version_id=$1 AND severity='WARNING') AS "warningCount",
       (SELECT bool_and(cardinality(arc_sequence)>=2) FROM network_turn_sequence_rule WHERE graph_version_id=$1) AS "sequencesContiguous"`,
    [graphVersionId]
  );
  const summary = summaryResult.rows[0];
  if (!summary || summary.pairwiseRuleCount !== 1 || summary.sequenceRuleCount !== 2 ||
      summary.fatalCount !== 1 || summary.warningCount !== 1 || summary.sequencesContiguous !== true) {
    throw new Error(`N02 database summary mismatch: ${JSON.stringify(summary)}`);
  }
  await client.query("COMMIT");
  process.stdout.write(`N02_CLIENT_SUMMARY ${JSON.stringify({
    ...summary,
    activationBlocked,
    activationError,
    automatonHash: compiled.automaton.automatonHash,
    restrictionContentHash: compiled.contentHash,
    replayHashMatch: true,
    graphVersionId
  })}\n`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
