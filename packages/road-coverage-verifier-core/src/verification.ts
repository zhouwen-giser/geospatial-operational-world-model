import { canonicalSha256, compareUnicodeCodePoints } from "../../platform/contract-runtime/src/index.js";
import type {
  AdmittedVerifiedRoute,
  CoverageRoute,
  CoverageVerificationReport,
  FixedMetrics,
  VerifierNetworkArc,
  VerifierTravelPolicy,
  VerifierTurnRule,
  VerifyCoverageRouteInput
} from "./types.js";

const WHOLE = 1_000_000;
const ZERO: FixedMetrics = { distanceMm: 0, durationMs: 0, riskMicroUnits: 0, energyMwh: 0, combinedCostUnits: 0, turnPenaltyUnits: 0 };

interface Violation { code: string; message: string; segmentSequence?: number }
interface TurnState { history: string[]; valid: boolean; penaltyUnits: number }

export function verifyCoverageRoute(input: VerifyCoverageRouteInput): CoverageVerificationReport {
  const snapshotHash = canonicalSha256(input.problem.routingSnapshot);
  const violations: Violation[] = [];
  const stale = canonicalSha256(input.currentRoutingSnapshot) !== snapshotHash;
  if (stale) violations.push({ code: "STALE_ROUTING_SNAPSHOT", message: "candidate snapshot differs from the current graph/profile/condition snapshot" });
  const byArc = new Map<string, VerifierNetworkArc>();
  for (const arc of input.networkArcs) {
    if (byArc.has(arc.arcKey)) violations.push({ code: "DUPLICATE_ARC_IDENTITY", message: `duplicate authority Arc ${arc.arcKey}` });
    byArc.set(arc.arcKey, arc);
  }
  const rules = activeRules(input.turnRules ?? [], input.travelPolicy.profileKey);
  const maxHistory = Math.max(1, ...rules.map((rule) => rule.arcSequence.length - 1));
  let history: string[] = input.problem.startState.fractionPpm === WHOLE ? [input.problem.startState.arcKey] : [];
  let previousEnd: string | undefined;
  let recomputed = ZERO;
  let arcIdentity = true, continuity = true, direction = true, fractions = true, turns = true, profile = true, condition = true, metrics = true;
  const eligible = new Map<string, VerifierNetworkArc>();
  for (const arc of input.networkArcs) {
    const evaluated = evaluateArc(arc, input.travelPolicy);
    if (evaluated !== undefined) eligible.set(arc.arcKey, evaluated);
  }

  for (const segment of input.candidate.segments) {
    const authority = byArc.get(segment.arcKey);
    if (authority === undefined || authority.graphVersion !== segment.graphVersion || segment.graphVersion !== input.problem.routingSnapshot.graphVersion) {
      arcIdentity = false;
      violations.push({ code: "UNKNOWN_OR_WRONG_VERSION_ARC", message: `segment ${segment.sequence} does not identify a pinned authority Arc`, segmentSequence: segment.sequence });
      continue;
    }
    if (!Number.isSafeInteger(segment.startFractionPpm) || !Number.isSafeInteger(segment.endFractionPpm) || segment.startFractionPpm < 0 || segment.endFractionPpm > WHOLE || segment.startFractionPpm >= segment.endFractionPpm) {
      fractions = false;
      direction = false;
      violations.push({ code: "INVALID_FRACTION", message: `segment ${segment.sequence} has an empty, reversed, or out-of-range interval`, segmentSequence: segment.sequence });
      violations.push({ code: "ILLEGAL_DIRECTION", message: `segment ${segment.sequence} does not advance along its directed Arc`, segmentSequence: segment.sequence });
      continue;
    }
    const start = stateNode(authority, segment.startFractionPpm);
    const end = stateNode(authority, segment.endFractionPpm);
    if (previousEnd !== undefined && previousEnd !== start) {
      continuity = false;
      violations.push({ code: "DISCONTINUOUS_SEGMENT", message: `segment ${segment.sequence} does not start where the preceding segment ended`, segmentSequence: segment.sequence });
    }
    previousEnd = end;
    const turn = replayTurn(history, segment.arcKey, rules, maxHistory);
    history = turn.history;
    if (!turn.valid) {
      turns = false;
      violations.push({ code: "TURN_RESTRICTION_VIOLATION", message: `segment ${segment.sequence} completes a forbidden or non-allowed turn`, segmentSequence: segment.sequence });
    }
    const evaluated = eligible.get(segment.arcKey);
    if (evaluated === undefined) {
      profile = profile && profileEligible(authority, input.travelPolicy);
      condition = condition && authority.traversalAllowed !== false;
      violations.push({ code: authority.traversalAllowed === false ? "CONDITION_CLOSED_ARC" : "PROFILE_ILLEGAL_ARC", message: `segment ${segment.sequence} traverses an excluded Arc`, segmentSequence: segment.sequence });
      continue;
    }
    const expected = addTurnPenalty(sliceMetrics(evaluated.metrics, segment.startFractionPpm, segment.endFractionPpm), turn.penaltyUnits);
    if (!sameMetrics(expected, segment.metrics)) {
      metrics = false;
      violations.push({ code: "METRIC_MISMATCH", message: `segment ${segment.sequence} fixed metrics do not replay`, segmentSequence: segment.sequence });
    }
    try {
      recomputed = addMetrics(recomputed, expected);
    } catch {
      metrics = false;
      violations.push({ code: "METRIC_OVERFLOW", message: "recomputed route metrics exceed safe integer range", segmentSequence: segment.sequence });
    }
  }
  if (!sameMetrics(recomputed, input.candidate.metrics)) {
    metrics = false;
    violations.push({ code: "ROUTE_METRIC_MISMATCH", message: "route metrics do not equal independently recomputed segment totals" });
  }

  const endpointChecks = verifyEndpoints(input, byArc, violations);
  const boundary = verifyBoundaryPolicy(input, violations);
  const coverage = verifyCoverage(input, byArc, violations);
  const { routeSignature: _routeSignature, ...routeBody } = input.candidate;
  const resultHash = canonicalSha256(routeBody) === input.candidate.routeSignature;
  if (!resultHash) violations.push({ code: "CANDIDATE_HASH_MISMATCH", message: "routeSignature does not match canonical candidate content" });
  const status: CoverageVerificationReport["status"] = stale ? "STALE" : violations.length === 0 ? "VALID" : "INVALID";
  const checks = {
    snapshot: !stale,
    arcIdentity,
    continuity,
    direction,
    fractions,
    turns,
    coverage: coverage.valid,
    start: endpointChecks.start,
    end: endpointChecks.end,
    boundary,
    profile,
    condition,
    metrics,
    resultHash
  };
  const body = {
    status,
    verifierVersion: "coverage-verifier/1.1.0",
    routingSnapshotHash: snapshotHash,
    checks,
    coverageRatioPpm: coverage.coverageRatioPpm,
    lengthWeightedCoverageRatioPpm: coverage.lengthWeightedCoverageRatioPpm,
    requiredLengthMm: coverage.requiredLengthMm,
    coveredRequiredLengthMm: coverage.coveredRequiredLengthMm,
    recomputedMetrics: recomputed,
    violations
  };
  const identityHash = canonicalSha256(body);
  const verificationId = `verify_${identityHash.slice("sha256:".length)}`;
  return { ...body, verificationId, reportHash: canonicalSha256({ ...body, verificationId }) };
}

