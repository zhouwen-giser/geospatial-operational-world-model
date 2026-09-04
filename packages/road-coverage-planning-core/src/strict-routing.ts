import { canonicalSha256, compareUnicodeCodePoints } from "../../platform/contract-runtime/src/index.js";
import { CoveragePlanningError } from "./errors.js";
import type {
  ClosedDcppSolution,
  CoverageProblem,
  CoverageObjectiveWeights,
  CoverageRoutingObjective,
  CoverageTraversalArc,
  CoverageTurnRule,
  FixedMetrics,
  RoadServiceObligation,
  StrictCoverageSolverOptions
} from "./types.js";

const WHOLE = 1_000_000;
const ZERO: FixedMetrics = { distanceMm: 0, durationMs: 0, riskMicroUnits: 0, energyMwh: 0, combinedCostUnits: 0, turnPenaltyUnits: 0 };

interface StrictStep {
  id: string;
  graphVersion: string;
  arcKey: string;
  from: string;
  to: string;
  startFractionPpm: number;
  endFractionPpm: number;
  metrics: FixedMetrics;
  sourceFeatureReferenceKey?: CoverageTraversalArc["sourceFeatureReferenceKey"];
}

interface StrictSegment {
  step: StrictStep;
  role: "SERVICE" | "DUPLICATE_SERVICE" | "TRANSIT" | "ACCESS" | "RETURN";
  phase: "ACCESS" | "INSIDE" | "RETURN";
  obligationIds: string[];
}

interface ServiceTask { id: string; obligation: RoadServiceObligation; step: StrictStep }
interface HistoryState { arcKeys: string[] }
interface TurnAdvance { valid: boolean; history: HistoryState; penaltyUnits: number }
interface StrictPath { steps: Array<{ step: StrictStep; penaltyUnits: number }>; cost: number; history: HistoryState }
interface SearchState {
  currentNode: string;
  history: HistoryState;
  remaining: number[];
  segments: StrictSegment[];
  cost: number;
  connectorPathCount: number;
}

