import { canonicalSha256, compareUnicodeCodePoints } from "../../platform/contract-runtime/src/index.js";
import { CoveragePlanningError } from "./errors.js";
import type {
  CoverageEndpointPolicy,
  DirectedState,
  GeoJsonArea,
  NetworkLocation,
  RoutingSnapshot
} from "./types.js";

export interface EndpointCandidate {
  state: DirectedState;
  distanceMm: number;
  evidence: Record<string, unknown>;
}

export interface CoverageEndpointRepository {
  resolveLocation(
    location: NetworkLocation,
    routingSnapshot: RoutingSnapshot,
    dataScopeKey: string,
    datasetScopeKey: string,
    snapToleranceMm: number,
    maximumCandidates: number
  ): Promise<EndpointCandidate[]>;
  boundaryCandidates(
    area: GeoJsonArea,
    routingSnapshot: RoutingSnapshot,
    dataScopeKey: string,
    datasetScopeKey: string,
    kind: "ENTRY" | "EXIT",
    maximumCandidates: number
  ): Promise<EndpointCandidate[]>;
}

export interface ResolveCoverageEndpointsInput {
  dataScopeKey: string;
  datasetScopeKey: string;
  routingSnapshot: RoutingSnapshot;
  area: GeoJsonArea;
  policy: CoverageEndpointPolicy;
}

export interface ResolvedCoverageEndpoints {
  startState: DirectedState;
  fixedEndState?: DirectedState;
  entryStates: DirectedState[];
  exitStates: DirectedState[];
  endpointMode: CoverageEndpointPolicy["endpointMode"];
  boundaryCrossingPolicy: CoverageEndpointPolicy["boundaryCrossingPolicy"];
  resolutionReceiptHash: `sha256:${string}`;
  evidence: Record<string, unknown>[];
}

export interface BoundaryEvent {
  sequence: number;
  kind: "ENTRY" | "EXIT";
  state: DirectedState;
}

export function directedStateKey(state: DirectedState): string {
  return `${state.arcKey}:${state.fractionPpm}:${state.direction}`;
}

export async function resolveCoverageEndpoints(
  repository: CoverageEndpointRepository,
  input: ResolveCoverageEndpointsInput
): Promise<ResolvedCoverageEndpoints> {
  const start = await resolveUnique(repository, input.policy.start, input, "start");
  const fixedEnd = input.policy.fixedEnd === undefined
    ? undefined
    : await resolveUnique(repository, input.policy.fixedEnd, input, "fixed end");
  if (input.policy.endpointMode === "FIXED_END" && fixedEnd === undefined) {
    throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "FIXED_END requires a resolvable fixed end");
  }
  if (input.policy.endpointMode !== "FIXED_END" && fixedEnd !== undefined) {
    throw new CoveragePlanningError("INVALID_SELECTION_POLICY", "fixed end is valid only for FIXED_END");
  }
  const entry = await resolveBoundary(repository, input, "ENTRY", input.policy.entry);
  const exit = await resolveBoundary(repository, input, "EXIT", input.policy.exit);
  const evidence = [start.evidence, ...(fixedEnd === undefined ? [] : [fixedEnd.evidence]),
    ...entry.map((candidate) => candidate.evidence), ...exit.map((candidate) => candidate.evidence)];
  const receipt = {
    routingSnapshot: input.routingSnapshot,
    startState: start.state,
    ...(fixedEnd === undefined ? {} : { fixedEndState: fixedEnd.state }),
    entryStates: entry.map((candidate) => candidate.state),
    exitStates: exit.map((candidate) => candidate.state),
    endpointMode: input.policy.endpointMode,
    boundaryCrossingPolicy: input.policy.boundaryCrossingPolicy,
    snapToleranceMm: input.policy.snapToleranceMm,
    evidence
  };
  return {
    startState: start.state,
    ...(fixedEnd === undefined ? {} : { fixedEndState: fixedEnd.state }),
    entryStates: canonicalCandidates(entry).map((candidate) => candidate.state),
    exitStates: canonicalCandidates(exit).map((candidate) => candidate.state),
    endpointMode: input.policy.endpointMode,
    boundaryCrossingPolicy: input.policy.boundaryCrossingPolicy,
    resolutionReceiptHash: canonicalSha256(receipt),
    evidence
  };
}

