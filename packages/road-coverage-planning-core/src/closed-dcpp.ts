import { canonicalSha256 } from "../../platform/contract-runtime/src/index.js";
import { CoveragePlanningError } from "./errors.js";
import type {
  ClosedDcppAugmentation,
  ClosedDcppSolution,
  CoverageProblem,
  CoverageTraversalArc,
  FixedMetrics,
  RoadServiceObligation
} from "./types.js";

const WHOLE_ARC_PPM = 1_000_000;
const MAX_ROUTE_SEGMENTS = 1_000_000;
const ZERO_METRICS: FixedMetrics = {
  distanceMm: 0,
  durationMs: 0,
  riskMicroUnits: 0,
  energyMwh: 0,
  combinedCostUnits: 0,
  turnPenaltyUnits: 0
};

interface TraversalInstance {
  id: string;
  arc: CoverageTraversalArc;
  serviceRole: "SERVICE" | "DUPLICATE_SERVICE";
  obligationIds: string[];
}

interface ShortestPath {
  cost: number;
  arcs: CoverageTraversalArc[];
}

interface ImbalanceNode {
  nodeKey: string;
  quantity: number;
}

interface ResidualEdge {
  to: number;
  reverse: number;
  capacity: number;
  cost: number;
  originalCapacity: number;
}

/**
 * Solves the exact closed directed Chinese Postman problem for a graph where
 * every traversable Arc is a full-Arc fixed-direction service obligation.
 * RPP, partial service, and strict turn automata are deliberately later phases.
 */
export function solveClosedDcpp(problem: CoverageProblem, traversableArcs: readonly CoverageTraversalArc[]): ClosedDcppSolution {
  const startedAt = Date.now();
  const deadline = startedAt + problem.budgets.timeLimitMs;
  if (problem.endpointMode !== "RETURN_TO_START" || problem.fixedEndState !== undefined) {
    throw new CoveragePlanningError("CAPABILITY_NOT_AVAILABLE", "closed DCPP requires RETURN_TO_START without a fixed end");
  }

  const arcs = validateGraphAndObligations(problem, traversableArcs);
  const obligationsByArc = new Map<string, RoadServiceObligation>();
  for (const obligation of problem.obligationSet.obligations) obligationsByArc.set(obligation.arcKey, obligation);

  const baseInstances: TraversalInstance[] = [];
  const balance = new Map<string, number>();
  for (const arc of arcs) {
    const obligation = obligationsByArc.get(arc.arcKey)!;
    for (let pass = 1; pass <= obligation.requiredPasses; pass += 1) {
      baseInstances.push({
        id: `required:${arc.arcKey}:${pass.toString().padStart(2, "0")}`,
        arc,
        serviceRole: "SERVICE",
        obligationIds: [obligation.obligationId]
      });
      addBalance(balance, arc.fromNodeKey, 1);
      addBalance(balance, arc.toNodeKey, -1);
    }
  }

  const supplies = sortedImbalances(balance, (value) => value < 0, (value) => -value);
  const demands = sortedImbalances(balance, (value) => value > 0, (value) => value);
  const matrixCellCount = supplies.length * demands.length;
  if (matrixCellCount > problem.budgets.maximumMatrixCells) {
    throw new CoveragePlanningError("RESOURCE_EXHAUSTED", `closed DCPP matrix requires ${matrixCellCount} cells`);
  }

  const shortestPaths = new Map<string, ShortestPath>();
  for (const supply of supplies) {
    for (const demand of demands) {
      checkDeadline(deadline);
      const path = shortestPath(arcs, supply.nodeKey, demand.nodeKey, deadline);
      shortestPaths.set(pairKey(supply.nodeKey, demand.nodeKey), path);
    }
  }

  const augmentation = minimumCostTransportation(supplies, demands, shortestPaths, deadline);
  const augmentedInstances: TraversalInstance[] = [];
  let duplicateSequence = 0;
  for (const item of augmentation) {
    const path = shortestPaths.get(pairKey(item.fromNodeKey, item.toNodeKey))!;
    for (let copy = 0; copy < item.quantity; copy += 1) {
      for (const arc of path.arcs) {
        duplicateSequence += 1;
        const obligation = obligationsByArc.get(arc.arcKey);
        augmentedInstances.push({
          id: `duplicate:${duplicateSequence.toString().padStart(9, "0")}:${arc.arcKey}`,
          arc,
          serviceRole: "DUPLICATE_SERVICE",
          obligationIds: obligation === undefined ? [] : [obligation.obligationId]
        });
      }
    }
  }

  const instances = [...baseInstances, ...augmentedInstances];
  if (instances.length > MAX_ROUTE_SEGMENTS) {
    throw new CoveragePlanningError("RESOURCE_EXHAUSTED", `closed DCPP route requires ${instances.length} traversals`);
  }
  const preferred = baseInstances.find((instance) => instance.arc.arcKey === problem.startState.arcKey)!;
  const circuit = eulerCircuit(instances, preferred, deadline);
  const segments = materializeExactTerminalCircuit(problem, circuit);
  const metrics = segments.reduce<FixedMetrics>((total, segment) => addMetrics(total, segment.metrics), ZERO_METRICS);
  const routeBody = {
    routeIndex: 1 as const,
    startState: structuredClone(problem.startState),
    endState: structuredClone(problem.startState),
    segments,
    boundaryEvents: [],
    metrics
  };
  const route = { ...routeBody, routeSignature: canonicalSha256(routeBody) };
  return {
    route,
    diagnostics: {
      solverVersion: "coverage-closed-dcpp/1.0",
      algorithmFamily: "CLOSED_DCPP",
      exactness: "EXACT",
      requiredComponentCount: weakComponentCount(arcs),
      imbalanceCount: supplies.length + demands.length,
      connectorPathCount: augmentation.reduce((total, item) => safeAdd(total, item.quantity), 0),
      candidatesGenerated: 1,
      candidatesVerified: 0,
      terminatedBy: "PROFILES_COMPLETE",
      elapsedMs: Math.max(0, Date.now() - startedAt),
      resourceMetrics: {
        traversableArcCount: arcs.length,
        requiredTraversalCount: baseInstances.length,
        augmentedTraversalCount: augmentedInstances.length,
        matrixCellCount
      }
    },
    augmentation
  };
}

