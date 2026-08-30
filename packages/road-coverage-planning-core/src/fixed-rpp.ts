import { canonicalSha256, compareUnicodeCodePoints } from "../../platform/contract-runtime/src/index.js";
import { CoveragePlanningError } from "./errors.js";
import type {
  ClosedDcppAugmentation,
  ClosedDcppSolution,
  CoverageProblem,
  CoverageTraversalArc,
  FixedMetrics,
  RoadServiceObligation
} from "./types.js";

const WHOLE = 1_000_000;
const MAX_SEGMENTS = 1_000_000;
const ZERO: FixedMetrics = { distanceMm: 0, durationMs: 0, riskMicroUnits: 0, energyMwh: 0, combinedCostUnits: 0, turnPenaltyUnits: 0 };

interface AtomicStep {
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

interface RouteEdge {
  id: string;
  step: AtomicStep;
  role: "SERVICE" | "DUPLICATE_SERVICE" | "TRANSIT";
  obligationIds: string[];
}

interface Path {
  cost: number;
  steps: AtomicStep[];
}

interface QuantityNode { nodeKey: string; quantity: number }
interface Component { id: string; nodes: string[] }
interface ComponentLink { left: number; right: number; from: string; to: string; path: Path }
interface ResidualEdge { to: number; reverse: number; capacity: number; cost: number; originalCapacity: number }

/**
 * Deterministic bounded heuristic for fixed-direction RPP. Required service R
 * remains separate from the complete traversable atomic network E.
 */
export function solveFixedDirectionRpp(problem: CoverageProblem, traversableArcs: readonly CoverageTraversalArc[]): ClosedDcppSolution {
  const startedAt = Date.now();
  const deadline = startedAt + problem.budgets.timeLimitMs;
  if (problem.endpointMode === "LAST_AREA_EXIT") {
    throw new CoveragePlanningError("CAPABILITY_NOT_AVAILABLE", "LAST_AREA_EXIT route construction requires the strict boundary phase");
  }
  const arcs = validateInput(problem, traversableArcs);
  const byArc = new Map(arcs.map((arc) => [arc.arcKey, arc]));
  const endState = problem.endpointMode === "FIXED_END" ? problem.fixedEndState : problem.startState;
  if (endState === undefined) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "FIXED_END requires an exact terminal state");
  const fractions = collectFractions(problem, arcs);
  const atomicNetwork = buildAtomicNetwork(arcs, fractions);
  const startNode = stateNode(byArc.get(problem.startState.arcKey)!, problem.startState.fractionPpm);
  const endNode = stateNode(byArc.get(endState.arcKey)!, endState.fractionPpm);
  const requiredEdges = buildRequiredEdges(problem.obligationSet.obligations, byArc);
  const components = requiredComponents(requiredEdges, startNode, endNode);
  const pathCache = new Map<string, Path>();
  let matrixCells = 0;
  const path = (from: string, to: string): Path => {
    const key = `${from}\u0000${to}`;
    const cached = pathCache.get(key);
    if (cached !== undefined) return cached;
    matrixCells += 1;
    if (matrixCells > problem.budgets.maximumMatrixCells) {
      throw new CoveragePlanningError("RESOURCE_EXHAUSTED", `RPP connector matrix exceeded ${problem.budgets.maximumMatrixCells} cells`);
    }
    const found = shortestPath(atomicNetwork, from, to, deadline);
    pathCache.set(key, found);
    return found;
  };

  const componentLinks = minimumSpanningComponentLinks(components, path, deadline);
  const connectorEdges: RouteEdge[] = [];
  let connectorSequence = 0;
  for (const link of componentLinks) {
    for (const step of link.path.steps) {
      connectorSequence += 1;
      connectorEdges.push(classifiedEdge(`component:${connectorSequence.toString().padStart(9, "0")}`, step, problem.obligationSet.obligations));
    }
  }