export function solveStrictCoverageRoute(
  problem: CoverageProblem,
  traversableArcs: readonly CoverageTraversalArc[],
  options: StrictCoverageSolverOptions
): ClosedDcppSolution {
  const startedAt = Date.now();
  const deadline = startedAt + problem.budgets.timeLimitMs;
  validateOptions(options);
  if (options.routeCount !== undefined && options.routeCount !== 1) {
    throw new CoveragePlanningError("CAPABILITY_NOT_AVAILABLE", "v0.6 supports exactly one route");
  }
  if (options.serviceMode === "EITHER_DIRECTION") {
    throw new CoveragePlanningError("CAPABILITY_NOT_AVAILABLE", "EITHER_DIRECTION is not a Stable v0.6 service mode");
  }
  const arcs = effectiveArcs(problem, traversableArcs, options);
  const byArc = new Map(arcs.map((arc) => [arc.arcKey, arc]));
  for (const obligation of problem.obligationSet.obligations) if (!byArc.has(obligation.arcKey)) {
    throw new CoveragePlanningError("NO_FEASIBLE_PLAN", `required Arc is closed or excluded by the travel profile: ${obligation.arcKey}`);
  }
  const endState = problem.endpointMode === "FIXED_END" ? problem.fixedEndState : problem.endpointMode === "LAST_AREA_EXIT" ? problem.exitStates?.[0] : problem.startState;
  if (endState === undefined) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "FIXED_END requires fixedEndState");
  validateDirectedState(problem.startState.arcKey, problem.startState.direction, problem.startState.fractionPpm, byArc, "start");
  validateDirectedState(endState.arcKey, endState.direction, endState.fractionPpm, byArc, "end");
  const fractions = collectFractions(problem, arcs, endState.arcKey, endState.fractionPpm);
  const network = atomicNetwork(arcs, fractions);
  const tasks = serviceTasks(problem.obligationSet.obligations, byArc);
  const rules = activeRules(options.turnRules ?? [], options.travelPolicy.profileKey);
  const maxHistory = Math.max(1, ...rules.map((rule) => rule.arcSequence.length - 1));
  let matrixCells = 0;
  let expandedCandidates = 0;

  const startArc = byArc.get(problem.startState.arcKey)!;
  let initialHistory: HistoryState = { arcKeys: [] };
  let initialNode = stateNode(startArc, problem.startState.fractionPpm);
  const initialSegments: StrictSegment[] = [];
  if (problem.startState.fractionPpm < WHOLE) {
    const access = intervalStep(startArc, problem.startState.fractionPpm, WHOLE);
    const advanced = advanceTurn(initialHistory, access.arcKey, rules, maxHistory);
    if (!advanced.valid) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "start access violates a strict turn rule");
    initialHistory = advanced.history;
    initialNode = access.to;
    initialSegments.push({ step: withTurnPenalty(access, advanced.penaltyUnits), role: "ACCESS", phase: "ACCESS", obligationIds: [] });
  } else {
    initialHistory = { arcKeys: [startArc.arcKey] };
    initialNode = stateNode(startArc, WHOLE);
  }

  let beam: SearchState[] = [{
    currentNode: initialNode,
    history: initialHistory,
    remaining: tasks.map((_, index) => index),
    segments: initialSegments,
    cost: initialSegments.reduce((sum, segment) => safeAdd(sum, objectiveValue(segment.step.metrics, options.objective, options.objectiveWeights, false)), 0),
    connectorPathCount: 0
  }];
  while (beam[0]?.remaining.length !== 0) {
    checkDeadline(deadline);
    const next: SearchState[] = [];
    for (const state of beam) {
      for (const taskIndex of state.remaining) {
        checkDeadline(deadline);
        const task = tasks[taskIndex]!;
        matrixCells += 1;
        if (matrixCells > problem.budgets.maximumMatrixCells) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "strict connector matrix budget exceeded");
        let connector: StrictPath;
        try {
          connector = strictShortestPath(network, state.currentNode, task.step.from, state.history, task.step.arcKey, rules, maxHistory, options.objective, options.objectiveWeights, deadline);
        } catch (error) {
          if (error instanceof CoveragePlanningError && error.code === "UNREACHABLE") continue;
          throw error;
        }
        const serviceTurn = advanceTurn(connector.history, task.step.arcKey, rules, maxHistory);
        if (!serviceTurn.valid) continue;
        const connectorSegments = connector.steps.map(({ step, penaltyUnits }) => classifiedConnector(withTurnPenalty(step, penaltyUnits), problem.obligationSet.obligations));
        const serviceStep = withTurnPenalty(task.step, serviceTurn.penaltyUnits);
        const cost = safeAdd(state.cost, safeAdd(connector.cost, objectiveValue(serviceStep.metrics, options.objective, options.objectiveWeights, true)));
        expandedCandidates += 1;
        next.push({
          currentNode: task.step.to,
          history: serviceTurn.history,
          remaining: state.remaining.filter((index) => index !== taskIndex),
          segments: [...state.segments, ...connectorSegments, { step: serviceStep, role: "SERVICE", phase: "INSIDE", obligationIds: [task.obligation.obligationId] }],
          cost,
          connectorPathCount: state.connectorPathCount + (connector.steps.length > 0 ? 1 : 0)
        });
      }
    }
    if (next.length === 0) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "strict turns make all remaining obligation orders infeasible");
    next.sort(compareSearchStates);
    beam = deduplicateStates(next).slice(0, problem.budgets.maximumCandidates);
  }

  const endArc = byArc.get(endState.arcKey)!;
  const terminalNode = endState.fractionPpm === WHOLE ? stateNode(endArc, WHOLE) : stateNode(endArc, 0);
  const terminalPrefix = endState.fractionPpm > 0 && endState.fractionPpm < WHOLE ? intervalStep(endArc, 0, endState.fractionPpm) : undefined;
  const completed: SearchState[] = [];
  for (const state of beam) {
    matrixCells += 1;
    if (matrixCells > problem.budgets.maximumMatrixCells) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "strict terminal matrix budget exceeded");
    try {
      const connector = strictShortestPath(network, state.currentNode, terminalNode, state.history, terminalPrefix?.arcKey, rules, maxHistory, options.objective, options.objectiveWeights, deadline);
      const connectorSegments = connector.steps.map(({ step, penaltyUnits }) => classifiedConnector(withTurnPenalty(step, penaltyUnits), problem.obligationSet.obligations));
      let history = connector.history;
      let terminalCost = connector.cost;
      const terminalSegments: StrictSegment[] = [];
      if (terminalPrefix !== undefined) {
        const turn = advanceTurn(history, terminalPrefix.arcKey, rules, maxHistory);
        if (!turn.valid) continue;
        const step = withTurnPenalty(terminalPrefix, turn.penaltyUnits);
        history = turn.history;
        terminalCost = safeAdd(terminalCost, objectiveValue(step.metrics, options.objective, options.objectiveWeights, false));
        terminalSegments.push({ step, role: "RETURN", phase: "RETURN", obligationIds: [] });
      }
      completed.push({
        currentNode: terminalPrefix?.to ?? terminalNode,
        history,
        remaining: [],
        segments: [...state.segments, ...connectorSegments, ...terminalSegments],
        cost: safeAdd(state.cost, terminalCost),
        connectorPathCount: state.connectorPathCount + (connector.steps.length > 0 ? 1 : 0)
      });
    } catch (error) {
      if (!(error instanceof CoveragePlanningError) || error.code !== "UNREACHABLE") throw error;
    }
  }
  if (completed.length === 0) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "strict terminal is unreachable after servicing all obligations");
  completed.sort(compareSearchStates);
  const best = completed[0]!;
  const segments = best.segments.map((segment, index) => ({
    sequence: index + 1,
    graphVersion: segment.step.graphVersion,
    arcKey: segment.step.arcKey,
    startFractionPpm: segment.step.startFractionPpm,
    endFractionPpm: segment.step.endFractionPpm,
    phase: segment.phase,
    serviceRole: segment.role,
    ...(segment.obligationIds.length === 0 ? {} : { obligationIds: segment.obligationIds }),
    ...(segment.step.sourceFeatureReferenceKey === undefined ? {} : { sourceFeatureReferenceKey: segment.step.sourceFeatureReferenceKey }),
    metrics: segment.step.metrics
  }));
  const metrics = segments.reduce<FixedMetrics>((sum, segment) => addMetrics(sum, segment.metrics), ZERO);
  const routeBody = { routeIndex: 1 as const, startState: structuredClone(problem.startState), endState: structuredClone(endState), segments, boundaryEvents: [], metrics };
  return {
    route: { ...routeBody, routeSignature: canonicalSha256(routeBody) },
    diagnostics: {
      solverVersion: "coverage-strict-routing/1.1",
      algorithmFamily: bothDirections(problem.obligationSet.obligations) ? "BOTH_DIRECTIONS_RPP" : "FIXED_RPP",
      exactness: "BOUNDED_HEURISTIC",
      requiredComponentCount: weakRequiredComponents(tasks),
      imbalanceCount: 0,
      connectorPathCount: best.connectorPathCount,
      candidatesGenerated: expandedCandidates,
      candidatesVerified: 0,
      terminatedBy: "PROFILES_COMPLETE",
      elapsedMs: Math.max(0, Date.now() - startedAt),
      resourceMetrics: { traversableArcCount: arcs.length, atomicTraversalCount: network.length, taskCount: tasks.length, matrixCellCount: matrixCells, beamWidth: problem.budgets.maximumCandidates, objective: options.objective, seed: options.seed ?? 0, strictTurnStateSpace: true }
    },
    augmentation: []
  };
}