function validateGraphAndObligations(problem: CoverageProblem, input: readonly CoverageTraversalArc[]): CoverageTraversalArc[] {
  if (input.length === 0) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "closed DCPP requires a non-empty traversable graph");
  const arcs = [...input].sort((left, right) => left.arcKey.localeCompare(right.arcKey));
  const byArc = new Map<string, CoverageTraversalArc>();
  for (const arc of arcs) {
    if (byArc.has(arc.arcKey)) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", `duplicate traversable Arc: ${arc.arcKey}`);
    if (arc.graphVersion !== problem.routingSnapshot.graphVersion) {
      throw new CoveragePlanningError("VERSION_NOT_FOUND", `Arc ${arc.arcKey} is not in the pinned graph version`);
    }
    if (arc.fromNodeKey.length === 0 || arc.toNodeKey.length === 0) {
      throw new CoveragePlanningError("NO_FEASIBLE_PLAN", `Arc ${arc.arcKey} has an invalid endpoint`);
    }
    validateMetrics(arc.metrics, arc.arcKey);
    byArc.set(arc.arcKey, arc);
  }
  const obligationArcs = new Set<string>();
  for (const obligation of problem.obligationSet.obligations) {
    if (obligation.graphVersion !== problem.routingSnapshot.graphVersion || !byArc.has(obligation.arcKey)) {
      throw new CoveragePlanningError("VERSION_NOT_FOUND", `obligation Arc is absent from the pinned graph: ${obligation.arcKey}`);
    }
    if (obligationArcs.has(obligation.arcKey)) {
      throw new CoveragePlanningError("CAPABILITY_NOT_AVAILABLE", `closed DCPP requires one full-Arc obligation per Arc: ${obligation.arcKey}`);
    }
    if (obligation.startFractionPpm !== 0 || obligation.endFractionPpm !== WHOLE_ARC_PPM) {
      throw new CoveragePlanningError("CAPABILITY_NOT_AVAILABLE", "partial service obligations require the fixed-direction RPP phase");
    }
    obligationArcs.add(obligation.arcKey);
  }
  if (obligationArcs.size !== arcs.length || arcs.some((arc) => !obligationArcs.has(arc.arcKey))) {
    throw new CoveragePlanningError("CAPABILITY_NOT_AVAILABLE", "closed DCPP requires R to contain every Arc in E");
  }
  const startArc = byArc.get(problem.startState.arcKey);
  if (startArc === undefined || startArc.direction !== problem.startState.direction) {
    throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "closed DCPP start state is not on a required directed Arc");
  }
  if (!Number.isSafeInteger(problem.startState.fractionPpm) || problem.startState.fractionPpm < 0 || problem.startState.fractionPpm > WHOLE_ARC_PPM) {
    throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "closed DCPP start fraction is invalid");
  }
  return arcs;
}

