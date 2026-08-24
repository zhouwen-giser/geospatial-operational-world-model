import { sha256, stableKey } from "./canonical.js";
import type {
  BuiltNetworkArc,
  BuiltNetworkEdge,
  NetworkArcConditionOverride,
  NetworkArcCostMetrics,
  NetworkConditionSnapshot,
  NetworkCostProfile,
  NetworkCostWeights,
  NetworkTravelProfile
} from "./types.js";

function sortedUnique(values: readonly string[]): readonly string[] {
  const result = [...new Set(values)].sort();
  if (result.some((value) => value.length === 0)) throw new Error("profile allowlist contains an empty value");
  return result;
}

function positiveSafe(value: number | undefined, label: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function nonnegativeSafe(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
  return value;
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) throw new Error(`${label} exceeds safe fixed-point range`);
  return Number(value);
}

function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error("fixed-point division requires nonnegative values");
  return (numerator + denominator / 2n) / denominator;
}

export function createTravelProfile(input: Omit<NetworkTravelProfile, "contentHash">): NetworkTravelProfile {
  if (!input.profileKey || !input.version) throw new Error("travel profile identity is incomplete");
  const maximumSpeedMmPerS = positiveSafe(input.maximumSpeedMmPerS, "maximum speed");
  nonnegativeSafe(input.requiredAccessMask, "required access mask");
  const normalized = {
    ...input,
    allowedRoadClasses: sortedUnique(input.allowedRoadClasses),
    allowedSurfaces: sortedUnique(input.allowedSurfaces),
    ...(maximumSpeedMmPerS === undefined ? {} : { maximumSpeedMmPerS })
  };
  return { ...normalized, contentHash: sha256(normalized) };
}

export function createCostProfile(input: Omit<NetworkCostProfile, "contentHash" | "roundingPolicy"> & {
  readonly weights: NetworkCostWeights;
}): NetworkCostProfile {
  if (!input.profileKey || !input.version) throw new Error("cost profile identity is incomplete");
  const weights = input.weights;
  for (const [name, value] of Object.entries(weights)) nonnegativeSafe(value, `${name} weight`);
  if (weights.distance + weights.time + weights.risk + weights.energy + weights.surface !== 1_000_000) {
    throw new Error("cost profile weights must sum to one million PPM");
  }
  const normalized = { ...input, weights, roundingPolicy: "HALF_AWAY_FROM_ZERO" as const };
  return { ...normalized, contentHash: sha256(normalized) };
}

export function isArcEligible(
  edge: BuiltNetworkEdge,
  arc: BuiltNetworkArc,
  profile: NetworkTravelProfile
): boolean {
  if (arc.edgeKey !== edge.edgeKey) throw new Error("profile evaluation Arc does not belong to Edge");
  if (!profile.allowedRoadClasses.includes(edge.roadClass)) return false;
  if (profile.allowedSurfaces.length > 0 && (edge.surface === undefined || !profile.allowedSurfaces.includes(edge.surface))) return false;
  if ((arc.defaultSpeedMmPerS > (profile.maximumSpeedMmPerS ?? Number.MAX_SAFE_INTEGER))) return false;
  if ((arc as BuiltNetworkArc & { accessMask?: number }).accessMask !== undefined &&
      (((arc as BuiltNetworkArc & { accessMask: number }).accessMask & profile.requiredAccessMask) !== profile.requiredAccessMask)) return false;
  if (profile.onewayPolicy === "STRICT" &&
      ((edge.oneway === "FORWARD_ONLY" && arc.direction !== "FORWARD") ||
       (edge.oneway === "REVERSE_ONLY" && arc.direction !== "REVERSE"))) return false;
  return true;
}

