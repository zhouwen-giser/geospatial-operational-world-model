import type { PoolClient } from "pg";
import { evaluateArcCost } from "./profile-cost-condition.js";
import type {
  BuiltNetworkTopology,
  NetworkArcCostMetrics,
  NetworkConditionSnapshot,
  NetworkCostProfile,
  NetworkTravelProfile
} from "./types.js";

type ProfileTransaction = Pick<PoolClient, "query">;

export interface PersistNetworkProfileRequest {
  readonly graphVersionId: string;
  readonly dataScopeKey: string;
  readonly topology: BuiltNetworkTopology;
  readonly arcIdsByKey: ReadonlyMap<string, string>;
  readonly travelProfile: NetworkTravelProfile;
  readonly costProfile: NetworkCostProfile;
  readonly baseMetricsByArcKey: ReadonlyMap<string, {
    readonly riskMicroUnits: number;
    readonly energyMwh: number;
    readonly surfacePenaltyUnits: number;
  }>;
}

export interface PersistedNetworkProfile {
  readonly travelProfileVersionId: string;
  readonly costProfileVersionId: string;
  readonly metricsByArcKey: ReadonlyMap<string, NetworkArcCostMetrics>;
}

export class PostgresNetworkProfileConditionWriter {
  constructor(private readonly database: ProfileTransaction) {}

