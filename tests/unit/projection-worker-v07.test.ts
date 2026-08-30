import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { WorldEvent } from "../../packages/world-model-core/src/types.js";
import {
  ProjectionWorker,
  isIdleWorkerTick,
  type HistoricalProjectionStages,
  type ProjectionWorkerComponents,
  type WorkerTickResult
} from "../../services/projection-worker/src/worker.js";

const pool = {} as pg.Pool;
const workerOptions = {
  workerId: "history-worker-test",
  batchSize: 10,
  leaseSeconds: 30,
  retryDelayMs: 250
} as const;

describe("ProjectionWorker v0.7 historical ordering", () => {
  it("runs observations, operational projection and all historical stages before relay", async () => {
    const order: string[] = [];
    const event = { eventId: "event-1" } as WorldEvent;
    const components = projectionComponents(order, {
      observationIds: ["observation-1", "observation-2"],
      events: [event],
      operationalProjected: 3
    });
    const historical = historicalStages(order, {
      intervals: {
        taskIntervalsClaimed: 2,
        taskIntervalsProjected: 1,
        taskIntervalsSuperseded: 1,
        historicalProjectionFailures: 0,
        staleFenceFailures: 0
      },
      tracklets: {
        trackletsClaimed: 2,
        trackletsRebuilt: 2,
        historicalProjectionFailures: 0,
        staleFenceFailures: 0
      },
      finalizations: {
        finalizationsClaimed: 1,
        trackletsFinalized: 1,
        historicalProjectionFailures: 0,
        staleFenceFailures: 0
      },
      trajectories: {
        historicalTrajectoryClaims: 2,
        historicalTrajectoriesMaterialized: 1,
        historicalTrajectoryOutcomesRecorded: 1,
        historicalProjectionFailures: 0,
        staleFenceFailures: 0
      }
    });
    const worker = new ProjectionWorker(pool, { ...workerOptions, historical, components });

    const result = await worker.tick();

    expect(order).toEqual([
      "observations:claim",
      "observations:process:observation-1",
      "observations:process:observation-2",
      "operational:project",
      "history:task-intervals",
      "history:tracklet-rebuild",
      "history:tracklet-finalization",
      "history:trajectory-materialization",
      "events:unpublished",
      "events:publish:event-1",
      "events:mark:event-1"
    ]);
    expect(result).toEqual({
      claimed: 2,
      projected: 2,
      failed: 0,
      eventsPublished: 1,
      operationalProjected: 3,
      taskIntervalsProjected: 1,
      trackletsRebuilt: 2,
      trackletsFinalized: 1,
      historicalTrajectoryClaims: 2,
      historicalTrajectoriesMaterialized: 1,
      historicalTrajectoryOutcomesRecorded: 1,
      historicalProjectionFailures: 0,
      historicalItemFailures: 0,
      historicalStageFailures: 0,
      failedHistoricalStages: []
    });
    const expectedStageOptions = {
      workerId: "history-worker-test",
      batchSize: 10,
      leaseSeconds: 30,
      retryDelayMs: 250
    };
    expect(historical.projectTaskIntervals).toHaveBeenCalledWith(expectedStageOptions);
    expect(historical.rebuildTracklets).toHaveBeenCalledWith(expectedStageOptions);
    expect(historical.finalizeTracklets).toHaveBeenCalledWith(expectedStageOptions);
    expect(historical.materializeHistoricalTrajectories).toHaveBeenCalledWith(expectedStageOptions);
  });

  it("never promotes invalid counts or stale fences and continues later bounded stages", async () => {
    const order: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const components = projectionComponents(order, {
      observationIds: ["observation-fails"],
      failedObservationId: "observation-fails",
      events: [],
      operationalProjected: 0
    });
    const historical: HistoricalProjectionStages = {
      projectTaskIntervals: vi.fn(async () => {
        order.push("history:task-intervals");
        return {
          taskIntervalsClaimed: 0,
          taskIntervalsProjected: 1,
          taskIntervalsSuperseded: 0,
          historicalProjectionFailures: 0,
          staleFenceFailures: 0
        };
      }),
      rebuildTracklets: vi.fn(async () => {
        order.push("history:tracklet-rebuild");
        throw new Error("stage unavailable");
      }),
      finalizeTracklets: vi.fn(async () => {
        order.push("history:tracklet-finalization");
        return {
          finalizationsClaimed: 1,
          trackletsFinalized: 0,
          historicalProjectionFailures: 1,
          staleFenceFailures: 1
        };
      }),
      materializeHistoricalTrajectories: vi.fn(async () => {
        order.push("history:trajectory-materialization");
        return {
          historicalTrajectoryClaims: 0,
          historicalTrajectoriesMaterialized: 0,
          historicalTrajectoryOutcomesRecorded: 0,
          historicalProjectionFailures: 0,
          staleFenceFailures: 0
        };
      })
    };
    const worker = new ProjectionWorker(pool, { ...workerOptions, historical, components });
    try {
      const result = await worker.tick();
      expect(result).toMatchObject({
        claimed: 1,
        projected: 0,
        failed: 1,
        taskIntervalsProjected: 0,
        trackletsRebuilt: 0,
        trackletsFinalized: 0,
        historicalProjectionFailures: 3,
        historicalItemFailures: 1,
        historicalStageFailures: 2,
        failedHistoricalStages: [
          { stage: "TASK_INTERVALS", failureKind: "CONTRACT_FAILURE" },
          { stage: "TRACKLET_REBUILD", failureKind: "UNKNOWN" }
        ]
      });
      expect(order).toEqual([
        "observations:claim",
        "observations:process:observation-fails",
        "observations:mark-failure:observation-fails",
        "operational:project",
        "history:task-intervals",
        "history:tracklet-rebuild",
        "history:tracklet-finalization",
        "history:trajectory-materialization",
        "events:unpublished"
      ]);
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("treats a tick as idle only when every published counter is zero", () => {
    const idle: WorkerTickResult = {
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
      failedHistoricalStages: []
    };
    expect(isIdleWorkerTick(idle)).toBe(true);
    for (const key of Object.keys(idle).filter((key) => key !== "failedHistoricalStages") as Array<keyof WorkerTickResult>) {
      expect(isIdleWorkerTick({ ...idle, [key]: 1 }), key).toBe(false);
    }
    expect(isIdleWorkerTick({
      ...idle,
      failedHistoricalStages: [{ stage: "TASK_INTERVALS", failureKind: "DATABASE_UNAVAILABLE" }]
    })).toBe(false);
  });
});

function projectionComponents(
  order: string[],
  options: {
    observationIds: string[];
    failedObservationId?: string;
    events: WorldEvent[];
    operationalProjected: number;
  }
): ProjectionWorkerComponents {
  return {
    observations: component({
      claimBatch: vi.fn(async () => {
        order.push("observations:claim");
        return options.observationIds;
      }),
      markFailure: vi.fn(async (id: string) => {
        order.push(`observations:mark-failure:${id}`);
      })
    }),
    processor: component({
      process: vi.fn(async (id: string) => {
        order.push(`observations:process:${id}`);
        if (id === options.failedObservationId) throw new Error("observation projection failed");
        return {};
      })
    }),
    operational: component({
      projectPending: vi.fn(async () => {
        order.push("operational:project");
        return options.operationalProjected;
      })
    }),
    events: component({
      unpublished: vi.fn(async () => {
        order.push("events:unpublished");
        return options.events;
      }),
      markPublished: vi.fn(async (eventId: string) => {
        order.push(`events:mark:${eventId}`);
      })
    }),
    bus: component({
      publishEvent: vi.fn(async (event: WorldEvent) => {
        order.push(`events:publish:${event.eventId}`);
      }),
      drain: vi.fn(async () => undefined)
    })
  };
}

function historicalStages(
  order: string[],
  results: {
    intervals: Awaited<ReturnType<HistoricalProjectionStages["projectTaskIntervals"]>>;
    tracklets: Awaited<ReturnType<HistoricalProjectionStages["rebuildTracklets"]>>;
    finalizations: Awaited<ReturnType<HistoricalProjectionStages["finalizeTracklets"]>>;
    trajectories: Awaited<ReturnType<HistoricalProjectionStages["materializeHistoricalTrajectories"]>>;
  }
): HistoricalProjectionStages {
  return {
    projectTaskIntervals: vi.fn(async () => {
      order.push("history:task-intervals");
      return results.intervals;
    }),
    rebuildTracklets: vi.fn(async () => {
      order.push("history:tracklet-rebuild");
      return results.tracklets;
    }),
    finalizeTracklets: vi.fn(async () => {
      order.push("history:tracklet-finalization");
      return results.finalizations;
    }),
    materializeHistoricalTrajectories: vi.fn(async () => {
      order.push("history:trajectory-materialization");
      return results.trajectories;
    })
  };
}

function component<T>(value: unknown): T {
  return value as T;
}