function shortestPath(arcs: readonly CoverageTraversalArc[], from: string, to: string, deadline: number): ShortestPath {
  if (from === to) return { cost: 0, arcs: [] };
  const nodes = [...new Set(arcs.flatMap((arc) => [arc.fromNodeKey, arc.toNodeKey]))].sort();
  const outgoing = new Map<string, CoverageTraversalArc[]>();
  for (const arc of arcs) {
    const list = outgoing.get(arc.fromNodeKey) ?? [];
    list.push(arc);
    outgoing.set(arc.fromNodeKey, list);
  }
  for (const list of outgoing.values()) list.sort((left, right) => left.arcKey.localeCompare(right.arcKey));
  const distance = new Map<string, number>(nodes.map((node) => [node, Number.POSITIVE_INFINITY]));
  const previous = new Map<string, CoverageTraversalArc>();
  const settled = new Set<string>();
  distance.set(from, 0);
  while (settled.size < nodes.length) {
    checkDeadline(deadline);
    let current: string | undefined;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const node of nodes) {
      const candidate = distance.get(node)!;
      if (!settled.has(node) && candidate < currentDistance) {
        current = node;
        currentDistance = candidate;
      }
    }
    if (current === undefined || !Number.isFinite(currentDistance)) break;
    if (current === to) break;
    settled.add(current);
    for (const arc of outgoing.get(current) ?? []) {
      const candidate = safeAdd(currentDistance, arc.metrics.combinedCostUnits);
      const existing = distance.get(arc.toNodeKey)!;
      if (candidate < existing) {
        distance.set(arc.toNodeKey, candidate);
        previous.set(arc.toNodeKey, arc);
      }
    }
  }
  const cost = distance.get(to);
  if (cost === undefined || !Number.isFinite(cost)) {
    throw new CoveragePlanningError("UNREACHABLE", `no directed connector from ${from} to ${to}`);
  }
  const path: CoverageTraversalArc[] = [];
  let cursor = to;
  while (cursor !== from) {
    const arc = previous.get(cursor);
    if (arc === undefined) throw new CoveragePlanningError("UNREACHABLE", `connector reconstruction failed from ${from} to ${to}`);
    path.push(arc);
    cursor = arc.fromNodeKey;
  }
  path.reverse();
  return { cost, arcs: path };
}

