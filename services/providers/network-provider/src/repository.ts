import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { PlatformCommonDefinitionsReferenceKey } from "../../../../packages/platform/contract-runtime/src/index.js";
import { matrix, shortestPath, verifyPath, type Objective } from "./engine.js";
import type {
  DirectedState,
  LoadedNetwork,
  NetworkArc,
  NetworkExecutionResult,
  NetworkProviderOptions,
  NetworkSqlClient,
  Row,
  RoutingSnapshot,
  TurnRule
} from "./types.js";

export const NETWORK_OPERATION_IDS = [
  "network.graph.get", "network.graph.list", "network.graph.diagnose",
  "network.snap.point", "network.snap.points", "network.path.shortest",
  "network.path.cost-matrix", "network.path.expand", "network.path.verify",
  "network.connectivity.inspect", "network.reachability"
] as const;
export type NetworkOperationId = (typeof NETWORK_OPERATION_IDS)[number];

export class NetworkRepository {
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly maximumSegments: number;
  private readonly maximumMatrixPoints: number;
  private readonly ambiguityScoreTolerance: number;
  private readonly now: () => Date;

  constructor(private readonly options: NetworkProviderOptions) {
    this.statementTimeoutMs = positive(options.statementTimeoutMs ?? 10_000, "statementTimeoutMs");
    this.lockTimeoutMs = positive(options.lockTimeoutMs ?? 1_000, "lockTimeoutMs");
    this.maximumSegments = bounded(options.maximumSegments ?? 100_000, 100_000, "maximumSegments");
    this.maximumMatrixPoints = bounded(options.maximumMatrixPoints ?? 64, 500, "maximumMatrixPoints");
    this.ambiguityScoreTolerance = nonnegative(options.ambiguityScoreTolerance ?? 1_000, "ambiguityScoreTolerance");
    this.now = options.now ?? (() => new Date());
  }