export function admitVerifiedCoverageRoute(route: CoverageRoute, verification: CoverageVerificationReport): AdmittedVerifiedRoute {
  if (verification.status !== "VALID" || Object.values(verification.checks).some((passed) => !passed)) {
    throw new Error(`only an independently VALID coverage route can be admitted: ${verification.status}; ${verification.violations.map((violation) => violation.code).join(",")}`);
  }
  const { reportHash: _reportHash, ...reportBody } = verification;
  if (canonicalSha256(reportBody) !== verification.reportHash) throw new Error("verification receipt hash mismatch");
  const { routeSignature: _routeSignature, ...routeBody } = route;
  if (canonicalSha256(routeBody) !== route.routeSignature) throw new Error("candidate route hash mismatch at admission");
  return { route: structuredClone(route), verification: structuredClone(verification), admissionHash: canonicalSha256({ routeSignature: route.routeSignature, reportHash: verification.reportHash }) };
}

function verifyEndpoints(input: VerifyCoverageRouteInput, byArc: ReadonlyMap<string, VerifierNetworkArc>, violations: Violation[]): { start: boolean; end: boolean } {
  let start = canonicalSha256(input.candidate.startState) === canonicalSha256(input.problem.startState);
  const expectedEnd = input.problem.endpointMode === "FIXED_END" ? input.problem.fixedEndState : input.problem.endpointMode === "LAST_AREA_EXIT" ? input.candidate.endState : input.problem.startState;
  let end = expectedEnd !== undefined && canonicalSha256(input.candidate.endState) === canonicalSha256(expectedEnd);
  const first = input.candidate.segments[0], last = input.candidate.segments.at(-1);
  const startArc = byArc.get(input.problem.startState.arcKey), endArc = expectedEnd === undefined ? undefined : byArc.get(expectedEnd.arcKey);
  if (first === undefined || startArc === undefined || stateNode(startArc, input.problem.startState.fractionPpm) !== segmentStartNode(first, byArc)) start = false;
  if (last === undefined || endArc === undefined || stateNode(endArc, expectedEnd!.fractionPpm) !== segmentEndNode(last, byArc)) end = false;
  if (!start) violations.push({ code: "START_STATE_MISMATCH", message: "candidate does not start at the exact problem state" });
  if (!end) violations.push({ code: "END_STATE_MISMATCH", message: "candidate does not end at the exact endpoint-mode terminal" });
  return { start, end };
}

