import { describe, expect, it } from "vitest";
import { decideProjection, freshness, validateObservationTime } from "../../packages/observation-model/src/fusion.js";
import { makeObservation } from "../../packages/runtime/src/memory-world.js";

const base = makeObservation({
  observationId: "obs-new",
  observer: { type: "UAV", id: "uav-1" },
  subject: { type: "Vehicle", id: "vehicle-8" },
  observationType: "position",
  observedAt: "2026-08-11T00:00:02.000Z",
  receivedAt: "2026-08-11T00:00:02.010Z",
  source: "uav",
  confidence: 0.9
});

describe("deterministic projection policy", () => {
  it("uses source priority inside the conflict window", () => {
    const decision = decideProjection({
      observedAt: "2026-08-11T00:00:01.000Z",
      confidence: 0.99,
      source: "camera",
      sourceObservationId: "obs-old"
    }, base, { sourcePriorities: { camera: 70, uav: 80 }, conflictWindowMs: 5_000, maxOutOfOrderMs: 60_000 });
    expect(decision).toEqual({ apply: true, reason: "higher-priority" });
  });

  it("rejects materially out-of-order observations", () => {
    const decision = decideProjection({
      observedAt: "2026-08-11T00:02:00.000Z", confidence: 1, source: "uav", sourceObservationId: "newer"
    }, base, { sourcePriorities: { uav: 80 }, conflictWindowMs: 5_000, maxOutOfOrderMs: 30_000 });
    expect(decision).toEqual({ apply: false, reason: "out-of-order" });
  });

  it("distinguishes future/late time and computes freshness", () => {
    const now = Date.parse("2026-08-11T00:00:03Z");
    expect(validateObservationTime(base, now, 1_000, 60_000).valid).toBe(true);
    expect(validateObservationTime({
      ...base,
      observedAt: new Date(now).toISOString(),
      receivedAt: new Date(now - 10_000).toISOString()
    }, now, 1_000, 60_000).reason).toBe("bad_timestamp");
    expect(freshness("2026-08-11T00:00:00Z", 5_000, Date.parse("2026-08-11T00:00:06Z"))).toEqual({ freshnessMs: 6_000, stale: true });
  });
});
