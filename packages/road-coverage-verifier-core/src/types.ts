import type {
  GowmV06CoverageCommonFixedMetrics as FixedMetrics,
  GowmV06CoverageCommonReferenceKey as ReferenceKey,
  GowmV06CoverageCommonRoutingSnapshot as RoutingSnapshot,
  GowmV06CoverageProblem as CoverageProblem,
  GowmV06CoverageRoute as CoverageRoute,
  GowmV06CoverageVerificationReport as CoverageVerificationReport
} from "../../platform/contract-runtime/src/index.js";

export type { CoverageProblem, CoverageRoute, CoverageVerificationReport, FixedMetrics, ReferenceKey, RoutingSnapshot };

export interface VerifierNetworkArc {
  graphVersion: string;
  arcKey: string;
  fromNodeKey: string;
  toNodeKey: string;
  direction: "FORWARD" | "REVERSE";
  metrics: FixedMetrics;
  sourceFeatureReferenceKey?: ReferenceKey;
  roadClass?: string;
  surface?: string;
  accessMask?: number;
  traversalAllowed?: boolean;
  speedMmPerS?: number;
  speedOverrideMmPerS?: number;
  riskOverrideMicroUnits?: number;
  conditionPenaltyUnits?: number;
}

export type VerifierObjective = "SHORTEST_DISTANCE" | "FASTEST" | "LOWEST_RISK" | "LOWEST_ENERGY" | "BALANCED";

export interface VerifierTurnRule {
  ruleKey: string;
  arcSequence: string[];
  ruleType: "FORBIDDEN" | "ALLOWED_ONLY" | "PENALTY";
  penaltyUnits?: number;
  travelProfileKeys?: string[];
}

export interface VerifierTravelPolicy {
  profileKey: string;
  allowedRoadClasses?: string[];
  allowedSurfaces?: string[];
  requiredAccessMask?: number;
  maximumSpeedMmPerS?: number;
}

export interface VerifyCoverageRouteInput {
  problem: CoverageProblem;
  candidate: CoverageRoute;
  currentRoutingSnapshot: RoutingSnapshot;
  networkArcs: VerifierNetworkArc[];
  objective: VerifierObjective;
  travelPolicy: VerifierTravelPolicy;
  turnRules?: VerifierTurnRule[];
}

export interface AdmittedVerifiedRoute {
  route: CoverageRoute;
  verification: CoverageVerificationReport;
  admissionHash: `sha256:${string}`;
}