  async loadPinned(snapshotValue: unknown, security: { dataScopeKey?: string; datasetScopeKey?: string }, deadlineRemainingMs: number): Promise<LoadedNetwork> {
    const dataScopeKey = security.dataScopeKey?.trim(); const datasetScopeKey = security.datasetScopeKey?.trim();
    if (!dataScopeKey || !datasetScopeKey) throw new ProviderProtocolError("SCOPE_DENIED", "network data and dataset scopes are required");
    const client = await this.options.pool.connect().catch((cause: unknown) => { throw new ProviderProtocolError("PROVIDER_NOT_READY", "network read pool is unavailable", { retryable: true, cause }); });
    let open = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); open = true;
      const timeout = Math.max(1, Math.min(this.statementTimeoutMs, Math.floor(deadlineRemainingMs)));
      await client.query("SELECT set_config('statement_timeout',$1::text,true)", [`${timeout}ms`]);
      await client.query("SELECT gowm_network_v1.set_scope($1::text,$2::text)", [dataScopeKey, datasetScopeKey]);
      const network = await this.loadNetwork(client, routingSnapshot(snapshotValue), dataScopeKey, datasetScopeKey);
      await client.query("COMMIT"); open = false; return network;
    } catch (error) { if (open) await client.query("ROLLBACK").catch(() => undefined); throw mapDatabaseError(error); }
    finally { client.release(); }
  }

  async inspectFreshness(network: LoadedNetwork, security: { dataScopeKey?: string; datasetScopeKey?: string }, deadlineRemainingMs: number): Promise<{ graphCurrent: boolean; profileCurrent: boolean; conditionCurrent: boolean }> {
    const dataScopeKey = security.dataScopeKey?.trim(); const datasetScopeKey = security.datasetScopeKey?.trim();
    if (!dataScopeKey || !datasetScopeKey) throw new ProviderProtocolError("SCOPE_DENIED", "network data and dataset scopes are required");
    const client = await this.options.pool.connect(); let open = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); open = true;
      const timeout = Math.max(1, Math.min(this.statementTimeoutMs, Math.floor(deadlineRemainingMs)));
      await client.query("SELECT set_config('statement_timeout',$1::text,true)", [`${timeout}ms`]);
      await client.query("SELECT gowm_network_v1.set_scope($1::text,$2::text)", [dataScopeKey, datasetScopeKey]);
      const active = (await client.query("SELECT graph_version,content_hash FROM gowm_network_v1.resolve_active_graph($1)", [requiredString(network.graph.graph_key, "graph_key")])).rows[0];
      const condition = (await client.query("SELECT condition_snapshot_id::text,content_hash FROM gowm_network_v1.condition_snapshot WHERE graph_version_id=$1::uuid ORDER BY observed_at DESC,condition_snapshot_id DESC LIMIT 1", [requiredString(network.graph.graph_version_id, "graph_version_id")])).rows[0];
      const profiles = (await client.query(`WITH chosen_travel AS (SELECT profile_key FROM gowm_network_v1.travel_profile WHERE version=$1 ORDER BY profile_key LIMIT 1), chosen_cost AS (SELECT profile_key FROM gowm_network_v1.cost_profile WHERE version=$2 AND content_hash=$3 ORDER BY profile_key LIMIT 1), latest_travel AS (SELECT version FROM gowm_network_v1.travel_profile WHERE profile_key=(SELECT profile_key FROM chosen_travel) ORDER BY travel_profile_version_id DESC LIMIT 1), latest_cost AS (SELECT version,content_hash FROM gowm_network_v1.cost_profile WHERE profile_key=(SELECT profile_key FROM chosen_cost) ORDER BY cost_profile_version_id DESC LIMIT 1) SELECT (SELECT version FROM latest_travel) AS travel_version,(SELECT version FROM latest_cost) AS cost_version,(SELECT content_hash FROM latest_cost) AS cost_hash`, [network.routingSnapshot.travelProfileVersion, network.routingSnapshot.costProfileVersion, network.routingSnapshot.costContentHash])).rows[0];
      await client.query("COMMIT"); open = false;
      return {
        graphCurrent: Boolean(active) && active!.graph_version === network.routingSnapshot.graphVersion && active!.content_hash === network.routingSnapshot.graphContentHash,
        profileCurrent: Boolean(profiles) && profiles!.travel_version === network.routingSnapshot.travelProfileVersion && profiles!.cost_version === network.routingSnapshot.costProfileVersion && profiles!.cost_hash === network.routingSnapshot.costContentHash,
        conditionCurrent: network.routingSnapshot.conditionSnapshotId === undefined ? condition === undefined : Boolean(condition) && condition!.condition_snapshot_id === network.routingSnapshot.conditionSnapshotId && condition!.content_hash === network.routingSnapshot.conditionContentHash
      };
    } catch (error) { if (open) await client.query("ROLLBACK").catch(() => undefined); throw mapDatabaseError(error); }
    finally { client.release(); }
  }

  async arcsIntersectingAreas(snapshotValue: unknown, areas: Row[], security: { dataScopeKey?: string; datasetScopeKey?: string }, deadlineRemainingMs: number): Promise<string[]> {
    if (areas.length === 0) return [];
    const dataScopeKey=security.dataScopeKey?.trim(),datasetScopeKey=security.datasetScopeKey?.trim();if(!dataScopeKey||!datasetScopeKey)throw new ProviderProtocolError("SCOPE_DENIED","network data and dataset scopes are required");
    const client=await this.options.pool.connect();let open=false;try{await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");open=true;const timeout=Math.max(1,Math.min(this.statementTimeoutMs,Math.floor(deadlineRemainingMs)));await client.query("SELECT set_config('statement_timeout',$1::text,true)",[`${timeout}ms`]);await client.query("SELECT gowm_network_v1.set_scope($1::text,$2::text)",[dataScopeKey,datasetScopeKey]);const snapshot=routingSnapshot(snapshotValue);const graph=(await client.query("SELECT graph_version_id FROM gowm_network_v1.graph_version WHERE graph_version=$1 AND dataset_version=$2 AND content_hash=$3 ORDER BY created_at DESC LIMIT 1",[snapshot.graphVersion,snapshot.networkDatasetVersion,snapshot.graphContentHash])).rows[0];if(!graph)throw new ProviderProtocolError("VERSION_NOT_FOUND","routing graph snapshot is unavailable in scope");const result=await client.query("SELECT arc_key FROM gowm_network_v1.arcs_intersecting_areas($1::uuid,$2::jsonb)",[requiredString(graph.graph_version_id,"graph_version_id"),JSON.stringify(areas)]);await client.query("COMMIT");open=false;return result.rows.map(item=>externalArcKey(requiredString(item.arc_key,"arc_key")));}catch(error){if(open)await client.query("ROLLBACK").catch(()=>undefined);throw mapDatabaseError(error);}finally{client.release();}
  }

  async execute(operationId: NetworkOperationId, inputValue: unknown, security: { dataScopeKey?: string; datasetScopeKey?: string }, deadlineRemainingMs: number): Promise<NetworkExecutionResult> {
    const dataScopeKey = security.dataScopeKey?.trim();
    const datasetScopeKey = security.datasetScopeKey?.trim();
    if (!dataScopeKey || !datasetScopeKey) throw new ProviderProtocolError("SCOPE_DENIED", "network data and dataset scopes are required");
    const input = asRow(inputValue);
    const client = await this.options.pool.connect().catch((cause: unknown) => {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "network read pool is unavailable", { retryable: true, cause });
    });
    let open = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      open = true;
      const timeout = Math.max(1, Math.min(this.statementTimeoutMs, Math.floor(deadlineRemainingMs), optionalPositive(input.deadlineMs) ?? Number.POSITIVE_INFINITY));
      await client.query("SELECT set_config('statement_timeout',$1::text,true)", [`${timeout}ms`]);
      await client.query("SELECT set_config('lock_timeout',$1::text,true)", [`${Math.min(timeout, this.lockTimeoutMs)}ms`]);
      await client.query("SELECT gowm_network_v1.set_scope($1::text,$2::text)", [dataScopeKey, datasetScopeKey]);
      const snapshot = routingSnapshot(input.routingSnapshot);
      const network = await this.loadNetwork(client, snapshot, dataScopeKey, datasetScopeKey);
      const deadlineAtMs = this.now().getTime() + timeout;
      const result = await this.dispatch(client, operationId, input, network, deadlineAtMs);
      await client.query("COMMIT");
      open = false;
      return result;
    } catch (error) {
      if (open) await client.query("ROLLBACK").catch(() => undefined);
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async readiness(): Promise<{ ready: boolean; reasons: string[] }> {
    let client: NetworkSqlClient | undefined;
    try {
      client = await this.options.pool.connect();
      await client.query("SELECT * FROM gowm_network_v1.graph_version LIMIT 0");
      await client.query("SELECT * FROM gowm_network_v1.arc LIMIT 0");
      return { ready: true, reasons: [] };
    } catch {
      return { ready: false, reasons: ["gowm_network_v1 read contract is unavailable"] };
    } finally { client?.release(); }
  }

  private async dispatch(client: NetworkSqlClient, operationId: NetworkOperationId, input: Row, network: LoadedNetwork, deadlineAtMs: number): Promise<NetworkExecutionResult> {
    const standard = (output: unknown, rows = network.arcs.length, candidates = 0, warnings: string[] = []): NetworkExecutionResult => ({
      output, dataSnapshot: network.dataSnapshot, rows, candidates, warnings
    });
    if (operationId === "network.graph.get") return standard(graphVersionOutput(network.graph), 1);
    if (operationId === "network.graph.list") return standard(buildResult(network, "network.graph.list", []), 1);
    if (operationId === "network.graph.diagnose") return standard(buildResult(network, "network.graph.diagnose", diagnostics(network)), network.arcs.length);
    if (operationId === "network.snap.point" || operationId === "network.snap.points") {
      const output = await this.snap(client, input, network);
      return standard(output, network.arcs.length, (output.candidates as unknown[]).length);
    }
    if (operationId === "network.path.shortest") {
      const maximumSegments = Math.min(this.maximumSegments, optionalPositive(input.maximumSegments) ?? this.maximumSegments);
      const output = shortestPath(network, directedState(input.start), directedState(input.destination), objective(input.objective), maximumSegments, input.turnLegality === "IGNORE_SOFT_PENALTIES", () => this.now().getTime(), deadlineAtMs);
      return standard(output, network.arcs.length);
    }
    if (operationId === "network.path.cost-matrix") {
      const points = array(input.points).map(directedState);
      if (points.length > this.maximumMatrixPoints) throw new ProviderProtocolError("BUDGET_EXCEEDED", "synchronous network matrix point budget exceeded", { details: { maximumMatrixPoints: this.maximumMatrixPoints } });
      return standard(matrix(network, points, objective(input.objective), this.maximumSegments, () => this.now().getTime(), deadlineAtMs), network.arcs.length);
    }
    if (operationId === "network.path.verify") return standard(verifyPath(network, input), network.arcs.length);
    if (operationId === "network.path.expand") {
      const verified = verifyPath(network, input);
      if (verified.status !== "VALID") throw new ProviderProtocolError("INVALID_REQUEST", "path cannot be expanded because independent replay failed", { details: { verification: verified } });
      return standard(input, network.arcs.length);
    }
    if (operationId === "network.connectivity.inspect") return standard(buildResult(network, "network.connectivity.inspect", diagnostics(network)), network.arcs.length);
    return standard(buildResult(network, "network.reachability", reachabilityDiagnostics(network, input.location)), network.arcs.length);
  }

  private async snap(client: NetworkSqlClient, input: Row, network: LoadedNetwork): Promise<Row> {
    const location = asRow(input.location);
    if (typeof location.arcKey === "string") {
      const state = directedState(location);
      const arc = network.arcs.find((candidate) => candidate.key === state.arcKey && candidate.direction === state.direction);
      const candidates = arc ? [{ state: withSource(state, arc), distanceMm: 0, candidateScore: 0 }] : [];
      return { status: arc ? "RESOLVED_UNIQUE" : "UNREACHABLE", routingSnapshot: network.routingSnapshot, candidates };
    }
    if (location.namespace === "gowm" && typeof location.id === "string") {
      const matches = network.arcs.filter((arc) => arc.sourceFeatureReferenceKey?.id === location.id).slice(0, integer(input.limit, "limit"));
      const candidates = matches.map((arc) => ({ state: stateFor(arc, 500_000), distanceMm: 0, candidateScore: 0 }));
      return { status: candidates.length === 0 ? "UNREACHABLE" : candidates.length === 1 ? "RESOLVED_UNIQUE" : "AMBIGUOUS", routingSnapshot: network.routingSnapshot, candidates };
    }
    const coordinates = array(location.coordinates);
    if (coordinates.length < 2) throw new ProviderProtocolError("INVALID_REQUEST", "snap position requires two coordinates");
    const longitude = finite(coordinates[0], "longitude");
    const latitude = finite(coordinates[1], "latitude");
    const limit = integer(input.limit, "limit");
    const raw = await client.query(
      "SELECT * FROM gowm_network_v1.snap_candidates_wgs84($1::uuid,$2::float8,$3::float8,32)",
      [requiredString(network.graph.graph_version_id, "graph_version_id"), longitude, latitude]
    );
    const byId = new Map(network.arcs.map((arc) => [arc.id, arc]));
    const heading = input.headingDegrees === undefined ? undefined : finite(input.headingDegrees, "headingDegrees") * 1_000_000;
    const maximumDistanceMm = Math.round(finite(input.maxDistanceM, "maxDistanceM") * 1000);
    const candidates = raw.rows.flatMap((row) => {
      const arc = byId.get(String(row.arc_id));
      const distanceMm = safeInteger(row.distance_mm, "distance_mm");
      if (!arc || distanceMm > maximumDistanceMm) return [];
      const difference = heading === undefined ? undefined : circularDifference(heading, arc.headingMicrodegrees);
      const candidateScore = distanceMm + (difference === undefined ? 0 : Math.round(difference / 1_000));
      return [{
        state: stateFor(arc, safeInteger(row.fraction_ppm, "fraction_ppm")),
        distanceMm,
        ...(difference === undefined ? {} : { headingDifferenceMicrodegrees: difference }),
        candidateScore
      }];
    }).sort((a, b) => a.candidateScore - b.candidateScore || a.state.arcKey.localeCompare(b.state.arcKey)).slice(0, limit);
    const status = candidates.length === 0 ? "UNREACHABLE"
      : candidates.length > 1 && candidates[1]!.candidateScore - candidates[0]!.candidateScore <= this.ambiguityScoreTolerance ? "AMBIGUOUS"
      : "RESOLVED_UNIQUE";
    return { status, routingSnapshot: network.routingSnapshot, candidates };
  }

  private async loadNetwork(client: NetworkSqlClient, requested: RoutingSnapshot, dataScopeKey: string, datasetScopeKey: string): Promise<LoadedNetwork> {
    const graphResult = await client.query(
      "SELECT * FROM gowm_network_v1.graph_version WHERE graph_version=$1 AND dataset_version=$2 AND content_hash=$3 ORDER BY created_at DESC LIMIT 1",
      [requested.graphVersion, requested.networkDatasetVersion, requested.graphContentHash]
    );
    const graph = graphResult.rows[0];
    if (!graph) throw new ProviderProtocolError("VERSION_NOT_FOUND", "routing graph snapshot is unavailable in scope");
    const profileResult = await client.query(
      "SELECT travel.travel_profile_version_id,travel.required_access_mask,travel.mode,cost.cost_profile_version_id,cost.content_hash FROM gowm_network_v1.travel_profile travel JOIN gowm_network_v1.cost_profile cost USING (travel_profile_version_id) WHERE travel.version=$1 AND cost.version=$2 AND cost.content_hash=$3 ORDER BY travel.profile_key,cost.profile_key LIMIT 1",
      [requested.travelProfileVersion, requested.costProfileVersion, requested.costContentHash]
    );
    const profile = profileResult.rows[0];
    if (!profile) throw new ProviderProtocolError("VERSION_NOT_FOUND", "routing profile snapshot is unavailable in scope");
    let conditionId: string | undefined;
    if (requested.conditionSnapshotId !== undefined) {
      const conditionResult = await client.query(
        "SELECT condition_snapshot_id,content_hash FROM gowm_network_v1.condition_snapshot WHERE graph_version_id=$1::uuid AND (condition_snapshot_id::text=$2 OR condition_snapshot_key=$2) ORDER BY observed_at DESC LIMIT 1",
        [graph.graph_version_id, requested.conditionSnapshotId]
      );
      const condition = conditionResult.rows[0];
      if (!condition || (requested.conditionContentHash !== undefined && condition.content_hash !== requested.conditionContentHash)) throw new ProviderProtocolError("VERSION_NOT_FOUND", "routing condition snapshot is unavailable in scope");
      conditionId = requiredString(condition.condition_snapshot_id, "condition_snapshot_id");
    }
    const arcResult = await client.query(
      `SELECT arc.arc_id,arc.arc_key,arc.source_node_id,arc.target_node_id,arc.direction,
              edge.source_feature_reference_key,arc.access_mask,
              arc.heading_microdegrees,
              cost.distance_mm,cost.duration_ms,cost.risk_microunits,cost.energy_mwh,cost.combined_cost_units,
              condition.traversal_allowed,condition.penalty_units AS condition_penalty_units,
              condition.risk_override_microunits,condition.access_override_mask,condition.cost_multiplier_ppm,
              condition.speed_override_mm_per_s
       FROM gowm_network_v1.arc arc
       JOIN gowm_network_v1.edge edge ON edge.graph_version_id=arc.graph_version_id AND edge.edge_id=arc.edge_id
       JOIN gowm_network_v1.arc_cost cost ON cost.graph_version_id=arc.graph_version_id AND cost.arc_id=arc.arc_id
         AND cost.travel_profile_version_id=$2::uuid AND cost.cost_profile_version_id=$3::uuid
       LEFT JOIN gowm_network_v1.arc_condition condition ON condition.graph_version_id=arc.graph_version_id AND condition.arc_id=arc.arc_id
         AND condition.condition_snapshot_id=$4::uuid
       WHERE arc.graph_version_id=$1::uuid ORDER BY arc.arc_key`,
      [graph.graph_version_id, profile.travel_profile_version_id, profile.cost_profile_version_id, conditionId ?? null]
    );
    const requiredMask = bigint(profile.required_access_mask, "required_access_mask");
    const arcs: NetworkArc[] = arcResult.rows.flatMap((row) => {
      const effectiveMask = bigint(row.access_override_mask ?? row.access_mask, "access_mask");
      if (row.traversal_allowed === false || (effectiveMask & requiredMask) !== requiredMask) return [];
      const multiplier = safeInteger(row.cost_multiplier_ppm ?? 1_000_000, "cost_multiplier_ppm");
      const duration = row.speed_override_mm_per_s === null || row.speed_override_mm_per_s === undefined
        ? safeInteger(row.duration_ms, "duration_ms")
        : Math.ceil(safeInteger(row.distance_mm, "distance_mm") * 1000 / safeInteger(row.speed_override_mm_per_s, "speed_override_mm_per_s"));
      const sourceId = optionalString(row.source_feature_reference_key);
      return [{
        id: String(row.arc_id), key: externalArcKey(requiredString(row.arc_key, "arc_key")),
        source: String(row.source_node_id), target: String(row.target_node_id), direction: direction(row.direction),
        headingMicrodegrees: safeInteger(row.heading_microdegrees, "heading_microdegrees"),
        ...(sourceId === undefined ? {} : { sourceFeatureReferenceKey: referenceKey("LAYER_FEATURE", sourceId, requested.networkDatasetVersion) }),
        distanceMm: safeInteger(row.distance_mm, "distance_mm"), durationMs: duration,
        riskMicroUnits: safeInteger(row.risk_override_microunits ?? row.risk_microunits, "risk_microunits"),
        energyMwh: safeInteger(row.energy_mwh, "energy_mwh"),
        combinedCostUnits: multiplyPpm(safeInteger(row.combined_cost_units, "combined_cost_units"), multiplier),
        conditionPenaltyUnits: safeInteger(row.condition_penalty_units ?? 0, "condition_penalty_units")
      }];
    });
    const idToKey = new Map(arcs.map((arc) => [arc.id, arc.key]));
    const pairResult = await client.query("SELECT from_arc_id,to_arc_id,rule_type,penalty_units,profile_filter FROM gowm_network_v1.turn_rule WHERE graph_version_id=$1::uuid ORDER BY rule_key", [graph.graph_version_id]);
    const sequenceResult = await client.query("SELECT arc_sequence,rule_type,penalty_units,profile_filter FROM gowm_network_v1.turn_sequence_rule WHERE graph_version_id=$1::uuid ORDER BY rule_key", [graph.graph_version_id]);
    const applies = (row: Row): boolean => profileApplies(row.profile_filter, requiredString(profile.mode, "mode"), requested.travelProfileVersion);
    const turnRules: TurnRule[] = [
      ...pairResult.rows.filter(applies).flatMap((row) => ruleFromIds([row.from_arc_id, row.to_arc_id], row, idToKey)),
      ...sequenceResult.rows.filter(applies).flatMap((row) => ruleFromIds(array(row.arc_sequence), row, idToKey))
    ];
    const datasetReferenceId = requiredString(graph.dataset_reference_key, "dataset_reference_key");
    const capturedAt = this.now().toISOString();
    return {
      routingSnapshot: { ...requested }, graph, arcs, turnRules,
      dataSnapshot: {
        consistency: "PINNED", capturedAt,
        scopeDigest: sha256({ dataScopeKey, datasetScopeKey }),
        resources: [{
          referenceKey: referenceKey("DATASET", datasetReferenceId, requested.networkDatasetVersion),
          authority: "GOWM Network Foundation", pinning: "PINNED", digest: requested.graphContentHash
        }]
      }
    };
  }
}

