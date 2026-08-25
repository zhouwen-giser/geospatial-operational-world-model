import { describe, expect, it } from "vitest";

import {
  buildCanonicalCoverageProblem,
  buildRoadServiceObligation,
  obligationSetHash,
  solveOpenDcpp
} from "../../packages/road-coverage-planning-core/src/index.js";
import type { CoverageTraversalArc, DirectedState } from "../../packages/road-coverage-planning-core/src/index.js";

const snapshot = {
  networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "travel-v1", costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}`
} as const;
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" } as const;
const key = (hex: string): string => `arc_${hex.repeat(32)}`;
const arc = (hex: string, fromNodeKey: string, toNodeKey: string, cost: number): CoverageTraversalArc => ({
  graphVersion: snapshot.graphVersion,
  arcKey: key(hex),
  fromNodeKey,
  toNodeKey,
  direction: "FORWARD",
  sourceFeatureReferenceKey: feature,
  metrics: { distanceMm: cost * 1_000, durationMs: cost * 100, riskMicroUnits: cost, energyMwh: cost * 2, combinedCostUnits: cost, turnPenaltyUnits: 0 }
});

function openProblem(graph: readonly CoverageTraversalArc[], startState: DirectedState, fixedEndState: DirectedState) {
  const obligations = graph.map((value) => buildRoadServiceObligation({
    routingSnapshot: snapshot,
    graphVersion: snapshot.graphVersion,
    arcKey: value.arcKey,
    startFractionPpm: 0,
    endFractionPpm: 1_000_000,
    requiredPasses: 1,
    selectionPolicyVersion: "coverage-selection/1.0",
    sourceFeatureReferenceKey: feature
  }));
  const ledgerHash = obligationSetHash(obligations);
  return buildCanonicalCoverageProblem({
    routingSnapshot: snapshot,
    startState,
    fixedEndState,
    endpointMode: "FIXED_END",
    boundaryCrossingPolicy: "FREE",
    obligationSet: {
      schemaVersion: "1.0",
      obligationSetId: `obls_${ledgerHash.slice("sha256:".length)}`,
      routingSnapshot: snapshot,
      selectionMode: "INTERSECTING_COMPLETE_EDGE",
      obligations,
      obligationCount: obligations.length,
      totalRequiredLengthMm: obligations.length * 1_000,
      selectionReceiptHash: `sha256:${"3".repeat(64)}`,
      warnings: []
    },
    objective: { profile: "SHORTEST_TOTAL_DISTANCE" },
    budgets: { timeLimitMs: 10_000, maximumCandidates: 1, maximumMatrixCells: 64 }
  });
}

describe("open directed Chinese Postman solver", () => {
  const graph = [arc("1", "A", "B", 3), arc("2", "B", "C", 5), arc("3", "C", "A", 7)];

  it("repairs the terminal imbalance and ends at a distinct exact fixed state", () => {
    const problem = openProblem(
      graph,
      { arcKey: key("1"), fractionPpm: 0, direction: "FORWARD" },
      { arcKey: key("2"), fractionPpm: 0, direction: "FORWARD" }
    );
    const solved = solveOpenDcpp(problem, graph);

    expect(solved.route.startState).toEqual(problem.startState);
    expect(solved.route.endState).toEqual(problem.fixedEndState);
    expect(solved.route.startState).not.toEqual(solved.route.endState);
    expect(solved.augmentation).toEqual([{ fromNodeKey: "A", toNodeKey: "B", quantity: 1, unitCost: 3, arcKeys: [key("1")] }]);
    expect(solved.diagnostics).toMatchObject({ algorithmFamily: "OPEN_DCPP", imbalanceCount: 2, connectorPathCount: 1 });
    expect(solved.route.segments.at(-1)?.arcKey).toBe(key("1"));
  });

  it("keeps partial start and end states continuous through local access and return segments", () => {
    const problem = openProblem(
      graph,
      { arcKey: key("1"), fractionPpm: 250_000, direction: "FORWARD" },
      { arcKey: key("2"), fractionPpm: 500_000, direction: "FORWARD" }
    );
    const solved = solveOpenDcpp(problem, [...graph].reverse());

    expect(solved.augmentation).toEqual([]);
    expect(solved.route.startState).toEqual(problem.startState);
    expect(solved.route.endState).toEqual(problem.fixedEndState);
    expect(solved.route.segments[0]).toMatchObject({ arcKey: key("1"), startFractionPpm: 250_000, endFractionPpm: 1_000_000, phase: "ACCESS", serviceRole: "ACCESS" });
    expect(solved.route.segments.at(-1)).toMatchObject({ arcKey: key("2"), startFractionPpm: 0, endFractionPpm: 500_000, phase: "RETURN", serviceRole: "RETURN" });
    expect(solved.route.segments.filter((segment) => segment.serviceRole === "SERVICE")).toHaveLength(3);
  });

  it("replays the same route signature independently of input Arc order", () => {
    const problem = openProblem(
      graph,
      { arcKey: key("1"), fractionPpm: 250_000, direction: "FORWARD" },
      { arcKey: key("2"), fractionPpm: 500_000, direction: "FORWARD" }
    );
    expect(solveOpenDcpp(problem, graph).route.routeSignature).toBe(solveOpenDcpp(problem, [...graph].reverse()).route.routeSignature);
  });

  it("fails closed when an Open solver receives a non-FIXED_END problem", () => {
    const fixed = openProblem(
      graph,
      { arcKey: key("1"), fractionPpm: 0, direction: "FORWARD" },
      { arcKey: key("2"), fractionPpm: 0, direction: "FORWARD" }
    );
    const { fixedEndState: _fixedEndState, ...withoutEnd } = fixed;
    const invalid = { ...withoutEnd, endpointMode: "RETURN_TO_START" as const };
    expect(() => solveOpenDcpp(invalid, graph)).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_AVAILABLE" }));
  });
});
