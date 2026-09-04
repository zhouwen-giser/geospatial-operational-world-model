import { dirname, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  PostgresNetworkFeatureBindingWriter,
  PostgresNetworkTopologyWriter,
  PostgresNetworkTurnWriter,
  createCostProfile,
  createTravelProfile,
  evaluateArcCost,
  sha256,
  stableKey,
  type NetworkCostProfile,
  type NetworkTravelProfile
} from "../../packages/network-foundation/src/index.js";
import {
  loadOpenDriveAdmissionPlan,
  materializeAdmissionPlan,
  type OpenDriveAdmissionMaterialization,
  type PlannedCatalogFeature
} from "./admission-artifacts.js";
import {
  assertMutationAuthorized,
  databaseFingerprint,
  inspectDatabaseIdentity,
  readAdmissionAuthorization
} from "./admission-safety.js";
import {
  aggregateStatus,
  redactedError,
  writeAcceptanceReport,
  type AcceptanceCheck,
  type AcceptanceReport
} from "./report.js";

export interface AdmissionConfiguration {
  readonly artifactDirectory: string;
  readonly reportDirectory: string;
  readonly dataScopeKey: string;
  readonly datasetScopeKey: string;
  readonly graphKey: string;
  readonly databaseUrl?: string;
  readonly showDatabaseFingerprint: boolean;
}

export interface AdmissionResult {
  readonly status: "PASS" | "FAIL" | "NOT_RUN" | "BLOCKED";
  readonly datasetReferenceKey: string;
  readonly datasetVersion: string;
  readonly datasetContentHash: string;
  readonly graphVersion: string;
  readonly graphContentHash: string;
  readonly graphVersionId?: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly databaseFingerprint?: string;
}