function minimumCostTransportation(
  supplies: readonly ImbalanceNode[],
  demands: readonly ImbalanceNode[],
  shortestPaths: ReadonlyMap<string, ShortestPath>,
  deadline: number
): ClosedDcppAugmentation[] {
  if (supplies.length === 0 && demands.length === 0) return [];
  const totalSupply = supplies.reduce((total, item) => safeAdd(total, item.quantity), 0);
  const totalDemand = demands.reduce((total, item) => safeAdd(total, item.quantity), 0);
  if (totalSupply !== totalDemand) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "directed imbalance totals are inconsistent");
  const source = 0;
  const supplyOffset = 1;
  const demandOffset = supplyOffset + supplies.length;
  const sink = demandOffset + demands.length;
  const graph: ResidualEdge[][] = Array.from({ length: sink + 1 }, () => []);
  const pairEdges = new Map<string, { node: number; edge: number }>();
  for (let index = 0; index < supplies.length; index += 1) addResidualEdge(graph, source, supplyOffset + index, supplies[index]!.quantity, 0);
  for (let supplyIndex = 0; supplyIndex < supplies.length; supplyIndex += 1) {
    for (let demandIndex = 0; demandIndex < demands.length; demandIndex += 1) {
      const supply = supplies[supplyIndex]!;
      const demand = demands[demandIndex]!;
      const node = supplyOffset + supplyIndex;
      const edge = graph[node]!.length;
      addResidualEdge(graph, node, demandOffset + demandIndex, totalSupply, shortestPaths.get(pairKey(supply.nodeKey, demand.nodeKey))!.cost);
      pairEdges.set(pairKey(supply.nodeKey, demand.nodeKey), { node, edge });
    }
  }
  for (let index = 0; index < demands.length; index += 1) addResidualEdge(graph, demandOffset + index, sink, demands[index]!.quantity, 0);

  let delivered = 0;
  while (delivered < totalSupply) {
    checkDeadline(deadline);
    const distance = Array<number>(graph.length).fill(Number.POSITIVE_INFINITY);
    const previousNode = Array<number>(graph.length).fill(-1);
    const previousEdge = Array<number>(graph.length).fill(-1);
    distance[source] = 0;
    for (let pass = 0; pass < graph.length - 1; pass += 1) {
      let changed = false;
      for (let node = 0; node < graph.length; node += 1) {
        if (!Number.isFinite(distance[node]!)) continue;
        for (let edgeIndex = 0; edgeIndex < graph[node]!.length; edgeIndex += 1) {
          const edge = graph[node]![edgeIndex]!;
          if (edge.capacity <= 0) continue;
          const candidate = safeSignedAdd(distance[node]!, edge.cost);
          if (candidate < distance[edge.to]!) {
            distance[edge.to] = candidate;
            previousNode[edge.to] = node;
            previousEdge[edge.to] = edgeIndex;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    if (!Number.isFinite(distance[sink]!)) throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "directed imbalance cannot be balanced");
    let quantity = totalSupply - delivered;
    for (let cursor = sink; cursor !== source; cursor = previousNode[cursor]!) {
      const node = previousNode[cursor]!;
      const edge = graph[node]![previousEdge[cursor]!]!;
      quantity = Math.min(quantity, edge.capacity);
    }
    for (let cursor = sink; cursor !== source; cursor = previousNode[cursor]!) {
      const node = previousNode[cursor]!;
      const edge = graph[node]![previousEdge[cursor]!]!;
      edge.capacity -= quantity;
      graph[cursor]![edge.reverse]!.capacity += quantity;
    }
    delivered = safeAdd(delivered, quantity);
  }

  const result: ClosedDcppAugmentation[] = [];
  for (const supply of supplies) {
    for (const demand of demands) {
      const key = pairKey(supply.nodeKey, demand.nodeKey);
      const reference = pairEdges.get(key)!;
      const edge = graph[reference.node]![reference.edge]!;
      const quantity = edge.originalCapacity - edge.capacity;
      if (quantity > 0) {
        const path = shortestPaths.get(key)!;
        result.push({
          fromNodeKey: supply.nodeKey,
          toNodeKey: demand.nodeKey,
          quantity,
          unitCost: path.cost,
          arcKeys: path.arcs.map((arc) => arc.arcKey)
        });
      }
    }
  }
  return result;
}

function eulerCircuit(instances: readonly TraversalInstance[], preferred: TraversalInstance, deadline: number): TraversalInstance[] {
  const outgoing = new Map<string, TraversalInstance[]>();
  for (const instance of instances) {
    const list = outgoing.get(instance.arc.fromNodeKey) ?? [];
    list.push(instance);
    outgoing.set(instance.arc.fromNodeKey, list);
  }
  for (const [node, list] of outgoing) {
    list.sort((left, right) => {
      if (node === preferred.arc.fromNodeKey) {
        if (left.id === preferred.id) return -1;
        if (right.id === preferred.id) return 1;
      }
      return left.arc.arcKey.localeCompare(right.arc.arcKey) || left.id.localeCompare(right.id);
    });
  }
  const cursors = new Map<string, number>();
  const used = new Set<string>();
  const nodeStack = [preferred.arc.fromNodeKey];
  const edgeStack: TraversalInstance[] = [];
  const reverseCircuit: TraversalInstance[] = [];
  while (nodeStack.length > 0) {
    checkDeadline(deadline);
    const node = nodeStack.at(-1)!;
    const list = outgoing.get(node) ?? [];
    let cursor = cursors.get(node) ?? 0;
    while (cursor < list.length && used.has(list[cursor]!.id)) cursor += 1;
    cursors.set(node, cursor);
    if (cursor < list.length) {
      const edge = list[cursor]!;
      used.add(edge.id);
      cursors.set(node, cursor + 1);
      nodeStack.push(edge.arc.toNodeKey);
      edgeStack.push(edge);
    } else {
      nodeStack.pop();
      const edge = edgeStack.pop();
      if (edge !== undefined) reverseCircuit.push(edge);
    }
  }
  const circuit = reverseCircuit.reverse();
  if (used.size !== instances.length || circuit.length !== instances.length || circuit[0]?.id !== preferred.id || circuit.at(-1)?.arc.toNodeKey !== preferred.arc.fromNodeKey) {
    throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "required directed graph does not admit one closed Euler traversal");
  }
  for (let index = 1; index < circuit.length; index += 1) {
    if (circuit[index - 1]!.arc.toNodeKey !== circuit[index]!.arc.fromNodeKey) {
      throw new CoveragePlanningError("NO_FEASIBLE_PLAN", "Euler traversal is discontinuous");
    }
  }
  return circuit;
}

function materializeExactTerminalCircuit(problem: CoverageProblem, circuit: readonly TraversalInstance[]) {
  const first = circuit[0]!;
  const fraction = problem.startState.fractionPpm;
  const materialized: Array<{
    graphVersion: string;
    arcKey: string;
    startFractionPpm: number;
    endFractionPpm: number;
    phase: "INSIDE";
    serviceRole: "SERVICE" | "DUPLICATE_SERVICE";
    obligationIds?: string[];
    sourceFeatureReferenceKey?: NonNullable<CoverageTraversalArc["sourceFeatureReferenceKey"]>;
    metrics: FixedMetrics;
  }> = [];
  const append = (instance: TraversalInstance, startFractionPpm: number, endFractionPpm: number): void => {
    if (startFractionPpm === endFractionPpm) return;
    materialized.push({
      graphVersion: instance.arc.graphVersion,
      arcKey: instance.arc.arcKey,
      startFractionPpm,
      endFractionPpm,
      phase: "INSIDE",
      serviceRole: instance.serviceRole,
      ...(instance.obligationIds.length === 0 ? {} : { obligationIds: instance.obligationIds }),
      ...(instance.arc.sourceFeatureReferenceKey === undefined ? {} : { sourceFeatureReferenceKey: instance.arc.sourceFeatureReferenceKey }),
      metrics: sliceMetrics(instance.arc.metrics, startFractionPpm, endFractionPpm)
    });
  };
  append(first, fraction, WHOLE_ARC_PPM);
  for (const instance of circuit.slice(1)) append(instance, 0, WHOLE_ARC_PPM);
  append(first, 0, fraction);
  return materialized.map((segment, index) => ({ sequence: index + 1, ...segment }));
}

function sliceMetrics(metrics: FixedMetrics, startFractionPpm: number, endFractionPpm: number): FixedMetrics {
  const slice = (value: number): number => {
    const start = (BigInt(value) * BigInt(startFractionPpm)) / BigInt(WHOLE_ARC_PPM);
    const end = (BigInt(value) * BigInt(endFractionPpm)) / BigInt(WHOLE_ARC_PPM);
    const result = Number(end - start);
    if (!Number.isSafeInteger(result) || result < 0) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "fixed-point metric slice overflowed");
    return result;
  };
  return {
    distanceMm: slice(metrics.distanceMm),
    durationMs: slice(metrics.durationMs),
    riskMicroUnits: slice(metrics.riskMicroUnits),
    energyMwh: slice(metrics.energyMwh),
    combinedCostUnits: slice(metrics.combinedCostUnits),
    turnPenaltyUnits: slice(metrics.turnPenaltyUnits ?? 0)
  };
}