  async persistProfile(request: PersistNetworkProfileRequest): Promise<PersistedNetworkProfile> {
    const profileResult = await this.database.query<{ travel_profile_id: string }>(
      `INSERT INTO network_travel_profile(data_scope_key,profile_key,description)
       VALUES ($1,$2,$3) RETURNING travel_profile_id::text`,
      [request.dataScopeKey, request.travelProfile.profileKey, `${request.travelProfile.vehicleClass} travel profile`]
    );
    const travelProfileId = profileResult.rows[0]?.travel_profile_id;
    if (!travelProfileId) throw new Error("travel profile identity was not returned");
    const constraints = {
      vehicleClass: request.travelProfile.vehicleClass,
      allowedRoadClasses: request.travelProfile.allowedRoadClasses,
      allowedSurfaces: request.travelProfile.allowedSurfaces,
      onewayPolicy: request.travelProfile.onewayPolicy
    };
    const versionResult = await this.database.query<{ travel_profile_version_id: string }>(
      `INSERT INTO network_travel_profile_version(
         travel_profile_id,data_scope_key,version,mode,required_access_mask,
         maximum_speed_mm_per_s,constraints,content_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING travel_profile_version_id::text`,
      [travelProfileId, request.dataScopeKey, request.travelProfile.version,
        request.travelProfile.vehicleClass === "ROAD_VEHICLE" ? "CAR" : "SERVICE",
        request.travelProfile.requiredAccessMask, request.travelProfile.maximumSpeedMmPerS ?? null,
        JSON.stringify(constraints), request.travelProfile.contentHash]
    );
    const travelProfileVersionId = versionResult.rows[0]?.travel_profile_version_id;
    if (!travelProfileVersionId) throw new Error("travel profile version identity was not returned");
    const costResult = await this.database.query<{ cost_profile_id: string }>(
      `INSERT INTO network_cost_profile(travel_profile_id,data_scope_key,profile_key,description)
       VALUES ($1,$2,$3,$4) RETURNING cost_profile_id::text`,
      [travelProfileId, request.dataScopeKey, request.costProfile.profileKey, "Fixed-point network cost profile"]
    );
    const costProfileId = costResult.rows[0]?.cost_profile_id;
    if (!costProfileId) throw new Error("cost profile identity was not returned");
    const weights = request.costProfile.weights;
    const costVersionResult = await this.database.query<{ cost_profile_version_id: string }>(
      `INSERT INTO network_cost_profile_version(
         cost_profile_id,travel_profile_id,travel_profile_version_id,data_scope_key,version,
         distance_weight_ppm,duration_weight_ppm,risk_weight_ppm,energy_weight_ppm,
         surface_weight_ppm,formula,content_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       RETURNING cost_profile_version_id::text`,
      [costProfileId, travelProfileId, travelProfileVersionId, request.dataScopeKey,
        request.costProfile.version, weights.distance, weights.time, weights.risk,
        weights.energy, weights.surface, JSON.stringify({ roundingPolicy: request.costProfile.roundingPolicy }),
        request.costProfile.contentHash]
    );
    const costProfileVersionId = costVersionResult.rows[0]?.cost_profile_version_id;
    if (!costProfileVersionId) throw new Error("cost profile version identity was not returned");

    const edges = new Map(request.topology.edges.map((edge) => [edge.edgeKey, edge]));
    const metricsByArcKey = new Map<string, NetworkArcCostMetrics>();
    for (const arc of request.topology.arcs) {
      const edge = edges.get(arc.edgeKey);
      const arcId = request.arcIdsByKey.get(arc.arcKey);
      const base = request.baseMetricsByArcKey.get(arc.arcKey);
      if (!edge || !arcId || !base) throw new Error("profile cost input is missing Arc topology or base metrics");
      const metrics = evaluateArcCost({
        edge,
        arc,
        travelProfile: request.travelProfile,
        costProfile: request.costProfile,
        baseRiskMicroUnits: base.riskMicroUnits,
        baseEnergyMwh: base.energyMwh,
        surfacePenaltyUnits: base.surfacePenaltyUnits
      });
      if (!metrics) continue;
      await this.database.query(
        `INSERT INTO network_arc_cost(
           graph_version_id,arc_id,travel_profile_version_id,cost_profile_version_id,data_scope_key,
           distance_mm,duration_ms,risk_microunits,energy_millijoules,energy_mwh,
           combined_cost_units,content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [request.graphVersionId, arcId, travelProfileVersionId, costProfileVersionId,
          request.dataScopeKey, metrics.distanceMm, metrics.durationMs, metrics.riskMicroUnits,
          metrics.energyMwh * 3600, metrics.energyMwh, metrics.combinedCostUnits, metrics.contentHash]
      );
      metricsByArcKey.set(arc.arcKey, metrics);
    }
    return { travelProfileVersionId, costProfileVersionId, metricsByArcKey };
  }

  async persistConditionSnapshot(request: {
    readonly graphVersionId: string;
    readonly dataScopeKey: string;
    readonly arcIdsByKey: ReadonlyMap<string, string>;
    readonly snapshot: NetworkConditionSnapshot;
  }): Promise<string> {
    const result = await this.database.query<{ condition_snapshot_id: string }>(
      `INSERT INTO network_condition_snapshot(
         graph_version_id,data_scope_key,condition_snapshot_key,source_snapshot_version,
         observed_at,valid_until,completeness,source_content_hash,content_hash,metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING condition_snapshot_id::text`,
      [request.graphVersionId, request.dataScopeKey, request.snapshot.conditionSnapshotKey,
        request.snapshot.sourceSnapshotVersion, request.snapshot.observedAt, request.snapshot.validUntil,
        request.snapshot.completeness, request.snapshot.sourceContentHash, request.snapshot.contentHash,
        JSON.stringify(request.snapshot.metadata)]
    );
    const snapshotId = result.rows[0]?.condition_snapshot_id;
    if (!snapshotId) throw new Error("condition snapshot identity was not returned");
    for (const condition of request.snapshot.conditions) {
      const arcId = request.arcIdsByKey.get(condition.arcKey);
      if (!arcId) throw new Error("condition references an unavailable Arc");
      await this.database.query(
        `INSERT INTO network_arc_condition(
           condition_snapshot_id,graph_version_id,arc_id,data_scope_key,traversal_allowed,
           speed_override_mm_per_s,penalty_units,reason_codes,evidence,content_hash,
           risk_override_microunits,access_override_mask,cost_multiplier_ppm
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::jsonb,$10,$11,$12,$13)`,
        [snapshotId, request.graphVersionId, arcId, request.dataScopeKey, condition.traversalAllowed,
          condition.speedOverrideMmPerS ?? null, condition.penaltyUnits ?? 0, condition.reasonCodes,
          JSON.stringify(condition.evidence), condition.contentHash, condition.riskOverrideMicroUnits ?? null,
          condition.accessOverrideMask ?? null, condition.costMultiplierPpm ?? null]
      );
    }
    return snapshotId;
  }
}
