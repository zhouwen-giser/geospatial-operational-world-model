import { describe, expect, it } from "vitest";

import {
  buildCanonicalCoverageProblem,
  buildRoadServiceObligation,
  obligationSetHash,
  solveFixedDirectionRpp
} from "../../packages/road-coverage-planning-core/src/index.js";
import type { CoverageTraversalArc, RoadServiceObligation } from "../../packages/road-coverage-planning-core/src/index.js";

const snapshot = {
  networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}`
} as const;
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" } as const;
const key = (hex: string): string => `arc_${hex.repeat(32)}`;
const edgeKey = (hex: string): string => `edge_${hex.repeat(32)}`;
const arc = (hex: string, fromNodeKey: string, toNodeKey: string, cost: number, direction: "FORWARD" | "REVERSE" = "FORWARD"): CoverageTraversalArc => ({
  graphVersion: snapshot.graphVersion,
  arcKey: key(hex),
  fromNodeKey,
  toNodeKey,
  direction,
  sourceFeatureReferenceKey: feature,
  metrics: { distanceMm: cost * 1_000, durationMs: cost * 100, riskMicroUnits: cost, energyMwh: cost * 2, combinedCostUnits: cost, turnPenaltyUnits: 0 }
});

function obligation(value: CoverageTraversalArc, startFractionPpm = 0, endFractionPpm = 1_000_000, requiredPasses = 1, sourceEdgeKey?: string): RoadServiceObligation {
  return buildRoadServiceObligation({
    routingSnapshot: snapshot,
    graphVersion: snapshot.graphVersion,
    ...(sourceEdgeKey === undefined ? {} : { edgeKey: sourceEdgeKey }),
    arcKey: value.arcKey,
    startFractionPpm,
    endFractionPpm,
    requiredPasses,
    selectionPolicyVersion: "coverage-selection/1.0",
    sourceFeatureReferenceKey: feature
  });
}

function problem(graph: readonly CoverageTraversalArc[], obligations: RoadServiceObligation[], startArc: CoverageTraversalArc, startFractionPpm = 0) {
  const ledgerHash = obligationSetHash(obligations);
  return buildCanonicalCoverageProblem({
    routingSnapshot: snapshot,
    startState: { arcKey: startArc.arcKey, fractionPpm: startFractionPpm, direction: startArc.direction },
    endpointMode: "RETURN_TO_START",
    boundaryCrossingPolicy: "FREE",
    obligationSet: {
      schemaVersion: "1.0", obligationSetId: `obls_${ledgerHash.slice("sha256:".length)}`, routingSnapshot: snapshot,
      selectionMode: "CLIPPED_INSIDE_AREA", obligations, obligationCount: obligations.length,
      totalRequiredLengthMm: obligations.length * 1_000, selectionReceiptHash: `sha256:${"3".repeat(64)}`, warnings: []
    },
    objective: { profile: "LEAST_DEADHEAD" },
    budgets: { timeLimitMs: 10_000, maximumCandidates: 1, maximumMatrixCells: 256 }
  });
}

describe("fixed-direction rural postman solver", () => {
  it("services a partial obligation exactly and connects it through optional full-network transit", () => {
    const forward = arc("1", "A", "B", 100);
    const reverse = arc("2", "B", "A", 10, "REVERSE");
    const input = problem([forward, reverse], [obligation(forward, 250_000, 750_000)], forward, 250_000);
    const solved = solveFixedDirectionRpp(input, [reverse, forward]);

    const service = solved.route.segments.filter((segment) => segment.serviceRole === "SERVICE");
    expect(service).toHaveLength(1);
    expect(service[0]).toMatchObject({ arcKey: forward.arcKey, startFractionPpm: 250_000, endFractionPpm: 750_000 });
    expect(solved.route.segments.filter((segment) => segment.serviceRole === "TRANSIT").map((segment) => segment.arcKey))
      .toEqual([forward.arcKey, reverse.arcKey, forward.arcKey]);
    expect(solved.route.endState).toEqual(input.startState);
  });

  it("connects disconnected required components using optional arcs from E without promoting them to R", () => {
    const first = arc("1", "A", "B", 1);
    const connector = arc("2", "B", "C", 2);
    const second = arc("3", "C", "D", 1);
    const returnArc = arc("4", "D", "A", 2);
    const graph = [first, connector, second, returnArc];
    const input = problem(graph, [obligation(first), obligation(second)], first);
    const solved = solveFixedDirectionRpp(input, graph);

    expect(solved.diagnostics.requiredComponentCount).toBe(2);
    expect(solved.route.segments.map((segment) => [segment.arcKey, segment.serviceRole])).toEqual([
      [first.arcKey, "SERVICE"], [connector.arcKey, "TRANSIT"], [second.arcKey, "SERVICE"], [returnArc.arcKey, "TRANSIT"]
    ]);
    expect(new Set(solved.route.segments.flatMap((segment) => segment.obligationIds ?? []))).toEqual(new Set(input.obligationSet.obligations.map((row) => row.obligationId)));
  });

  it("satisfies repeated passes and labels required-Arc balance copies as duplicate service", () => {
    const forward = arc("1", "A", "B", 1);
    const reverse = arc("2", "B", "A", 1, "REVERSE");
    const sharedEdge = edgeKey("f");
    const input = problem([forward, reverse], [obligation(forward, 0, 1_000_000, 2, sharedEdge), obligation(reverse, 0, 1_000_000, 1, sharedEdge)], forward);
    const solved = solveFixedDirectionRpp(input, [forward, reverse]);

    expect(solved.diagnostics.algorithmFamily).toBe("BOTH_DIRECTIONS_RPP");
    expect(solved.route.segments.filter((segment) => segment.arcKey === forward.arcKey && segment.serviceRole === "SERVICE")).toHaveLength(2);
    expect(solved.route.segments.filter((segment) => segment.arcKey === reverse.arcKey && segment.serviceRole === "SERVICE")).toHaveLength(1);
    expect(solved.route.segments.filter((segment) => segment.arcKey === reverse.arcKey && segment.serviceRole === "DUPLICATE_SERVICE")).toHaveLength(1);
  });

  it("produces the same route signature for any E input ordering", () => {
    const first = arc("1", "A", "B", 1), connector = arc("2", "B", "C", 2), second = arc("3", "C", "D", 1), returnArc = arc("4", "D", "A", 2);
    const graph = [first, connector, second, returnArc];
    const input = problem(graph, [obligation(first), obligation(second)], first);
    expect(solveFixedDirectionRpp(input, graph).route.routeSignature).toBe(solveFixedDirectionRpp(input, [...graph].reverse()).route.routeSignature);
  });
});