function addMetrics(left: FixedMetrics, right: FixedMetrics): FixedMetrics {
  return {
    distanceMm: safeAdd(left.distanceMm, right.distanceMm),
    durationMs: safeAdd(left.durationMs, right.durationMs),
    riskMicroUnits: safeAdd(left.riskMicroUnits, right.riskMicroUnits),
    energyMwh: safeAdd(left.energyMwh, right.energyMwh),
    combinedCostUnits: safeAdd(left.combinedCostUnits, right.combinedCostUnits),
    turnPenaltyUnits: safeAdd(left.turnPenaltyUnits ?? 0, right.turnPenaltyUnits ?? 0)
  };
}

function validateMetrics(metrics: FixedMetrics, arcKey: string): void {
  const values = {
    distanceMm: metrics.distanceMm,
    durationMs: metrics.durationMs,
    riskMicroUnits: metrics.riskMicroUnits,
    energyMwh: metrics.energyMwh,
    combinedCostUnits: metrics.combinedCostUnits,
    turnPenaltyUnits: metrics.turnPenaltyUnits ?? 0
  };
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", `Arc ${arcKey} has invalid ${name}`);
  }
}

function addBalance(balance: Map<string, number>, node: string, delta: number): void {
  balance.set(node, safeSignedAdd(balance.get(node) ?? 0, delta));
}

