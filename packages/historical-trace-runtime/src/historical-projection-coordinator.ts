import { reconstructTaskExecutionIntervals } from "../../historical-trace-core/src/index.js";
import type {
  TaskIntervalProjectionRepository
} from "./interval-repository.js";
import type {
  TrackletProjectionRepository
} from "./tracklet-projection-repository.js";
import type {
  HistoricalTrajectoryProjectionRepository
} from "./trajectory-projection-repository.js";
import type {
  PostgresHistoricalTrajectoryMaterializer
} from "./historical-trajectory-materializer.js";

export interface HistoricalProjectionTickOptions {
  workerId: string;
  batchSize: number;
  leaseSeconds: number;
  retryDelayMs?: number;
}

export interface HistoricalProjectionTickResult {
  taskIntervalsClaimed: number;
  taskIntervalsProjected: number;
  taskIntervalsSuperseded: number;
  trackletsClaimed: number;
  trackletsRebuilt: number;
  finalizationsClaimed: number;
  trackletsFinalized: number;
  historicalTrajectoryClaims: number;
  historicalTrajectoriesMaterialized: number;
  historicalTrajectoryOutcomesRecorded: number;
  historicalProjectionFailures: number;
  staleFenceFailures: number;
}

export interface HistoricalProjectionStageFailures {
  historicalProjectionFailures: number;
  staleFenceFailures: number;
}

export interface TaskIntervalProjectionStageResult extends HistoricalProjectionStageFailures {
  taskIntervalsClaimed: number;
  taskIntervalsProjected: number;
  taskIntervalsSuperseded: number;
}

export interface TrackletRebuildStageResult extends HistoricalProjectionStageFailures {
  trackletsClaimed: number;
  trackletsRebuilt: number;
}

export interface TrackletFinalizationStageResult extends HistoricalProjectionStageFailures {
  finalizationsClaimed: number;
  trackletsFinalized: number;
}

export interface HistoricalTrajectoryProjectionStageResult extends HistoricalProjectionStageFailures {
  historicalTrajectoryClaims: number;
  historicalTrajectoriesMaterialized: number;
  historicalTrajectoryOutcomesRecorded: number;
}

export interface HistoricalProjectionCoordinatorDependencies {
  intervals: TaskIntervalProjectionRepository;
  tracklets: TrackletProjectionRepository;
  trajectories?: HistoricalTrajectoryProjectionRepository;
  materializer?: PostgresHistoricalTrajectoryMaterializer;
  now?: () => Date;
}

function validateOptions(options: HistoricalProjectionTickOptions): void {
  if (options.workerId.trim().length === 0 || options.workerId.length > 128) throw new TypeError("workerId is invalid");
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) {
    throw new TypeError("batchSize must be between 1 and 1000");
  }
  if (!Number.isFinite(options.leaseSeconds) || options.leaseSeconds <= 0 || options.leaseSeconds > 15 * 60) {
    throw new TypeError("leaseSeconds must be between 0 and 900");
  }
  if (options.retryDelayMs !== undefined
      && (!Number.isSafeInteger(options.retryDelayMs) || options.retryDelayMs < 0)) {
    throw new TypeError("retryDelayMs must be a non-negative integer");
  }
}

function isFenceFailure(error: unknown): boolean {
  return error !== null && typeof error === "object"
    && "code" in error && (error as { code?: unknown }).code === "PROJECTION_FENCE_LOST";
}

/**
 * Bounded worker slice. Claim functions provide SKIP LOCKED concurrency; each
 * repository performs append/head/analysis writes and its generation CAS in
 * one transaction. Per-key failures are isolated and requeued fail-closed.
 */
