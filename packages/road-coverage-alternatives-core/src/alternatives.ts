import { canonicalSha256 } from "../../platform/contract-runtime/src/index.js";
import type {
  GowmV06CoverageAlternative as CoverageAlternative,
  GowmV06CoverageAlternativePolicy as CoverageAlternativePolicy,
  GowmV06CoverageResultSet as CoverageResultSet,
  GowmV06CoverageSolverDiagnostics as CoverageSolverDiagnostics
} from "../../platform/contract-runtime/src/index.js";
import { admitVerifiedCoverageRoute } from "../../road-coverage-verifier-core/src/index.js";
import type { AdmittedVerifiedRoute, RoutingSnapshot } from "../../road-coverage-verifier-core/src/index.js";

export interface VerifiedAlternativeCandidate {
  admitted: AdmittedVerifiedRoute;
  objectiveProfile: CoverageAlternativePolicy["profiles"][number];
  solverDiagnostics: CoverageSolverDiagnostics;
  displayMetadata?: Record<string, unknown>;
}

export interface BuildCoverageResultSetInput {
  requestId: string;
  problemHash: `sha256:${string}`;
  routingSnapshot: RoutingSnapshot;
  policy: CoverageAlternativePolicy;
  candidates: VerifiedAlternativeCandidate[];
  searchTerminatedBy: NonNullable<CoverageResultSet["searchTerminatedBy"]>;
  createdAt: string;
  validUntil: string;
}

interface CandidateFacts extends Record<string, number> {
  distanceMm: number;
  durationMs: number;
  riskMicroUnits: number;
  energyMwh: number;
  combinedCostUnits: number;
  deadheadDistanceMm: number;
  serviceDistanceMm: number;
}

interface PreparedCandidate extends VerifiedAlternativeCandidate { facts: CandidateFacts }

export function buildVerifiedCoverageResultSet(input: BuildCoverageResultSetInput): Readonly<CoverageResultSet> {
  validatePolicy(input.policy);
  const profileOrder = new Map(input.policy.profiles.map((profile, index) => [profile, index]));
  const admitted = input.candidates
    .filter((candidate) => profileOrder.has(candidate.objectiveProfile))
    .map((candidate) => ({ ...candidate, admitted: admitVerifiedCoverageRoute(candidate.admitted.route, candidate.admitted.verification), facts: routeFacts(candidate.admitted.route) }));
  const bySignature = new Map<string, PreparedCandidate>();
  for (const candidate of admitted) {
    const signature = candidate.admitted.route.routeSignature;
    const existing = bySignature.get(signature);
    if (existing === undefined || compareCandidates(candidate, existing, profileOrder) < 0) bySignature.set(signature, candidate);
  }
  const ordered = [...bySignature.values()].sort((left, right) => compareCandidates(left, right, profileOrder));
  const selected: PreparedCandidate[] = [];
  for (const candidate of ordered) {
    if (selected.length >= input.policy.requestedCount) break;
    if (selected.every((existing) => {
      const similarity = compareRoutes(existing.admitted.route, candidate.admitted.route);
      return similarity.weightedArcOverlapPpm <= input.policy.maximumWeightedArcOverlapPpm &&
        similarity.deadheadJaccardDistancePpm >= input.policy.minimumDeadheadJaccardDistancePpm;
    })) selected.push(candidate);
  }
  const alternatives = selected.map((candidate, index) => alternative(candidate, index + 1)) as unknown as CoverageResultSet["alternatives"];
  const pairwiseSimilarity = alternatives.flatMap((left, leftIndex) => alternatives.slice(leftIndex + 1).map((right) => ({
    leftAlternativeId: left.alternativeId,
    rightAlternativeId: right.alternativeId,
    ...compareRoutes(left.route, right.route)
  })));
  const status: CoverageResultSet["status"] = alternatives.length >= input.policy.requestedCount
    ? "SUCCEEDED"
    : alternatives.length >= input.policy.minimumVerifiedCount
      ? "PARTIAL"
      : alternatives.length === 0
        ? "NO_FEASIBLE_PLAN"
        : "PARTIAL";
  const resultIdentity = canonicalSha256({ requestId: input.requestId, problemHash: input.problemHash, routingSnapshot: input.routingSnapshot });
  const body = {
    schemaVersion: "1.0" as const,
    referenceKey: reference("QUERY_RESULT", resultIdentity),
    resultSetId: `result_${resultIdentity.slice("sha256:".length)}`,
    requestId: input.requestId,
    problemHash: input.problemHash,
    status,
    routingSnapshot: input.routingSnapshot,
    createdAt: input.createdAt,
    validUntil: input.validUntil,
    revalidationRequired: true as const,
    searchTerminatedBy: input.searchTerminatedBy,
    alternatives,
    pairwiseSimilarity,
    receipts: [{
      kind: "ALTERNATIVE_SELECTION",
      requestedCount: input.policy.requestedCount,
      minimumVerifiedCount: input.policy.minimumVerifiedCount,
      admittedCandidateCount: admitted.length,
      deduplicatedCandidateCount: ordered.length,
      selectedCount: alternatives.length,
      terminationReason: input.searchTerminatedBy
    }]
  };
  return deepFreeze({ ...body, resultHash: canonicalSha256(body) });
}