function validateOptions(options: StrictCoverageSolverOptions): void {
  if (!(["SHORTEST_DISTANCE", "FASTEST", "LOWEST_RISK", "LOWEST_ENERGY", "BALANCED", "LEAST_DEADHEAD", "WEIGHTED"] as const).includes(options.objective)) throw new CoveragePlanningError("CAPABILITY_NOT_AVAILABLE", "unsupported routing objective");
  if (options.objective === "WEIGHTED") validateWeights(options.objectiveWeights);
  for (const rule of options.turnRules ?? []) {
    if (rule.arcSequence.length < 2 || (rule.ruleType === "ALLOWED_ONLY" && rule.arcSequence.length !== 2) || !Number.isSafeInteger(rule.penaltyUnits ?? 0) || (rule.penaltyUnits ?? 0) < 0 || (rule.ruleType === "PENALTY" && (rule.penaltyUnits ?? 0) === 0)) {
      throw new CoveragePlanningError("CAPABILITY_NOT_AVAILABLE", `invalid strict turn rule: ${rule.ruleKey}`);
    }
  }
}

function effectiveArcs(problem: CoverageProblem, input: readonly CoverageTraversalArc[], options: StrictCoverageSolverOptions): CoverageTraversalArc[] {
  const result: CoverageTraversalArc[] = [];
  const seen = new Set<string>();
  for (const source of [...input].sort((left, right) => compareUnicodeCodePoints(left.arcKey, right.arcKey))) {
    if (seen.has(source.arcKey)) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", `duplicate Arc: ${source.arcKey}`);
    seen.add(source.arcKey);
    if (source.graphVersion !== problem.routingSnapshot.graphVersion) throw new CoveragePlanningError("VERSION_NOT_FOUND", `Arc is outside pinned graph: ${source.arcKey}`);
    validateMetrics(source.metrics, source.arcKey);
    if (source.traversalAllowed === false) continue;
    if (options.travelPolicy.allowedRoadClasses !== undefined && (source.roadClass === undefined || !options.travelPolicy.allowedRoadClasses.includes(source.roadClass))) continue;
    if (options.travelPolicy.allowedSurfaces !== undefined && (source.surface === undefined || !options.travelPolicy.allowedSurfaces.includes(source.surface))) continue;
    const requiredMask = options.travelPolicy.requiredAccessMask ?? 0;
    if (requiredMask !== 0 && (((source.accessMask ?? 0) & requiredMask) !== requiredMask)) continue;
    const speed = minimumDefined(source.speedOverrideMmPerS, options.travelPolicy.maximumSpeedMmPerS, source.speedMmPerS);
    if (speed !== undefined && (!Number.isSafeInteger(speed) || speed <= 0)) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", `Arc has invalid effective speed: ${source.arcKey}`);
    const durationMs = speed === undefined ? source.metrics.durationMs : ceilRatio(source.metrics.distanceMm, 1_000, speed);
    const riskMicroUnits = source.riskOverrideMicroUnits ?? source.metrics.riskMicroUnits;
    if (!Number.isSafeInteger(riskMicroUnits) || riskMicroUnits < 0) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", `Arc has invalid risk: ${source.arcKey}`);
    const metrics = {
      ...source.metrics,
      durationMs,
      riskMicroUnits,
      combinedCostUnits: safeAdd(source.metrics.combinedCostUnits, source.conditionPenaltyUnits ?? 0),
      turnPenaltyUnits: 0
    };
    result.push({ ...source, metrics });
  }
  if (result.length === 0) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "travel profile and conditions exclude all Arcs");
  return result;
}

