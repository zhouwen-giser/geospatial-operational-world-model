import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { LoadedNetwork, NetworkArc, Row, RoutingSnapshotCurrentnessResult, TurnRule } from "../../../../packages/network-query-core/src/index.js";

export interface RouteFreshness { graphCurrent: boolean; profileCurrent: boolean; conditionCurrent: boolean; currentness?: RoutingSnapshotCurrentnessResult; }

export function verifyRouteCandidate(network: LoadedNetwork, candidateValue: unknown, freshness?: RouteFreshness): Row {
  const candidate = row(candidateValue); const segments = list(candidate.segments).map(row);
  const byKey = new Map(network.arcs.map((arc) => [arc.key, arc])); const checks: Row[] = [];
  const metrics = zeroMetrics(); const traversed: string[] = [];
  let identity = segments.length > 0, continuity = true, direction = true, fractions = true, turns = true, segmentMetrics = true, turnPenalty = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!; const arcKey = text(segment.arcKey, "segment.arcKey"); const arc = byKey.get(arcKey);
    if (!arc || segment.graphVersion !== network.routingSnapshot.graphVersion) { identity = false; continue; }
    const start = integer(segment.startFractionPpm, "startFractionPpm"); const end = integer(segment.endFractionPpm, "endFractionPpm");
    if (start > 1_000_000 || end > 1_000_000 || end < start) fractions = false;
    const previous = index === 0 ? undefined : byKey.get(text(segments[index - 1]!.arcKey, "segment.arcKey"));
    if (previous && previous.target !== arc.source) continuity = false;
    if (arc.direction !== "FORWARD" && arc.direction !== "REVERSE") direction = false;
    const effect = replayTurn(traversed, arc.key, network.turnRules); if (effect.forbidden) turns = false; turnPenalty += effect.penalty; traversed.push(arc.key);
    const expected = arcMetrics(arc, Math.max(0, end - start));
    for (const name of ["distanceMm", "durationMs", "riskMicroUnits", "energyMwh"] as const) if (segment[name] !== expected[name]) segmentMetrics = false;
    add(metrics, expected);
  }
  metrics.combinedCostUnits += turnPenalty;
  const supplied = row(candidate.metrics); const aggregateMetrics = Object.entries(metrics).every(([name, value]) => supplied[name] === value);
  const signature = sha256({ segments: segments.map((segment) => [segment.arcKey, segment.startFractionPpm, segment.endFractionPpm]) });
  const signatureValid = candidate.routeSignature === signature;
  checks.push({ code: "ARC_IDENTITY_VERSION", status: identity ? "PASS" : "FAIL" }, { code: "ARC_CONTINUITY", status: continuity ? "PASS" : "FAIL" }, { code: "DIRECTION", status: direction ? "PASS" : "FAIL" }, { code: "PARTIAL_FRACTIONS", status: fractions ? "PASS" : "FAIL" }, { code: "TURN_LEGALITY", status: turns ? "PASS" : "FAIL", details: { turnPenaltyUnits: turnPenalty } }, { code: "SEGMENT_METRICS", status: segmentMetrics ? "PASS" : "FAIL" }, { code: "AGGREGATE_METRICS", status: aggregateMetrics ? "PASS" : "FAIL", details: metrics }, { code: "ROUTE_SIGNATURE", status: signatureValid ? "PASS" : "FAIL" });
  const valid = identity && continuity && direction && fractions && turns && segmentMetrics && aggregateMetrics && signatureValid;
  const stale = valid && freshness !== undefined && (!freshness.graphCurrent || !freshness.profileCurrent || !freshness.conditionCurrent);
  if (freshness) checks.push({ code: "GRAPH_CURRENT", status: freshness.graphCurrent ? "PASS" : "FAIL" }, { code: "PROFILE_CURRENT", status: freshness.profileCurrent ? "PASS" : "FAIL" }, { code: "CONDITION_CURRENT", status: freshness.conditionCurrent ? "PASS" : "FAIL" });
  return { status: valid ? stale ? "STALE" : "VALID" : "INVALID", checks, verifierVersion: "gowm-route-independent-verifier/1.0.0", verifiedResultHash: sha256(candidate), warnings: stale ? [`The immutable route remains valid for its pinned snapshot; currentness is ${freshness?.currentness?.currentness ?? "STALE"}.`] : [] };
}

function replayTurn(history: string[], next: string, rules: TurnRule[]): { forbidden: boolean; penalty: number } { const candidate = [...history, next]; let penalty = 0; for (const rule of rules) { if (rule.ruleType === "ALLOWED_ONLY" && rule.sequence.length === 2 && history.at(-1) === rule.sequence[0] && next !== rule.sequence[1]) return { forbidden: true, penalty: 0 }; if (rule.sequence.length > candidate.length) continue; const suffix = candidate.slice(-rule.sequence.length); if (!suffix.every((key, index) => key === rule.sequence[index])) continue; if (rule.ruleType === "FORBIDDEN") return { forbidden: true, penalty: 0 }; if (rule.ruleType === "PENALTY") penalty += rule.penaltyUnits; } return { forbidden: false, penalty }; }
function arcMetrics(arc: NetworkArc, span: number) { return { distanceMm: fraction(arc.distanceMm, span), durationMs: fraction(arc.durationMs, span), riskMicroUnits: fraction(arc.riskMicroUnits, span), energyMwh: fraction(arc.energyMwh, span), combinedCostUnits: fraction(arc.combinedCostUnits + arc.conditionPenaltyUnits, span) }; }
function zeroMetrics() { return { distanceMm: 0, durationMs: 0, riskMicroUnits: 0, energyMwh: 0, combinedCostUnits: 0 }; }
function add(target: ReturnType<typeof zeroMetrics>, value: ReturnType<typeof arcMetrics>): void { for (const name of Object.keys(target) as Array<keyof typeof target>) target[name] += value[name]; }
function fraction(value: number, ppm: number): number { return Number((BigInt(value) * BigInt(ppm) + 500_000n) / 1_000_000n); }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function row(value: unknown): Row { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderProtocolError("INVALID_REQUEST", "route verifier expected an object"); return value as Row; }
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value) throw new ProviderProtocolError("INVALID_REQUEST", `${name} is required`); return value; }
function integer(value: unknown, name: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ProviderProtocolError("INVALID_REQUEST", `${name} must be a non-negative integer`); return parsed; }