  const balance = new Map<string, number>();
  for (const edge of [...requiredEdges, ...connectorEdges]) {
    addBalance(balance, edge.step.from, 1);
    addBalance(balance, edge.step.to, -1);
  }
  if (startNode !== endNode) {
    addBalance(balance, startNode, -1);
    addBalance(balance, endNode, 1);
  }
  const supplies = imbalance(balance, (value) => value < 0, (value) => -value);
  const demands = imbalance(balance, (value) => value > 0, (value) => value);
  const balancePaths = new Map<string, Path>();
  for (const supply of supplies) for (const demand of demands) balancePaths.set(pairKey(supply.nodeKey, demand.nodeKey), path(supply.nodeKey, demand.nodeKey));
  const flow = minimumCostFlow(supplies, demands, balancePaths, deadline);
  const augmentationEdges: RouteEdge[] = [];
  let augmentationSequence = 0;
  for (const item of flow) {
    const selected = balancePaths.get(pairKey(item.fromNodeKey, item.toNodeKey))!;
    for (let copy = 0; copy < item.quantity; copy += 1) {
      for (const step of selected.steps) {
        augmentationSequence += 1;
        augmentationEdges.push(classifiedEdge(`balance:${augmentationSequence.toString().padStart(9, "0")}`, step, problem.obligationSet.obligations));
      }
    }
  }
  const allEdges = [...requiredEdges, ...connectorEdges, ...augmentationEdges];
  if (allEdges.length > MAX_SEGMENTS) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "RPP route exceeds the segment limit");
  const trail = eulerTrail(allEdges, startNode, endNode, deadline);
  const segments = trail.map((edge, index) => ({
    sequence: index + 1,
    graphVersion: edge.step.graphVersion,
    arcKey: edge.step.arcKey,
    startFractionPpm: edge.step.startFractionPpm,
    endFractionPpm: edge.step.endFractionPpm,
    phase: "INSIDE" as const,
    serviceRole: edge.role,
    ...(edge.obligationIds.length === 0 ? {} : { obligationIds: edge.obligationIds }),
    ...(edge.step.sourceFeatureReferenceKey === undefined ? {} : { sourceFeatureReferenceKey: edge.step.sourceFeatureReferenceKey }),
    metrics: edge.step.metrics
  }));
  const metrics = segments.reduce<FixedMetrics>((total, segment) => addMetrics(total, segment.metrics), ZERO);
  const routeBody = {
    routeIndex: 1 as const,
    startState: structuredClone(problem.startState),
    endState: structuredClone(endState),
    segments,
    boundaryEvents: [],
    metrics
  };
  const componentAugmentation: ClosedDcppAugmentation[] = componentLinks.map((link) => ({
    fromNodeKey: link.from,
    toNodeKey: link.to,
    quantity: 1,
    unitCost: link.path.cost,
    arcKeys: link.path.steps.map((step) => step.arcKey)
  }));
  return {
    route: { ...routeBody, routeSignature: canonicalSha256(routeBody) },
    diagnostics: {
      solverVersion: "coverage-fixed-rpp/1.0",
      algorithmFamily: bothDirectionsRequired(problem.obligationSet.obligations) ? "BOTH_DIRECTIONS_RPP" : "FIXED_RPP",
      exactness: "BOUNDED_HEURISTIC",
      requiredComponentCount: components.filter((component) => component.id.startsWith("required:")).length,
      imbalanceCount: supplies.length + demands.length,
      connectorPathCount: componentLinks.length + flow.reduce((total, item) => safeAdd(total, item.quantity), 0),
      candidatesGenerated: 1,
      candidatesVerified: 0,
      terminatedBy: "PROFILES_COMPLETE",
      elapsedMs: Math.max(0, Date.now() - startedAt),
      resourceMetrics: {
        traversableArcCount: arcs.length,
        atomicTraversalCount: atomicNetwork.length,
        obligationCount: problem.obligationSet.obligations.length,
        requiredTraversalCount: requiredEdges.length,
        componentConnectorTraversalCount: connectorEdges.length,
        balanceTraversalCount: augmentationEdges.length,
        matrixCellCount: matrixCells
      }
    },
    augmentation: [...componentAugmentation, ...flow]
  };
}