function collectFractions(problem: CoverageProblem, arcs: readonly CoverageTraversalArc[], endArcKey: string, endFraction: number): Map<string, number[]> {
  const values = new Map(arcs.map((arc) => [arc.arcKey, new Set([0, WHOLE])]));
  for (const obligation of problem.obligationSet.obligations) {
    values.get(obligation.arcKey)?.add(obligation.startFractionPpm);
    values.get(obligation.arcKey)?.add(obligation.endFractionPpm);
  }
  values.get(problem.startState.arcKey)!.add(problem.startState.fractionPpm);
  values.get(endArcKey)!.add(endFraction);
  return new Map([...values].map(([key, fractions]) => [key, [...fractions].sort((left, right) => left - right)]));
}

function atomicNetwork(arcs: readonly CoverageTraversalArc[], fractions: ReadonlyMap<string, number[]>): StrictStep[] {
  const result: StrictStep[] = [];
  for (const arc of arcs) {
    const points = fractions.get(arc.arcKey)!;
    for (let index = 1; index < points.length; index += 1) result.push(intervalStep(arc, points[index - 1]!, points[index]!));
  }
  return result.sort((left, right) => compareUnicodeCodePoints(left.id, right.id));
}

function serviceTasks(obligations: readonly RoadServiceObligation[], byArc: ReadonlyMap<string, CoverageTraversalArc>): ServiceTask[] {
  const result: ServiceTask[] = [];
  for (const obligation of [...obligations].sort((left, right) => compareUnicodeCodePoints(left.obligationId, right.obligationId))) {
    const arc = byArc.get(obligation.arcKey)!;
    if (obligation.startFractionPpm >= obligation.endFractionPpm) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", `invalid service interval: ${obligation.obligationId}`);
    const step = intervalStep(arc, obligation.startFractionPpm, obligation.endFractionPpm);
    for (let pass = 1; pass <= obligation.requiredPasses; pass += 1) result.push({ id: `${obligation.obligationId}:${pass.toString().padStart(2, "0")}`, obligation, step });
  }
  return result;
}

