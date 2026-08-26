import { describe, expect, it } from "vitest";

import {
  buildCanonicalCoverageProblem,
  buildRoadServiceObligation,
  obligationSetHash,
  solveStrictCoverageRoute,
  weightedObjectiveValue
} from "../../packages/road-coverage-planning-core/src/index.js";
import type {
  CoverageTraversalArc,
  CoverageTurnRule,
  FixedMetrics,
  RoadServiceObligation,
  StrictCoverageSolverOptions
} from "../../packages/road-coverage-planning-core/src/index.js";

const snapshot = {
  networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}`
} as const;
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" } as const;
const key = (hex: string): string => `arc_${hex.repeat(32)}`;
const fixed = (distanceMm: number, durationMs = distanceMm, riskMicroUnits = distanceMm, energyMwh = distanceMm, combinedCostUnits = distanceMm): FixedMetrics => ({ distanceMm, durationMs, riskMicroUnits, energyMwh, combinedCostUnits, turnPenaltyUnits: 0 });
const arc = (hex: string, fromNodeKey: string, toNodeKey: string, metrics: FixedMetrics, extras: Partial<CoverageTraversalArc> = {}): CoverageTraversalArc => ({ graphVersion: snapshot.graphVersion, arcKey: key(hex), fromNodeKey, toNodeKey, direction: "FORWARD", sourceFeatureReferenceKey: feature, metrics, ...extras });
const obligation = (value: CoverageTraversalArc, passes = 1): RoadServiceObligation => buildRoadServiceObligation({ routingSnapshot: snapshot, graphVersion: snapshot.graphVersion, arcKey: value.arcKey, startFractionPpm: 0, endFractionPpm: 1_000_000, requiredPasses: passes, selectionPolicyVersion: "coverage-selection/1.0", sourceFeatureReferenceKey: feature });

function problem(start: CoverageTraversalArc, obligations: RoadServiceObligation[], maximumMatrixCells = 256) {
  const hash = obligationSetHash(obligations);
  return buildCanonicalCoverageProblem({
    routingSnapshot: snapshot,
    startState: { arcKey: start.arcKey, fractionPpm: 1_000_000, direction: start.direction },
    endpointMode: "RETURN_TO_START",
    boundaryCrossingPolicy: "FREE",
    obligationSet: { schemaVersion: "1.0", obligationSetId: `obls_${hash.slice("sha256:".length)}`, routingSnapshot: snapshot, selectionMode: "MANUAL_OBLIGATIONS", obligations, obligationCount: obligations.length, totalRequiredLengthMm: obligations.length, selectionReceiptHash: `sha256:${"3".repeat(64)}`, warnings: [] },
    objective: { profile: "STRICT_TEST" },
    budgets: { timeLimitMs: 10_000, maximumCandidates: 16, maximumMatrixCells }
  });
}

const options = (overrides: Partial<StrictCoverageSolverOptions> = {}): StrictCoverageSolverOptions => ({ objective: "SHORTEST_DISTANCE", travelPolicy: { profileKey: "UGV/1.0" }, routeCount: 1, serviceMode: "FIXED_DIRECTION", seed: 7, ...overrides });

function turnFixture() {
  const start = arc("1", "X", "A", fixed(1));
  const direct = arc("2", "A", "D", fixed(5));
  const first = arc("3", "A", "C", fixed(1));
  const second = arc("4", "C", "D", fixed(1));
  const service = arc("5", "D", "E", fixed(1));
  const back = arc("6", "E", "A", fixed(1));
  const graph = [start, direct, first, second, service, back];
  return { start, direct, first, second, service, back, graph, problem: problem(start, [obligation(service)]) };
}

describe("strict turn-aware coverage routing", () => {
  it("never uses a forbidden pairwise turn and enforces ALLOWED_ONLY semantics", () => {
    const fixture = turnFixture();
    const forbidden: CoverageTurnRule = { ruleKey: "forbid-direct", arcSequence: [fixture.start.arcKey, fixture.direct.arcKey], ruleType: "FORBIDDEN" };
    const solved = solveStrictCoverageRoute(fixture.problem, fixture.graph, options({ turnRules: [forbidden] }));
    expect(solved.route.segments.map((segment) => segment.arcKey)).not.toContain(fixture.direct.arcKey);
    expect(solved.route.segments.map((segment) => segment.arcKey)).toEqual([fixture.first.arcKey, fixture.second.arcKey, fixture.service.arcKey, fixture.back.arcKey]);

    const only: CoverageTurnRule = { ruleKey: "only-first", arcSequence: [fixture.start.arcKey, fixture.first.arcKey], ruleType: "ALLOWED_ONLY" };
    expect(solveStrictCoverageRoute(fixture.problem, fixture.graph, options({ turnRules: [only] })).route.segments.map((segment) => segment.arcKey))
      .toEqual([fixture.first.arcKey, fixture.second.arcKey, fixture.service.arcKey, fixture.back.arcKey]);
  });

  it("carries multi-edge automaton context from a connector into the service boundary", () => {
    const fixture = turnFixture();
    const sequence: CoverageTurnRule = { ruleKey: "forbid-sequence", arcSequence: [fixture.first.arcKey, fixture.second.arcKey, fixture.service.arcKey], ruleType: "FORBIDDEN" };
    const solved = solveStrictCoverageRoute(fixture.problem, fixture.graph, options({ turnRules: [sequence] }));
    const collapsed = solved.route.segments.map((segment) => segment.arcKey).filter((value, index, rows) => index === 0 || value !== rows[index - 1]);
    expect(collapsed.join(">")).not.toContain([fixture.first.arcKey, fixture.second.arcKey, fixture.service.arcKey].join(">"));
    expect(collapsed).toEqual([fixture.direct.arcKey, fixture.service.arcKey, fixture.back.arcKey]);
    expect(solved.diagnostics.resourceMetrics).toMatchObject({ strictTurnStateSpace: true });
  });

  it("honors closure, speed, and travel-profile legality without changing distance", () => {
    const fixture = turnFixture();
    const baselineService = { ...fixture.service, roadClass: "LOCAL", surface: "PAVED", accessMask: 3, speedMmPerS: 1_000, metrics: fixed(10_000, 10_000, 4, 5, 10_000) };
    const baselineProblem = problem(fixture.start, [obligation(baselineService)]);
    const baselineGraph = fixture.graph.map((value) => value.arcKey === fixture.service.arcKey ? baselineService : value);
    const slowed = { ...baselineService, speedOverrideMmPerS: 500 };
    const slowedGraph = baselineGraph.map((value) => value.arcKey === fixture.service.arcKey ? slowed : value);
    const profile = options({ objective: "FASTEST", travelPolicy: { profileKey: "UGV/1.0", allowedRoadClasses: ["LOCAL"], allowedSurfaces: ["PAVED"], requiredAccessMask: 1 } });
    const eligibleGraph = baselineGraph.map((value) => ({ ...value, roadClass: value.roadClass ?? "LOCAL", surface: value.surface ?? "PAVED", accessMask: value.accessMask ?? 3 }));
    const eligibleSlowed = slowedGraph.map((value) => ({ ...value, roadClass: value.roadClass ?? "LOCAL", surface: value.surface ?? "PAVED", accessMask: value.accessMask ?? 3 }));
    const normalService = solveStrictCoverageRoute(baselineProblem, eligibleGraph, profile).route.segments.find((segment) => segment.serviceRole === "SERVICE")!;
    const slowService = solveStrictCoverageRoute(baselineProblem, eligibleSlowed, profile).route.segments.find((segment) => segment.serviceRole === "SERVICE")!;
    expect(slowService.metrics.distanceMm).toBe(normalService.metrics.distanceMm);
    expect(slowService.metrics.durationMs).toBe(normalService.metrics.durationMs * 2);
    expect(() => solveStrictCoverageRoute(baselineProblem, eligibleGraph.map((value) => value.arcKey === fixture.service.arcKey ? { ...value, traversalAllowed: false } : value), profile)).toThrowError(expect.objectContaining({ code: "NO_FEASIBLE_PLAN" }));
    expect(() => solveStrictCoverageRoute(baselineProblem, eligibleGraph, options({ travelPolicy: { profileKey: "UGV/1.0", allowedRoadClasses: ["HIGHWAY"] } }))).toThrowError(expect.objectContaining({ code: "NO_FEASIBLE_PLAN" }));
  });

  it("selects distance, time, and risk connector alternatives using safe fixed metrics", () => {
    const start = arc("1", "X", "A", fixed(1));
    const short = arc("2", "A", "D", fixed(10, 100, 100, 20, 50));
    const fast1 = arc("3", "A", "C", fixed(10, 10, 50, 20, 40));
    const fast2 = arc("4", "C", "D", fixed(10, 10, 50, 20, 40));
    const risk1 = arc("5", "A", "F", fixed(30, 30, 1, 20, 30));
    const risk2 = arc("6", "F", "D", fixed(30, 30, 1, 20, 30));
    const service = arc("7", "D", "E", fixed(1));
    const back = arc("8", "E", "A", fixed(1));
    const graph = [start, short, fast1, fast2, risk1, risk2, service, back];
    const input = problem(start, [obligation(service)]);
    const connector = (objective: StrictCoverageSolverOptions["objective"]) => solveStrictCoverageRoute(input, graph, options({ objective })).route.segments.filter((segment) => segment.serviceRole !== "SERVICE" && segment.arcKey !== back.arcKey).map((segment) => segment.arcKey);
    expect(connector("SHORTEST_DISTANCE")).toEqual([short.arcKey]);
    expect(connector("FASTEST")).toEqual([fast1.arcKey, fast2.arcKey]);
    expect(connector("LOWEST_RISK")).toEqual([risk1.arcKey, risk2.arcKey]);
    const weightedConnector = (weights: NonNullable<StrictCoverageSolverOptions["objectiveWeights"]>) => solveStrictCoverageRoute(input, graph, options({ objective: "WEIGHTED", objectiveWeights: weights })).route.segments.filter((segment) => segment.serviceRole !== "SERVICE" && segment.arcKey !== back.arcKey).map((segment) => segment.arcKey);
    expect(weightedConnector({ distance: 1_000_000, duration: 0, risk: 0, deadhead: 0 })).toEqual([short.arcKey]);
    expect(weightedConnector({ distance: 0, duration: 1_000_000, risk: 0, deadhead: 0 })).toEqual([fast1.arcKey, fast2.arcKey]);
    const solved = solveStrictCoverageRoute(input, graph, options({ objective: "SHORTEST_DISTANCE" }));
    expect(solved.route.metrics.distanceMm).toBe(solved.route.segments.reduce((sum, segment) => sum + segment.metrics.distanceMm, 0));
    expect(solved.route.metrics.energyMwh).toBe(solved.route.segments.reduce((sum, segment) => sum + segment.metrics.energyMwh, 0));
  });

  it("is deterministic for the same frozen problem/version/seed", () => {
    const fixture = turnFixture();
    const first = solveStrictCoverageRoute(fixture.problem, fixture.graph, options());
    const second = solveStrictCoverageRoute(fixture.problem, [...fixture.graph].reverse(), options());
    expect(first.route.routeSignature).toBe(second.route.routeSignature);
    expect(first.route.segments).toEqual(second.route.segments);
  });

  it("fails safely on matrix budget and fixed-point overflow", () => {
    const fixture = turnFixture();
    expect(() => solveStrictCoverageRoute(problem(fixture.start, [obligation(fixture.service)], 1), fixture.graph, options())).toThrowError(expect.objectContaining({ code: "RESOURCE_EXHAUSTED" }));
    const hugeService = arc("7", "D", "E", fixed(Number.MAX_SAFE_INTEGER, 1, 1, 1, Number.MAX_SAFE_INTEGER));
    const hugeBack = arc("8", "E", "A", fixed(Number.MAX_SAFE_INTEGER, 1, 1, 1, Number.MAX_SAFE_INTEGER));
    const input = problem(fixture.start, [obligation(hugeService)]);
    expect(() => solveStrictCoverageRoute(input, [fixture.start, fixture.direct, hugeService, hugeBack], options({ objective: "BALANCED" }))).toThrowError(expect.objectContaining({ code: "RESOURCE_EXHAUSTED" }));
    expect(() => weightedObjectiveValue(fixed(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0), { distance: 1_000_000, duration: 1_000_000, risk: 1_000_000, energy: 1_000_000, deadhead: 1_000_000 }, false)).toThrowError(expect.objectContaining({ code: "RESOURCE_EXHAUSTED" }));
  });

  it("rejects multi-route and either-direction requests before search", () => {
    const fixture = turnFixture();
    expect(() => solveStrictCoverageRoute(fixture.problem, fixture.graph, options({ routeCount: 2 }))).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_AVAILABLE" }));
    expect(() => solveStrictCoverageRoute(fixture.problem, fixture.graph, options({ serviceMode: "EITHER_DIRECTION" }))).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_AVAILABLE" }));
  });
});