export class HistoricalProjectionCoordinator {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: HistoricalProjectionCoordinatorDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    if ((dependencies.trajectories === undefined) !== (dependencies.materializer === undefined)) {
      throw new TypeError("historical trajectory queue and materializer must be configured together");
    }
  }

  private retryAt(options: HistoricalProjectionTickOptions): string {
    return new Date(this.now().getTime() + (options.retryDelayMs ?? 1_000)).toISOString();
  }

  public async projectTaskIntervals(options: HistoricalProjectionTickOptions): Promise<TaskIntervalProjectionStageResult> {
    validateOptions(options);
    const result: TaskIntervalProjectionStageResult = {
      taskIntervalsClaimed: 0,
      taskIntervalsProjected: 0,
      taskIntervalsSuperseded: 0,
      historicalProjectionFailures: 0,
      staleFenceFailures: 0
    };

    const intervalClaims = await this.dependencies.intervals.claim(
      options.workerId, options.batchSize, options.leaseSeconds
    );
    result.taskIntervalsClaimed = intervalClaims.length;
    for (const claim of intervalClaims) {
      try {
        const input = await this.dependencies.intervals.load(claim);
        const reconstruction = reconstructTaskExecutionIntervals(input.events, input.profile);
        const committed = await this.dependencies.intervals.commit(input, reconstruction);
        if (committed.supersededBeforeProjection) result.taskIntervalsSuperseded += 1;
        else result.taskIntervalsProjected += 1;
      } catch (error) {
        result.historicalProjectionFailures += 1;
        if (isFenceFailure(error)) result.staleFenceFailures += 1;
        await this.dependencies.intervals.fail(claim, error, this.retryAt(options)).catch(() => false);
      }
    }
    return result;
  }

  public async rebuildTracklets(options: HistoricalProjectionTickOptions): Promise<TrackletRebuildStageResult> {
    validateOptions(options);
    const result: TrackletRebuildStageResult = {
      trackletsClaimed: 0,
      trackletsRebuilt: 0,
      historicalProjectionFailures: 0,
      staleFenceFailures: 0
    };
    const trackletClaims = await this.dependencies.tracklets.claimTracklets(
      options.workerId, options.batchSize, options.leaseSeconds
    );
    result.trackletsClaimed = trackletClaims.length;
    for (const claim of trackletClaims) {
      try {
        await this.dependencies.tracklets.rebuildAndComplete(claim);
        result.trackletsRebuilt += 1;
      } catch (error) {
        result.historicalProjectionFailures += 1;
        if (isFenceFailure(error)) result.staleFenceFailures += 1;
        await this.dependencies.tracklets.failTracklet(claim, error, this.retryAt(options)).catch(() => false);
      }
    }
    return result;
  }

  public async finalizeTracklets(options: HistoricalProjectionTickOptions): Promise<TrackletFinalizationStageResult> {
    validateOptions(options);
    const result: TrackletFinalizationStageResult = {
      finalizationsClaimed: 0,
      trackletsFinalized: 0,
      historicalProjectionFailures: 0,
      staleFenceFailures: 0
    };
    const finalizationClaims = await this.dependencies.tracklets.claimFinalizations(
      options.workerId, options.batchSize, options.leaseSeconds
    );
    result.finalizationsClaimed = finalizationClaims.length;
    for (const claim of finalizationClaims) {
      try {
        const evidence = await this.dependencies.tracklets.loadFinalization(claim);
        await this.dependencies.tracklets.finalizeAndComplete(evidence);
        result.trackletsFinalized += 1;
      } catch (error) {
        result.historicalProjectionFailures += 1;
        if (isFenceFailure(error)) result.staleFenceFailures += 1;
        await this.dependencies.tracklets.failFinalization(claim, error, this.retryAt(options)).catch(() => false);
      }
    }
    return result;
  }

  public async materializeHistoricalTrajectories(
    options: HistoricalProjectionTickOptions
  ): Promise<HistoricalTrajectoryProjectionStageResult> {
    validateOptions(options);
    const trajectories = this.dependencies.trajectories;
    const materializer = this.dependencies.materializer;
    if (trajectories === undefined || materializer === undefined) {
      throw new TypeError("historical trajectory projection stage is not configured");
    }
    const result: HistoricalTrajectoryProjectionStageResult = {
      historicalTrajectoryClaims: 0,
      historicalTrajectoriesMaterialized: 0,
      historicalTrajectoryOutcomesRecorded: 0,
      historicalProjectionFailures: 0,
      staleFenceFailures: 0
    };
    const claims = await trajectories.claim(options.workerId, options.batchSize, options.leaseSeconds);
    result.historicalTrajectoryClaims = claims.length;
    for (const claim of claims) {
      try {
        const committed = await trajectories.materializeAndComplete(claim, materializer);
        if (committed.status === "MATERIALIZED") result.historicalTrajectoriesMaterialized += 1;
        else result.historicalTrajectoryOutcomesRecorded += 1;
      } catch (error) {
        result.historicalProjectionFailures += 1;
        if (isFenceFailure(error)) result.staleFenceFailures += 1;
        await trajectories.fail(claim, error, this.retryAt(options)).catch(() => false);
      }
    }
    return result;
  }

  public async tick(options: HistoricalProjectionTickOptions): Promise<HistoricalProjectionTickResult> {
    validateOptions(options);
    const intervals = await this.projectTaskIntervals(options);
    const tracklets = await this.rebuildTracklets(options);
    const finalizations = await this.finalizeTracklets(options);
    const trajectories = this.dependencies.trajectories === undefined
      ? {
          historicalTrajectoryClaims: 0,
          historicalTrajectoriesMaterialized: 0,
          historicalTrajectoryOutcomesRecorded: 0,
          historicalProjectionFailures: 0,
          staleFenceFailures: 0
        }
      : await this.materializeHistoricalTrajectories(options);
    return {
      taskIntervalsClaimed: intervals.taskIntervalsClaimed,
      taskIntervalsProjected: intervals.taskIntervalsProjected,
      taskIntervalsSuperseded: intervals.taskIntervalsSuperseded,
      trackletsClaimed: tracklets.trackletsClaimed,
      trackletsRebuilt: tracklets.trackletsRebuilt,
      finalizationsClaimed: finalizations.finalizationsClaimed,
      trackletsFinalized: finalizations.trackletsFinalized,
      historicalTrajectoryClaims: trajectories.historicalTrajectoryClaims,
      historicalTrajectoriesMaterialized: trajectories.historicalTrajectoriesMaterialized,
      historicalTrajectoryOutcomesRecorded: trajectories.historicalTrajectoryOutcomesRecorded,
      historicalProjectionFailures: intervals.historicalProjectionFailures
        + tracklets.historicalProjectionFailures
        + finalizations.historicalProjectionFailures
        + trajectories.historicalProjectionFailures,
      staleFenceFailures: intervals.staleFenceFailures
        + tracklets.staleFenceFailures
        + finalizations.staleFenceFailures
        + trajectories.staleFenceFailures
    };
  }
}
