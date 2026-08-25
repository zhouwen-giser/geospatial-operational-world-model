import type {
  GowmV06CoverageCommonReferenceKey as ReferenceKey,
  GowmV06CoverageCommonDirectedState as DirectedState,
  GowmV06CoverageCommonNetworkLocation as NetworkLocation,
  GowmV06CoverageCommonRoutingSnapshot as RoutingSnapshot,
  GowmV06CoverageCommonFixedMetrics as FixedMetrics,
  GowmV06CoverageObligationSet as CoverageObligationSet,
  GowmV06CoverageRoute as CoverageRoute,
  GowmV06CoverageSolverDiagnostics as CoverageSolverDiagnostics,
  GowmV06CoverageProblem as CoverageProblem,
  GowmV06CoverageEndpointPolicy as CoverageEndpointPolicy,
  GowmV06RoadSelectionPolicy as RoadSelectionPolicy,
  GowmV06RoadServiceObligation as RoadServiceObligation
} from "../../platform/contract-runtime/src/index.js";

export type { CoverageEndpointPolicy, CoverageObligationSet, CoverageProblem, CoverageRoute, CoverageSolverDiagnostics, DirectedState, FixedMetrics, NetworkLocation, ReferenceKey, RoadSelectionPolicy, RoadServiceObligation, RoutingSnapshot };

export type GeoJsonArea = {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown[];
};

export interface CoverageSelectionRequest {
  dataScopeKey: string;
  datasetScopeKey: string;
  routingSnapshot: RoutingSnapshot;
  area: GeoJsonArea | ReferenceKey;
  resolvedArea?: GeoJsonArea;
  policy: RoadSelectionPolicy;
  maximumSelectionCandidates: number;
}

export interface CoverageSelectionCandidate {
  graphVersion: string;
  edgeKey: string;
  arcKey: string;
  direction: "FORWARD" | "REVERSE";
  oneway: "BIDIRECTIONAL" | "FORWARD_ONLY" | "REVERSE_ONLY";
  startFractionPpm: number;
  endFractionPpm: number;
  requiredLengthMm: number;
  roadClass: string;
  sourceFeatureReferenceId: string;
}

export interface CoverageSelectionRepository {
  select(request: CoverageSelectionRequest): Promise<CoverageSelectionCandidate[]>;
  validateManual(request: CoverageSelectionRequest, arcKeys: string[]): Promise<CoverageSelectionCandidate[]>;
}

export interface CoverageSelectionReceipt {
  schemaVersion: "1.0";
  method: "POSTGIS_BOUNDARY_INCLUSIVE_FRACTION_PPM_V1" | "VALIDATED_MANUAL_OBLIGATIONS_V1";
  mode: RoadSelectionPolicy["mode"];
  routingSnapshot: RoutingSnapshot;
  selectionPolicyVersion: string;
  areaHash: `sha256:${string}`;
  areaReferenceKey?: ReferenceKey;
  candidateCount: number;
  obligationCount: number;
  minimumSegmentLengthMm: number;
  boundaryToleranceMm: number;
}

export interface CoverageSelectionResult {
  obligationSet: CoverageObligationSet;
  receipt: CoverageSelectionReceipt;
}

export interface CoverageSqlResult<T extends Record<string, unknown> = Record<string, unknown>> {
  rows: T[];
  rowCount: number | null;
}

export interface CoverageSqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<CoverageSqlResult<T>>;
  release(): void;
}

export interface CoverageSqlPool {
  connect(): Promise<CoverageSqlClient>;
}

export interface CoverageTraversalArc {
  graphVersion: string;
  arcKey: string;
  fromNodeKey: string;
  toNodeKey: string;
  direction: "FORWARD" | "REVERSE";
  metrics: FixedMetrics;
  sourceFeatureReferenceKey?: ReferenceKey;
}

export interface ClosedDcppAugmentation {
  fromNodeKey: string;
  toNodeKey: string;
  quantity: number;
  unitCost: number;
  arcKeys: string[];
}

export interface ClosedDcppSolution {
  route: CoverageRoute;
  diagnostics: CoverageSolverDiagnostics;
  augmentation: ClosedDcppAugmentation[];
}