export function verifyEndpointAndBoundaryPolicy(
  resolved: ResolvedCoverageEndpoints,
  routeStart: DirectedState,
  routeEnd: DirectedState,
  boundaryEvents: readonly BoundaryEvent[]
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  if (directedStateKey(routeStart) !== directedStateKey(resolved.startState)) violations.push("START_STATE_MISMATCH");
  if (resolved.endpointMode === "RETURN_TO_START" && directedStateKey(routeEnd) !== directedStateKey(resolved.startState)) {
    violations.push("RETURN_TO_START_MISMATCH");
  }
  if (resolved.endpointMode === "FIXED_END" &&
      (resolved.fixedEndState === undefined || directedStateKey(routeEnd) !== directedStateKey(resolved.fixedEndState))) {
    violations.push("FIXED_END_MISMATCH");
  }
  const ordered = [...boundaryEvents].sort((left, right) => left.sequence - right.sequence);
  const entries = ordered.filter((event) => event.kind === "ENTRY");
  const exits = ordered.filter((event) => event.kind === "EXIT");
  if (resolved.endpointMode === "LAST_AREA_EXIT") {
    const lastExit = exits.at(-1);
    if (!lastExit || directedStateKey(routeEnd) !== directedStateKey(lastExit.state)) violations.push("LAST_AREA_EXIT_MISMATCH");
  }
  if (resolved.boundaryCrossingPolicy === "FIRST_ENTRY_ONLY" && entries.length !== 1) {
    violations.push("FIRST_ENTRY_ONLY_VIOLATION");
  }
  if (resolved.boundaryCrossingPolicy === "ENTRY_SET_ONLY") {
    const allowed = new Set(resolved.entryStates.map(directedStateKey));
    if (entries.some((event) => !allowed.has(directedStateKey(event.state)))) violations.push("ENTRY_SET_ONLY_VIOLATION");
  }
  if (resolved.boundaryCrossingPolicy === "NO_REENTRY") {
    const firstExit = ordered.findIndex((event) => event.kind === "EXIT");
    if (firstExit >= 0 && ordered.slice(firstExit + 1).some((event) => event.kind === "ENTRY")) {
      violations.push("NO_REENTRY_VIOLATION");
    }
  }
  return { valid: violations.length === 0, violations };
}

async function resolveUnique(
  repository: CoverageEndpointRepository,
  location: NetworkLocation,
  input: ResolveCoverageEndpointsInput,
  label: string
): Promise<EndpointCandidate> {
  const candidates = canonicalCandidates(await repository.resolveLocation(
    location,
    input.routingSnapshot,
    input.dataScopeKey,
    input.datasetScopeKey,
    input.policy.snapToleranceMm,
    2
  )).filter((candidate) => candidate.distanceMm <= input.policy.snapToleranceMm);
  if (candidates.length === 0) throw new CoveragePlanningError("UNREACHABLE", `${label} has no legal directed network state`);
  const first = candidates[0]!;
  const second = candidates[1];
  if (second && second.distanceMm === first.distanceMm && directedStateKey(second.state) !== directedStateKey(first.state)) {
    throw new CoveragePlanningError("AMBIGUOUS_LOCATION", `${label} resolves to multiple equal-score directed states`);
  }
  return first;
}

async function resolveBoundary(
  repository: CoverageEndpointRepository,
  input: ResolveCoverageEndpointsInput,
  kind: "ENTRY" | "EXIT",
  policy: CoverageEndpointPolicy["entry"]
): Promise<EndpointCandidate[]> {
  const maximum = policy.maximumCandidates ?? 8;
  let candidates: EndpointCandidate[];
  if (policy.mode === "AUTO") {
    candidates = await repository.boundaryCandidates(
      input.area, input.routingSnapshot, input.dataScopeKey, input.datasetScopeKey, kind, maximum + 1
    );
  } else {
    const states = policy.states ?? [];
    if (policy.mode === "FIXED" && states.length !== 1) {
      throw new CoveragePlanningError("INVALID_SELECTION_POLICY", `${kind} FIXED mode requires exactly one state`);
    }
    candidates = [];
    for (const state of states) {
      const resolved = await repository.resolveLocation(
        state, input.routingSnapshot, input.dataScopeKey, input.datasetScopeKey, 0, 1
      );
      if (resolved.length !== 1 || directedStateKey(resolved[0]!.state) !== directedStateKey(state)) {
        throw new CoveragePlanningError("UNREACHABLE", `${kind} supplied state is unavailable in the pinned graph`);
      }
      candidates.push(resolved[0]!);
    }
  }
  const canonical = canonicalCandidates(candidates);
  if (canonical.length > maximum) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", `${kind} boundary candidate limit exceeded`);
  if (canonical.length === 0 && policy.mode !== "AUTO") throw new CoveragePlanningError("UNREACHABLE", `${kind} boundary set is empty`);
  return canonical;
}

function canonicalCandidates(candidates: readonly EndpointCandidate[]): EndpointCandidate[] {
  return [...new Map(candidates.map((candidate) => [directedStateKey(candidate.state), candidate])).values()]
    .sort((left, right) => left.distanceMm - right.distanceMm || compareUnicodeCodePoints(directedStateKey(left.state), directedStateKey(right.state)));
}
