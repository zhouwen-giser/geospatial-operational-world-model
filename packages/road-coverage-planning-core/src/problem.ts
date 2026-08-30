import { canonicalSha256, compareUnicodeCodePoints } from "../../platform/contract-runtime/src/index.js";
import { buildRoadServiceObligation, canonicalObligationLedger, obligationSetHash } from "./canonical.js";
import { CoveragePlanningError } from "./errors.js";
import type {
  CoverageObligationSet,
  CoverageProblem,
  DirectedState,
  RoutingSnapshot
} from "./types.js";

export interface CoverageProblemInput {
  routingSnapshot: RoutingSnapshot;
  startState: DirectedState;
  fixedEndState?: DirectedState;
  entryStates?: DirectedState[];
  exitStates?: DirectedState[];
  endpointMode: CoverageProblem["endpointMode"];
  boundaryCrossingPolicy: CoverageProblem["boundaryCrossingPolicy"];
  obligationSet: CoverageObligationSet;
  objective: Record<string, unknown>;
  budgets: CoverageProblem["budgets"];
}

export function buildCanonicalCoverageProblem(input: CoverageProblemInput): CoverageProblem {
  validateProblemInput(input);
  const obligationSet = normalizeObligationSet(input.routingSnapshot, input.obligationSet);
  const canonicalBody = {
    contractVersion: "1.0" as const,
    routingSnapshot: input.routingSnapshot,
    startState: canonicalState(input.startState),
    ...(input.fixedEndState === undefined ? {} : { fixedEndState: canonicalState(input.fixedEndState) }),
    ...(input.entryStates === undefined ? {} : { entryStates: canonicalStates(input.entryStates) }),
    ...(input.exitStates === undefined ? {} : { exitStates: canonicalStates(input.exitStates) }),
    endpointMode: input.endpointMode,
    boundaryCrossingPolicy: input.boundaryCrossingPolicy,
    obligationSet,
    objective: input.objective,
    budgets: input.budgets
  };
  const problemHash = canonicalSha256(canonicalBody);
  return {
    ...canonicalBody,
    problemId: `covp_${problemHash.slice("sha256:".length)}`,
    problemHash
  };
}

export function coverageProblemHash(problem: CoverageProblem): `sha256:${string}` {
  const { problemId: _problemId, problemHash: _problemHash, ...body } = problem;
  return canonicalSha256({
    ...body,
    obligationSet: normalizeObligationSet(problem.routingSnapshot, problem.obligationSet),
    ...(problem.entryStates === undefined ? {} : { entryStates: canonicalStates(problem.entryStates) }),
    ...(problem.exitStates === undefined ? {} : { exitStates: canonicalStates(problem.exitStates) })
  });
}

function normalizeObligationSet(snapshot: RoutingSnapshot, input: CoverageObligationSet): CoverageObligationSet {
  if (canonicalSha256(input.routingSnapshot) !== canonicalSha256(snapshot)) {
    throw new CoveragePlanningError("VERSION_NOT_FOUND", "obligation set and coverage problem pin different RoutingSnapshots");
  }
  const obligations = canonicalObligationLedger(input.obligations).map((obligation) => {
    const rebuilt = buildRoadServiceObligation({
      routingSnapshot: snapshot,
      graphVersion: obligation.graphVersion,
      ...(obligation.edgeKey === undefined ? {} : { edgeKey: obligation.edgeKey }),
      arcKey: obligation.arcKey,
      startFractionPpm: obligation.startFractionPpm,
      endFractionPpm: obligation.endFractionPpm,
      requiredPasses: obligation.requiredPasses,
      selectionPolicyVersion: obligation.selectionPolicyVersion ?? "coverage-selection/1.0",
      ...(obligation.sourceAreaReferenceKey === undefined ? {} : { sourceAreaReferenceKey: obligation.sourceAreaReferenceKey }),
      sourceFeatureReferenceKey: obligation.sourceFeatureReferenceKey
    });
    if (rebuilt.obligationId !== obligation.obligationId || rebuilt.contentHash !== obligation.contentHash) {
      throw new CoveragePlanningError("INVALID_SELECTION_POLICY", `obligation identity mismatch: ${obligation.obligationId}`);
    }
    return rebuilt;
  });
  const ledgerHash = obligationSetHash(obligations);
  return {
    ...input,
    obligationSetId: `obls_${ledgerHash.slice("sha256:".length)}`,
    obligations,
    obligationCount: obligations.length
  };
}

function validateProblemInput(input: CoverageProblemInput): void {
  if (input.obligationSet.obligations.length === 0) {
    throw new CoveragePlanningError("NO_OBLIGATIONS", "canonical problem requires at least one service obligation");
  }
  if (input.endpointMode === "FIXED_END" && input.fixedEndState === undefined) {
    throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "FIXED_END requires fixedEndState");
  }
  if (input.endpointMode !== "FIXED_END" && input.fixedEndState !== undefined) {
    throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "fixedEndState is valid only for FIXED_END");
  }
  const { timeLimitMs, maximumCandidates, maximumMatrixCells } = input.budgets;
  if (!Number.isSafeInteger(timeLimitMs) || timeLimitMs < 100 ||
      !Number.isSafeInteger(maximumCandidates) || maximumCandidates < 1 || maximumCandidates > 64 ||
      !Number.isSafeInteger(maximumMatrixCells) || maximumMatrixCells < 1) {
    throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "coverage problem budgets are invalid");
  }
}

function canonicalStates(states: readonly DirectedState[]): DirectedState[] {
  return [...states].map(canonicalState).sort((left, right) =>
    compareUnicodeCodePoints(left.arcKey, right.arcKey) || left.fractionPpm - right.fractionPpm || compareUnicodeCodePoints(left.direction, right.direction)
  );
}

function canonicalState(state: DirectedState): DirectedState {
  return {
    arcKey: state.arcKey,
    fractionPpm: state.fractionPpm,
    direction: state.direction,
    ...(state.headingMicrodegrees === undefined ? {} : { headingMicrodegrees: state.headingMicrodegrees }),
    ...(state.sourceFeatureReferenceKey === undefined ? {} : { sourceFeatureReferenceKey: state.sourceFeatureReferenceKey })
  };
}