function validateInput(problem: CoverageProblem, input: readonly CoverageTraversalArc[]): CoverageTraversalArc[] {
  if (input.length === 0) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "RPP requires a non-empty traversable network E");
  const arcs = [...input].sort((left, right) => compareUnicodeCodePoints(left.arcKey, right.arcKey));
  const byArc = new Map<string, CoverageTraversalArc>();
  for (const arc of arcs) {
    if (byArc.has(arc.arcKey)) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", `duplicate traversable Arc: ${arc.arcKey}`);
    if (arc.graphVersion !== problem.routingSnapshot.graphVersion) throw new CoveragePlanningError("VERSION_NOT_FOUND", `Arc is outside the pinned graph: ${arc.arcKey}`);
    if (arc.fromNodeKey.length === 0 || arc.toNodeKey.length === 0) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", `Arc has an invalid endpoint: ${arc.arcKey}`);
    validateMetrics(arc.metrics, arc.arcKey);
    byArc.set(arc.arcKey, arc);
  }
  for (const obligation of problem.obligationSet.obligations) {
    const arc = byArc.get(obligation.arcKey);
    if (arc === undefined || obligation.graphVersion !== problem.routingSnapshot.graphVersion) throw new CoveragePlanningError("VERSION_NOT_FOUND", `obligation Arc is not in E: ${obligation.arcKey}`);
    if (obligation.startFractionPpm >= obligation.endFractionPpm) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", `obligation fraction is reversed or empty: ${obligation.obligationId}`);
  }
  validateState(problem.startState.arcKey, problem.startState.direction, problem.startState.fractionPpm, byArc, "start");
  if (problem.endpointMode === "FIXED_END") {
    if (problem.fixedEndState === undefined) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "FIXED_END is missing fixedEndState");
    validateState(problem.fixedEndState.arcKey, problem.fixedEndState.direction, problem.fixedEndState.fractionPpm, byArc, "end");
  }
  return arcs;
}

function validateState(arcKey: string, direction: string, fraction: number, byArc: ReadonlyMap<string, CoverageTraversalArc>, label: string): void {
  const arc = byArc.get(arcKey);
  if (arc === undefined || arc.direction !== direction || !Number.isSafeInteger(fraction) || fraction < 0 || fraction > WHOLE) {
    throw new CoveragePlanningError("NO_FEASIBLE_PLAN", `RPP ${label} state is invalid`);
  }
}

function collectFractions(problem: CoverageProblem, arcs: readonly CoverageTraversalArc[]): Map<string, number[]> {
  const values = new Map(arcs.map((arc) => [arc.arcKey, new Set([0, WHOLE])]));
  for (const obligation of problem.obligationSet.obligations) {
    values.get(obligation.arcKey)!.add(obligation.startFractionPpm);
    values.get(obligation.arcKey)!.add(obligation.endFractionPpm);
  }
  values.get(problem.startState.arcKey)!.add(problem.startState.fractionPpm);
  if (problem.fixedEndState !== undefined) values.get(problem.fixedEndState.arcKey)!.add(problem.fixedEndState.fractionPpm);
  return new Map([...values].map(([arcKey, fractions]) => [arcKey, [...fractions].sort((left, right) => left - right)]));
}

function buildAtomicNetwork(arcs: readonly CoverageTraversalArc[], fractions: ReadonlyMap<string, number[]>): AtomicStep[] {
  const steps: AtomicStep[] = [];
  for (const arc of arcs) {
    const points = fractions.get(arc.arcKey)!;
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]!;
      const end = points[index]!;
      steps.push({
        id: `atomic:${arc.arcKey}:${start.toString().padStart(7, "0")}:${end.toString().padStart(7, "0")}`,
        graphVersion: arc.graphVersion,
        arcKey: arc.arcKey,
        from: stateNode(arc, start),
        to: stateNode(arc, end),
        startFractionPpm: start,
        endFractionPpm: end,
        metrics: sliceMetrics(arc.metrics, start, end),
        ...(arc.sourceFeatureReferenceKey === undefined ? {} : { sourceFeatureReferenceKey: arc.sourceFeatureReferenceKey })
      });
    }
  }
  return steps.sort((left, right) => compareUnicodeCodePoints(left.id, right.id));
}