function strictShortestPath(
  network: readonly StrictStep[], from: string, to: string, initialHistory: HistoryState, requiredNextArc: string | undefined,
  rules: readonly CoverageTurnRule[], maxHistory: number, objective: CoverageRoutingObjective, weights: CoverageObjectiveWeights | undefined, deadline: number
): StrictPath {
  if (from === to && (requiredNextArc === undefined || advanceTurn(initialHistory, requiredNextArc, rules, maxHistory).valid)) return { steps: [], cost: 0, history: initialHistory };
  const outgoing = new Map<string, StrictStep[]>();
  for (const step of network) ensureArray(outgoing, step.from).push(step);
  for (const values of outgoing.values()) values.sort((left, right) => compareUnicodeCodePoints(left.id, right.id));
  const startKey = searchKey(from, initialHistory);
  const distance = new Map<string, number>([[startKey, 0]]);
  const states = new Map<string, { node: string; history: HistoryState }>([[startKey, { node: from, history: initialHistory }]]);
  const previous = new Map<string, { key: string; step: StrictStep; penaltyUnits: number }>();
  const settled = new Set<string>();
  while (true) {
    checkDeadline(deadline);
    let currentKey: string | undefined;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const [key, value] of distance) if (!settled.has(key) && (value < currentDistance || (value === currentDistance && (currentKey === undefined || compareUnicodeCodePoints(key, currentKey) < 0)))) { currentKey = key; currentDistance = value; }
    if (currentKey === undefined) break;
    const current = states.get(currentKey)!;
    if (current.node === to && (requiredNextArc === undefined || advanceTurn(current.history, requiredNextArc, rules, maxHistory).valid)) {
      const steps: Array<{ step: StrictStep; penaltyUnits: number }> = [];
      let cursor = currentKey;
      while (cursor !== startKey) { const item = previous.get(cursor)!; steps.push({ step: item.step, penaltyUnits: item.penaltyUnits }); cursor = item.key; }
      steps.reverse();
      return { steps, cost: currentDistance, history: current.history };
    }
    settled.add(currentKey);
    for (const step of outgoing.get(current.node) ?? []) {
      const turn = advanceTurn(current.history, step.arcKey, rules, maxHistory);
      if (!turn.valid) continue;
      const nextKey = searchKey(step.to, turn.history);
      const candidate = safeAdd(currentDistance, safeAdd(objectiveValue(step.metrics, objective, weights, false), turn.penaltyUnits));
      if (candidate < (distance.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
        distance.set(nextKey, candidate); states.set(nextKey, { node: step.to, history: turn.history }); previous.set(nextKey, { key: currentKey, step, penaltyUnits: turn.penaltyUnits });
      }
    }
  }
  throw new CoveragePlanningError("UNREACHABLE", `strict turn-aware connector is unavailable from ${from} to ${to}`);
}