function verifyBoundaryPolicy(input: VerifyCoverageRouteInput, violations: Violation[]): boolean {
  const events = input.authoritativeBoundaryEvents as Array<Record<string, unknown>> | undefined;
  if (events === undefined) {
    if (input.problem.boundaryCrossingPolicy === "FREE" && input.problem.endpointMode !== "LAST_AREA_EXIT") return true;
    violations.push({ code: "BOUNDARY_AUTHORITY_UNAVAILABLE", message: "independent versioned boundary reconstruction is required for this policy" });
    return false;
  }
  const validShape = events.every((event, index) => event.sequence === index + 1 && (event.kind === "ENTRY" || event.kind === "EXIT") && typeof event.state === "object" && event.state !== null);
  let valid = validShape;
  const entries = events.filter((event) => event.kind === "ENTRY");
  if (input.problem.boundaryCrossingPolicy === "FIRST_ENTRY_ONLY") {
    if (input.boundaryStartInside === undefined) valid = false;
    else if (input.boundaryStartInside) {
      let exited = false;
      for (const event of events) { if (event.kind === "EXIT") exited = true; if (event.kind === "ENTRY" && exited) valid = false; }
    } else valid = valid && entries.length === 1;
  }
  if (input.problem.boundaryCrossingPolicy === "ENTRY_SET_ONLY") {
    const allowed = new Set((input.problem.entryStates ?? []).map((state) => canonicalSha256(state)));
    valid = valid && entries.every((event) => allowed.has(canonicalSha256(event.state)));
  }
  if (input.problem.boundaryCrossingPolicy === "NO_REENTRY") {
    let exited = false;
    for (const event of events) { if (event.kind === "EXIT") exited = true; if (event.kind === "ENTRY" && exited) valid = false; }
  }
  if (input.problem.endpointMode === "LAST_AREA_EXIT") {
    const lastExit = [...events].reverse().find((event) => event.kind === "EXIT");
    valid = valid && lastExit !== undefined && canonicalSha256(lastExit.state) === canonicalSha256(input.candidate.endState);
  }
  if (!valid) violations.push({ code: "BOUNDARY_POLICY_VIOLATION", message: "boundary events violate the canonical crossing or terminal policy" });
  return valid;
}