function buildRequiredEdges(obligations: readonly RoadServiceObligation[], byArc: ReadonlyMap<string, CoverageTraversalArc>): RouteEdge[] {
  const result: RouteEdge[] = [];
  for (const obligation of [...obligations].sort((left, right) => compareUnicodeCodePoints(left.obligationId, right.obligationId))) {
    const arc = byArc.get(obligation.arcKey)!;
    const step: AtomicStep = {
      id: `service:${obligation.obligationId}`,
      graphVersion: arc.graphVersion,
      arcKey: arc.arcKey,
      from: stateNode(arc, obligation.startFractionPpm),
      to: stateNode(arc, obligation.endFractionPpm),
      startFractionPpm: obligation.startFractionPpm,
      endFractionPpm: obligation.endFractionPpm,
      metrics: sliceMetrics(arc.metrics, obligation.startFractionPpm, obligation.endFractionPpm),
      ...(arc.sourceFeatureReferenceKey === undefined ? {} : { sourceFeatureReferenceKey: arc.sourceFeatureReferenceKey })
    };
    for (let pass = 1; pass <= obligation.requiredPasses; pass += 1) {
      result.push({ id: `${step.id}:${pass.toString().padStart(2, "0")}`, step, role: "SERVICE", obligationIds: [obligation.obligationId] });
    }
  }
  return result;
}

function requiredComponents(edges: readonly RouteEdge[], start: string, end: string): Component[] {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    ensureSet(adjacency, edge.step.from).add(edge.step.to);
    ensureSet(adjacency, edge.step.to).add(edge.step.from);
  }
  const result: Component[] = [];
  const visited = new Set<string>();
  for (const node of [...adjacency.keys()].sort()) {
    if (visited.has(node)) continue;
    const nodes: string[] = [];
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      nodes.push(current);
      for (const neighbour of adjacency.get(current) ?? []) if (!visited.has(neighbour)) stack.push(neighbour);
    }
    nodes.sort();
    result.push({ id: `required:${nodes[0]}`, nodes });
  }
  for (const terminal of [...new Set([start, end])].sort()) {
    if (!result.some((component) => component.nodes.includes(terminal))) result.push({ id: `terminal:${terminal}`, nodes: [terminal] });
  }
  return result.sort((left, right) => compareUnicodeCodePoints(left.id, right.id));
}

function minimumSpanningComponentLinks(components: readonly Component[], getPath: (from: string, to: string) => Path, deadline: number): ComponentLink[] {
  if (components.length <= 1) return [];
  const candidates: ComponentLink[] = [];
  for (let left = 0; left < components.length; left += 1) {
    for (let right = left + 1; right < components.length; right += 1) {
      checkDeadline(deadline);
      let best: ComponentLink | undefined;
      for (const from of components[left]!.nodes) for (const to of components[right]!.nodes) {
        for (const directed of [{ from, to }, { from: to, to: from }]) {
          const path = getPath(directed.from, directed.to);
          const candidate = { left, right, from: directed.from, to: directed.to, path };
          if (best === undefined || compareLinks(candidate, best) < 0) best = candidate;
        }
      }
      if (best === undefined) throw new CoveragePlanningError("UNREACHABLE", "required components cannot be connected");
      candidates.push(best);
    }
  }
  candidates.sort(compareLinks);
  const parent = components.map((_, index) => index);
  const root = (value: number): number => {
    let cursor = value;
    while (parent[cursor] !== cursor) cursor = parent[cursor]!;
    while (parent[value] !== value) {
      const next = parent[value]!;
      parent[value] = cursor;
      value = next;
    }
    return cursor;
  };
  const result: ComponentLink[] = [];
  for (const candidate of candidates) {
    const leftRoot = root(candidate.left);
    const rightRoot = root(candidate.right);
    if (leftRoot === rightRoot) continue;
    parent[rightRoot] = leftRoot;
    result.push(candidate);
    if (result.length === components.length - 1) break;
  }
  if (result.length !== components.length - 1) throw new CoveragePlanningError("UNREACHABLE", "required component tree is incomplete");
  return result;
}

function compareLinks(left: ComponentLink, right: ComponentLink): number {
  return left.path.cost - right.path.cost || compareUnicodeCodePoints(left.from, right.from) || compareUnicodeCodePoints(left.to, right.to) ||
    compareUnicodeCodePoints(left.path.steps.map((step) => step.id).join("|"), right.path.steps.map((step) => step.id).join("|"));
}

