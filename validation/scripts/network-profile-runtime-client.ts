import { Pool } from "pg";
import {
  buildNetworkTopology,
  createConditionSnapshot,
  createCostProfile,
  createTravelProfile,
  evaluateArcCost,
  PostgresNetworkProfileConditionWriter,
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

function feature(id: string, latitude: number, roadClass: string, surface: string): MaterializedNetworkFeature {
  return {
    featureReferenceKey: `wrf_${id.repeat(32)}`,
    featureVersion: "1",
    layerKey: "road-centerline",
    contentHash: `sha256:${id.repeat(64)}`,
    positions: [0, 1].map((longitude) => ({
      longitudeNanodegrees: longitude * 1_000_000,
      latitudeNanodegrees: latitude * 1_000_000,
      elevationMm: 0
    })),
    properties: { roadClass, surface, oneway: true, defaultSpeedMmPerS: 10_000 }
  };
}

const runId = required("GOWM_N03_RUN_ID");
const build: MaterializedNetworkBuild = {
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
    version: `network-build-policy-${runId}`,
    coordinatePrecisionNanodegrees: 1,
    defaultElevationMm: 0,
    connectAtGradeIntersections: true
  },
  features: [
    feature("4", 4, "PRIMARY", "ASPHALT"),
    feature("5", 5, "TRACK", "GRAVEL"),
    feature("6", 6, "SERVICE", "DIRT")
  ],
  sourceContentHash: sha256({ runId, source: "n03-profile-fixture" }),
  graphIdentityHash: sha256({ runId, graph: "n03-profile-fixture" }),
  warnings: []
};
const topology = buildNetworkTopology(build);
const roadProfile = createTravelProfile({
  profileKey: `road-vehicle-${runId}`,
  version: "1",
  vehicleClass: "ROAD_VEHICLE",
  allowedRoadClasses: ["PRIMARY"],
  allowedSurfaces: ["ASPHALT"],
  onewayPolicy: "STRICT",
  maximumSpeedMmPerS: 20_000,
  requiredAccessMask: 0
});
const ugvProfile = createTravelProfile({
  profileKey: `ugv-${runId}`,
  version: "1",
  vehicleClass: "UGV",
  allowedRoadClasses: ["TRACK", "SERVICE"],
  allowedSurfaces: ["GRAVEL", "DIRT"],
  onewayPolicy: "STRICT",
  maximumSpeedMmPerS: 20_000,
  requiredAccessMask: 0
});
const weights = { distance: 200_000, time: 300_000, risk: 200_000, energy: 200_000, surface: 100_000 };
const roadCostProfile = createCostProfile({ profileKey: `road-balanced-${runId}`, version: "1", weights });
const ugvCostProfile = createCostProfile({ profileKey: `ugv-balanced-${runId}`, version: "1", weights });
const baseMetrics = new Map(topology.arcs.map((arc, index) => [arc.arcKey, {
  riskMicroUnits: 11 + index,
  energyMwh: 13 + index,
  surfacePenaltyUnits: 17 + index
}]));