function advanceTurn(history: HistoryState, nextArcKey: string, rules: readonly CoverageTurnRule[], maxHistory: number): TurnAdvance {
  if (history.arcKeys.at(-1) === nextArcKey) return { valid: true, history, penaltyUnits: 0 };
  const candidate = [...history.arcKeys, nextArcKey];
  const previous = history.arcKeys.at(-1);
  const allowedOnly = rules.filter((rule) => rule.ruleType === "ALLOWED_ONLY" && previous === rule.arcSequence[0]);
  if (allowedOnly.length > 0 && !allowedOnly.some((rule) => nextArcKey === rule.arcSequence[1])) return { valid: false, history, penaltyUnits: 0 };
  let penaltyUnits = 0;
  for (const rule of rules) {
    if (rule.ruleType === "ALLOWED_ONLY" || rule.arcSequence.length > candidate.length) continue;
    const suffix = candidate.slice(-rule.arcSequence.length);
    if (!suffix.every((arcKey, index) => arcKey === rule.arcSequence[index])) continue;
    if (rule.ruleType === "FORBIDDEN") return { valid: false, history, penaltyUnits: 0 };
    penaltyUnits = safeAdd(penaltyUnits, rule.penaltyUnits ?? 0);
  }
  return { valid: true, history: { arcKeys: candidate.slice(-maxHistory) }, penaltyUnits };
}

function activeRules(rules: readonly CoverageTurnRule[], profileKey: string): CoverageTurnRule[] {
  return [...rules].filter((rule) => rule.travelProfileKeys === undefined || rule.travelProfileKeys.includes(profileKey)).sort((left, right) => compareUnicodeCodePoints(left.ruleKey, right.ruleKey));
}

function intervalStep(arc: CoverageTraversalArc, start: number, end: number): StrictStep {
  return {
    id: `${arc.arcKey}:${start.toString().padStart(7, "0")}:${end.toString().padStart(7, "0")}`,
    graphVersion: arc.graphVersion,
    arcKey: arc.arcKey,
    from: stateNode(arc, start),
    to: stateNode(arc, end),
    startFractionPpm: start,
    endFractionPpm: end,
    metrics: sliceMetrics(arc.metrics, start, end),
    ...(arc.sourceFeatureReferenceKey === undefined ? {} : { sourceFeatureReferenceKey: arc.sourceFeatureReferenceKey })
  };
}

function classifiedConnector(step: StrictStep, obligations: readonly RoadServiceObligation[]): StrictSegment {
  const ids = obligations.filter((obligation) => obligation.arcKey === step.arcKey && step.startFractionPpm >= obligation.startFractionPpm && step.endFractionPpm <= obligation.endFractionPpm).map((obligation) => obligation.obligationId).sort();
  return { step, role: ids.length > 0 ? "DUPLICATE_SERVICE" : "TRANSIT", phase: "INSIDE", obligationIds: ids };
}

function withTurnPenalty(step: StrictStep, penaltyUnits: number): StrictStep {
  if (penaltyUnits === 0) return step;
  return { ...step, metrics: { ...step.metrics, turnPenaltyUnits: safeAdd(step.metrics.turnPenaltyUnits ?? 0, penaltyUnits), combinedCostUnits: safeAdd(step.metrics.combinedCostUnits, penaltyUnits) } };
}

