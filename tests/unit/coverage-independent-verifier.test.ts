import { describe, expect, it } from "vitest";

import { canonicalSha256, validateContract } from "../../packages/platform/contract-runtime/src/index.js";
import { admitVerifiedCoverageRoute, verifyCoverageRoute } from "../../packages/road-coverage-verifier-core/src/index.js";
import type { CoverageRoute, RoutingSnapshot, VerifierNetworkArc, VerifyCoverageRouteInput } from "../../packages/road-coverage-verifier-core/src/index.js";
import { buildCanonicalCoverageProblem, buildRoadServiceObligation, obligationSetHash, solveStrictCoverageRoute } from "../../packages/road-coverage-planning-core/src/index.js";

const snapshot = {
  networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}`
} as const;
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" } as const;
const key = (hex: string): string => `arc_${hex.repeat(32)}`;
const arc = (hex: string, fromNodeKey: string, toNodeKey: string, distanceMm: number): VerifierNetworkArc => ({ graphVersion: snapshot.graphVersion, arcKey: key(hex), fromNodeKey, toNodeKey, direction: "FORWARD", sourceFeatureReferenceKey: feature, roadClass: "LOCAL", surface: "PAVED", accessMask: 1, metrics: { distanceMm, durationMs: distanceMm * 2, riskMicroUnits: distanceMm * 3, energyMwh: distanceMm * 4, combinedCostUnits: distanceMm, turnPenaltyUnits: 0 } });

function fixture(): VerifyCoverageRouteInput {
  const start = arc("1", "X", "A", 1), connector = arc("2", "A", "D", 5), service = arc("3", "D", "E", 7), back = arc("4", "E", "A", 11);
  const obligation = buildRoadServiceObligation({ routingSnapshot: snapshot, graphVersion: snapshot.graphVersion, arcKey: service.arcKey, startFractionPpm: 0, endFractionPpm: 1_000_000, requiredPasses: 1, selectionPolicyVersion: "coverage-selection/1.0", sourceFeatureReferenceKey: feature });
  const hash = obligationSetHash([obligation]);
  const problem = buildCanonicalCoverageProblem({
    routingSnapshot: snapshot,
    startState: { arcKey: start.arcKey, fractionPpm: 1_000_000, direction: "FORWARD" },
    endpointMode: "RETURN_TO_START",
    boundaryCrossingPolicy: "FREE",
    obligationSet: { schemaVersion: "1.0", obligationSetId: `obls_${hash.slice("sha256:".length)}`, routingSnapshot: snapshot, selectionMode: "MANUAL_OBLIGATIONS", obligations: [obligation], obligationCount: 1, totalRequiredLengthMm: 7, selectionReceiptHash: `sha256:${"3".repeat(64)}`, warnings: [] },
    objective: { profile: "SHORTEST_DISTANCE" },
    budgets: { timeLimitMs: 10_000, maximumCandidates: 4, maximumMatrixCells: 32 }
  });
  const networkArcs = [start, connector, service, back];
  const candidate = solveStrictCoverageRoute(problem, networkArcs, { objective: "SHORTEST_DISTANCE", travelPolicy: { profileKey: "UGV/1.0" } }).route;
  return { problem, candidate, currentRoutingSnapshot: snapshot, networkArcs, objective: "SHORTEST_DISTANCE", travelPolicy: { profileKey: "UGV/1.0" }, turnRules: [] };
}

function rehash(route: CoverageRoute): CoverageRoute {
  const { routeSignature: _routeSignature, ...body } = structuredClone(route);
  return { ...body, routeSignature: canonicalSha256(body) };
}

describe("independent coverage verifier", () => {
  it("validates a legal route with exact pass and length-weighted coverage", () => {
    const input = fixture();
    const report = verifyCoverageRoute(input);
    expect(report.status).toBe("VALID");
    expect(report.coverageRatioPpm).toBe(1_000_000);
    expect(report.lengthWeightedCoverageRatioPpm).toBe(1_000_000);
    expect(report.requiredLengthMm).toBe(7);
    expect(report.coveredRequiredLengthMm).toBe(7);
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(validateContract("urn:gowm:v0.6:coverage-verification-report", report)).toMatchObject({ valid: true });
    expect(admitVerifiedCoverageRoute(input.candidate, report).verification.status).toBe("VALID");
  });

  it("kills Arc identity, continuity, orientation, and fraction mutations", () => {
    const input = fixture();
    const unknown = structuredClone(input.candidate);
    unknown.segments[0]!.arcKey = key("f");
    const unknownReport = verifyCoverageRoute({ ...input, candidate: rehash(unknown) });
    expect(unknownReport.violations.map((item) => item.code)).toContain("UNKNOWN_OR_WRONG_VERSION_ARC");

    const discontinuous = structuredClone(input.candidate);
    discontinuous.segments[0]!.endFractionPpm = 500_000;
    const discontinuityReport = verifyCoverageRoute({ ...input, candidate: rehash(discontinuous) });
    expect(discontinuityReport.violations.map((item) => item.code)).toContain("DISCONTINUOUS_SEGMENT");

    const reversed = structuredClone(input.candidate);
    reversed.segments[1]!.startFractionPpm = 1_000_000;
    reversed.segments[1]!.endFractionPpm = 0;
    const reversedReport = verifyCoverageRoute({ ...input, candidate: rehash(reversed) });
    expect(reversedReport.violations.map((item) => item.code)).toEqual(expect.arrayContaining(["INVALID_FRACTION", "ILLEGAL_DIRECTION"]));
  });

  it("independently detects pairwise and multi-edge turn violations", () => {
    const input = fixture();
    const [start, connector, service] = input.networkArcs;
    const pair = verifyCoverageRoute({ ...input, turnRules: [{ ruleKey: "pair", arcSequence: [start!.arcKey, connector!.arcKey], ruleType: "FORBIDDEN" }] });
    const sequence = verifyCoverageRoute({ ...input, turnRules: [{ ruleKey: "sequence", arcSequence: [start!.arcKey, connector!.arcKey, service!.arcKey], ruleType: "FORBIDDEN" }] });
    expect(pair.violations.map((item) => item.code)).toContain("TURN_RESTRICTION_VIOLATION");
    expect(sequence.violations.map((item) => item.code)).toContain("TURN_RESTRICTION_VIOLATION");
  });

  it("recomputes service pass counts and both coverage ratios", () => {
    const input = fixture();
    const missing = structuredClone(input.candidate);
    missing.segments = missing.segments.filter((segment) => segment.serviceRole !== "SERVICE");
    const report = verifyCoverageRoute({ ...input, candidate: rehash(missing) });
    expect(report.status).toBe("INVALID");
    expect(report.coverageRatioPpm).toBe(0);
    expect(report.lengthWeightedCoverageRatioPpm).toBe(0);
    expect(report.violations.map((item) => item.code)).toContain("OBLIGATION_PASS_DEFICIT");
  });

  it("detects terminal and boundary-policy mutations", () => {
    const input = fixture();
    const endpoint = structuredClone(input.candidate);
    endpoint.startState.fractionPpm = 999_999;
    endpoint.endState.fractionPpm = 999_999;
    const endpointReport = verifyCoverageRoute({ ...input, candidate: rehash(endpoint) });
    expect(endpointReport.violations.map((item) => item.code)).toEqual(expect.arrayContaining(["START_STATE_MISMATCH", "END_STATE_MISMATCH"]));

    const boundaryCandidate = structuredClone(input.candidate);
    boundaryCandidate.boundaryEvents = [
      { sequence: 1, kind: "ENTRY", state: input.problem.startState },
      { sequence: 2, kind: "EXIT", state: input.problem.startState },
      { sequence: 3, kind: "ENTRY", state: input.problem.startState }
    ];
    const boundaryProblem = { ...input.problem, boundaryCrossingPolicy: "NO_REENTRY" as const };
    const boundaryReport = verifyCoverageRoute({ ...input, problem: boundaryProblem, candidate: rehash(boundaryCandidate) });
    expect(boundaryReport.violations.map((item) => item.code)).toContain("BOUNDARY_POLICY_VIOLATION");
  });

  it("detects profile, condition, metric, and result hash mutations", () => {
    const input = fixture();
    const profile = verifyCoverageRoute({ ...input, travelPolicy: { profileKey: "UGV/1.0", allowedRoadClasses: ["HIGHWAY"] } });
    expect(profile.violations.map((item) => item.code)).toContain("PROFILE_ILLEGAL_ARC");
    const closed = verifyCoverageRoute({ ...input, networkArcs: input.networkArcs.map((value) => value.arcKey === input.candidate.segments[1]!.arcKey ? { ...value, traversalAllowed: false } : value) });
    expect(closed.violations.map((item) => item.code)).toContain("CONDITION_CLOSED_ARC");

    const metric = structuredClone(input.candidate);
    metric.segments[0]!.metrics.distanceMm += 1;
    const metricReport = verifyCoverageRoute({ ...input, candidate: rehash(metric) });
    expect(metricReport.violations.map((item) => item.code)).toContain("METRIC_MISMATCH");
    const hash = structuredClone(input.candidate);
    hash.metrics.distanceMm += 1;
    const hashReport = verifyCoverageRoute({ ...input, candidate: hash });
    expect(hashReport.violations.map((item) => item.code)).toContain("CANDIDATE_HASH_MISMATCH");
  });

  it("returns STALE for a new graph/profile/condition snapshot", () => {
    const input = fixture();
    const current: RoutingSnapshot = { ...snapshot, costContentHash: `sha256:${"9".repeat(64)}` };
    const report = verifyCoverageRoute({ ...input, currentRoutingSnapshot: current });
    expect(report.status).toBe("STALE");
    expect(report.checks.snapshot).toBe(false);
    expect(report.violations.map((item) => item.code)).toContain("STALE_ROUTING_SNAPSHOT");
  });

  it("prevents an invalid or tampered verification receipt from admission", () => {
    const input = fixture();
    const invalid = verifyCoverageRoute({ ...input, turnRules: [{ ruleKey: "pair", arcSequence: [input.networkArcs[0]!.arcKey, input.networkArcs[1]!.arcKey], ruleType: "FORBIDDEN" }] });
    expect(() => admitVerifiedCoverageRoute(input.candidate, invalid)).toThrow(/independently VALID/u);
    const valid = verifyCoverageRoute(input);
    expect(() => admitVerifiedCoverageRoute(input.candidate, { ...valid, reportHash: `sha256:${"0".repeat(64)}` })).toThrow(/receipt hash/u);
  });
});