function shortestPath(network: readonly AtomicStep[], from: string, to: string, deadline: number): Path {
  if (from === to) return { cost: 0, steps: [] };
  const outgoing = new Map<string, AtomicStep[]>();
  const nodes = new Set<string>();
  for (const step of network) {
    ensureArray(outgoing, step.from).push(step);
    nodes.add(step.from); nodes.add(step.to);
  }
  for (const steps of outgoing.values()) steps.sort((left, right) => compareUnicodeCodePoints(left.id, right.id));
  const orderedNodes = [...nodes].sort();
  const distance = new Map(orderedNodes.map((node) => [node, Number.POSITIVE_INFINITY]));
  const previous = new Map<string, AtomicStep>();
  const settled = new Set<string>();
  distance.set(from, 0);
  while (settled.size < orderedNodes.length) {
    checkDeadline(deadline);
    let current: string | undefined;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const node of orderedNodes) {
      const candidate = distance.get(node)!;
      if (!settled.has(node) && candidate < currentDistance) { current = node; currentDistance = candidate; }
    }
    if (current === undefined || !Number.isFinite(currentDistance)) break;
    if (current === to) break;
    settled.add(current);
    for (const step of outgoing.get(current) ?? []) {
      const candidate = safeAdd(currentDistance, step.metrics.combinedCostUnits);
      if (candidate < distance.get(step.to)!) { distance.set(step.to, candidate); previous.set(step.to, step); }
    }
  }
  const cost = distance.get(to);
  if (cost === undefined || !Number.isFinite(cost)) throw new CoveragePlanningError("UNREACHABLE", `no directed RPP connector from ${from} to ${to}`);
  const steps: AtomicStep[] = [];
  let cursor = to;
  while (cursor !== from) {
    const step = previous.get(cursor);
    if (step === undefined) throw new CoveragePlanningError("UNREACHABLE", "RPP connector reconstruction failed");
    steps.push(step); cursor = step.from;
  }
  steps.reverse();
  return { cost, steps };
}

function minimumCostFlow(supplies: readonly QuantityNode[], demands: readonly QuantityNode[], paths: ReadonlyMap<string, Path>, deadline: number): ClosedDcppAugmentation[] {
  if (supplies.length === 0 && demands.length === 0) return [];
  const total = supplies.reduce((sum, item) => safeAdd(sum, item.quantity), 0);
  if (total !== demands.reduce((sum, item) => safeAdd(sum, item.quantity), 0)) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "RPP imbalance totals differ");
  const source = 0, supplyOffset = 1, demandOffset = supplyOffset + supplies.length, sink = demandOffset + demands.length;
  const graph: ResidualEdge[][] = Array.from({ length: sink + 1 }, () => []);
  const pairEdges = new Map<string, { node: number; edge: number }>();
  supplies.forEach((item, index) => addResidual(graph, source, supplyOffset + index, item.quantity, 0));
  supplies.forEach((supply, supplyIndex) => demands.forEach((demand, demandIndex) => {
    const node = supplyOffset + supplyIndex, edge = graph[node]!.length;
    addResidual(graph, node, demandOffset + demandIndex, total, paths.get(pairKey(supply.nodeKey, demand.nodeKey))!.cost);
    pairEdges.set(pairKey(supply.nodeKey, demand.nodeKey), { node, edge });
  }));
  demands.forEach((item, index) => addResidual(graph, demandOffset + index, sink, item.quantity, 0));
  let delivered = 0;
  while (delivered < total) {
    checkDeadline(deadline);
    const distance = Array<number>(graph.length).fill(Number.POSITIVE_INFINITY);
    const previousNode = Array<number>(graph.length).fill(-1), previousEdge = Array<number>(graph.length).fill(-1);
    distance[source] = 0;
    for (let pass = 0; pass < graph.length - 1; pass += 1) {
      let changed = false;
      for (let node = 0; node < graph.length; node += 1) if (Number.isFinite(distance[node]!)) {
        for (let edgeIndex = 0; edgeIndex < graph[node]!.length; edgeIndex += 1) {
          const edge = graph[node]![edgeIndex]!;
          if (edge.capacity <= 0) continue;
          const candidate = safeSignedAdd(distance[node]!, edge.cost);
          if (candidate < distance[edge.to]!) { distance[edge.to] = candidate; previousNode[edge.to] = node; previousEdge[edge.to] = edgeIndex; changed = true; }
        }
      }
      if (!changed) break;
    }
    if (!Number.isFinite(distance[sink]!)) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "RPP imbalance flow is infeasible");
    let quantity = total - delivered;
    for (let cursor = sink; cursor !== source; cursor = previousNode[cursor]!) quantity = Math.min(quantity, graph[previousNode[cursor]!]![previousEdge[cursor]!]!.capacity);
    for (let cursor = sink; cursor !== source; cursor = previousNode[cursor]!) {
      const node = previousNode[cursor]!, edge = graph[node]![previousEdge[cursor]!]!;
      edge.capacity -= quantity; graph[cursor]![edge.reverse]!.capacity += quantity;
    }
    delivered = safeAdd(delivered, quantity);
  }
  const result: ClosedDcppAugmentation[] = [];
  for (const supply of supplies) for (const demand of demands) {
    const key = pairKey(supply.nodeKey, demand.nodeKey), reference = pairEdges.get(key)!, edge = graph[reference.node]![reference.edge]!;
    const quantity = edge.originalCapacity - edge.capacity;
    if (quantity > 0) {
      const path = paths.get(key)!;
      result.push({ fromNodeKey: supply.nodeKey, toNodeKey: demand.nodeKey, quantity, unitCost: path.cost, arcKeys: path.steps.map((step) => step.arcKey) });
    }
  }
  return result;
}

