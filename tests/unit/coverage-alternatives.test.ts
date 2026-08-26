import { describe, expect, it } from "vitest";

import { validateContract } from "../../packages/platform/contract-runtime/src/index.js";
import { buildVerifiedCoverageResultSet, compareRoutes } from "../../packages/road-coverage-alternatives-core/src/index.js";
import type { BuildCoverageResultSetInput, VerifiedAlternativeCandidate } from "../../packages/road-coverage-alternatives-core/src/index.js";
import { admitVerifiedCoverageRoute, verifyCoverageRoute } from "../../packages/road-coverage-verifier-core/src/index.js";
import { buildCanonicalCoverageProblem, buildRoadServiceObligation, obligationSetHash, solveStrictCoverageRoute } from "../../packages/road-coverage-planning-core/src/index.js";
import type { CoverageTraversalArc, FixedMetrics } from "../../packages/road-coverage-planning-core/src/index.js";

const snapshot = { networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1", graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}` } as const;
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" } as const;
const key = (hex: string): string => `arc_${hex.repeat(32)}`;
const fixed = (distanceMm: number, durationMs: number): FixedMetrics => ({ distanceMm, durationMs, riskMicroUnits: distanceMm, energyMwh: distanceMm, combinedCostUnits: distanceMm, turnPenaltyUnits: 0 });
const arc = (hex: string, fromNodeKey: string, toNodeKey: string, metrics: FixedMetrics): CoverageTraversalArc => ({ graphVersion: snapshot.graphVersion, arcKey: key(hex), fromNodeKey, toNodeKey, direction: "FORWARD", sourceFeatureReferenceKey: feature, metrics });

function candidates(): { values: VerifiedAlternativeCandidate[]; problemHash: `sha256:${string}` } {
  const start = arc("1", "X", "A", fixed(1, 1));
  const short = arc("2", "A", "D", fixed(10, 100));
  const fast1 = arc("3", "A", "C", fixed(10, 10));
  const fast2 = arc("4", "C", "D", fixed(10, 10));
  const service = arc("5", "D", "E", fixed(1, 1));
  const back = arc("6", "E", "A", fixed(1, 1));
  const networkArcs = [start, short, fast1, fast2, service, back];
  const required = buildRoadServiceObligation({ routingSnapshot: snapshot, graphVersion: snapshot.graphVersion, arcKey: service.arcKey, startFractionPpm: 0, endFractionPpm: 1_000_000, requiredPasses: 1, selectionPolicyVersion: "coverage-selection/1.0", sourceFeatureReferenceKey: feature });
  const hash = obligationSetHash([required]);
  const problem = buildCanonicalCoverageProblem({ routingSnapshot: snapshot, startState: { arcKey: start.arcKey, fractionPpm: 1_000_000, direction: "FORWARD" }, endpointMode: "RETURN_TO_START", boundaryCrossingPolicy: "FREE", obligationSet: { schemaVersion: "1.0", obligationSetId: `obls_${hash.slice("sha256:".length)}`, routingSnapshot: snapshot, selectionMode: "MANUAL_OBLIGATIONS", obligations: [required], obligationCount: 1, totalRequiredLengthMm: 1, selectionReceiptHash: `sha256:${"3".repeat(64)}`, warnings: [] }, objective: { profiles: ["SHORTEST_TOTAL_DISTANCE", "FASTEST_COMPLETION"] }, budgets: { timeLimitMs: 10_000, maximumCandidates: 8, maximumMatrixCells: 64 } });
  const build = (objective: "SHORTEST_DISTANCE" | "FASTEST", objectiveProfile: "SHORTEST_TOTAL_DISTANCE" | "FASTEST_COMPLETION"): VerifiedAlternativeCandidate => {
    const solution = solveStrictCoverageRoute(problem, networkArcs, { objective, travelPolicy: { profileKey: "UGV/1.0" } });
    const verification = verifyCoverageRoute({ problem, candidate: solution.route, currentRoutingSnapshot: snapshot, networkArcs, objective, travelPolicy: { profileKey: "UGV/1.0" } });
    return { admitted: admitVerifiedCoverageRoute(solution.route, verification), objectiveProfile, solverDiagnostics: solution.diagnostics };
  };
  return { values: [build("SHORTEST_DISTANCE", "SHORTEST_TOTAL_DISTANCE"), build("FASTEST", "FASTEST_COMPLETION")], problemHash: problem.problemHash as `sha256:${string}` };
}

function input(values: VerifiedAlternativeCandidate[], problemHash: `sha256:${string}`, overrides: Partial<BuildCoverageResultSetInput["policy"]> = {}): BuildCoverageResultSetInput {
  return {
    requestId: "request-alternatives",
    problemHash,
    routingSnapshot: snapshot,
    policy: { requestedCount: 2, minimumVerifiedCount: 2, profiles: ["SHORTEST_TOTAL_DISTANCE", "FASTEST_COMPLETION"], maximumWeightedArcOverlapPpm: 900_000, minimumDeadheadJaccardDistancePpm: 500_000, maximumGenerationCandidates: 8, ...overrides },
    candidates: values,
    searchTerminatedBy: "PROFILES_COMPLETE",
    createdAt: "2026-08-25T04:00:00Z",
    validUntil: "2026-08-25T04:05:00Z"
  };
}

describe("verified coverage alternatives", () => {
  it("keeps identical routes request-owned and scope-isolated while preserving replay", () => {
    const fixture = candidates();
    const original = { ...input(fixture.values, fixture.problemHash), identityScope: "scope-a" };
    const first = buildVerifiedCoverageResultSet(original);
    const replay = buildVerifiedCoverageResultSet(original);
    const otherRequest = buildVerifiedCoverageResultSet({ ...original, requestId: "another-request" });
    const otherScope = buildVerifiedCoverageResultSet({ ...original, identityScope: "scope-b" });
    expect(first.resultHash).toBe(replay.resultHash);
    for (const other of [otherRequest, otherScope]) {
      expect(first.referenceKey.id).not.toBe(other.referenceKey.id);
      expect(first.alternatives[0]!.referenceKey!.id).not.toBe(other.alternatives[0]!.referenceKey!.id);
      expect(first.alternatives[0]!.route.routeSignature).toBe(other.alternatives[0]!.route.routeSignature);
    }
  });
  it("returns one or two requested independently verified alternatives", () => {
    const fixture = candidates();
    const two = buildVerifiedCoverageResultSet(input(fixture.values, fixture.problemHash));
    expect(two.status).toBe("SUCCEEDED");
    expect(two.alternatives).toHaveLength(2);
    expect(two.pairwiseSimilarity).toHaveLength(1);
    expect(two.alternatives.every((alternative) => alternative.verification.status === "VALID")).toBe(true);
    expect(validateContract("urn:gowm:v0.6:coverage-result-set", two)).toMatchObject({ valid: true });

    const one = buildVerifiedCoverageResultSet(input([fixture.values[0]!], fixture.problemHash, { requestedCount: 1, minimumVerifiedCount: 1, profiles: ["SHORTEST_TOTAL_DISTANCE"] }));
    expect(one.status).toBe("SUCCEEDED");
    expect(one.alternatives).toHaveLength(1);
  });

  it("deduplicates identical ordered routes and ignores display-only metadata", () => {
    const fixture = candidates();
    const duplicate = { ...fixture.values[0]!, objectiveProfile: "FASTEST_COMPLETION" as const, displayMetadata: { label: "different", geometryColor: "red" } };
    const result = buildVerifiedCoverageResultSet(input([fixture.values[0]!, duplicate], fixture.problemHash, { minimumVerifiedCount: 1 }));
    expect(result.alternatives).toHaveLength(1);
    expect(result.status).toBe("PARTIAL");
  });

  it("enforces weighted overlap and deadhead Jaccard thresholds", () => {
    const fixture = candidates();
    const similarity = compareRoutes(fixture.values[0]!.admitted.route, fixture.values[1]!.admitted.route);
    expect(similarity.weightedArcOverlapPpm).toBeLessThan(900_000);
    expect(similarity.deadheadJaccardDistancePpm).toBeGreaterThanOrEqual(500_000);
    const strict = buildVerifiedCoverageResultSet(input(fixture.values, fixture.problemHash, { maximumWeightedArcOverlapPpm: 0 }));
    expect(strict.alternatives).toHaveLength(1);
    expect(strict.status).toBe("PARTIAL");
  });

  it("rejects unverified candidates before deduplication or ranking", () => {
    const fixture = candidates();
    const invalid = structuredClone(fixture.values[0]!);
    invalid.admitted.verification.status = "INVALID";
    expect(() => buildVerifiedCoverageResultSet(input([invalid], fixture.problemHash, { requestedCount: 1, minimumVerifiedCount: 1, profiles: ["SHORTEST_TOTAL_DISTANCE"] }))).toThrow(/independently VALID/u);
  });

  it("ranks deterministically and derives truthful objective explanation facts", () => {
    const fixture = candidates();
    const first = buildVerifiedCoverageResultSet(input(fixture.values, fixture.problemHash));
    const replay = buildVerifiedCoverageResultSet(input([...fixture.values].reverse(), fixture.problemHash));
    expect(first.resultHash).toBe(replay.resultHash);
    expect(first.alternatives.map((alternative) => alternative.route.routeSignature)).toEqual(replay.alternatives.map((alternative) => alternative.route.routeSignature));
    expect(first.alternatives[0]!.pros[0]).toBe(`Verified distance ${first.alternatives[0]!.route.metrics.distanceMm} mm`);
    expect(first.alternatives[1]!.pros[0]).toBe(`Verified duration ${first.alternatives[1]!.route.metrics.durationMs} ms`);
  });

  it("deep-freezes the result and exposes the explicit termination reason", () => {
    const fixture = candidates();
    const result = buildVerifiedCoverageResultSet(input(fixture.values, fixture.problemHash));
    expect(result.searchTerminatedBy).toBe("PROFILES_COMPLETE");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.alternatives)).toBe(true);
    expect(Object.isFrozen(result.pairwiseSimilarity)).toBe(true);
    expect(() => (result.alternatives as unknown as unknown[]).push({})).toThrow();
  });

  it("publishes domain no-feasible outcomes with independent snapshot hashes", () => {
    const fixture = candidates();
    const request = input([], fixture.problemHash, { requestedCount: 1, minimumVerifiedCount: 1, profiles: ["SHORTEST_TOTAL_DISTANCE"] });
    const result = buildVerifiedCoverageResultSet({
      ...request, searchTerminatedBy: "NO_FEASIBLE_PLAN", noFeasibleReasons: ["ENDPOINT_UNREACHABLE"],
      integrity: { dataSnapshotHash: `sha256:${"4".repeat(64)}`, computeSnapshotHash: `sha256:${"5".repeat(64)}`, contractHash: `sha256:${"6".repeat(64)}` }
    });
    expect(result.status).toBe("NO_FEASIBLE_PLAN");
    expect(result.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "NO_FEASIBLE_RESULT", normalizedStatus: "NO_FEASIBLE_RESULT", reasons: ["ENDPOINT_UNREACHABLE"] }),
      expect.objectContaining({ kind: "SNAPSHOT_INTEGRITY", problemHash: fixture.problemHash })
    ]));
    expect(validateContract("urn:gowm:v0.6:coverage-result-set", result).valid).toBe(true);
  });
});
