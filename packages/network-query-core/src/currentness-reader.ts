import { RoutingSnapshotCurrentnessEvaluator, type RoutingSnapshotCurrentnessResult } from "./currentness.js";
import type { NetworkSqlClient, RoutingSnapshot } from "./types.js";

/** Uses the caller's scoped, repeatable-read transaction; never loads route arcs. */
export async function readRoutingSnapshotCurrentness(
  client: Pick<NetworkSqlClient, "query">,
  requested: RoutingSnapshot,
  evaluatedAt = new Date().toISOString()
): Promise<RoutingSnapshotCurrentnessResult> {
  const evaluator = new RoutingSnapshotCurrentnessEvaluator();
  const pinned = (await client.query(
    `SELECT graph_key,graph_version_id FROM gowm_network_v1.graph_version
     WHERE graph_version=$1 AND dataset_version=$2 AND content_hash=$3 LIMIT 2`,
    [requested.graphVersion, requested.networkDatasetVersion, requested.graphContentHash]
  )).rows;
  if (pinned.length !== 1) return evaluator.evaluate(requested, undefined, evaluatedAt);
  const active = (await client.query(
    `SELECT graph.graph_version_id,graph.graph_version,graph.content_hash,graph.dataset_version
     FROM gowm_network_v1.resolve_active_graph($1) active
     JOIN gowm_network_v1.graph_version graph USING(graph_version_id)`, [pinned[0]!.graph_key]
  )).rows[0];
  // Cost identity includes its travel-profile FK. Never guess a profile family
  // from a version label shared by unrelated profiles.
  const families = (await client.query(
    `SELECT DISTINCT cost.profile_key AS cost_key,travel.profile_key AS travel_key
     FROM gowm_network_v1.cost_profile cost
     JOIN gowm_network_v1.travel_profile travel USING(travel_profile_version_id)
     WHERE cost.version=$1 AND cost.content_hash=$2 AND travel.version=$3 LIMIT 2`,
    [requested.costProfileVersion, requested.costContentHash, requested.travelProfileVersion]
  )).rows;
  if (active === undefined || families.length !== 1) return evaluator.evaluate(requested, undefined, evaluatedAt);
  const family = families[0]!;
  const travel = (await client.query(
    `SELECT version FROM gowm_network_v1.travel_profile WHERE profile_key=$1
     ORDER BY created_at DESC,travel_profile_version_id DESC LIMIT 1`, [family.travel_key]
  )).rows[0];
  const cost = (await client.query(
    `SELECT version,content_hash FROM gowm_network_v1.cost_profile WHERE profile_key=$1
     ORDER BY created_at DESC,cost_profile_version_id DESC LIMIT 1`, [family.cost_key]
  )).rows[0];
  if (!travel || !cost) return evaluator.evaluate(requested, undefined, evaluatedAt);
  const condition = (await client.query(
    `SELECT condition_snapshot_id::text,content_hash FROM gowm_network_v1.condition_snapshot
     WHERE graph_version_id=$1::uuid ORDER BY observed_at DESC,condition_snapshot_id DESC LIMIT 1`,
    [active.graph_version_id]
  )).rows[0];
  const world = requested.sourceWorldVersion === undefined ? undefined :
    (await client.query("SELECT world_version FROM gowm_network_v1.source_world")).rows[0];
  const worldVersion = world === undefined ? undefined : Number(world.world_version);
  const current: RoutingSnapshot = {
    networkDatasetVersion: String(active.dataset_version), graphVersion: String(active.graph_version),
    graphContentHash: String(active.content_hash) as `sha256:${string}`,
    travelProfileVersion: String(travel.version), costProfileVersion: String(cost.version),
    costContentHash: String(cost.content_hash) as `sha256:${string}`,
    ...(condition === undefined ? {} : { conditionSnapshotId: String(condition.condition_snapshot_id), conditionContentHash: String(condition.content_hash) as `sha256:${string}` }),
    ...(worldVersion !== undefined && Number.isSafeInteger(worldVersion) && worldVersion >= 0 ? { sourceWorldVersion: worldVersion } : {})
  };
  return evaluator.evaluate(requested, current, evaluatedAt);
}

export function parseRoutingSnapshot(value: unknown): RoutingSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!["networkDatasetVersion", "graphVersion", "travelProfileVersion", "costProfileVersion"].every((key) => typeof row[key] === "string" && row[key].length > 0) ||
      !["graphContentHash", "costContentHash"].every((key) => typeof row[key] === "string" && /^sha256:[0-9a-f]{64}$/u.test(row[key]))) return undefined;
  if (row.conditionSnapshotId !== undefined && (typeof row.conditionSnapshotId !== "string" || row.conditionSnapshotId.length === 0)) return undefined;
  if (row.conditionContentHash !== undefined && (typeof row.conditionContentHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(row.conditionContentHash))) return undefined;
  if (row.sourceWorldVersion !== undefined && (typeof row.sourceWorldVersion !== "number" || !Number.isSafeInteger(row.sourceWorldVersion) || row.sourceWorldVersion < 0)) return undefined;
  return structuredClone(row) as unknown as RoutingSnapshot;
}