function eulerTrail(edges: readonly RouteEdge[], start: string, end: string, deadline: number): RouteEdge[] {
  const outgoing = new Map<string, RouteEdge[]>();
  for (const edge of edges) ensureArray(outgoing, edge.step.from).push(edge);
  for (const list of outgoing.values()) list.sort((left, right) => compareUnicodeCodePoints(left.step.id, right.step.id) || compareUnicodeCodePoints(left.id, right.id));
  const cursors = new Map<string, number>(), used = new Set<string>();
  const nodeStack = [start], edgeStack: RouteEdge[] = [], reversed: RouteEdge[] = [];
  while (nodeStack.length > 0) {
    checkDeadline(deadline);
    const node = nodeStack.at(-1)!, list = outgoing.get(node) ?? [];
    let cursor = cursors.get(node) ?? 0;
    while (cursor < list.length && used.has(list[cursor]!.id)) cursor += 1;
    cursors.set(node, cursor);
    if (cursor < list.length) {
      const edge = list[cursor]!; used.add(edge.id); cursors.set(node, cursor + 1); nodeStack.push(edge.step.to); edgeStack.push(edge);
    } else {
      nodeStack.pop(); const edge = edgeStack.pop(); if (edge !== undefined) reversed.push(edge);
    }
  }
  const trail = reversed.reverse();
  if (used.size !== edges.length || trail.length !== edges.length || trail.at(-1)?.step.to !== end) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "RPP graph does not admit the requested Euler trail");
  for (let index = 1; index < trail.length; index += 1) if (trail[index - 1]!.step.to !== trail[index]!.step.from) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "RPP Euler trail is discontinuous");
  return trail;
}

function classifiedEdge(id: string, step: AtomicStep, obligations: readonly RoadServiceObligation[]): RouteEdge {
  const ids = obligations.filter((obligation) => obligation.arcKey === step.arcKey && step.startFractionPpm >= obligation.startFractionPpm && step.endFractionPpm <= obligation.endFractionPpm).map((obligation) => obligation.obligationId).sort();
  return { id, step, role: ids.length > 0 ? "DUPLICATE_SERVICE" : "TRANSIT", obligationIds: ids };
}

function bothDirectionsRequired(obligations: readonly RoadServiceObligation[]): boolean {
  const byEdge = new Map<string, Set<string>>();
  for (const obligation of obligations) if (obligation.edgeKey !== undefined) ensureSet(byEdge, obligation.edgeKey).add(obligation.arcKey);
  return [...byEdge.values()].some((arcs) => arcs.size > 1);
}