export function compareRoutes(left: AdmittedVerifiedRoute["route"], right: AdmittedVerifiedRoute["route"]): { weightedArcOverlapPpm: number; deadheadJaccardDistancePpm: number } {
  const leftWeights = weightedSegments(left), rightWeights = weightedSegments(right);
  const keys = new Set([...leftWeights.keys(), ...rightWeights.keys()]);
  let intersection = 0, union = 0;
  for (const key of keys) {
    const leftValue = leftWeights.get(key) ?? 0, rightValue = rightWeights.get(key) ?? 0;
    intersection = safeAdd(intersection, Math.min(leftValue, rightValue));
    union = safeAdd(union, Math.max(leftValue, rightValue));
  }
  const leftDeadhead = deadheadSet(left), rightDeadhead = deadheadSet(right);
  const deadheadUnion = new Set([...leftDeadhead, ...rightDeadhead]);
  const deadheadIntersection = [...leftDeadhead].filter((key) => rightDeadhead.has(key)).length;
  return {
    weightedArcOverlapPpm: ratio(intersection, union),
    deadheadJaccardDistancePpm: deadheadUnion.size === 0 ? 0 : 1_000_000 - ratio(deadheadIntersection, deadheadUnion.size)
  };
}

function alternative(candidate: PreparedCandidate, rank: number): CoverageAlternative {
  const facts = candidate.facts;
  const explanation = explanationFor(candidate.objectiveProfile, facts);
  const body = {
    alternativeId: "",
    rank,
    objectiveProfile: candidate.objectiveProfile,
    route: structuredClone(candidate.admitted.route),
    verification: structuredClone(candidate.admitted.verification),
    solverDiagnostics: structuredClone(candidate.solverDiagnostics),
    objectiveVector: facts,
    pros: explanation.pros,
    cons: explanation.cons
  };
  const { alternativeId: _alternativeId, ...identityBody } = body;
  const identity = canonicalSha256({ ...identityBody, routeSignature: candidate.admitted.route.routeSignature });
  const alternativeId = `alt_${identity.slice("sha256:".length)}`;
  const withIdentity = { ...body, alternativeId, referenceKey: reference("DERIVED_REFERENCE", identity) };
  return { ...withIdentity, contentHash: canonicalSha256(withIdentity) };
}

function explanationFor(profile: VerifiedAlternativeCandidate["objectiveProfile"], facts: CandidateFacts): { pros: string[]; cons: string[] } {
  const fact = profile === "FASTEST_COMPLETION" ? `Verified duration ${facts.durationMs} ms`
    : profile === "SHORTEST_TOTAL_DISTANCE" ? `Verified distance ${facts.distanceMm} mm`
      : profile === "LEAST_DEADHEAD" ? `Verified deadhead ${facts.deadheadDistanceMm} mm`
        : profile === "LOWEST_RISK" ? `Verified risk ${facts.riskMicroUnits} micro-units`
          : `Verified combined cost ${facts.combinedCostUnits} units`;
  return { pros: [fact], cons: facts.deadheadDistanceMm === 0 ? [] : [`Includes ${facts.deadheadDistanceMm} mm non-service travel`] };
}