export function createConditionSnapshot(input: Omit<NetworkConditionSnapshot, "conditionSnapshotKey" | "contentHash" | "conditions"> & {
  readonly conditions: readonly Omit<NetworkArcConditionOverride, "contentHash">[];
}): NetworkConditionSnapshot {
  const observedAt = Date.parse(input.observedAt);
  const validUntil = Date.parse(input.validUntil);
  if (!Number.isFinite(observedAt) || !Number.isFinite(validUntil) || validUntil <= observedAt) {
    throw new Error("condition snapshot interval is invalid");
  }
  const conditions = input.conditions.map((condition) => {
    positiveSafe(condition.speedOverrideMmPerS, "condition speed override");
    if (!condition.traversalAllowed && condition.speedOverrideMmPerS !== undefined) {
      throw new Error("closed Arc cannot carry a speed override");
    }
    for (const [name, value] of [
      ["risk override", condition.riskOverrideMicroUnits],
      ["access override", condition.accessOverrideMask],
      ["cost multiplier", condition.costMultiplierPpm],
      ["penalty", condition.penaltyUnits]
    ] as const) if (value !== undefined) nonnegativeSafe(value, name);
    const normalized = {
      ...condition,
      reasonCodes: sortedUnique(condition.reasonCodes),
      evidence: [...condition.evidence]
    };
    return { ...normalized, contentHash: sha256(normalized) };
  }).sort((left, right) => left.arcKey.localeCompare(right.arcKey));
  if (new Set(conditions.map((condition) => condition.arcKey)).size !== conditions.length) {
    throw new Error("condition snapshot contains duplicate Arc overrides");
  }
  const normalized = {
    sourceSnapshotVersion: input.sourceSnapshotVersion,
    observedAt: input.observedAt,
    validUntil: input.validUntil,
    completeness: input.completeness,
    sourceContentHash: input.sourceContentHash,
    conditions,
    metadata: input.metadata
  };
  const conditionSnapshotKey = stableKey("cs", normalized);
  return { conditionSnapshotKey, ...normalized, contentHash: sha256({ conditionSnapshotKey, ...normalized }) };
}

export function evaluateArcCost(input: {
  readonly edge: BuiltNetworkEdge;
  readonly arc: BuiltNetworkArc;
  readonly travelProfile: NetworkTravelProfile;
  readonly costProfile: NetworkCostProfile;
  readonly baseRiskMicroUnits: number;
  readonly baseEnergyMwh: number;
  readonly surfacePenaltyUnits: number;
  readonly conditionSnapshot?: NetworkConditionSnapshot;
}): NetworkArcCostMetrics | null {
  if (!isArcEligible(input.edge, input.arc, input.travelProfile)) return null;
  const condition = input.conditionSnapshot?.conditions.find((item) => item.arcKey === input.arc.arcKey);
  if (condition && !condition.traversalAllowed) return null;
  const speedMmPerS = condition?.speedOverrideMmPerS ?? input.arc.defaultSpeedMmPerS;
  positiveSafe(speedMmPerS, "effective speed");
  const distanceMm = nonnegativeSafe(input.arc.lengthMm, "distance");
  const durationMs = safeNumber((BigInt(distanceMm) * 1000n + BigInt(speedMmPerS) - 1n) / BigInt(speedMmPerS), "duration");
  const riskMicroUnits = nonnegativeSafe(condition?.riskOverrideMicroUnits ?? input.baseRiskMicroUnits, "risk");
  const energyMwh = nonnegativeSafe(input.baseEnergyMwh, "energy");
  const surfacePenaltyUnits = nonnegativeSafe(input.surfacePenaltyUnits, "surface penalty");
  const weights = input.costProfile.weights;
  const weightedNumerator = BigInt(distanceMm) * BigInt(weights.distance) +
    BigInt(durationMs) * BigInt(weights.time) + BigInt(riskMicroUnits) * BigInt(weights.risk) +
    BigInt(energyMwh) * BigInt(weights.energy) + BigInt(surfacePenaltyUnits) * BigInt(weights.surface);
  let combined = divideRoundHalfAwayFromZero(weightedNumerator, 1_000_000n);
  combined += BigInt(condition?.penaltyUnits ?? 0);
  combined = divideRoundHalfAwayFromZero(combined * BigInt(condition?.costMultiplierPpm ?? 1_000_000), 1_000_000n);
  const normalized = {
    distanceMm,
    durationMs,
    riskMicroUnits,
    energyMwh,
    surfacePenaltyUnits,
    combinedCostUnits: safeNumber(combined, "combined cost"),
    speedMmPerS,
    ...(input.conditionSnapshot ? { conditionSnapshotKey: input.conditionSnapshot.conditionSnapshotKey } : {})
  };
  return { ...normalized, contentHash: sha256({ arcKey: input.arc.arcKey, travelProfile: input.travelProfile.contentHash, costProfile: input.costProfile.contentHash, ...normalized }) };
}
