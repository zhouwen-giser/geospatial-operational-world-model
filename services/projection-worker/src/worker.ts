import { randomUUID } from "node:crypto";
import type pg from "pg";
import { loadConfig } from "../../../packages/world-model-core/src/config.js";
import { ObservationRepository } from "../../../packages/runtime/src/observation-repository.js";
import { EventRepository } from "../../../packages/runtime/src/event-repository.js";
import { ProjectionProcessor } from "../../../packages/runtime/src/projection.js";
import { WorldEventBus } from "../../../packages/runtime/src/bus.js";
import { OperationalProjectionRepository } from "../../../packages/runtime/src/operational-projection-repository.js";
import type {
  HistoricalProjectionTickOptions,
  HistoricalTrajectoryProjectionStageResult,
  TaskIntervalProjectionStageResult,
  TrackletFinalizationStageResult,
  TrackletRebuildStageResult
} from "../../../packages/historical-trace-runtime/src/index.js";

export interface WorkerTickResult {
  claimed: number;
  projected: number;
  failed: number;
  eventsPublished: number;
  operationalProjected: number;
  taskIntervalsProjected: number;
  trackletsRebuilt: number;
  trackletsFinalized: number;
  historicalTrajectoryClaims: number;
  historicalTrajectoriesMaterialized: number;
  historicalTrajectoryOutcomesRecorded: number;
  historicalProjectionFailures: number;
}

/**
 * The worker calls these stages separately so the global ordering remains
 * explicit. Each successful count must represent a repository commit whose
 * lease/generation CAS completed; stale fences remain failures.
 */
export interface HistoricalProjectionStages {
  projectTaskIntervals(options: HistoricalProjectionTickOptions): Promise<TaskIntervalProjectionStageResult>;
  rebuildTracklets(options: HistoricalProjectionTickOptions): Promise<TrackletRebuildStageResult>;
  finalizeTracklets(options: HistoricalProjectionTickOptions): Promise<TrackletFinalizationStageResult>;
  materializeHistoricalTrajectories(
    options: HistoricalProjectionTickOptions
  ): Promise<HistoricalTrajectoryProjectionStageResult>;
}

export interface ProjectionWorkerComponents {
  observations: Pick<ObservationRepository, "claimBatch" | "markFailure">;
  events: Pick<EventRepository, "unpublished" | "markPublished">;
  processor: Pick<ProjectionProcessor, "process">;
  operational: Pick<OperationalProjectionRepository, "projectPending">;
  bus: Pick<WorldEventBus, "publishEvent" | "drain">;
}

export interface ProjectionWorkerOptions {
  historical: HistoricalProjectionStages;
  workerId?: string;
  batchSize?: number;
  leaseSeconds?: number;
  retryDelayMs?: number;
  components?: Partial<ProjectionWorkerComponents>;
}

export class ProjectionWorker {
  private readonly observations: ProjectionWorkerComponents["observations"];
  private readonly events: ProjectionWorkerComponents["events"];
  private readonly processor: ProjectionWorkerComponents["processor"];
  private readonly operational: ProjectionWorkerComponents["operational"];
  private readonly bus: ProjectionWorkerComponents["bus"];
  private readonly historical: HistoricalProjectionStages;
  private readonly stageOptions: HistoricalProjectionTickOptions;
  private readonly batchSize: number;

  constructor(pool: pg.Pool, options: ProjectionWorkerOptions) {
    const config = loadConfig();
    this.batchSize = boundedInteger(
      options.batchSize ?? config.projectionBatchSize,
      1,
      1_000,
      "projection batch size"
    );
    const workerId = (options.workerId ?? `${process.env.HOSTNAME ?? "local"}-${randomUUID()}`).trim();
    if (workerId.length === 0 || workerId.length > 128) throw new Error("projection worker id is invalid");
    const leaseSeconds = boundedInteger(
      options.leaseSeconds ?? integerEnvironment("HISTORICAL_PROJECTION_LEASE_SECONDS", 30),
      1,
      900,
      "historical projection lease seconds"
    );
    const retryDelayMs = boundedInteger(
      options.retryDelayMs ?? integerEnvironment("HISTORICAL_PROJECTION_RETRY_DELAY_MS", 1_000),
      0,
      3_600_000,
      "historical projection retry delay milliseconds"
    );
    this.stageOptions = { workerId, batchSize: this.batchSize, leaseSeconds, retryDelayMs };
    this.historical = options.historical;
    this.observations = options.components?.observations ?? new ObservationRepository(pool);
    this.events = options.components?.events ?? new EventRepository(pool);
    this.processor = options.components?.processor ?? new ProjectionProcessor(pool);
    this.operational = options.components?.operational ?? new OperationalProjectionRepository(pool);
    this.bus = options.components?.bus ?? new WorldEventBus();
  }