function verifyCoverage(input: VerifyCoverageRouteInput, byArc: ReadonlyMap<string, VerifierNetworkArc>, violations: Violation[]) {
  let totalPasses = 0, coveredPasses = 0, requiredLengthMm = 0, coveredRequiredLengthMm = 0;
  for (const obligation of input.problem.obligationSet.obligations) {
    const arc = byArc.get(obligation.arcKey);
    if (arc === undefined) continue;
    const service = input.candidate.segments.filter((segment) => segment.serviceRole === "SERVICE" && segment.obligationIds?.includes(obligation.obligationId));
    for (const segment of service) if (segment.arcKey !== obligation.arcKey) violations.push({ code: "OBLIGATION_ARC_MISMATCH", message: `obligation ${obligation.obligationId} is claimed on another Arc`, segmentSequence: segment.sequence });
    const boundaries = new Set([obligation.startFractionPpm, obligation.endFractionPpm]);
    for (const segment of service.filter((item) => item.arcKey === obligation.arcKey)) {
      boundaries.add(Math.max(obligation.startFractionPpm, segment.startFractionPpm));
      boundaries.add(Math.min(obligation.endFractionPpm, segment.endFractionPpm));
    }
    const points = [...boundaries].filter((value) => value >= obligation.startFractionPpm && value <= obligation.endFractionPpm).sort((left, right) => left - right);
    let actualPasses = Number.POSITIVE_INFINITY;
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1]!, end = points[index]!;
      if (start === end) continue;
      actualPasses = Math.min(actualPasses, service.filter((segment) => segment.arcKey === obligation.arcKey && segment.startFractionPpm <= start && segment.endFractionPpm >= end).length);
    }
    if (!Number.isFinite(actualPasses)) actualPasses = 0;
    const fulfilled = Math.min(actualPasses, obligation.requiredPasses);
    totalPasses = safeAdd(totalPasses, obligation.requiredPasses);
    coveredPasses = safeAdd(coveredPasses, fulfilled);
    const onePassLength = sliceMetrics(arc.metrics, obligation.startFractionPpm, obligation.endFractionPpm).distanceMm;
    requiredLengthMm = safeAdd(requiredLengthMm, safeMultiply(onePassLength, obligation.requiredPasses));
    coveredRequiredLengthMm = safeAdd(coveredRequiredLengthMm, safeMultiply(onePassLength, fulfilled));
    if (actualPasses < obligation.requiredPasses) violations.push({ code: "OBLIGATION_PASS_DEFICIT", message: `obligation ${obligation.obligationId} has ${actualPasses}/${obligation.requiredPasses} complete passes` });
  }
  const coverageRatioPpm = ratio(coveredPasses, totalPasses);
  const lengthWeightedCoverageRatioPpm = ratio(coveredRequiredLengthMm, requiredLengthMm);
  return { valid: coverageRatioPpm === WHOLE, coverageRatioPpm, lengthWeightedCoverageRatioPpm, requiredLengthMm, coveredRequiredLengthMm };
}

function replayTurn(history: readonly string[], nextArc: string, rules: readonly VerifierTurnRule[], maxHistory: number): TurnState {
  if (history.at(-1) === nextArc) return { history: [...history], valid: true, penaltyUnits: 0 };
  for (const rule of rules) if (rule.ruleType === "ALLOWED_ONLY" && history.at(-1) === rule.arcSequence[0] && nextArc !== rule.arcSequence[1]) return { history: [...history], valid: false, penaltyUnits: 0 };
  const candidate = [...history, nextArc]; let penaltyUnits = 0;
  for (const rule of rules) {
    if (rule.ruleType === "ALLOWED_ONLY" || rule.arcSequence.length > candidate.length) continue;
    const suffix = candidate.slice(-rule.arcSequence.length);
    if (!suffix.every((value, index) => value === rule.arcSequence[index])) continue;
    if (rule.ruleType === "FORBIDDEN") return { history: candidate.slice(-maxHistory), valid: false, penaltyUnits: 0 };
    penaltyUnits = safeAdd(penaltyUnits, rule.penaltyUnits ?? 0);
  }
  return { history: candidate.slice(-maxHistory), valid: true, penaltyUnits };
}

function evaluateArc(arc: VerifierNetworkArc, policy: VerifierTravelPolicy): VerifierNetworkArc | undefined {
  if (arc.traversalAllowed === false || !profileEligible(arc, policy)) return undefined;
  validateMetrics(arc.metrics);
  const speeds = [arc.speedOverrideMmPerS, policy.maximumSpeedMmPerS, arc.speedMmPerS].filter((value): value is number => value !== undefined);
  const speed = speeds.length === 0 ? undefined : Math.min(...speeds);
  if (speed !== undefined && (!Number.isSafeInteger(speed) || speed <= 0)) return undefined;
  const durationMs = speed === undefined ? arc.metrics.durationMs : ceilRatio(arc.metrics.distanceMm, 1_000, speed);
  const riskMicroUnits = arc.riskOverrideMicroUnits ?? arc.metrics.riskMicroUnits;
  const base = { ...arc.metrics, durationMs, riskMicroUnits };
  // Objective scores choose a route; they must not replace its pinned cost-profile metrics.
  return { ...arc, metrics: { ...base, combinedCostUnits: safeAdd(base.combinedCostUnits, arc.conditionPenaltyUnits ?? 0), turnPenaltyUnits: 0 } };
}

function profileEligible(arc: VerifierNetworkArc, policy: VerifierTravelPolicy): boolean {
  return !(policy.allowedRoadClasses !== undefined && (arc.roadClass === undefined || !policy.allowedRoadClasses.includes(arc.roadClass))) &&
    !(policy.allowedSurfaces !== undefined && (arc.surface === undefined || !policy.allowedSurfaces.includes(arc.surface))) &&
    ((arc.accessMask ?? 0) & (policy.requiredAccessMask ?? 0)) === (policy.requiredAccessMask ?? 0);
}