function sortedImbalances(balance: ReadonlyMap<string, number>, predicate: (value: number) => boolean, quantity: (value: number) => number): ImbalanceNode[] {
  return [...balance.entries()]
    .filter(([, value]) => predicate(value))
    .map(([nodeKey, value]) => ({ nodeKey, quantity: quantity(value) }))
    .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey));
}

function addResidualEdge(graph: ResidualEdge[][], from: number, to: number, capacity: number, cost: number): void {
  const forward: ResidualEdge = { to, reverse: graph[to]!.length, capacity, cost, originalCapacity: capacity };
  const reverse: ResidualEdge = { to: from, reverse: graph[from]!.length, capacity: 0, cost: -cost, originalCapacity: 0 };
  graph[from]!.push(forward);
  graph[to]!.push(reverse);
}

function weakComponentCount(arcs: readonly CoverageTraversalArc[]): number {
  const adjacency = new Map<string, Set<string>>();
  for (const arc of arcs) {
    (adjacency.get(arc.fromNodeKey) ?? adjacency.set(arc.fromNodeKey, new Set()).get(arc.fromNodeKey)!).add(arc.toNodeKey);
    (adjacency.get(arc.toNodeKey) ?? adjacency.set(arc.toNodeKey, new Set()).get(arc.toNodeKey)!).add(arc.fromNodeKey);
  }
  const visited = new Set<string>();
  let count = 0;
  for (const node of [...adjacency.keys()].sort()) {
    if (visited.has(node)) continue;
    count += 1;
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const neighbour of adjacency.get(current) ?? []) if (!visited.has(neighbour)) stack.push(neighbour);
    }
  }
  return count;
}

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "closed DCPP time limit exceeded", { retryable: true });
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "fixed-point integer overflow");
  return result;
}

function safeSignedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new CoveragePlanningError("RESOURCE_EXHAUSTED", "integer overflow");
  return result;
}

function pairKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}