function stateNode(arc: CoverageTraversalArc, fraction: number): string {
  if (fraction === 0) return `node:${arc.fromNodeKey}`;
  if (fraction === WHOLE) return `node:${arc.toNodeKey}`;
  return `state:${arc.arcKey}:${fraction.toString().padStart(7, "0")}`;
}

function sliceMetrics(metrics: FixedMetrics, start: number, end: number): FixedMetrics {
  const slice = (value: number): number => {
    const result = Number((BigInt(value) * BigInt(end)) / BigInt(WHOLE) - (BigInt(value) * BigInt(start)) / BigInt(WHOLE));
    if (!Number.isSafeInteger(result) || result < 0) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "RPP fixed-point slice overflow");
    return result;
  };
  return { distanceMm: slice(metrics.distanceMm), durationMs: slice(metrics.durationMs), riskMicroUnits: slice(metrics.riskMicroUnits), energyMwh: slice(metrics.energyMwh), combinedCostUnits: slice(metrics.combinedCostUnits), turnPenaltyUnits: slice(metrics.turnPenaltyUnits ?? 0) };
}

function addMetrics(left: FixedMetrics, right: FixedMetrics): FixedMetrics {
  return { distanceMm: safeAdd(left.distanceMm, right.distanceMm), durationMs: safeAdd(left.durationMs, right.durationMs), riskMicroUnits: safeAdd(left.riskMicroUnits, right.riskMicroUnits), energyMwh: safeAdd(left.energyMwh, right.energyMwh), combinedCostUnits: safeAdd(left.combinedCostUnits, right.combinedCostUnits), turnPenaltyUnits: safeAdd(left.turnPenaltyUnits ?? 0, right.turnPenaltyUnits ?? 0) };
}

function validateMetrics(metrics: FixedMetrics, arcKey: string): void {
  for (const [name, value] of Object.entries({ distanceMm: metrics.distanceMm, durationMs: metrics.durationMs, riskMicroUnits: metrics.riskMicroUnits, energyMwh: metrics.energyMwh, combinedCostUnits: metrics.combinedCostUnits, turnPenaltyUnits: metrics.turnPenaltyUnits ?? 0 })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", `Arc ${arcKey} has invalid ${name}`);
  }
}

function imbalance(balance: ReadonlyMap<string, number>, predicate: (value: number) => boolean, quantity: (value: number) => number): QuantityNode[] {
  return [...balance].filter(([, value]) => predicate(value)).map(([nodeKey, value]) => ({ nodeKey, quantity: quantity(value) })).sort((left, right) => compareUnicodeCodePoints(left.nodeKey, right.nodeKey));
}

function addBalance(balance: Map<string, number>, node: string, delta: number): void { balance.set(node, safeSignedAdd(balance.get(node) ?? 0, delta)); }
function addResidual(graph: ResidualEdge[][], from: number, to: number, capacity: number, cost: number): void {
  const forward = { to, reverse: graph[to]!.length, capacity, cost, originalCapacity: capacity };
  const reverse = { to: from, reverse: graph[from]!.length, capacity: 0, cost: -cost, originalCapacity: 0 };
  graph[from]!.push(forward); graph[to]!.push(reverse);
}
function ensureSet<K>(map: Map<K, Set<string>>, key: K): Set<string> { const value = map.get(key) ?? new Set<string>(); map.set(key, value); return value; }
function ensureArray<K, V>(map: Map<K, V[]>, key: K): V[] { const value = map.get(key) ?? []; map.set(key, value); return value; }
function pairKey(from: string, to: string): string { return `${from}\u0000${to}`; }
function safeAdd(left: number, right: number): number { const value = left + right; if (!Number.isSafeInteger(value) || value < 0) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "RPP fixed-point overflow"); return value; }
function safeSignedAdd(left: number, right: number): number { const value = left + right; if (!Number.isSafeInteger(value)) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "RPP integer overflow"); return value; }
function checkDeadline(deadline: number): void { if (Date.now() > deadline) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "RPP time limit exceeded", { retryable: true }); }
