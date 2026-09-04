import { createHash } from "node:crypto";
import { canonicalJson } from "../../../observation-model/src/canonical.js";

export interface UgvSamplingPolicy {
  version: string;
  gnssMinimumIntervalMs: number;
  gnssForceDisplacementM: number;
  gnssHeartbeatMs: number;
  speedMinimumIntervalMs: number;
  speedForceDeltaMps: number;
  platformMinimumIntervalMs: number;
  chassisProgressDeltaPercent: number;
  chassisHeartbeatMs: number;
  reconMinimumIntervalMs: number;
  reconCoverageDeltaPercent: number;
  targetMinimumIntervalMs: number;
}

export const DEFAULT_UGV_SAMPLING_POLICY: UgvSamplingPolicy = {
  version: "ugv-authority-sampling-v1",
  gnssMinimumIntervalMs: 500,
  gnssForceDisplacementM: 0.5,
  gnssHeartbeatMs: 5_000,
  speedMinimumIntervalMs: 500,
  speedForceDeltaMps: 0.2,
  platformMinimumIntervalMs: 1_000,
  chassisProgressDeltaPercent: 5,
  chassisHeartbeatMs: 5_000,
  reconMinimumIntervalMs: 1_000,
  reconCoverageDeltaPercent: 1,
  targetMinimumIntervalMs: 500
};

export function samplingPolicyHash(policy: UgvSamplingPolicy): string {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

export function elapsedSince(isoTime: string, prior: unknown): number {
  const currentMs = Date.parse(isoTime);
  const priorMs = typeof prior === "string" ? Date.parse(prior) : Number.NaN;
  return Number.isFinite(priorMs) ? Math.max(0, currentMs - priorMs) : Number.POSITIVE_INFINITY;
}

export function approximateDistanceM(
  longitude: number,
  latitude: number,
  priorLongitude: unknown,
  priorLatitude: unknown
): number {
  if (typeof priorLongitude !== "number" || typeof priorLatitude !== "number") return Number.POSITIVE_INFINITY;
  const meanLatitudeRad = ((latitude + priorLatitude) / 2) * Math.PI / 180;
  const eastM = (longitude - priorLongitude) * 111_320 * Math.cos(meanLatitudeRad);
  const northM = (latitude - priorLatitude) * 110_540;
  return Math.hypot(eastM,northM);
}

export function stableChanged(left: unknown,right: unknown): boolean {
  return canonicalJson(left) !== canonicalJson(right);
}
