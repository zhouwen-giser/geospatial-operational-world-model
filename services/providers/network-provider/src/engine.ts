import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { DirectedState, LoadedNetwork, NetworkArc, RoutingSnapshot, Row, TurnRule } from "./types.js";

export type Objective = "SHORTEST_DISTANCE" | "FASTEST" | "LOWEST_RISK" | "LOWEST_ENERGY" | "WEIGHTED";

interface Label {
  node: string;
  history: string[];
  arcKeys: string[];
  objectiveCost: number;
  turnPenalty: number;
}

interface CandidatePath {
  arcs: NetworkArc[];
  turnPenalty: number;
}

export function shortestPath(
  network: LoadedNetwork,
  start: DirectedState,
  destination: DirectedState,
  objective: Objective,
  maximumSegments: number,
  ignoreSoftPenalties = false,
  nowMs: () => number = Date.now,
  deadlineAtMs = Number.POSITIVE_INFINITY,
  excludedArcKeys: ReadonlySet<string> = new Set()
): Row {
  assertState(start);
  assertState(destination);
  const byKey = new Map(network.arcs.map((arc) => [arc.key, arc]));
  const startArc = byKey.get(start.arcKey);
  const destinationArc = byKey.get(destination.arcKey);
  if (!startArc || !destinationArc || excludedArcKeys.has(start.arcKey) || excludedArcKeys.has(destination.arcKey) || startArc.direction !== start.direction || destinationArc.direction !== destination.direction) {
    return noPath(network.routingSnapshot);
  }
  if (startArc.key === destinationArc.key && destination.fractionPpm >= start.fractionPpm) {
    return complete(network.routingSnapshot, [{ arc: startArc, from: start.fractionPpm, to: destination.fractionPpm }], 0);
  }

  const maxHistory = Math.max(1, ...network.turnRules.map((rule) => rule.sequence.length - 1));
  const outgoing = new Map<string, NetworkArc[]>();
  for (const arc of network.arcs) {
    if (excludedArcKeys.has(arc.key)) continue;
    const values = outgoing.get(arc.source) ?? [];
    values.push(arc);
    outgoing.set(arc.source, values);
  }
  for (const values of outgoing.values()) values.sort((a, b) => a.key.localeCompare(b.key));

  const initialFraction = 1_000_000 - start.fractionPpm;
  const initial: Label = {
    node: startArc.target,
    history: [startArc.key].slice(-maxHistory),
    arcKeys: [startArc.key],
    objectiveCost: fraction(metric(startArc, objective), initialFraction),
    turnPenalty: 0
  };
  const queue: Label[] = [initial];
  const best = new Map<string, number>([[stateKey(initial.node, initial.history), initial.objectiveCost]]);
  let chosen: CandidatePath | undefined;

  while (queue.length > 0) {
    assertDeadline(nowMs, deadlineAtMs);
    queue.sort((a, b) => a.objectiveCost - b.objectiveCost || a.arcKeys.join("\0").localeCompare(b.arcKeys.join("\0")));
    const current = queue.shift();
    if (!current) break;
    if (current.arcKeys.length > maximumSegments) throw new ProviderProtocolError("BUDGET_EXCEEDED", "network segment budget exceeded", { details: { maximumSegments } });
    const currentKey = stateKey(current.node, current.history);
    if (current.objectiveCost !== best.get(currentKey)) continue;

    if (current.node === destinationArc.source) {
      const transition = turnEffect(current.history, destinationArc.key, network.turnRules, ignoreSoftPenalties);
      if (!transition.forbidden) {
        const keys = [...current.arcKeys, destinationArc.key];
        if (keys.length > maximumSegments) throw new ProviderProtocolError("BUDGET_EXCEEDED", "network segment budget exceeded", { details: { maximumSegments } });
        const arcs = keys.map((key) => byKey.get(key)).filter((arc): arc is NetworkArc => arc !== undefined);
        chosen = { arcs, turnPenalty: current.turnPenalty + transition.penalty };
        break;
      }
    }

    for (const next of outgoing.get(current.node) ?? []) {
      const transition = turnEffect(current.history, next.key, network.turnRules, ignoreSoftPenalties);
      if (transition.forbidden) continue;
      const history = [...current.history, next.key].slice(-maxHistory);
      const objectiveCost = current.objectiveCost + metric(next, objective) + transition.penalty;
      const key = stateKey(next.target, history);
      if (objectiveCost >= (best.get(key) ?? Number.POSITIVE_INFINITY)) continue;
      best.set(key, objectiveCost);
      queue.push({
        node: next.target,
        history,
        arcKeys: [...current.arcKeys, next.key],
        objectiveCost,
        turnPenalty: current.turnPenalty + transition.penalty
      });
    }
  }

  if (!chosen) return noPath(network.routingSnapshot);
  const slices = chosen.arcs.map((arc, index) => ({
    arc,
    from: index === 0 ? start.fractionPpm : 0,
    to: index === chosen.arcs.length - 1 ? destination.fractionPpm : 1_000_000
  }));
  return complete(network.routingSnapshot, slices, chosen.turnPenalty);
}

