import { describe, expect, it } from "vitest";

import { validateContract } from "../../packages/platform/contract-runtime/src/index.js";
import {
  buildCanonicalCoverageProblem,
  buildRoadServiceObligation,
  coverageProblemHash,
  obligationSetHash
} from "../../packages/road-coverage-planning-core/src/index.js";
import type {
  CoverageObligationSet,
  CoverageProblemInput,
  DirectedState,
  RoutingSnapshot
} from "../../packages/road-coverage-planning-core/src/index.js";

const snapshot: RoutingSnapshot = {
  networkDatasetVersion: "dataset-v1",
  graphVersion: "graph-v1",
  travelProfileVersion: "travel-v1",
  costProfileVersion: "cost-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`,
  costContentHash: `sha256:${"2".repeat(64)}`
};
const feature = { namespace: "gowm" as const, kind: "LAYER_FEATURE" as const, id: `wrf_${"a".repeat(32)}`, version: "dataset-v1" };

function state(hex: string, fractionPpm: number): DirectedState {
  return { arcKey: `arc_${hex.repeat(64)}`, fractionPpm, direction: "FORWARD" };
}

function obligation(hex: string, startFractionPpm: number, endFractionPpm: number, pinnedSnapshot = snapshot) {
  return buildRoadServiceObligation({
    routingSnapshot: pinnedSnapshot,
    graphVersion: "graph-v1",
    edgeKey: `ed_${hex.repeat(64)}`,
    arcKey: `arc_${hex.repeat(64)}`,
    startFractionPpm,
    endFractionPpm,
    requiredPasses: 1,
    selectionPolicyVersion: "coverage-selection/1.0",
    sourceFeatureReferenceKey: feature
  });
}

function obligationSet(reverse = false, pinnedSnapshot = snapshot): CoverageObligationSet {
  const obligations = [obligation("a", 0, 400_000, pinnedSnapshot), obligation("b", 600_000, 1_000_000, pinnedSnapshot)];
  if (reverse) obligations.reverse();
  const hash = obligationSetHash(obligations);
  return {
    schemaVersion: "1.0",
    obligationSetId: `obls_${hash.slice("sha256:".length)}`,
    routingSnapshot: pinnedSnapshot,
    selectionMode: "CLIPPED_INSIDE_AREA",
    obligations,
    obligationCount: obligations.length,
    totalRequiredLengthMm: 800_000,
    selectionReceiptHash: `sha256:${"3".repeat(64)}`,
    warnings: []
  };
}

function input(overrides: Partial<CoverageProblemInput> = {}): CoverageProblemInput {
  return {
    routingSnapshot: snapshot,
    startState: state("a", 0),
    entryStates: [state("b", 0), state("a", 0)],
    exitStates: [state("b", 1_000_000), state("a", 1_000_000)],
    endpointMode: "RETURN_TO_START",
    boundaryCrossingPolicy: "FREE",
    obligationSet: obligationSet(),
    objective: { profile: "LEAST_DEADHEAD", weights: { duration: 0, distance: 1_000_000 } },
    budgets: { timeLimitMs: 10_000, maximumCandidates: 8, maximumMatrixCells: 1_024 },
    ...overrides
  };
}

describe("canonical coverage problem and ledger", () => {
  it("builds a frozen-contract-valid canonical problem", () => {
    const problem = buildCanonicalCoverageProblem(input());
    expect(validateContract("urn:gowm:v0.6:coverage-problem", problem)).toEqual({ valid: true, issues: [] });
    expect(problem.problemHash).toBe(coverageProblemHash(problem));
    expect(problem.problemId).toBe(`covp_${problem.problemHash.slice("sha256:".length)}`);
  });

  it("keeps problem hash stable across obligation and candidate-state ordering", () => {
    const left = buildCanonicalCoverageProblem(input());
    const right = buildCanonicalCoverageProblem(input({
      obligationSet: obligationSet(true),
      entryStates: [...input().entryStates!].reverse(),
      exitStates: [...input().exitStates!].reverse()
    }));
    expect(right).toEqual(left);
  });

  it("keeps canonical object-key order irrelevant", () => {
    const left = buildCanonicalCoverageProblem(input());
    const right = buildCanonicalCoverageProblem(input({
      objective: { weights: { distance: 1_000_000, duration: 0 }, profile: "LEAST_DEADHEAD" },
      budgets: { maximumMatrixCells: 1_024, maximumCandidates: 8, timeLimitMs: 10_000 }
    }));
    expect(right.problemHash).toBe(left.problemHash);
  });

  it("changes problem identity when snapshot, obligations, endpoint, objective, or budget changes", () => {
    const baseline = buildCanonicalCoverageProblem(input()).problemHash;
    const newerSnapshot = { ...snapshot, sourceWorldVersion: 2 };
    const variants = [
      input({ routingSnapshot: newerSnapshot, obligationSet: obligationSet(false, newerSnapshot) }),
      input({ obligationSet: { ...obligationSet(), selectionReceiptHash: `sha256:${"4".repeat(64)}` } }),
      input({ endpointMode: "FIXED_END", fixedEndState: state("b", 500_000) }),
      input({ objective: { profile: "FASTEST_COMPLETION" } }),
      input({ budgets: { timeLimitMs: 20_000, maximumCandidates: 8, maximumMatrixCells: 1_024 } })
    ];
    expect(variants.map((variant) => buildCanonicalCoverageProblem(variant).problemHash))
      .toSatisfy((hashes: string[]) => hashes.every((hash) => hash !== baseline));
  });

  it("rejects a tampered obligation identity before problem hashing", () => {
    const tampered = obligationSet();
    tampered.obligations[0] = { ...tampered.obligations[0]!, endFractionPpm: 500_000 };
    expect(() => buildCanonicalCoverageProblem(input({ obligationSet: tampered })))
      .toThrow(/obligation identity mismatch/u);
  });

  it("rejects snapshot drift, empty ledgers, and invalid endpoint/budget conditions", () => {
    expect(() => buildCanonicalCoverageProblem(input({
      obligationSet: { ...obligationSet(), routingSnapshot: { ...snapshot, graphVersion: "other" } }
    }))).toThrow(/different RoutingSnapshots/u);
    expect(() => buildCanonicalCoverageProblem(input({
      obligationSet: { ...obligationSet(), obligations: [], obligationCount: 0 }
    }))).toThrow(/at least one/u);
    expect(() => buildCanonicalCoverageProblem(input({ endpointMode: "FIXED_END" }))).toThrow(/fixedEndState/u);
    expect(() => buildCanonicalCoverageProblem(input({
      budgets: { timeLimitMs: 99, maximumCandidates: 1, maximumMatrixCells: 1 }
    }))).toThrow(/budgets/u);
  });
});