const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const GRAPH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function requiredSetting(value: string | undefined, name: string, pattern: RegExp): string {
  if (!value || !pattern.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

export function admissionConfiguration(
  environment: NodeJS.ProcessEnv,
  arguments_: readonly string[] = []
): AdmissionConfiguration {
  const positional = arguments_.find((argument) => !argument.startsWith("--"));
  const artifactDirectory = resolve(positional ?? environment.GOWM_OPENDRIVE_OUTPUT_ROOT ?? "artifacts/opendrive-task-network-v0.1/artifacts");
  return {
    artifactDirectory,
    reportDirectory: dirname(artifactDirectory),
    dataScopeKey: requiredSetting(environment.GOWM_OPENDRIVE_DATA_SCOPE_KEY ?? "opendrive-acceptance", "GOWM_OPENDRIVE_DATA_SCOPE_KEY", SCOPE_PATTERN),
    datasetScopeKey: requiredSetting(environment.GOWM_OPENDRIVE_DATASET_SCOPE_KEY ?? "airport2-task-network", "GOWM_OPENDRIVE_DATASET_SCOPE_KEY", SCOPE_PATTERN),
    graphKey: requiredSetting(environment.GOWM_OPENDRIVE_GRAPH_KEY ?? "airport2-task-network-v1", "GOWM_OPENDRIVE_GRAPH_KEY", GRAPH_PATTERN),
    ...(environment.GOWM_OPENDRIVE_DATABASE_URL === undefined || environment.GOWM_OPENDRIVE_DATABASE_URL.length === 0
      ? {} : { databaseUrl: environment.GOWM_OPENDRIVE_DATABASE_URL }),
    showDatabaseFingerprint: arguments_.includes("--show-db-fingerprint")
  };
}

export function catalogGeoJson(feature: Pick<PlannedCatalogFeature, "coordinates">): string {
  // spatial_feature_version is intentionally a 2D Catalog boundary. The
  // immutable compiler artifacts and network topology retain the source Z;
  // only the Catalog projection drops altitude to match its PostGIS typmod.
  return JSON.stringify({
    type: "LineString",
    coordinates: feature.coordinates.map(([longitude, latitude]) => [longitude, latitude])
  });
}

async function insertCatalog(
  client: PoolClient,
  materialized: OpenDriveAdmissionMaterialization,
  configuration: AdmissionConfiguration,
  createScope: boolean
): Promise<{ datasetId: string; datasetVersionId: string }> {
  if (createScope) {
    await client.query(
      `INSERT INTO data_scope(scope_key,operational_domain,description)
       VALUES($1,'TEST','Disposable OpenDRIVE task-network acceptance scope')`,
      [configuration.dataScopeKey]
    );
  }
  const dataset = await client.query<{ dataset_id: string }>(
    `INSERT INTO spatial_dataset(reference_key,data_scope_key,dataset_scope_key,dataset_key,name)
     VALUES($1,$2,$3,$4,$5) RETURNING dataset_id::text`,
    [materialized.datasetReferenceKey, configuration.dataScopeKey, configuration.datasetScopeKey,
      `opendrive:${configuration.graphKey}`, "Airport2 OpenDRIVE task network"]
  );
  const datasetId = dataset.rows[0]?.dataset_id;
  if (!datasetId) throw new Error("Catalog Dataset identity was not returned");
  const lineage = [{
    authority: "OpenDriveNetworkCompiler",
    sourceArtifactHash: materialized.plan.sourceArtifactHash,
    oracleArtifactHash: materialized.plan.oracleArtifactHash,
    transformContentHash: materialized.plan.transformContentHash,
    compilerVersion: materialized.plan.compilerVersion,
    buildPolicyVersion: materialized.plan.buildPolicyVersion,
    accuracyClaim: "UNVERIFIED_COMPATIBILITY_TRANSFORM"
  }];
  const quality = {
    status: "UNVERIFIED_COMPATIBILITY_TRANSFORM",
    activeWeakComponents: 1,
    quarantinedRoadIds: materialized.plan.quarantineRoadIds,
    missingSourceSemantics: ["surface", "access", "bridge", "tunnel", "signals"]
  };
  const version = await client.query<{ dataset_version_id: string }>(
    `INSERT INTO spatial_dataset_version(
       dataset_id,version,dataset_kind,source_ref,source_version,schema_version,crs,
       quality,lineage,content_hash,published_at
     ) VALUES($1,$2,'NETWORK',$3,$4,'opendrive-task-network/1.0','EPSG:4326',$5::jsonb,$6::jsonb,$7,$8)
     RETURNING dataset_version_id::text`,
    [datasetId, materialized.datasetVersion, `urn:sha256:${materialized.plan.sourceArtifactHash.slice(7)}`,
      materialized.plan.compilerVersion, JSON.stringify(quality), JSON.stringify(lineage),
      materialized.datasetContentHash, "1970-01-01T00:00:00.000Z"]
  );
  const datasetVersionId = version.rows[0]?.dataset_version_id;
  if (!datasetVersionId) throw new Error("Catalog DatasetVersion identity was not returned");

  for (const layerKey of ["physical_roads", "routing_channels"] as const) {
    const features = materialized.catalogFeatures.filter((feature) => feature.layerKey === layerKey);
    const layerReferenceKey = `wrf_${sha256({ dataset: materialized.datasetReferenceKey, layerKey }).slice(7, 39)}`;
    const layerHash = sha256(features.map(({ featureReferenceKey, contentHash }) => ({ featureReferenceKey, contentHash })));
    const layer = await client.query<{ layer_id: string }>(
      `INSERT INTO spatial_layer(reference_key,dataset_id,data_scope_key,dataset_scope_key,layer_key,name)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING layer_id::text`,
      [layerReferenceKey, datasetId, configuration.dataScopeKey, configuration.datasetScopeKey, layerKey,
        layerKey === "physical_roads" ? "OpenDRIVE physical roads" : "OpenDRIVE routing channels"]
    );
    const layerId = layer.rows[0]?.layer_id;
    if (!layerId) throw new Error("Catalog Layer identity was not returned");
    const layerVersion = await client.query<{ layer_version_id: string }>(
      `INSERT INTO spatial_layer_version(
         layer_id,dataset_id,dataset_version_id,version,layer_type,geometry_type,schema_version,crs,
         source_ref,source_version,quality,lineage,content_hash,published_at
       ) VALUES($1,$2,$3,$4,'VECTOR_FEATURE','LineString','opendrive-task-network/1.0','EPSG:4326',
                $5,$6,$7::jsonb,$8::jsonb,$9,$10) RETURNING layer_version_id::text`,
      [layerId, datasetId, datasetVersionId, materialized.datasetVersion,
        `urn:sha256:${materialized.plan.sourceArtifactHash.slice(7)}`, materialized.plan.compilerVersion,
        JSON.stringify({ featureCount: features.length, accuracyClaim: "UNVERIFIED_COMPATIBILITY_TRANSFORM" }),
        JSON.stringify(lineage), layerHash, "1970-01-01T00:00:00.000Z"]
    );
    const layerVersionId = layerVersion.rows[0]?.layer_version_id;
    if (!layerVersionId) throw new Error("Catalog LayerVersion identity was not returned");
    for (const feature of features) {
      const identity = await client.query<{ feature_id: string }>(
        `INSERT INTO spatial_feature_identity(
           reference_key,layer_id,data_scope_key,dataset_scope_key,feature_key,feature_type,display_name
         ) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING feature_id::text`,
        [feature.featureReferenceKey, layerId, configuration.dataScopeKey, configuration.datasetScopeKey,
          feature.featureKey, feature.featureType, feature.featureKey]
      );
      const featureId = identity.rows[0]?.feature_id;
      if (!featureId) throw new Error("Catalog Feature identity was not returned");
      await client.query(
        `INSERT INTO spatial_feature_version(
           feature_id,layer_id,layer_version_id,version,geometry,properties,source_feature_id,content_hash,published_at
         ) VALUES($1,$2,$3,$4,ST_SetSRID(ST_GeomFromGeoJSON($5),4326),$6::jsonb,$7,$8,$9)`,
        [featureId, layerId, layerVersionId, feature.featureVersion, catalogGeoJson(feature), JSON.stringify({
          ...feature.properties,
          sourceGeometryDimension: 3,
          catalogGeometryDimension: 2
        }),
          feature.featureKey, feature.contentHash, "1970-01-01T00:00:00.000Z"]
      );
    }
  }
  return { datasetId, datasetVersionId };
}

async function insertProfilesAndCosts(
  client: PoolClient,
  graphVersionId: string,
  dataScopeKey: string,
  materialized: OpenDriveAdmissionMaterialization,
  arcIdsByKey: ReadonlyMap<string, string>
): Promise<{ travelProfileVersionId: string; costProfileVersionIds: readonly string[]; conditionSnapshotId: string }> {
  const travelProfile: NetworkTravelProfile = createTravelProfile({
    profileKey: "TASK_SERVICE_V1",
    version: "1",
    vehicleClass: "UGV",
    allowedRoadClasses: ["XODR_TOWN"],
    allowedSurfaces: [],
    onewayPolicy: "STRICT",
    maximumSpeedMmPerS: 5000,
    requiredAccessMask: 0
  });
  const travel = await client.query<{ travel_profile_id: string }>(
    `INSERT INTO network_travel_profile(data_scope_key,profile_key,description)
     VALUES($1,$2,$3) RETURNING travel_profile_id::text`,
    [dataScopeKey, travelProfile.profileKey, "OpenDRIVE task service profile; maximum speed is a traversal cap"]
  );
  const travelProfileId = travel.rows[0]?.travel_profile_id;
  if (!travelProfileId) throw new Error("TravelProfile identity was not returned");
  const travelVersion = await client.query<{ travel_profile_version_id: string }>(
    `INSERT INTO network_travel_profile_version(
       travel_profile_id,data_scope_key,version,mode,required_access_mask,maximum_speed_mm_per_s,constraints,content_hash
     ) VALUES($1,$2,$3,'SERVICE',$4,$5,$6::jsonb,$7) RETURNING travel_profile_version_id::text`,
    [travelProfileId, dataScopeKey, travelProfile.version, travelProfile.requiredAccessMask,
      travelProfile.maximumSpeedMmPerS, JSON.stringify({
        vehicleClass: travelProfile.vehicleClass,
        allowedRoadClasses: travelProfile.allowedRoadClasses,
        allowedSurfaces: travelProfile.allowedSurfaces,
        onewayPolicy: travelProfile.onewayPolicy,
        maximumSpeedSemantics: "UPPER_BOUND"
      }), travelProfile.contentHash]
  );
  const travelProfileVersionId = travelVersion.rows[0]?.travel_profile_version_id;
  if (!travelProfileVersionId) throw new Error("TravelProfileVersion identity was not returned");

  const profiles: readonly NetworkCostProfile[] = [
    createCostProfile({ profileKey: "SHORTEST_DISTANCE_V1", version: "1", weights: { distance: 1_000_000, time: 0, risk: 0, energy: 0, surface: 0 } }),
    createCostProfile({ profileKey: "FASTEST_V1", version: "1", weights: { distance: 0, time: 1_000_000, risk: 0, energy: 0, surface: 0 } })
  ];
  const edges = new Map(materialized.topology.edges.map((edge) => [edge.edgeKey, edge]));
  const costProfileVersionIds: string[] = [];
  for (const profile of profiles) {
    const cost = await client.query<{ cost_profile_id: string }>(
      `INSERT INTO network_cost_profile(travel_profile_id,data_scope_key,profile_key,description)
       VALUES($1,$2,$3,$4) RETURNING cost_profile_id::text`,
      [travelProfileId, dataScopeKey, profile.profileKey, "OpenDRIVE fixed-point cost; risk/energy/surface are unknown and unweighted"]
    );
    const costProfileId = cost.rows[0]?.cost_profile_id;
    if (!costProfileId) throw new Error("CostProfile identity was not returned");
    const weights = profile.weights;
    const version = await client.query<{ cost_profile_version_id: string }>(
      `INSERT INTO network_cost_profile_version(
         cost_profile_id,travel_profile_id,travel_profile_version_id,data_scope_key,version,
         distance_weight_ppm,duration_weight_ppm,risk_weight_ppm,energy_weight_ppm,surface_weight_ppm,
         formula,content_hash
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       RETURNING cost_profile_version_id::text`,
      [costProfileId, travelProfileId, travelProfileVersionId, dataScopeKey, profile.version,
        weights.distance, weights.time, weights.risk, weights.energy, weights.surface,
        JSON.stringify({ roundingPolicy: profile.roundingPolicy, unknownDimensions: ["risk", "energy", "surface"] }),
        profile.contentHash]
    );
    const costProfileVersionId = version.rows[0]?.cost_profile_version_id;
    if (!costProfileVersionId) throw new Error("CostProfileVersion identity was not returned");
    costProfileVersionIds.push(costProfileVersionId);
    for (const arc of materialized.topology.arcs) {
      const edge = edges.get(arc.edgeKey);
      const arcId = arcIdsByKey.get(arc.arcKey);
      if (!edge || !arcId) throw new Error("ArcCost input topology is incomplete");
      const metrics = evaluateArcCost({
        edge,
        arc,
        travelProfile,
        costProfile: profile,
        baseRiskMicroUnits: 0,
        baseEnergyMwh: 0,
        surfacePenaltyUnits: 0
      });
      if (!metrics) throw new Error("TASK_SERVICE_V1 unexpectedly rejected an active OpenDRIVE Arc");
      await client.query(
        `INSERT INTO network_arc_cost(
           graph_version_id,arc_id,travel_profile_version_id,cost_profile_version_id,data_scope_key,
           distance_mm,duration_ms,risk_microunits,energy_millijoules,energy_mwh,combined_cost_units,content_hash
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [graphVersionId, arcId, travelProfileVersionId, costProfileVersionId, dataScopeKey,
          metrics.distanceMm, metrics.durationMs, metrics.riskMicroUnits, 0, metrics.energyMwh,
          metrics.combinedCostUnits, metrics.contentHash]
      );
    }
  }
  const snapshotCore = {
    graphContentHash: materialized.graphContentHash,
    sourceSnapshotVersion: "NO_DYNAMIC_ROAD_STATE_V1",
    completeness: "PARTIAL",
    sourceContentHash: sha256({ source: "NOT_PROVIDED", graph: materialized.graphContentHash }),
    metadata: { dynamicRoadState: "NOT_PROVIDED", interpretation: "absence of overrides is not evidence that all roads are open" }
  } as const;
  const conditionSnapshotKey = stableKey("cs", snapshotCore);
  const snapshotHash = sha256({ conditionSnapshotKey, ...snapshotCore });
  const snapshot = await client.query<{ condition_snapshot_id: string }>(
    `INSERT INTO network_condition_snapshot(
       graph_version_id,data_scope_key,condition_snapshot_key,source_snapshot_version,observed_at,valid_until,
       completeness,source_content_hash,content_hash,metadata
     ) VALUES($1,$2,$3,$4,$5,$6,'PARTIAL',$7,$8,$9::jsonb) RETURNING condition_snapshot_id::text`,
    [graphVersionId, dataScopeKey, conditionSnapshotKey, snapshotCore.sourceSnapshotVersion,
      "1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.000Z", snapshotCore.sourceContentHash,
      snapshotHash, JSON.stringify(snapshotCore.metadata)]
  );
  const conditionSnapshotId = snapshot.rows[0]?.condition_snapshot_id;
  if (!conditionSnapshotId) throw new Error("ConditionSnapshot identity was not returned");
  return { travelProfileVersionId, costProfileVersionIds, conditionSnapshotId };
}

async function verifyDatabaseState(
  client: PoolClient,
  graphVersionId: string,
  dataScopeKey: string,
  materialized: OpenDriveAdmissionMaterialization
): Promise<Record<string, number>> {
  const result = await client.query<{
    routing_features: string;
    edge_count: string;
    arc_count: string;
    binding_count: string;
    turn_count: string;
    road6_count: string;
    blocking_count: string;
    arc_cost_count: string;
    partial_snapshot_count: string;
    activation_count: string;
  }>(`SELECT
      (SELECT count(*) FROM spatial_feature_identity feature
       JOIN spatial_layer layer USING(layer_id)
       WHERE feature.data_scope_key=$2 AND layer.layer_key='routing_channels')::text AS routing_features,
      (SELECT count(*) FROM network_edge WHERE graph_version_id=$1)::text AS edge_count,
      (SELECT count(*) FROM network_arc WHERE graph_version_id=$1)::text AS arc_count,
      (SELECT count(*) FROM network_feature_binding WHERE graph_version_id=$1)::text AS binding_count,
      (SELECT count(*) FROM network_turn_rule WHERE graph_version_id=$1 AND rule_type='ALLOWED_ONLY')::text AS turn_count,
      (SELECT count(*) FROM network_edge WHERE graph_version_id=$1 AND access_attributes->>'sourceRoadId'='6')::text AS road6_count,
      (SELECT count(*) FROM network_validation_issue WHERE graph_version_id=$1 AND activation_blocking)::text AS blocking_count,
      (SELECT count(*) FROM network_arc_cost WHERE graph_version_id=$1)::text AS arc_cost_count,
      (SELECT count(*) FROM network_condition_snapshot WHERE graph_version_id=$1 AND completeness='PARTIAL')::text AS partial_snapshot_count,
      (SELECT count(*) FROM network_graph_activation_event WHERE graph_version_id=$1 AND event_type='ACTIVATE')::text AS activation_count`,
    [graphVersionId, dataScopeKey]
  );
  const row = result.rows[0];
  if (!row) throw new Error("database acceptance counts are unavailable");
  const counts = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  const expected = {
    routing_features: 244,
    edge_count: 244,
    arc_count: 244,
    binding_count: 244,
    turn_count: 336,
    road6_count: 0,
    blocking_count: 0,
    arc_cost_count: 488,
    partial_snapshot_count: 1,
    activation_count: 1
  };
  for (const [key, value] of Object.entries(expected)) {
    if (counts[key] !== value) throw new Error(`database acceptance ${key} expected ${value}, got ${String(counts[key])}`);
  }
  if (materialized.topology.edges.length !== counts.edge_count) throw new Error("declared GraphVersion topology differs from database content");
  return counts;
}

export interface AdmissionCollisionState {
  readonly scopeCount: number;
  readonly targetScopeCount: number;
  readonly targetScopeExact: boolean;
  readonly graphCollision: boolean;
  readonly datasetCollision: boolean;
  readonly datasetVersionCollision: boolean;
  readonly graphVersionCollision: boolean;
}

export function assertAdmissionPreconditions(
  state: AdmissionCollisionState,
  reuseExistingDevelopmentScope: boolean
): void {
  if (state.graphCollision || state.datasetCollision || state.datasetVersionCollision || state.graphVersionCollision) {
    throw new Error("target graph, Dataset identity/version, or graph content already exists; admission is not repeatable");
  }
  if (reuseExistingDevelopmentScope) {
    if (state.scopeCount !== 1 || state.targetScopeCount !== 1 || !state.targetScopeExact) {
      throw new Error("development admission requires the unique exact GOWM v1.1 baseline data scope");
    }
  } else if (state.targetScopeCount !== 0) {
    throw new Error("disposable admission target scope already exists; use a new one-time database scope");
  }
}

async function mutateDatabase(
  client: PoolClient,
  materialized: OpenDriveAdmissionMaterialization,
  configuration: AdmissionConfiguration,
  reuseExistingDevelopmentScope: boolean
): Promise<{ graphVersionId: string; counts: Record<string, number> }> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const migration = await client.query<{ migration_count: string }>(
      `SELECT count(*)::text AS migration_count FROM schema_migration WHERE version ~ '^069_'`
    );
    if (Number(migration.rows[0]?.migration_count ?? 0) !== 1) throw new Error("database is not at the required migration 069 baseline");
    const collision = await client.query<{
      scope_count: string; target_scope_count: string; target_scope_exact: boolean;
      graph_collision: boolean; dataset_collision: boolean; dataset_version_collision: boolean;
      graph_version_collision: boolean;
    }>(`SELECT
          (SELECT count(*)::text FROM data_scope) AS scope_count,
          (SELECT count(*)::text FROM data_scope WHERE scope_key=$1) AS target_scope_count,
          EXISTS(SELECT 1 FROM data_scope WHERE scope_key=$1 AND operational_domain='TEST'
            AND description='GOWM v1.1 compatibility scope') AS target_scope_exact,
          EXISTS(SELECT 1 FROM network_graph WHERE graph_key=$2) AS graph_collision,
          EXISTS(SELECT 1 FROM spatial_dataset WHERE reference_key=$3 OR
            (data_scope_key=$1 AND dataset_scope_key=$4 AND dataset_key=$5)) AS dataset_collision,
          EXISTS(SELECT 1 FROM spatial_dataset_version WHERE version=$6 OR content_hash=$7) AS dataset_version_collision,
          EXISTS(SELECT 1 FROM network_graph_version WHERE graph_version=$8 OR content_hash=$9 OR topology_hash=$10) AS graph_version_collision`,
      [configuration.dataScopeKey, configuration.graphKey, materialized.datasetReferenceKey,
        configuration.datasetScopeKey, `opendrive:${configuration.graphKey}`, materialized.datasetVersion,
        materialized.datasetContentHash, materialized.graphVersion, materialized.graphContentHash,
        materialized.topology.topologyHash]
    );
    const state = collision.rows[0];
    if (!state) throw new Error("admission collision state is unavailable");
    assertAdmissionPreconditions({
      scopeCount: Number(state.scope_count),
      targetScopeCount: Number(state.target_scope_count),
      targetScopeExact: state.target_scope_exact,
      graphCollision: state.graph_collision,
      datasetCollision: state.dataset_collision,
      datasetVersionCollision: state.dataset_version_collision,
      graphVersionCollision: state.graph_version_collision
    }, reuseExistingDevelopmentScope);
    const { datasetId, datasetVersionId } = await insertCatalog(client, materialized, configuration, !reuseExistingDevelopmentScope);
    const graph = await client.query<{ graph_id: string }>(
      `INSERT INTO network_graph(data_scope_key,dataset_scope_key,dataset_id,graph_key,description)
       VALUES($1,$2,$3,$4,$5) RETURNING graph_id::text`,
      [configuration.dataScopeKey, configuration.datasetScopeKey, datasetId, configuration.graphKey,
        "OpenDRIVE task network compiled from explicit lane/junction links"]
    );
    const graphId = graph.rows[0]?.graph_id;
    if (!graphId) throw new Error("NetworkGraph identity was not returned");
    const buildReceipt = {
      schemaVersion: "1.0",
      adapterKind: "CATALOG_VECTOR_LAYER",
      sourceArtifactHash: materialized.plan.sourceArtifactHash,
      oracleArtifactHash: materialized.plan.oracleArtifactHash,
      transformContentHash: materialized.plan.transformContentHash,
      transform: materialized.plan.transform,
      accuracyClaim: "UNVERIFIED_COMPATIBILITY_TRANSFORM",
      compilerVersion: materialized.plan.compilerVersion,
      compilerContentHash: materialized.plan.contentHash,
      compilerTopologyHash: materialized.plan.topologyHash ?? null,
      buildPolicyVersion: materialized.plan.buildPolicyVersion,
      connectAtGradeIntersections: false,
      quarantinedRoadIds: materialized.plan.quarantineRoadIds,
      counts: materialized.plan.counts
    };
    const graphVersion = await client.query<{ graph_version_id: string }>(
      `INSERT INTO network_graph_version(
         graph_id,dataset_id,dataset_version_id,data_scope_key,dataset_scope_key,graph_version,
         build_policy_version,source_content_hash,topology_hash,content_hash,node_count,edge_count,
         arc_count,turn_rule_count,status,build_receipt_id,build_receipt
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'VALIDATED',$15,$16::jsonb)
       RETURNING graph_version_id::text`,
      [graphId, datasetId, datasetVersionId, configuration.dataScopeKey, configuration.datasetScopeKey,
        materialized.graphVersion, materialized.plan.buildPolicyVersion, materialized.plan.contentHash,
        materialized.topology.topologyHash, materialized.graphContentHash, materialized.topology.nodes.length,
        materialized.topology.edges.length, materialized.topology.arcs.length, materialized.turns.pairwiseRules.length,
        `opendrive:${materialized.graphVersion}`, JSON.stringify(buildReceipt)]
    );
    const graphVersionId = graphVersion.rows[0]?.graph_version_id;
    if (!graphVersionId) throw new Error("GraphVersion identity was not returned");
    const persisted = await new PostgresNetworkTopologyWriter(client).persist({
      graphVersionId,
      dataScopeKey: configuration.dataScopeKey,
      topology: materialized.topology
    });
    await new PostgresNetworkFeatureBindingWriter(client).persist({
      graphVersionId,
      dataScopeKey: configuration.dataScopeKey,
      topology: materialized.topology,
      edgeIdsByKey: persisted.edgeIdsByKey
    });
    await new PostgresNetworkTurnWriter(client).persist({
      graphVersionId,
      dataScopeKey: configuration.dataScopeKey,
      compiled: materialized.turns,
      nodeIdsByKey: persisted.nodeIdsByKey,
      arcIdsByKey: persisted.arcIdsByKey
    });
    const profile = await insertProfilesAndCosts(
      client,
      graphVersionId,
      configuration.dataScopeKey,
      materialized,
      persisted.arcIdsByKey
    );
    const buildRun = await client.query<{ build_run_id: string }>(
      `INSERT INTO network_build_run(
         graph_id,dataset_version_id,data_scope_key,dataset_scope_key,build_policy_version,adapter_kind,
         status,input_hash,output_hash,requested_at,started_at,finished_at,receipt
       ) VALUES($1,$2,$3,$4,$5,'CATALOG_VECTOR_LAYER','SUCCEEDED',$6,$7,
                clock_timestamp(),clock_timestamp(),clock_timestamp(),$8::jsonb)
       RETURNING build_run_id::text`,
      [graphId, datasetVersionId, configuration.dataScopeKey, configuration.datasetScopeKey,
        materialized.plan.buildPolicyVersion, materialized.plan.contentHash, materialized.graphContentHash,
        JSON.stringify({ ...buildReceipt, travelProfileVersionId: profile.travelProfileVersionId,
          costProfileVersionIds: profile.costProfileVersionIds, conditionSnapshotId: profile.conditionSnapshotId })]
    );
    const buildRunId = buildRun.rows[0]?.build_run_id;
    if (!buildRunId) throw new Error("BuildRun identity was not returned");
    for (const issue of [
      ["UNVERIFIED_COMPATIBILITY_TRANSFORM", "Georeference is compatible with the supplied oracle but not surveying-certified"],
      ["MISSING_SOURCE_ROAD_SEMANTICS", "Surface, access, bridge, tunnel, and signal field semantics were not provided"],
      ["PARTIAL_CONDITION_SNAPSHOT", "No dynamic road-state source was provided"]
    ] as const) {
      await client.query(
        `INSERT INTO network_validation_issue(
           build_run_id,graph_version_id,data_scope_key,severity,issue_code,activation_blocking,entity_kind,details
         ) VALUES($1,$2,$3,'WARNING',$4,false,'GRAPH',$5::jsonb)`,
        [buildRunId, graphVersionId, configuration.dataScopeKey, issue[0], JSON.stringify({ summary: issue[1] })]
      );
    }
    await client.query(
      `SELECT * FROM activate_network_graph_version($1,$2,$3)`,
      [graphVersionId, "opendrive-activation-policy-v1", "opendrive-management-plane"]
    );
    const counts = await verifyDatabaseState(client, graphVersionId, configuration.dataScopeKey, materialized);
    await client.query("COMMIT");
    return { graphVersionId, counts };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function summary(materialized: OpenDriveAdmissionMaterialization): Record<string, unknown> {
  return {
    datasetReferenceKey: materialized.datasetReferenceKey,
    datasetVersion: materialized.datasetVersion,
    datasetContentHash: materialized.datasetContentHash,
    graphVersion: materialized.graphVersion,
    graphContentHash: materialized.graphContentHash,
    compilerContentHash: materialized.plan.contentHash,
    compilerTopologyHash: materialized.plan.topologyHash ?? null,
    counts: {
      physicalRoads: materialized.plan.physicalRoads.length,
      routingChannels: materialized.topology.arcs.length,
      edges: materialized.topology.edges.length,
      allowedOnlyTurnRules: materialized.turns.pairwiseRules.length,
      junctionConnectorChannels: materialized.plan.counts.junctionConnectorChannels,
      excludedNonDrivingConnectors: materialized.plan.counts.excludedNonDrivingConnectors,
      quarantinedChannels: materialized.plan.counts.quarantinedChannels
    },
    accuracyClaim: "UNVERIFIED_COMPATIBILITY_TRANSFORM",
    adapterKind: "CATALOG_VECTOR_LAYER"
  };
}

export async function runAdmission(
  environment: NodeJS.ProcessEnv = process.env,
  arguments_: readonly string[] = process.argv.slice(2)
): Promise<AdmissionResult> {
  const configuration = admissionConfiguration(environment, arguments_);
  const authorization = readAdmissionAuthorization(environment);
  const checks: AcceptanceCheck[] = [];
  let materialized: OpenDriveAdmissionMaterialization | undefined;
  let pool: Pool | undefined;
  let result: AdmissionResult | undefined;
  try {
    materialized = materializeAdmissionPlan(await loadOpenDriveAdmissionPlan(configuration.artifactDirectory));
    checks.push({ id: "ARTIFACT_CONTRACT", status: "PASS", summary: "Locked artifacts and fixed cardinalities validated" });
    checks.push({ id: "CATALOG_GRAPH_PLAN", status: "PASS", summary: "Deterministic DatasetVersion, GraphVersion, topology, bindings, turns, profiles, costs, and condition plan materialized" });
    if (configuration.showDatabaseFingerprint) {
      if (!configuration.databaseUrl) throw new Error("GOWM_OPENDRIVE_DATABASE_URL is required to inspect a database fingerprint");
      pool = new Pool({ connectionString: configuration.databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
      const client = await pool.connect();
      try {
        const identity = await inspectDatabaseIdentity(client);
        const fingerprint = databaseFingerprint(identity);
        checks.push({ id: "DATABASE_FINGERPRINT", status: "NOT_RUN", summary: "Database identity inspected; no mutation attempted", evidence: { database: identity.database, fingerprint } });
        result = {
          status: "NOT_RUN",
          datasetReferenceKey: materialized.datasetReferenceKey,
          datasetVersion: materialized.datasetVersion,
          datasetContentHash: materialized.datasetContentHash,
          graphVersion: materialized.graphVersion,
          graphContentHash: materialized.graphContentHash,
          counts: materialized.plan.counts,
          databaseFingerprint: fingerprint
        };
      } finally {
        client.release();
      }
    } else if (!authorization.mutate) {
      checks.push({ id: "REAL_DATABASE_ADMISSION", status: "NOT_RUN", summary: "Dry-run default retained; database was not opened or mutated" });
      result = {
        status: "NOT_RUN",
        datasetReferenceKey: materialized.datasetReferenceKey,
        datasetVersion: materialized.datasetVersion,
        datasetContentHash: materialized.datasetContentHash,
        graphVersion: materialized.graphVersion,
        graphContentHash: materialized.graphContentHash,
        counts: materialized.plan.counts
      };
    } else {
      if (!configuration.databaseUrl) throw new Error("GOWM_OPENDRIVE_DATABASE_URL is required when mutation is enabled");
      pool = new Pool({ connectionString: configuration.databaseUrl, max: 2, connectionTimeoutMillis: 10_000 });
      const client = await pool.connect();
      try {
        const identity = await inspectDatabaseIdentity(client);
        const fingerprint = assertMutationAuthorized(authorization, identity);
        checks.push({ id: "DATABASE_MUTATION_GUARD", status: "PASS", summary: "Explicit mutation switch, permitted database identity, instance fingerprint, and development project gates matched", evidence: { database: identity.database, fingerprint } });
        const admitted = await mutateDatabase(client, materialized, configuration, identity.database === "gowm");
        checks.push({ id: "REAL_DATABASE_ADMISSION", status: "PASS", summary: "Catalog, immutable graph content, profiles, costs, partial conditions, receipt, and activation committed in one transaction", evidence: admitted.counts });
        result = {
          status: "PASS",
          datasetReferenceKey: materialized.datasetReferenceKey,
          datasetVersion: materialized.datasetVersion,
          datasetContentHash: materialized.datasetContentHash,
          graphVersion: materialized.graphVersion,
          graphContentHash: materialized.graphContentHash,
          graphVersionId: admitted.graphVersionId,
          counts: admitted.counts,
          databaseFingerprint: fingerprint
        };
      } finally {
        client.release();
      }
    }
  } catch (error) {
    const status = materialized && authorization.mutate ? "FAIL" : "BLOCKED";
    checks.push({ id: "ADMISSION", status, summary: redactedError(error) });
    result = {
      status,
      datasetReferenceKey: materialized?.datasetReferenceKey ?? "UNAVAILABLE",
      datasetVersion: materialized?.datasetVersion ?? "UNAVAILABLE",
      datasetContentHash: materialized?.datasetContentHash ?? "UNAVAILABLE",
      graphVersion: materialized?.graphVersion ?? "UNAVAILABLE",
      graphContentHash: materialized?.graphContentHash ?? "UNAVAILABLE",
      counts: materialized?.plan.counts ?? {}
    };
  } finally {
    await pool?.end().catch(() => undefined);
  }
  const report: AcceptanceReport = {
    schemaVersion: "1.0",
    reportKind: "GOWM_OPENDRIVE_GRAPH_ADMISSION",
    status: aggregateStatus(checks),
    generatedAt: new Date().toISOString(),
    checks,
    summary: materialized ? summary(materialized) : { outcome: "No admission materialization was available" }
  };
  await writeAcceptanceReport(resolve(configuration.reportDirectory, "GOWM_GRAPH_REPORT.json"), report);
  return result!;
}