export function verifyPath(network: LoadedNetwork, input: Row): Row {
  const segments = Array.isArray(input.segments) ? input.segments.map(asRow) : [];
  const byKey = new Map(network.arcs.map((arc) => [arc.key, arc]));
  const checks: Row[] = [];
  let continuity = true;
  let legal = true;
  let metricMatch = true;
  let turnPenalty = 0;
  const recomputed = zeroMetrics();
  const keys: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const arc = byKey.get(requiredString(segment.arcKey, "segment.arcKey"));
    if (!arc) { continuity = false; legal = false; continue; }
    keys.push(arc.key);
    const from = integer(segment.startFractionPpm, "startFractionPpm");
    const to = integer(segment.endFractionPpm, "endFractionPpm");
    if (to < from || from > 1_000_000 || to > 1_000_000) continuity = false;
    const previous = index > 0 ? byKey.get(requiredString(segments[index - 1]!.arcKey, "segment.arcKey")) : undefined;
    if (previous && previous.target !== arc.source) continuity = false;
    const effect = turnEffect(keys.slice(0, -1), arc.key, network.turnRules, false);
    if (effect.forbidden) legal = false;
    turnPenalty += effect.penalty;
    addArcMetrics(recomputed, arc, Math.max(0, to - from));
    for (const [field, expected] of [
      ["distanceMm", fraction(arc.distanceMm, Math.max(0, to - from))],
      ["durationMs", fraction(arc.durationMs, Math.max(0, to - from))],
      ["riskMicroUnits", fraction(arc.riskMicroUnits, Math.max(0, to - from))],
      ["energyMwh", fraction(arc.energyMwh, Math.max(0, to - from))]
    ] as const) if (segment[field] !== undefined && segment[field] !== expected) metricMatch = false;
  }
  recomputed.combinedCostUnits += turnPenalty;
  const suppliedMetrics = isRow(input.metrics) ? input.metrics : {};
  for (const [field, value] of Object.entries(recomputed)) if (suppliedMetrics[field] !== value) metricMatch = false;
  checks.push({ code: "ARC_CONTINUITY", status: continuity ? "PASS" : "FAIL" });
  checks.push({ code: "TURN_LEGALITY", status: legal ? "PASS" : "FAIL", details: { turnPenaltyUnits: turnPenalty } });
  checks.push({ code: "METRIC_REPLAY", status: metricMatch ? "PASS" : "FAIL", details: recomputed });
  const resultHashValid = input.resultHash === hashPathInput(input);
  checks.push({ code: "RESULT_HASH", status: resultHashValid ? "PASS" : "FAIL" });
  const valid = continuity && legal && metricMatch && resultHashValid;
  return {
    status: valid ? "VALID" : "INVALID",
    checks,
    verifierVersion: "gowm-network-independent-verifier/1.0.0",
    verifiedResultHash: sha256(input)
  };
}

export function matrix(network: LoadedNetwork, points: DirectedState[], objective: Objective, maximumSegments: number, nowMs: () => number, deadlineAtMs: number): Row {
  const entries: Row[] = [];
  for (let fromIndex = 0; fromIndex < points.length; fromIndex += 1) {
    for (let toIndex = 0; toIndex < points.length; toIndex += 1) {
      if (fromIndex === toIndex) { entries.push({ fromIndex, toIndex, reachable: true, costUnits: 0 }); continue; }
      const path = shortestPath(network, points[fromIndex]!, points[toIndex]!, objective, maximumSegments, false, nowMs, deadlineAtMs);
      const reachable = path.status === "COMPLETED";
      entries.push({ fromIndex, toIndex, reachable, ...(reachable ? { costUnits: metricFromOutput(path, objective) } : {}) });
    }
  }
  const core = { routingSnapshot: network.routingSnapshot, pointCount: points.length, entries };
  return { ...core, resultHash: sha256(core) };
}

function complete(snapshot: RoutingSnapshot, slices: Array<{ arc: NetworkArc; from: number; to: number }>, turnPenalty: number): Row {
  const metrics = zeroMetrics();
  const segments = slices.map(({ arc, from, to }, index) => {
    const span = Math.max(0, to - from);
    const segment: Row = {
      graphVersion: snapshot.graphVersion,
      arcKey: arc.key,
      startFractionPpm: from,
      endFractionPpm: to,
      segmentRole: "ROUTE",
      distanceMm: fraction(arc.distanceMm, span),
      durationMs: fraction(arc.durationMs, span),
      riskMicroUnits: fraction(arc.riskMicroUnits, span),
      energyMwh: fraction(arc.energyMwh, span),
      turnPenaltyUnits: index === slices.length - 1 ? turnPenalty : 0,
      ...(arc.sourceFeatureReferenceKey === undefined ? {} : { sourceFeatureReferenceKey: arc.sourceFeatureReferenceKey })
    };
    addArcMetrics(metrics, arc, span);
    return segment;
  });
  metrics.combinedCostUnits += turnPenalty;
  const core = { status: "COMPLETED", routingSnapshot: snapshot, segments, metrics, warnings: [] as string[] };
  return { ...core, resultHash: sha256(core) };
}

