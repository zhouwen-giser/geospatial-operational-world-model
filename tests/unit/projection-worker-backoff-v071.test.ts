import { describe, expect, it, vi } from "vitest";
import {
  loadWorkerBackoffConfig,
  WorkerLoopBackoff,
  type WorkerDelay
} from "../../services/projection-worker/src/loop-backoff.js";
import type { WorkerTickResult } from "../../services/projection-worker/src/worker.js";

const config = { baseRetryDelayMs: 1_000, maxRetryDelayMs: 6_000, multiplier: 2 };

describe("Projection worker v0.7.1 loop backoff", () => {
  it("backs off exponentially for stage failures and caps the delay", () => {
    const backoff = new WorkerLoopBackoff(config);
    const failure = tick({
      historicalProjectionFailures: 1,
      historicalStageFailures: 1,
      failedHistoricalStages: [{ stage: "TASK_INTERVALS", failureKind: "DATABASE_UNAVAILABLE" }]
    });

    expect(backoff.decide(failure, 250)).toMatchObject({ delayMs: 1_000, consecutiveStageFailures: 1 });
    expect(backoff.decide(failure, 250)).toMatchObject({ delayMs: 2_000, consecutiveStageFailures: 2 });
    expect(backoff.decide(failure, 250)).toMatchObject({ delayMs: 4_000, consecutiveStageFailures: 3 });
    expect(backoff.decide(failure, 250)).toMatchObject({ delayMs: 6_000, consecutiveStageFailures: 4 });
    expect(backoff.decide(failure, 250)).toMatchObject({ delayMs: 6_000, consecutiveStageFailures: 5 });
  });

  it("resets after a tick without stage failure", () => {
    const backoff = new WorkerLoopBackoff(config);
    const failure = tick({ historicalProjectionFailures: 1, historicalStageFailures: 1 });
    backoff.decide(failure, 250);
    backoff.decide(failure, 250);

    expect(backoff.decide(tick({ projected: 1 }), 250)).toMatchObject({
      reason: "PRODUCTIVE",
      delayMs: 0,
      consecutiveStageFailures: 0,
      lastDelayMs: 0
    });
    expect(backoff.decide(failure, 250)).toMatchObject({ delayMs: 1_000, consecutiveStageFailures: 1 });
  });

  it("uses base retry for item-only failure without productive work", () => {
    const backoff = new WorkerLoopBackoff(config);
    expect(backoff.decide(tick({
      historicalProjectionFailures: 2,
      historicalItemFailures: 2
    }), 250)).toMatchObject({ reason: "ITEM_FAILURE", delayMs: 1_000, consecutiveStageFailures: 0 });
  });

  it("does not wait when item failures accompany productive work", () => {
    const backoff = new WorkerLoopBackoff(config);
    expect(backoff.decide(tick({
      taskIntervalsProjected: 1,
      historicalProjectionFailures: 1,
      historicalItemFailures: 1
    }), 250)).toMatchObject({ reason: "PRODUCTIVE", delayMs: 0 });
  });

  it("uses projection poll delay only for a completely idle tick", () => {
    const backoff = new WorkerLoopBackoff(config);
    expect(backoff.decide(tick(), 250)).toMatchObject({ reason: "IDLE", delayMs: 250 });
  });

  it("passes an AbortSignal to an injected delay", async () => {
    const calls: Array<{ milliseconds: number; signal?: AbortSignal }> = [];
    const sleep: WorkerDelay = vi.fn(async (milliseconds, signal) => {
      calls.push({ milliseconds, signal });
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const backoff = new WorkerLoopBackoff(config, sleep);
    const controller = new AbortController();
    controller.abort();
    const decision = backoff.decide(tick({ historicalProjectionFailures: 1, historicalStageFailures: 1 }), 250);

    await expect(backoff.wait(decision, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual([{ milliseconds: 1_000, signal: controller.signal }]);
  });

  it("loads bounded defaults and explicit environment values", () => {
    expect(loadWorkerBackoffConfig({})).toEqual({
      baseRetryDelayMs: 1_000,
      maxRetryDelayMs: 60_000,
      multiplier: 2
    });
    expect(loadWorkerBackoffConfig({
      HISTORICAL_PROJECTION_RETRY_DELAY_MS: "25",
      HISTORICAL_PROJECTION_MAX_RETRY_DELAY_MS: "125",
      HISTORICAL_PROJECTION_BACKOFF_MULTIPLIER: "1.5"
    })).toEqual({ baseRetryDelayMs: 25, maxRetryDelayMs: 125, multiplier: 1.5 });
  });
});

function tick(overrides: Partial<WorkerTickResult> = {}): WorkerTickResult {
  return {
    claimed: 0,
    projected: 0,
    failed: 0,
    eventsPublished: 0,
    operationalProjected: 0,
    taskIntervalsProjected: 0,
    trackletsRebuilt: 0,
    trackletsFinalized: 0,
    historicalTrajectoryClaims: 0,
    historicalTrajectoriesMaterialized: 0,
    historicalTrajectoryOutcomesRecorded: 0,
    historicalProjectionFailures: 0,
    historicalItemFailures: 0,
    historicalStageFailures: 0,
    failedHistoricalStages: [],
    ...overrides
  };
}