const pool = new Pool({
  host: required("GOWM_N03_DATABASE_HOST"),
  port: 5432,
  database: required("GOWM_N03_DATABASE"),
  user: required("GOWM_N03_DATABASE_ROLE"),
  password: required("GOWM_N03_DATABASE_PASSWORD"),
  max: 1,
  connectionTimeoutMillis: 10_000
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
  const graphVersionResult = await client.query<{ graph_version_id: string }>(
    `INSERT INTO network_graph_version(
       graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,graph_version,
       build_policy_version,source_content_hash,topology_hash,content_hash,node_count,edge_count,
       arc_count,turn_rule_count,status,build_receipt
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,'BUILDING',$14::jsonb)
     RETURNING graph_version_id::text`,
    [context.graph_id, context.dataset_id, context.dataset_version_id, context.data_scope_key,
      context.dataset_scope_key, runId, build.buildPolicy.version, build.sourceContentHash,
      topology.topologyHash, topology.contentHash, topology.nodes.length, topology.edges.length,
      topology.arcs.length, JSON.stringify({ runId, stage: "N03" })]
  );
  const graphVersionId = graphVersionResult.rows[0]?.graph_version_id;
  if (!graphVersionId) throw new Error("N03 graph version was not returned");
  const topologyRows = await new PostgresNetworkTopologyWriter(client).persist({
    graphVersionId, dataScopeKey: context.data_scope_key, topology
  });
  const writer = new PostgresNetworkProfileConditionWriter(client);
  const roadPersisted = await writer.persistProfile({
    graphVersionId, dataScopeKey: context.data_scope_key, topology,
    arcIdsByKey: topologyRows.arcIdsByKey, travelProfile: roadProfile,
    costProfile: roadCostProfile, baseMetricsByArcKey: baseMetrics
  });
  const ugvPersisted = await writer.persistProfile({
    graphVersionId, dataScopeKey: context.data_scope_key, topology,
    arcIdsByKey: topologyRows.arcIdsByKey, travelProfile: ugvProfile,
    costProfile: ugvCostProfile, baseMetricsByArcKey: baseMetrics
  });
  const roadArc = topology.arcs.find((arc) => roadPersisted.metricsByArcKey.has(arc.arcKey));
  const ugvArc = topology.arcs.find((arc) => ugvPersisted.metricsByArcKey.has(arc.arcKey));
  if (!roadArc || !ugvArc) throw new Error("profile-specific Arc fixtures are unavailable");
  const roadEdge = topology.edges.find((edge) => edge.edgeKey === roadArc.edgeKey)!;
  const ugvEdge = topology.edges.find((edge) => edge.edgeKey === ugvArc.edgeKey)!;
  const baseline = createConditionSnapshot({
    sourceSnapshotVersion: "1",
    observedAt: "2026-08-25T00:00:00Z",
    validUntil: "2026-08-25T01:00:00Z",
    completeness: "COMPLETE",
    sourceContentHash: sha256({ runId, condition: 1 }),
    conditions: [],
    metadata: { runId }
  });
  const changed = createConditionSnapshot({
    sourceSnapshotVersion: "2",
    observedAt: "2026-08-25T00:10:00Z",
    validUntil: "2026-08-25T01:10:00Z",
    completeness: "PARTIAL",
    sourceContentHash: sha256({ runId, condition: 2 }),
    conditions: [
      {
        arcKey: roadArc.arcKey,
        traversalAllowed: true,
        speedOverrideMmPerS: 5_000,
        riskOverrideMicroUnits: 99,
        costMultiplierPpm: 1_100_000,
        reasonCodes: ["INCIDENT"],
        evidence: [{ source: "n03-runtime", confidencePpm: 900_000 }]
      },
      {
        arcKey: ugvArc.arcKey,
        traversalAllowed: false,
        reasonCodes: ["CLOSED"],
        evidence: [{ source: "n03-runtime", authority: "operator" }]
      }
    ],
    metadata: { runId }
  });
  const baselineId = await writer.persistConditionSnapshot({
    graphVersionId, dataScopeKey: context.data_scope_key, arcIdsByKey: topologyRows.arcIdsByKey, snapshot: baseline
  });
  const changedId = await writer.persistConditionSnapshot({
    graphVersionId, dataScopeKey: context.data_scope_key, arcIdsByKey: topologyRows.arcIdsByKey, snapshot: changed
  });
  const roadBase = baseMetrics.get(roadArc.arcKey)!;
  const baselineCost = evaluateArcCost({
    edge: roadEdge, arc: roadArc, travelProfile: roadProfile, costProfile: roadCostProfile,
    baseRiskMicroUnits: roadBase.riskMicroUnits, baseEnergyMwh: roadBase.energyMwh,
    surfacePenaltyUnits: roadBase.surfacePenaltyUnits, conditionSnapshot: baseline
  });
  const changedCost = evaluateArcCost({
    edge: roadEdge, arc: roadArc, travelProfile: roadProfile, costProfile: roadCostProfile,
    baseRiskMicroUnits: roadBase.riskMicroUnits, baseEnergyMwh: roadBase.energyMwh,
    surfacePenaltyUnits: roadBase.surfacePenaltyUnits, conditionSnapshot: changed
  });
  const ugvBase = baseMetrics.get(ugvArc.arcKey)!;
  const closedCost = evaluateArcCost({
    edge: ugvEdge, arc: ugvArc, travelProfile: ugvProfile, costProfile: ugvCostProfile,
    baseRiskMicroUnits: ugvBase.riskMicroUnits, baseEnergyMwh: ugvBase.energyMwh,
    surfacePenaltyUnits: ugvBase.surfacePenaltyUnits, conditionSnapshot: changed
  });
  if (!baselineCost || !changedCost || changedCost.durationMs <= baselineCost.durationMs ||
      changedCost.riskMicroUnits !== 99 || closedCost !== null) {
    throw new Error("N03 pinned condition evaluation mismatch");
  }
  const baselineReplay = evaluateArcCost({
    edge: roadEdge, arc: roadArc, travelProfile: roadProfile, costProfile: roadCostProfile,
    baseRiskMicroUnits: roadBase.riskMicroUnits, baseEnergyMwh: roadBase.energyMwh,
    surfacePenaltyUnits: roadBase.surfacePenaltyUnits, conditionSnapshot: baseline
  });
  if (baselineReplay?.contentHash !== baselineCost.contentHash) throw new Error("historical condition replay diverged");

  const summaryResult = await client.query<Record<string, unknown>>(
    `SELECT
       (SELECT count(*)::int FROM network_travel_profile_version WHERE data_scope_key=$1 AND constraints->>'vehicleClass'='ROAD_VEHICLE') AS "roadProfileCount",
       (SELECT count(*)::int FROM network_travel_profile_version WHERE data_scope_key=$1 AND constraints->>'vehicleClass'='UGV') AS "ugvProfileCount",
       (SELECT count(*)::int FROM network_arc_cost WHERE graph_version_id=$2) AS "arcCostCount",
       (SELECT bool_and(cost.distance_mm=arc.length_mm) FROM network_arc_cost cost JOIN network_arc arc USING(graph_version_id,arc_id) WHERE cost.graph_version_id=$2) AS "distanceExact",
       (SELECT bool_and(cost.duration_ms=(arc.length_mm*1000+arc.default_speed_mm_per_s-1)/arc.default_speed_mm_per_s) FROM network_arc_cost cost JOIN network_arc arc USING(graph_version_id,arc_id) WHERE cost.graph_version_id=$2) AS "durationExact",
       (SELECT bool_and(cost.energy_millijoules=cost.energy_mwh*3600) FROM network_arc_cost cost WHERE cost.graph_version_id=$2) AS "energyExact",
       (SELECT bool_and(direction='FORWARD') FROM network_arc WHERE graph_version_id=$2) AS "strictOneway",
       (SELECT count(*)::int FROM network_condition_snapshot WHERE graph_version_id=$2) AS "conditionSnapshotCount",
       (SELECT count(*)::int FROM network_arc_condition WHERE graph_version_id=$2 AND NOT traversal_allowed) AS "closedArcCount",
       (SELECT count(*)::int FROM network_arc_condition WHERE graph_version_id=$2 AND risk_override_microunits=99 AND jsonb_array_length(evidence)>0) AS "riskEvidenceCount",
       (SELECT bool_and(default_speed_mm_per_s=10000) FROM network_arc WHERE graph_version_id=$2) AS "baseSpeedUnchanged"`,
    [context.data_scope_key, graphVersionId]
  );
  const summary = summaryResult.rows[0];
  if (!summary || summary.roadProfileCount !== 1 || summary.ugvProfileCount !== 1 ||
      summary.arcCostCount !== 3 || summary.distanceExact !== true || summary.durationExact !== true ||
      summary.energyExact !== true || summary.strictOneway !== true || summary.conditionSnapshotCount !== 2 ||
      summary.closedArcCount !== 1 || summary.riskEvidenceCount !== 1 || summary.baseSpeedUnchanged !== true) {
    throw new Error(`N03 database summary mismatch: ${JSON.stringify(summary)}`);
  }
  await client.query("COMMIT");
  process.stdout.write(`N03_CLIENT_SUMMARY ${JSON.stringify({
    ...summary,
    baselineSnapshotId: baselineId,
    changedSnapshotId: changedId,
    baselineDurationMs: baselineCost.durationMs,
    changedDurationMs: changedCost.durationMs,
    changedRiskMicroUnits: changedCost.riskMicroUnits,
    historicalReplayHashMatch: true,
    graphVersionId
  })}\n`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
