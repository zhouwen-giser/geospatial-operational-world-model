import { describe, expect, it } from "vitest";

import {
  buildCanonicalCoverageProblem,
  buildRoadServiceObligation,
  obligationSetHash,
  solveClosedDcpp
} from "../../packages/road-coverage-planning-core/src/index.js";
import type {
  CoverageProblem,
  CoverageTraversalArc,
  RoadServiceObligation
} from "../../packages/road-coverage-planning-core/src/index.js";

const snapshot = {
  networkDatasetVersion: "dataset-v1",
  graphVersion: "graph-v1",
  travelProfileVersion: "travel-v1",
  costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`,
  costContentHash: `sha256:${"2".repeat(64)}`
} as const;
const feature = { namespace: "gowm", kind: "LAYER_FEATURE", id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" } as const;
const key = (hex: string): string => `arc_${hex.repeat(32)}`;

function arc(hex: string, fromNodeKey: string, toNodeKey: string, combinedCostUnits: number): CoverageTraversalArc {
  return {
    graphVersion: snapshot.graphVersion,
    arcKey: key(hex),
    fromNodeKey,
    toNodeKey,
    direction: "FORWARD",
    sourceFeatureReferenceKey: feature,
    metrics: {
      distanceMm: combinedCostUnits * 1_000,
      durationMs: combinedCostUnits * 100,
      riskMicroUnits: combinedCostUnits,
      energyMwh: combinedCostUnits * 2,
      combinedCostUnits,
      turnPenaltyUnits: 0
    }
  };
}

function problem(arcs: readonly CoverageTraversalArc[], passes: Readonly<Record<string, number>> = {}, startFractionPpm = 250_000): CoverageProblem {
  const obligations = arcs.map((value) => buildRoadServiceObligation({
    routingSnapshot: snapshot,
    graphVersion: snapshot.graphVersion,
    arcKey: value.arcKey,
    startFractionPpm: 0,
    endFractionPpm: 1_000_000,
    requiredPasses: passes[value.arcKey] ?? 1,
    selectionPolicyVersion: "coverage-selection/1.0",
    sourceFeatureReferenceKey: feature
  }));
  return problemFromObligations(arcs[0]!, obligations, startFractionPpm);
}

function problemFromObligations(startArc: CoverageTraversalArc, obligations: RoadServiceObligation[], startFractionPpm: number): CoverageProblem {
  const ledgerHash = obligationSetHash(obligations);
  return buildCanonicalCoverageProblem({
    routingSnapshot: snapshot,
    startState: { arcKey: startArc.arcKey, fractionPpm: startFractionPpm, direction: startArc.direction },
    endpointMode: "RETURN_TO_START",
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

describe("closed directed Chinese Postman solver", () => {
  it("returns an exact Euler coverage circuit for an already balanced required graph", () => {
    const graph = [arc("1", "A", "B", 3), arc("2", "B", "C", 5), arc("3", "C", "A", 7)];
    const input = problem(graph);
    const solved = solveClosedDcpp(input, graph);

    expect(solved.augmentation).toEqual([]);
    expect(solved.diagnostics).toMatchObject({ algorithmFamily: "CLOSED_DCPP", exactness: "EXACT", imbalanceCount: 0 });
    expect(solved.route.startState).toEqual(input.startState);
    expect(solved.route.endState).toEqual(input.startState);
    expect(solved.route.segments.map((segment) => segment.arcKey)).toEqual([key("1"), key("2"), key("3"), key("1")]);
    expect(solved.route.metrics.combinedCostUnits).toBe(15);
    expect(new Set(solved.route.segments.flatMap((segment) => segment.obligationIds ?? [])).size).toBe(3);
  });

  it("uses the globally cheapest directed connector to balance an imbalanced required multigraph", () => {
    const graph = [
      arc("1", "A", "B", 50),
      arc("2", "B", "A", 10),
      arc("3", "B", "C", 1),
      arc("4", "C", "A", 1),
      arc("5", "A", "B", 1)
    ];
    const input = problem(graph, { [key("1")]: 2 });
    const solved = solveClosedDcpp(input, graph);

    expect(solved.augmentation).toEqual([{ fromNodeKey: "B", toNodeKey: "A", quantity: 1, unitCost: 2, arcKeys: [key("3"), key("4")] }]);
    expect(solved.diagnostics).toMatchObject({ imbalanceCount: 2, connectorPathCount: 1 });
    expect(solved.route.segments.filter((segment) => segment.serviceRole === "DUPLICATE_SERVICE").map((segment) => segment.arcKey).sort())
      .toEqual([key("3"), key("4")]);
    expect(solved.route.endState).toEqual(input.startState);
  });

  it("is deterministic and closes at the exact partial directed start state", () => {
    const graph = [arc("1", "A", "B", 3), arc("2", "B", "C", 5), arc("3", "C", "A", 7)];
    const input = problem(graph, {}, 345_678);
    const first = solveClosedDcpp(input, [...graph].reverse());
    const second = solveClosedDcpp(input, graph);

    expect(first.route.routeSignature).toBe(second.route.routeSignature);
    expect(first.route.startState).toEqual({ arcKey: key("1"), fractionPpm: 345_678, direction: "FORWARD" });
    expect(first.route.endState).toEqual(first.route.startState);
    expect(first.route.segments[0]).toMatchObject({ arcKey: key("1"), startFractionPpm: 345_678, endFractionPpm: 1_000_000 });
    expect(first.route.segments.at(-1)).toMatchObject({ arcKey: key("1"), startFractionPpm: 0, endFractionPpm: 345_678 });
  });

  it("fails closed instead of treating a partial RPP obligation as closed DCPP", () => {
    const graph = [arc("1", "A", "B", 3), arc("2", "B", "A", 5)];
    const obligations = graph.map((value, index) => buildRoadServiceObligation({
      routingSnapshot: snapshot,
      graphVersion: snapshot.graphVersion,
      arcKey: value.arcKey,
      startFractionPpm: index === 0 ? 100_000 : 0,
      endFractionPpm: index === 0 ? 900_000 : 1_000_000,
      requiredPasses: 1,
      selectionPolicyVersion: "coverage-selection/1.0",
      sourceFeatureReferenceKey: feature
    }));
    const input = problemFromObligations(graph[0]!, obligations, 0);
    expect(() => solveClosedDcpp(input, graph)).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_AVAILABLE" }));
  });
});