function graphVersionOutput(graph: Row): Row {
  return compact({
    networkDatasetReferenceKey: referenceKey("DATASET", requiredString(graph.dataset_reference_key, "dataset_reference_key"), requiredString(graph.dataset_version, "dataset_version")),
    networkDatasetVersion: requiredString(graph.dataset_version, "dataset_version"), graphVersion: requiredString(graph.graph_version, "graph_version"),
    buildPolicyVersion: requiredString(graph.build_policy_version, "build_policy_version"), sourceContentHash: requiredString(graph.source_content_hash, "source_content_hash"),
    topologyHash: requiredString(graph.topology_hash, "topology_hash"), contentHash: requiredString(graph.content_hash, "content_hash"), status: requiredString(graph.status, "status"),
    counts: { nodes: safeInteger(graph.node_count, "node_count"), edges: safeInteger(graph.edge_count, "edge_count"), arcs: safeInteger(graph.arc_count, "arc_count"), turnRules: safeInteger(graph.turn_rule_count, "turn_rule_count") },
    createdAt: dateString(graph.created_at), buildReceiptId: optionalString(graph.build_receipt_id)
  });
}
function buildResult(network: LoadedNetwork, requestId: string, items: Row[]): Row { return { requestId, status: network.graph.status === "ACTIVE" ? "ACTIVE" : "VALIDATED", graphVersion: graphVersionOutput(network.graph), diagnostics: items }; }
function diagnostics(network: LoadedNetwork): Row[] { const isolated = isolatedNodeCount(network.arcs); return [{ code: "GRAPH_COUNTS", severity: "INFO", count: network.arcs.length }, ...(isolated ? [{ code: "ISOLATED_NODES", severity: "WARNING", count: isolated }] : [])]; }
function reachabilityDiagnostics(network: LoadedNetwork, location: unknown): Row[] { const state = isRow(location) && typeof location.arcKey === "string" ? directedState(location) : undefined; if (!state) return [{ code: "REACHABILITY_REQUIRES_DIRECTED_STATE", severity: "WARNING", count: 1 }]; const start = network.arcs.find((arc) => arc.key === state.arcKey); if (!start) return [{ code: "UNREACHABLE_START", severity: "WARNING", count: 1 }]; const visited = new Set<string>([start.target]); let changed = true; while (changed) { changed = false; for (const arc of network.arcs) if (visited.has(arc.source) && !visited.has(arc.target)) { visited.add(arc.target); changed = true; } } return [{ code: "REACHABLE_NODES", severity: "INFO", count: visited.size }]; }
function isolatedNodeCount(arcs: NetworkArc[]): number { const degree = new Map<string, number>(); for (const arc of arcs) { degree.set(arc.source, (degree.get(arc.source) ?? 0) + 1); degree.set(arc.target, (degree.get(arc.target) ?? 0) + 1); } return [...degree.values()].filter((value) => value === 0).length; }
function ruleFromIds(ids: unknown[], row: Row, map: Map<string, string>): TurnRule[] { const sequence = ids.map((id) => map.get(String(id))); if (sequence.some((key) => key === undefined)) return []; const ruleType = requiredString(row.rule_type, "rule_type"); if (ruleType !== "FORBIDDEN" && ruleType !== "ALLOWED_ONLY" && ruleType !== "PENALTY") return []; return [{ sequence: sequence as string[], ruleType, penaltyUnits: safeInteger(row.penalty_units, "penalty_units") }]; }
function profileApplies(value: unknown, mode: string, version: string): boolean { if (!isRow(value) || Object.keys(value).length === 0) return true; const modes = Array.isArray(value.modes) ? value.modes : Array.isArray(value.mode) ? value.mode : value.mode === undefined ? [] : [value.mode]; const versions = Array.isArray(value.travelProfileVersions) ? value.travelProfileVersions : []; return (modes.length === 0 || modes.includes(mode)) && (versions.length === 0 || versions.includes(version)); }
function stateFor(arc: NetworkArc, fractionPpm: number): DirectedState { return { arcKey: arc.key, fractionPpm, direction: arc.direction, headingMicrodegrees: arc.headingMicrodegrees, ...(arc.sourceFeatureReferenceKey === undefined ? {} : { sourceFeatureReferenceKey: arc.sourceFeatureReferenceKey }) }; }
function withSource(state: DirectedState, arc: NetworkArc): DirectedState { return { ...state, ...(arc.sourceFeatureReferenceKey === undefined ? {} : { sourceFeatureReferenceKey: arc.sourceFeatureReferenceKey }) }; }
function routingSnapshot(value: unknown): RoutingSnapshot { const row = asRow(value); return compact({ networkDatasetVersion: requiredString(row.networkDatasetVersion, "networkDatasetVersion"), graphVersion: requiredString(row.graphVersion, "graphVersion"), travelProfileVersion: requiredString(row.travelProfileVersion, "travelProfileVersion"), costProfileVersion: requiredString(row.costProfileVersion, "costProfileVersion"), graphContentHash: digest(row.graphContentHash, "graphContentHash"), costContentHash: digest(row.costContentHash, "costContentHash"), conditionSnapshotId: optionalString(row.conditionSnapshotId), sourceWorldVersion: row.sourceWorldVersion === undefined ? undefined : safeInteger(row.sourceWorldVersion, "sourceWorldVersion"), conditionContentHash: row.conditionContentHash === undefined ? undefined : digest(row.conditionContentHash, "conditionContentHash"), capturedAt: optionalString(row.capturedAt) }) as unknown as RoutingSnapshot; }
function directedState(value: unknown): DirectedState { const row = asRow(value); const directionValue = direction(row.direction); return compact({ arcKey: requiredString(row.arcKey, "arcKey"), fractionPpm: safeInteger(row.fractionPpm, "fractionPpm"), direction: directionValue, headingMicrodegrees: row.headingMicrodegrees === undefined ? undefined : safeInteger(row.headingMicrodegrees, "headingMicrodegrees"), sourceFeatureReferenceKey: isRow(row.sourceFeatureReferenceKey) ? row.sourceFeatureReferenceKey : undefined }) as unknown as DirectedState; }
function objective(value: unknown): Objective { if (value === "SHORTEST_DISTANCE" || value === "FASTEST" || value === "LOWEST_RISK" || value === "LOWEST_ENERGY" || value === "WEIGHTED") return value; throw new ProviderProtocolError("INVALID_REQUEST", "unsupported network objective"); }
function direction(value: unknown): "FORWARD" | "REVERSE" { if (value === "FORWARD" || value === "REVERSE") return value; throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "invalid arc direction"); }
function referenceKey(kind: "DATASET" | "LAYER_FEATURE", id: string, version: string): PlatformCommonDefinitionsReferenceKey { return { namespace: "gowm", kind, id, version }; }
function circularDifference(a: number, b: number): number { const raw = Math.abs(a - b) % 360_000_000; return Math.min(raw, 360_000_000 - raw); }
function externalArcKey(value: string): string { if (!/^ar_[0-9a-f]{64}$/u.test(value)) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "internal Arc key is invalid"); return `arc_${value.slice(3)}`; }
function multiplyPpm(value: number, ppm: number): number { return Number((BigInt(value) * BigInt(ppm) + 500_000n) / 1_000_000n); }
function bigint(value: unknown, name: string): bigint { try { const parsed = BigInt(String(value)); if (parsed < 0n) throw new Error(); return parsed; } catch { throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} must be a non-negative integer`); } }
function digest(value: unknown, name: string): `sha256:${string}` { const text = requiredString(value, name); if (!/^sha256:[0-9a-f]{64}$/u.test(text)) throw new ProviderProtocolError("INVALID_REQUEST", `${name} must be sha256`); return text as `sha256:${string}`; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} is required`); return value; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function safeInteger(value: unknown, name: string): number { const number = typeof value === "number" ? value : Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", `${name} must be a non-negative safe integer`); return number; }
function integer(value: unknown, name: string): number { const result = safeInteger(value, name); if (result > 1_000_000 && name === "fractionPpm") throw new ProviderProtocolError("INVALID_REQUEST", "fractionPpm exceeds one million"); return result; }
function finite(value: unknown, name: string): number { const number = typeof value === "number" ? value : Number(value); if (!Number.isFinite(number)) throw new ProviderProtocolError("INVALID_REQUEST", `${name} must be finite`); return number; }
function optionalPositive(value: unknown): number | undefined { if (value === undefined) return undefined; const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new ProviderProtocolError("INVALID_REQUEST", "budget must be positive"); return number; }
function positive(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`); return value; }
function nonnegative(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be non-negative`); return value; }
function bounded(value: number, maximum: number, name: string): number { const checked = positive(value, name); if (checked > maximum) throw new Error(`${name} must not exceed ${maximum}`); return checked; }
function dateString(value: unknown): string | undefined { if (value === undefined || value === null) return undefined; const date = value instanceof Date ? value : new Date(String(value)); return Number.isFinite(date.getTime()) ? date.toISOString() : undefined; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new ProviderProtocolError("INVALID_REQUEST", "expected array"); return value; }
function isRow(value: unknown): value is Row { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function asRow(value: unknown): Row { if (!isRow(value)) throw new ProviderProtocolError("INVALID_REQUEST", "request must be an object"); return value; }
function compact<T extends Row>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T; }
function mapDatabaseError(error: unknown): ProviderProtocolError { if (error instanceof ProviderProtocolError) return error; const code = isRow(error) ? optionalString(error.code) : undefined; if (code === "42501") return new ProviderProtocolError("SCOPE_DENIED", "network scope is unavailable"); if (code === "57014") return new ProviderProtocolError("DEADLINE_EXCEEDED", "network statement deadline exceeded", { cause: error }); if (code === "22023") return new ProviderProtocolError("INVALID_REQUEST", "invalid network request", { cause: error }); return new ProviderProtocolError("PROVIDER_NOT_READY", "gowm_network_v1 execution failed", { retryable: true, cause: error }); }