  async tick(): Promise<WorkerTickResult> {
    // Task package order: observations -> operational snapshots -> task
    // intervals -> dirty tracklets -> finalization -> requested historical
    // trajectories -> event relay.
    const ids = await this.observations.claimBatch(this.stageOptions.workerId, this.batchSize);
    let projected = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await this.processor.process(id);
        projected += 1;
      } catch (error) {
        failed += 1;
        await this.observations.markFailure(id, error);
        process.stderr.write(`projection failed ${id}: ${error instanceof Error ? error.stack : String(error)}\n`);
      }
    }

    const operationalProjected = await this.operational.projectPending(this.batchSize);
    const intervals = await this.historicalStage(
      "task intervals",
      () => this.historical.projectTaskIntervals(this.stageOptions),
      validateTaskIntervalResult
    );
    const tracklets = await this.historicalStage(
      "tracklet rebuild",
      () => this.historical.rebuildTracklets(this.stageOptions),
      validateTrackletRebuildResult
    );
    const finalizations = await this.historicalStage(
      "tracklet finalization",
      () => this.historical.finalizeTracklets(this.stageOptions),
      validateTrackletFinalizationResult
    );
    const trajectories = await this.historicalStage(
      "historical trajectories",
      () => this.historical.materializeHistoricalTrajectories(this.stageOptions),
      validateHistoricalTrajectoryResult
    );
    const eventsPublished = await this.relayEvents();

    return {
      claimed: ids.length,
      projected,
      failed,
      eventsPublished,
      operationalProjected,
      taskIntervalsProjected: intervals?.taskIntervalsProjected ?? 0,
      trackletsRebuilt: tracklets?.trackletsRebuilt ?? 0,
      trackletsFinalized: finalizations?.trackletsFinalized ?? 0,
      historicalTrajectoryClaims: trajectories?.historicalTrajectoryClaims ?? 0,
      historicalTrajectoriesMaterialized: trajectories?.historicalTrajectoriesMaterialized ?? 0,
      historicalTrajectoryOutcomesRecorded: trajectories?.historicalTrajectoryOutcomesRecorded ?? 0,
      historicalProjectionFailures:
        (intervals?.historicalProjectionFailures ?? 1)
        + (tracklets?.historicalProjectionFailures ?? 1)
        + (finalizations?.historicalProjectionFailures ?? 1)
        + (trajectories?.historicalProjectionFailures ?? 1)
    };
  }

  async relayEvents(): Promise<number> {
    let published = 0;
    const pending = await this.events.unpublished(this.batchSize);
    for (const event of pending) {
      try {
        await this.bus.publishEvent(event);
        await this.events.markPublished(event.eventId);
        published += 1;
      } catch (error) {
        process.stderr.write(`event relay paused: ${error instanceof Error ? error.message : String(error)}\n`);
        break;
      }
    }
    return published;
  }

  async close(): Promise<void> {
    await this.bus.drain();
  }

  private async historicalStage<T>(
    label: string,
    action: () => Promise<T>,
    validate: (result: T) => void
  ): Promise<T | undefined> {
    try {
      const result = await action();
      validate(result);
      return result;
    } catch {
      // Repository last_error retains diagnostics. Keep the process log free of
      // SQL/connection detail while ensuring this stage cannot count as success.
      process.stderr.write(`historical projection stage failed: ${label}\n`);
      return undefined;
    }
  }
}

export function isIdleWorkerTick(result: WorkerTickResult): boolean {
  return result.claimed === 0
    && result.projected === 0
    && result.failed === 0
    && result.eventsPublished === 0
    && result.operationalProjected === 0
    && result.taskIntervalsProjected === 0
    && result.trackletsRebuilt === 0
    && result.trackletsFinalized === 0
    && result.historicalTrajectoryClaims === 0
    && result.historicalTrajectoriesMaterialized === 0
    && result.historicalTrajectoryOutcomesRecorded === 0
    && result.historicalProjectionFailures === 0;
}

function validateTaskIntervalResult(result: TaskIntervalProjectionStageResult): void {
  const claimed = count(result.taskIntervalsClaimed, "taskIntervalsClaimed");
  const projected = count(result.taskIntervalsProjected, "taskIntervalsProjected");
  const superseded = count(result.taskIntervalsSuperseded, "taskIntervalsSuperseded");
  const failures = validateFailures(result);
  if (projected + superseded + failures !== claimed) {
    throw new Error("task interval stage counts do not match claimed work");
  }
}

function validateTrackletRebuildResult(result: TrackletRebuildStageResult): void {
  const claimed = count(result.trackletsClaimed, "trackletsClaimed");
  const rebuilt = count(result.trackletsRebuilt, "trackletsRebuilt");
  const failures = validateFailures(result);
  if (rebuilt + failures !== claimed) throw new Error("tracklet rebuild counts do not match claimed work");
}

function validateTrackletFinalizationResult(result: TrackletFinalizationStageResult): void {
  const claimed = count(result.finalizationsClaimed, "finalizationsClaimed");
  const finalized = count(result.trackletsFinalized, "trackletsFinalized");
  const failures = validateFailures(result);
  if (finalized + failures !== claimed) throw new Error("tracklet finalization counts do not match claimed work");
}

function validateHistoricalTrajectoryResult(result: HistoricalTrajectoryProjectionStageResult): void {
  const claimed = count(result.historicalTrajectoryClaims, "historicalTrajectoryClaims");
  const materialized = count(result.historicalTrajectoriesMaterialized, "historicalTrajectoriesMaterialized");
  const outcomes = count(result.historicalTrajectoryOutcomesRecorded, "historicalTrajectoryOutcomesRecorded");
  const failures = validateFailures(result);
  if (materialized + outcomes + failures !== claimed) {
    throw new Error("historical trajectory stage counts do not match claimed work");
  }
}

function validateFailures(result: {
  historicalProjectionFailures: number;
  staleFenceFailures: number;
}): number {
  const failures = count(result.historicalProjectionFailures, "historicalProjectionFailures");
  const staleFences = count(result.staleFenceFailures, "staleFenceFailures");
  if (staleFences > failures) throw new Error("stale fence failures cannot exceed historical failures");
  return failures;
}

function count(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function integerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
