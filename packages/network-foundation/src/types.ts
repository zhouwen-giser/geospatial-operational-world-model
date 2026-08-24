export type NetworkAdapterKind = "CATALOG_VECTOR_LAYER" | "OSM_ARTIFACT_PREVIEW";

export interface NetworkDatasetVersion {
  readonly datasetReferenceKey: string;
  readonly datasetVersion: string;
  readonly datasetKind: string;
  readonly contentHash: string;
  readonly dataScopeKey: string;
  readonly datasetScopeKey: string;
}

export interface SourceLineFeature {
  readonly featureReferenceKey: string;
  readonly featureVersion: string;
  readonly layerKey: string;
  readonly contentHash: string;
  readonly coordinates: ReadonlyArray<readonly [longitude: number, latitude: number, elevationMetres?: number]>;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface NormalizedPosition {
  readonly longitudeNanodegrees: number;
  readonly latitudeNanodegrees: number;
  readonly elevationMm: number;
}

export interface MaterializedNetworkFeature extends Omit<SourceLineFeature, "coordinates"> {
  readonly positions: readonly NormalizedPosition[];
}

export interface NetworkBuildPolicy {
  readonly version: string;
  readonly coordinatePrecisionNanodegrees: number;
  readonly defaultElevationMm: number;
  readonly connectAtGradeIntersections: boolean;
}

export interface NetworkBuildRequest {
  readonly dataScopeKey: string;
  readonly datasetScopeKey: string;
  readonly datasetReferenceKey: string;
  readonly datasetVersion: string;
  readonly buildPolicy: NetworkBuildPolicy;
  readonly allowedLayerKeys: readonly string[];
}

export interface MaterializedNetworkBuild {
  readonly adapterKind: NetworkAdapterKind;
  readonly dataset: NetworkDatasetVersion;
  readonly buildPolicy: NetworkBuildPolicy;
  readonly features: readonly MaterializedNetworkFeature[];
  readonly sourceContentHash: string;
  readonly graphIdentityHash: string;
  readonly warnings: readonly string[];
}

export interface NetworkCatalogRepository {
  getDatasetVersion(request: NetworkBuildRequest): Promise<NetworkDatasetVersion | null>;
  listLineFeatures(request: NetworkBuildRequest): Promise<readonly SourceLineFeature[]>;
}

export interface BuiltNetworkNode {
  readonly nodeKey: string;
  readonly position: NormalizedPosition;
  readonly topologyIdentity: string;
}

export interface BuiltNetworkEdge {
  readonly edgeKey: string;
  readonly sourceFeatureReferenceKey: string;
  readonly sourceFeatureVersion: string;
  readonly sourceNodeKey: string;
  readonly targetNodeKey: string;
  readonly splitStartPpm: number;
  readonly splitEndPpm: number;
  readonly positions: readonly NormalizedPosition[];
  readonly lengthMm: number;
  readonly roadClass: string;
  readonly surface?: string;
  readonly isBridge: boolean;
  readonly isTunnel: boolean;
  readonly layerLevel: number;
  readonly oneway: "BIDIRECTIONAL" | "FORWARD_ONLY" | "REVERSE_ONLY";
}

export interface BuiltNetworkArc {
  readonly arcKey: string;
  readonly edgeKey: string;
  readonly sourceNodeKey: string;
  readonly targetNodeKey: string;
  readonly direction: "FORWARD" | "REVERSE";
  readonly positions: readonly NormalizedPosition[];
  readonly lengthMm: number;
  readonly defaultSpeedMmPerS: number;
}

export interface BuiltNetworkTopology {
  readonly nodes: readonly BuiltNetworkNode[];
  readonly edges: readonly BuiltNetworkEdge[];
  readonly arcs: readonly BuiltNetworkArc[];
  readonly topologyHash: string;
  readonly contentHash: string;
  readonly diagnostics: readonly string[];
}

export type TurnRuleType = "FORBIDDEN" | "ALLOWED_ONLY" | "PENALTY";

export interface SourcePairwiseTurnRestriction {
  readonly restrictionReferenceKey: string;
  readonly fromFeatureReferenceKey: string;
  readonly viaNodeKey: string;
  readonly toFeatureReferenceKey: string;
  readonly ruleType: TurnRuleType;
  readonly penaltyUnits?: number;
  readonly profileFilter?: Readonly<Record<string, unknown>>;
  readonly evidence?: readonly unknown[];
}

export interface SourceSequenceTurnRestriction {
  readonly restrictionReferenceKey: string;
  readonly featureReferenceKeys: readonly string[];
  readonly ruleType: "FORBIDDEN" | "PENALTY";
  readonly penaltyUnits?: number;
  readonly profileFilter?: Readonly<Record<string, unknown>>;
  readonly evidence?: readonly unknown[];
}

export interface BuiltPairwiseTurnRule {
  readonly ruleKey: string;
  readonly fromArcKey: string;
  readonly viaNodeKey: string;
  readonly toArcKey: string;
  readonly ruleType: TurnRuleType;
  readonly penaltyUnits: number;
  readonly profileFilter: Readonly<Record<string, unknown>>;
  readonly evidence: readonly unknown[];
  readonly contentHash: string;
}

export interface BuiltTurnSequenceRule {
  readonly ruleKey: string;
  readonly arcSequence: readonly string[];
  readonly ruleType: "FORBIDDEN" | "PENALTY";
  readonly penaltyUnits: number;
  readonly profileFilter: Readonly<Record<string, unknown>>;
  readonly evidence: readonly unknown[];
  readonly automatonHash: string;
  readonly contentHash: string;
}

export interface TurnRestrictionDiagnostic {
  readonly severity: "WARNING" | "FATAL";
  readonly issueCode: "UNRESOLVED_HARD_TURN_RESTRICTION" | "UNRESOLVED_SOFT_TURN_RESTRICTION";
  readonly activationBlocking: boolean;
  readonly restrictionReferenceKey: string;
  readonly reason: "ZERO_MATCHES" | "AMBIGUOUS_MATCHES";
  readonly candidateCount: number;
}

export interface SequenceAutomatonState {
  readonly stateId: number;
  readonly prefix: readonly string[];
}

export interface SequenceRestrictionAutomaton {
  readonly states: readonly SequenceAutomatonState[];
  readonly rules: readonly Pick<BuiltTurnSequenceRule, "ruleKey" | "arcSequence" | "ruleType" | "penaltyUnits">[];
  readonly automatonHash: string;
}

export interface CompiledTurnRestrictions {
  readonly pairwiseRules: readonly BuiltPairwiseTurnRule[];
  readonly sequenceRules: readonly BuiltTurnSequenceRule[];
  readonly automaton: SequenceRestrictionAutomaton;
  readonly diagnostics: readonly TurnRestrictionDiagnostic[];
  readonly contentHash: string;
}

export type NetworkVehicleClass = "ROAD_VEHICLE" | "UGV";

export interface NetworkTravelProfile {
  readonly profileKey: string;
  readonly version: string;
  readonly vehicleClass: NetworkVehicleClass;
  readonly allowedRoadClasses: readonly string[];
  readonly allowedSurfaces: readonly string[];
  readonly onewayPolicy: "STRICT" | "IGNORE_FOR_EMERGENCY";
  readonly maximumSpeedMmPerS?: number;
  readonly requiredAccessMask: number;
  readonly contentHash: string;
}

export interface NetworkCostWeights {
  readonly distance: number;
  readonly time: number;
  readonly risk: number;
  readonly energy: number;
  readonly surface: number;
}

export interface NetworkCostProfile {
  readonly profileKey: string;
  readonly version: string;
  readonly weights: NetworkCostWeights;
  readonly roundingPolicy: "HALF_AWAY_FROM_ZERO";
  readonly contentHash: string;
}

export interface NetworkArcConditionOverride {
  readonly arcKey: string;
  readonly traversalAllowed: boolean;
  readonly speedOverrideMmPerS?: number;
  readonly riskOverrideMicroUnits?: number;
  readonly accessOverrideMask?: number;
  readonly costMultiplierPpm?: number;
  readonly penaltyUnits?: number;
  readonly reasonCodes: readonly string[];
  readonly evidence: readonly unknown[];
  readonly contentHash: string;
}

export interface NetworkConditionSnapshot {
  readonly conditionSnapshotKey: string;
  readonly sourceSnapshotVersion: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly completeness: "COMPLETE" | "PARTIAL";
  readonly sourceContentHash: string;
  readonly conditions: readonly NetworkArcConditionOverride[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly contentHash: string;
}

export interface NetworkArcCostMetrics {
  readonly distanceMm: number;
  readonly durationMs: number;
  readonly riskMicroUnits: number;
  readonly energyMwh: number;
  readonly surfacePenaltyUnits: number;
  readonly combinedCostUnits: number;
  readonly speedMmPerS: number;
  readonly conditionSnapshotKey?: string;
  readonly contentHash: string;
}
