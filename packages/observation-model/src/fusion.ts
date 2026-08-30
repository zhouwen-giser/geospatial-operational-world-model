import type { CurrentProjection, ObservationEnvelope, ProjectionDecision } from "../../world-model-core/src/types.js";
import { compareUnicodeCodePoints } from "../../platform/contract-runtime/src/index.js";

export interface FusionPolicy {
  sourcePriorities: Record<string, number>;
  conflictWindowMs: number;
  maxOutOfOrderMs: number;
}

function priority(source: string, priorities: Record<string, number>): number {
  return priorities[source.toLowerCase()] ?? 0;
}

export function decideProjection(
  current: CurrentProjection | undefined,
  observation: ObservationEnvelope,
  policy: FusionPolicy
): ProjectionDecision {
  if (!current) return { apply: true, reason: "new" };

  const incomingTime = Date.parse(observation.observedAt);
  const currentTime = Date.parse(current.observedAt);
  const delta = incomingTime - currentTime;

  if (delta > policy.conflictWindowMs) return { apply: true, reason: "newer" };
  if (delta < -policy.maxOutOfOrderMs) return { apply: false, reason: "out-of-order" };

  const incomingPriority = priority(observation.source, policy.sourcePriorities);
  const currentPriority = priority(current.source, policy.sourcePriorities);
  if (incomingPriority !== currentPriority) {
    return incomingPriority > currentPriority
      ? { apply: true, reason: "higher-priority" }
      : { apply: false, reason: "superseded" };
  }

  if (observation.confidence !== current.confidence) {
    return observation.confidence > current.confidence
      ? { apply: true, reason: "higher-confidence" }
      : { apply: false, reason: "superseded" };
  }

  if (incomingTime !== currentTime) {
    return incomingTime > currentTime
      ? { apply: true, reason: "newer" }
      : { apply: false, reason: "out-of-order" };
  }

  return compareUnicodeCodePoints(observation.observationId, current.sourceObservationId) > 0
    ? { apply: true, reason: "tie-break" }
    : { apply: false, reason: "superseded" };
}

export function validateObservationTime(
  observation: ObservationEnvelope,
  nowMs: number,
  maxFutureSkewMs: number,
  maxLateArrivalMs: number
): { valid: boolean; reason?: "bad_timestamp" | "future" | "late" } {
  const observedMs = Date.parse(observation.observedAt);
  const receivedMs = Date.parse(observation.receivedAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(receivedMs)) return { valid: false, reason: "bad_timestamp" };
  if (observedMs > nowMs + maxFutureSkewMs || receivedMs > nowMs + maxFutureSkewMs) return { valid: false, reason: "future" };
  if (observedMs > receivedMs + maxFutureSkewMs) return { valid: false, reason: "bad_timestamp" };
  if (receivedMs - observedMs > maxLateArrivalMs) return { valid: false, reason: "late" };
  return { valid: true };
}

export function freshness(observedAt: string | undefined, staleAfterMs: number, nowMs = Date.now()): { freshnessMs: number | null; stale: boolean } {
  if (!observedAt) return { freshnessMs: null, stale: true };
  const value = Math.max(0, nowMs - Date.parse(observedAt));
  return { freshnessMs: value, stale: value > staleAfterMs };
}