function noPath(snapshot: RoutingSnapshot): Row {
  const core = { status: "NO_PATH", routingSnapshot: snapshot, segments: [] as Row[], metrics: zeroMetrics(), warnings: [] as string[] };
  return { ...core, resultHash: sha256(core) };
}

function turnEffect(history: string[], next: string, rules: TurnRule[], ignoreSoft: boolean): { forbidden: boolean; penalty: number } {
  const candidate = [...history, next];
  let penalty = 0;
  for (const rule of rules) {
    if (rule.ruleType === "ALLOWED_ONLY" && rule.sequence.length === 2 && history.at(-1) === rule.sequence[0] && next !== rule.sequence[1]) {
      return { forbidden: true, penalty: 0 };
    }
    if (rule.sequence.length > candidate.length) continue;
    const suffix = candidate.slice(-rule.sequence.length);
    if (!suffix.every((key, index) => key === rule.sequence[index])) continue;
    if (rule.ruleType === "FORBIDDEN") return { forbidden: true, penalty: 0 };
    if (!ignoreSoft) penalty += rule.penaltyUnits;
  }
  return { forbidden: false, penalty };
}

function metric(arc: NetworkArc, objective: Objective): number {
  if (objective === "SHORTEST_DISTANCE") return arc.distanceMm;
  if (objective === "FASTEST") return arc.durationMs;
  if (objective === "LOWEST_RISK") return arc.riskMicroUnits;
  if (objective === "LOWEST_ENERGY") return arc.energyMwh;
  return arc.combinedCostUnits + arc.conditionPenaltyUnits;
}

function metricFromOutput(path: Row, objective: Objective): number {
  const metrics = asRow(path.metrics);
  if (objective === "SHORTEST_DISTANCE") return integer(metrics.distanceMm, "distanceMm");
  if (objective === "FASTEST") return integer(metrics.durationMs, "durationMs");
  if (objective === "LOWEST_RISK") return integer(metrics.riskMicroUnits, "riskMicroUnits");
  if (objective === "LOWEST_ENERGY") return integer(metrics.energyMwh, "energyMwh");
  return integer(metrics.combinedCostUnits, "combinedCostUnits");
}

function zeroMetrics(): { distanceMm: number; durationMs: number; riskMicroUnits: number; energyMwh: number; combinedCostUnits: number } {
  return { distanceMm: 0, durationMs: 0, riskMicroUnits: 0, energyMwh: 0, combinedCostUnits: 0 };
}

function addArcMetrics(metrics: ReturnType<typeof zeroMetrics>, arc: NetworkArc, span: number): void {
  metrics.distanceMm += fraction(arc.distanceMm, span);
  metrics.durationMs += fraction(arc.durationMs, span);
  metrics.riskMicroUnits += fraction(arc.riskMicroUnits, span);
  metrics.energyMwh += fraction(arc.energyMwh, span);
  metrics.combinedCostUnits += fraction(arc.combinedCostUnits + arc.conditionPenaltyUnits, span);
}

function fraction(value: number, fractionPpm: number): number {
  return Number((BigInt(value) * BigInt(fractionPpm) + 500_000n) / 1_000_000n);
}

function hashPathInput(input: Row): `sha256:${string}` {
  const { resultHash: _ignored, ...core } = input;
  return sha256(core);
}

function stateKey(node: string, history: string[]): string { return `${node}|${history.join(",")}`; }
function assertDeadline(nowMs: () => number, deadlineAtMs: number): void { if (nowMs() >= deadlineAtMs) throw new ProviderProtocolError("DEADLINE_EXCEEDED", "network computation deadline exceeded"); }
function assertState(value: DirectedState): void { if (!Number.isSafeInteger(value.fractionPpm) || value.fractionPpm < 0 || value.fractionPpm > 1_000_000) throw new ProviderProtocolError("INVALID_REQUEST", "directed-state fraction is invalid"); }
function isRow(value: unknown): value is Row { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function asRow(value: unknown): Row { if (!isRow(value)) throw new ProviderProtocolError("INVALID_REQUEST", "expected object"); return value; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new ProviderProtocolError("INVALID_REQUEST", `${name} is required`); return value; }
function integer(value: unknown, name: string): number { const number = typeof value === "number" ? value : Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new ProviderProtocolError("INVALID_REQUEST", `${name} must be a non-negative integer`); return number; }