function compareSearchStates(left: SearchState, right: SearchState): number { return left.cost - right.cost || compareUnicodeCodePoints(stateSignature(left), stateSignature(right)); }
function stateSignature(state: SearchState): string { return `${state.remaining.join(",")}|${state.currentNode}|${state.history.arcKeys.join(",")}|${state.segments.map((segment) => `${segment.step.id}:${segment.role}`).join("|")}`; }
function deduplicateStates(states: readonly SearchState[]): SearchState[] {
  const result: SearchState[] = [], seen = new Set<string>();
  for (const state of states) { const key = `${state.remaining.join(",")}|${state.currentNode}|${state.history.arcKeys.join(",")}`; if (!seen.has(key)) { seen.add(key); result.push(state); } }
  return result;
}

function weakRequiredComponents(tasks: readonly ServiceTask[]): number {
  const adjacency = new Map<string, Set<string>>();
  for (const task of tasks) { ensureSet(adjacency, task.step.from).add(task.step.to); ensureSet(adjacency, task.step.to).add(task.step.from); }
  const visited = new Set<string>(); let count = 0;
  for (const node of [...adjacency.keys()].sort()) if (!visited.has(node)) { count += 1; const stack = [node]; while (stack.length > 0) { const current = stack.pop()!; if (visited.has(current)) continue; visited.add(current); for (const next of adjacency.get(current) ?? []) if (!visited.has(next)) stack.push(next); } }
  return count;
}

function bothDirections(obligations: readonly RoadServiceObligation[]): boolean {
  const byEdge = new Map<string, Set<string>>();
  for (const obligation of obligations) if (obligation.edgeKey !== undefined) ensureSet(byEdge, obligation.edgeKey).add(obligation.arcKey);
  return [...byEdge.values()].some((set) => set.size > 1);
}

function validateDirectedState(arcKey: string, direction: string, fraction: number, arcs: ReadonlyMap<string, CoverageTraversalArc>, label: string): void {
  const arc = arcs.get(arcKey);
  if (arc === undefined || arc.direction !== direction || !Number.isSafeInteger(fraction) || fraction < 0 || fraction > WHOLE) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", `strict ${label} state is invalid`);
}

function stateNode(arc: CoverageTraversalArc, fraction: number): string { return fraction === 0 ? `node:${arc.fromNodeKey}` : fraction === WHOLE ? `node:${arc.toNodeKey}` : `state:${arc.arcKey}:${fraction.toString().padStart(7, "0")}`; }
function searchKey(node: string, history: HistoryState): string { return `${node}\u0000${history.arcKeys.join("\u0001")}`; }

function objectiveRaw(metrics: FixedMetrics, objective: CoverageRoutingObjective): number {
  return objective === "SHORTEST_DISTANCE" || objective === "LEAST_DEADHEAD" ? metrics.distanceMm : objective === "FASTEST" ? metrics.durationMs : objective === "LOWEST_RISK" ? metrics.riskMicroUnits : objective === "LOWEST_ENERGY" ? metrics.energyMwh : metrics.combinedCostUnits;
}
function objectiveValue(metrics: FixedMetrics, objective: CoverageRoutingObjective, weights: CoverageObjectiveWeights | undefined, service: boolean): number {
  if (objective === "LEAST_DEADHEAD") return service ? 0 : safeAdd(metrics.distanceMm, metrics.turnPenaltyUnits ?? 0);
  if (objective === "WEIGHTED") return safeAdd(weightedObjectiveValue(metrics, weights!, service), metrics.turnPenaltyUnits ?? 0);
  return objective === "BALANCED" ? metrics.combinedCostUnits : safeAdd(objectiveRaw(metrics, objective), metrics.turnPenaltyUnits ?? 0);
}