function compareCandidates(left: PreparedCandidate, right: PreparedCandidate, order: ReadonlyMap<string, number>): number {
  return (order.get(left.objectiveProfile) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.objectiveProfile) ?? Number.MAX_SAFE_INTEGER) ||
    profileScore(left) - profileScore(right) || left.admitted.route.routeSignature.localeCompare(right.admitted.route.routeSignature);
}

function profileScore(candidate: PreparedCandidate): number {
  const facts = candidate.facts;
  return candidate.objectiveProfile === "FASTEST_COMPLETION" ? facts.durationMs
    : candidate.objectiveProfile === "SHORTEST_TOTAL_DISTANCE" ? facts.distanceMm
      : candidate.objectiveProfile === "LEAST_DEADHEAD" ? facts.deadheadDistanceMm
        : candidate.objectiveProfile === "LOWEST_RISK" ? facts.riskMicroUnits
          : facts.combinedCostUnits;
}

function routeFacts(route: AdmittedVerifiedRoute["route"]): CandidateFacts {
  let deadheadDistanceMm = 0, serviceDistanceMm = 0;
  for (const segment of route.segments) {
    if (segment.serviceRole === "SERVICE") serviceDistanceMm = safeAdd(serviceDistanceMm, segment.metrics.distanceMm);
    else deadheadDistanceMm = safeAdd(deadheadDistanceMm, segment.metrics.distanceMm);
  }
  return { ...route.metrics, deadheadDistanceMm, serviceDistanceMm };
}

function weightedSegments(route: AdmittedVerifiedRoute["route"]): Map<string, number> {
  const result = new Map<string, number>();
  for (const segment of route.segments) {
    const key = `${segment.arcKey}:${segment.startFractionPpm}:${segment.endFractionPpm}:${segment.serviceRole}`;
    result.set(key, safeAdd(result.get(key) ?? 0, segment.metrics.distanceMm));
  }
  return result;
}

function deadheadSet(route: AdmittedVerifiedRoute["route"]): Set<string> {
  return new Set(route.segments.filter((segment) => segment.serviceRole !== "SERVICE" && segment.serviceRole !== "DUPLICATE_SERVICE")
    .map((segment) => `${segment.arcKey}:${segment.startFractionPpm}:${segment.endFractionPpm}`));
}

function validatePolicy(policy: CoverageAlternativePolicy): void {
  if (!Number.isSafeInteger(policy.requestedCount) || !Number.isSafeInteger(policy.minimumVerifiedCount) || policy.requestedCount < 1 || policy.requestedCount > 5 || policy.minimumVerifiedCount < 1 || policy.minimumVerifiedCount > policy.requestedCount || policy.profiles.length < 1 || !Number.isSafeInteger(policy.maximumWeightedArcOverlapPpm) || !Number.isSafeInteger(policy.minimumDeadheadJaccardDistancePpm)) {
    throw new Error("alternative policy is invalid");
  }
}

function reference<K extends "QUERY_RESULT" | "DERIVED_REFERENCE">(kind: K, hash: `sha256:${string}`) {
  return { namespace: "gowm" as const, kind, id: `wrf_${hash.slice("sha256:".length, "sha256:".length + 32)}`, version: "1" };
}

function ratio(numerator: number, denominator: number): number { return denominator === 0 ? 1_000_000 : Number((BigInt(numerator) * 1_000_000n) / BigInt(denominator)); }
function safeAdd(left: number, right: number): number { const result = left + right; if (!Number.isSafeInteger(result) || result < 0) throw new Error("alternative fixed-point overflow"); return result; }
function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