function activeRules(rules: readonly VerifierTurnRule[], profileKey: string): VerifierTurnRule[] { return [...rules].filter((rule) => rule.travelProfileKeys === undefined || rule.travelProfileKeys.includes(profileKey)).sort((left, right) => compareUnicodeCodePoints(left.ruleKey, right.ruleKey)); }
function segmentStartNode(segment: CoverageRoute["segments"][number], arcs: ReadonlyMap<string, VerifierNetworkArc>): string | undefined { const arc = arcs.get(segment.arcKey); return arc === undefined ? undefined : stateNode(arc, segment.startFractionPpm); }
function segmentEndNode(segment: CoverageRoute["segments"][number], arcs: ReadonlyMap<string, VerifierNetworkArc>): string | undefined { const arc = arcs.get(segment.arcKey); return arc === undefined ? undefined : stateNode(arc, segment.endFractionPpm); }
function stateNode(arc: VerifierNetworkArc, fraction: number): string { return fraction === 0 ? `node:${arc.fromNodeKey}` : fraction === WHOLE ? `node:${arc.toNodeKey}` : `state:${arc.arcKey}:${fraction.toString().padStart(7, "0")}`; }

function sliceMetrics(metrics: FixedMetrics, start: number, end: number): FixedMetrics { const slice = (value: number) => Number((BigInt(value) * BigInt(end)) / BigInt(WHOLE) - (BigInt(value) * BigInt(start)) / BigInt(WHOLE)); return { distanceMm: slice(metrics.distanceMm), durationMs: slice(metrics.durationMs), riskMicroUnits: slice(metrics.riskMicroUnits), energyMwh: slice(metrics.energyMwh), combinedCostUnits: slice(metrics.combinedCostUnits), turnPenaltyUnits: slice(metrics.turnPenaltyUnits ?? 0) }; }
function addTurnPenalty(metrics: FixedMetrics, penalty: number): FixedMetrics { return penalty === 0 ? metrics : { ...metrics, combinedCostUnits: safeAdd(metrics.combinedCostUnits, penalty), turnPenaltyUnits: safeAdd(metrics.turnPenaltyUnits ?? 0, penalty) }; }
function addMetrics(left: FixedMetrics, right: FixedMetrics): FixedMetrics { return { distanceMm: safeAdd(left.distanceMm, right.distanceMm), durationMs: safeAdd(left.durationMs, right.durationMs), riskMicroUnits: safeAdd(left.riskMicroUnits, right.riskMicroUnits), energyMwh: safeAdd(left.energyMwh, right.energyMwh), combinedCostUnits: safeAdd(left.combinedCostUnits, right.combinedCostUnits), turnPenaltyUnits: safeAdd(left.turnPenaltyUnits ?? 0, right.turnPenaltyUnits ?? 0) }; }
function sameMetrics(left: FixedMetrics, right: FixedMetrics): boolean { return left.distanceMm === right.distanceMm && left.durationMs === right.durationMs && left.riskMicroUnits === right.riskMicroUnits && left.energyMwh === right.energyMwh && left.combinedCostUnits === right.combinedCostUnits && (left.turnPenaltyUnits ?? 0) === (right.turnPenaltyUnits ?? 0); }
function validateMetrics(metrics: FixedMetrics): void { for (const value of [metrics.distanceMm, metrics.durationMs, metrics.riskMicroUnits, metrics.energyMwh, metrics.combinedCostUnits, metrics.turnPenaltyUnits ?? 0]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid metrics"); }
function ratio(numerator: number, denominator: number): number { return denominator === 0 ? WHOLE : Number((BigInt(numerator) * BigInt(WHOLE)) / BigInt(denominator)); }
function ceilRatio(value: number, multiplier: number, divisor: number): number { return Number((BigInt(value) * BigInt(multiplier) + BigInt(divisor) - 1n) / BigInt(divisor)); }
function safeAdd(left: number, right: number): number { const result = left + right; if (!Number.isSafeInteger(result) || result < 0) throw new Error("safe integer overflow"); return result; }
function safeMultiply(left: number, right: number): number { const result = left * right; if (!Number.isSafeInteger(result) || result < 0) throw new Error("safe integer overflow"); return result; }