export function weightedObjectiveValue(metrics: FixedMetrics, weights: CoverageObjectiveWeights, service: boolean): number {
  validateWeights(weights);
  const numerator = BigInt(metrics.distanceMm) * BigInt(weights.distance) + BigInt(metrics.durationMs) * BigInt(weights.duration) +
    BigInt(metrics.riskMicroUnits) * BigInt(weights.risk) + BigInt(metrics.energyMwh) * BigInt(weights.energy ?? 0) +
    BigInt(service ? 0 : metrics.distanceMm) * BigInt(weights.deadhead);
  const score = numerator / 1_000_000n;
  if (score > BigInt(Number.MAX_SAFE_INTEGER)) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "weighted objective exceeds safe fixed-point range");
  return Number(score);
}

function validateWeights(weights: CoverageObjectiveWeights | undefined): asserts weights is CoverageObjectiveWeights {
  if (weights === undefined || ![weights.distance, weights.duration, weights.risk, weights.energy ?? 0, weights.deadhead].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000)) {
    throw new CoveragePlanningError("CAPABILITY_NOT_AVAILABLE", "WEIGHTED requires bounded integer PPM distance, duration, risk, energy, and deadhead weights");
  }
}

function sliceMetrics(metrics: FixedMetrics, start: number, end: number): FixedMetrics {
  const slice = (value: number): number => { const result = Number((BigInt(value) * BigInt(end)) / BigInt(WHOLE) - (BigInt(value) * BigInt(start)) / BigInt(WHOLE)); if (!Number.isSafeInteger(result) || result < 0) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "strict fixed-point slice overflow"); return result; };
  return { distanceMm: slice(metrics.distanceMm), durationMs: slice(metrics.durationMs), riskMicroUnits: slice(metrics.riskMicroUnits), energyMwh: slice(metrics.energyMwh), combinedCostUnits: slice(metrics.combinedCostUnits), turnPenaltyUnits: slice(metrics.turnPenaltyUnits ?? 0) };
}
function addMetrics(left: FixedMetrics, right: FixedMetrics): FixedMetrics { return { distanceMm: safeAdd(left.distanceMm, right.distanceMm), durationMs: safeAdd(left.durationMs, right.durationMs), riskMicroUnits: safeAdd(left.riskMicroUnits, right.riskMicroUnits), energyMwh: safeAdd(left.energyMwh, right.energyMwh), combinedCostUnits: safeAdd(left.combinedCostUnits, right.combinedCostUnits), turnPenaltyUnits: safeAdd(left.turnPenaltyUnits ?? 0, right.turnPenaltyUnits ?? 0) }; }
function validateMetrics(metrics: FixedMetrics, arcKey: string): void { for (const [name, value] of Object.entries({ distanceMm: metrics.distanceMm, durationMs: metrics.durationMs, riskMicroUnits: metrics.riskMicroUnits, energyMwh: metrics.energyMwh, combinedCostUnits: metrics.combinedCostUnits, turnPenaltyUnits: metrics.turnPenaltyUnits ?? 0 })) if (!Number.isSafeInteger(value) || value < 0) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", `Arc ${arcKey} has invalid ${name}`); }
function ceilRatio(value: number, multiplier: number, divisor: number): number { const result = Number((BigInt(value) * BigInt(multiplier) + BigInt(divisor) - 1n) / BigInt(divisor)); if (!Number.isSafeInteger(result)) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "duration overflow"); return result; }
function minimumDefined(...values: Array<number | undefined>): number | undefined { const present = values.filter((value): value is number => value !== undefined); return present.length === 0 ? undefined : Math.min(...present); }
function safeAdd(left: number, right: number): number { const result = left + right; if (!Number.isSafeInteger(result) || result < 0) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "strict fixed-point overflow"); return result; }
function ensureArray<K, V>(map: Map<K, V[]>, key: K): V[] { const value = map.get(key) ?? []; map.set(key, value); return value; }
function ensureSet<K>(map: Map<K, Set<string>>, key: K): Set<string> { const value = map.get(key) ?? new Set<string>(); map.set(key, value); return value; }
function checkDeadline(deadline: number): void { if (Date.now() > deadline) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "strict solver time budget exceeded", { retryable: true }); }
