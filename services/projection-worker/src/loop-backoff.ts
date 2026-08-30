import { setTimeout as delay } from "node:timers/promises";
import { hasProductiveWorkerWork, isIdleWorkerTick, type WorkerTickResult } from "./worker.js";

export interface WorkerBackoffState {
  consecutiveStageFailures: number;
  lastDelayMs: number;
}

export interface WorkerBackoffConfig {
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  multiplier: number;
}

export type WorkerDelayReason = "STAGE_FAILURE" | "ITEM_FAILURE" | "IDLE" | "PRODUCTIVE" | "NONE";

export interface WorkerDelayDecision extends WorkerBackoffState {
  delayMs: number;
  reason: WorkerDelayReason;
}

export type WorkerDelay = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export class WorkerLoopBackoff {
  private readonly config: WorkerBackoffConfig;
  private readonly sleep: WorkerDelay;
  private current: WorkerBackoffState = { consecutiveStageFailures: 0, lastDelayMs: 0 };

  constructor(config: WorkerBackoffConfig, sleep: WorkerDelay = abortableWorkerDelay) {
    validateConfig(config);
    this.config = config;
    this.sleep = sleep;
  }

  get state(): WorkerBackoffState {
    return { ...this.current };
  }

  decide(result: WorkerTickResult, projectionPollMs: number): WorkerDelayDecision {
    if (!Number.isSafeInteger(projectionPollMs) || projectionPollMs < 0) {
      throw new Error("projectionPollMs must be a non-negative integer");
    }
    if (result.historicalStageFailures > 0) {
      const consecutiveStageFailures = this.current.consecutiveStageFailures + 1;
      const exponential = this.config.baseRetryDelayMs
        * Math.pow(this.config.multiplier, consecutiveStageFailures - 1);
      const delayMs = Math.min(this.config.maxRetryDelayMs, Math.ceil(exponential));
      this.current = { consecutiveStageFailures, lastDelayMs: delayMs };
      return { ...this.current, delayMs, reason: "STAGE_FAILURE" };
    }

    this.current = { consecutiveStageFailures: 0, lastDelayMs: 0 };
    if (hasProductiveWorkerWork(result)) return { ...this.current, delayMs: 0, reason: "PRODUCTIVE" };
    if (result.historicalItemFailures > 0) {
      this.current.lastDelayMs = this.config.baseRetryDelayMs;
      return { ...this.current, delayMs: this.current.lastDelayMs, reason: "ITEM_FAILURE" };
    }
    if (isIdleWorkerTick(result)) {
      this.current.lastDelayMs = projectionPollMs;
      return { ...this.current, delayMs: projectionPollMs, reason: "IDLE" };
    }
    return { ...this.current, delayMs: 0, reason: "NONE" };
  }

  async wait(decision: WorkerDelayDecision, signal?: AbortSignal): Promise<void> {
    if (decision.delayMs > 0) await this.sleep(decision.delayMs, signal);
  }
}

export function loadWorkerBackoffConfig(environment: NodeJS.ProcessEnv = process.env): WorkerBackoffConfig {
  return {
    baseRetryDelayMs: integerEnvironment(environment, "HISTORICAL_PROJECTION_RETRY_DELAY_MS", 1_000),
    maxRetryDelayMs: integerEnvironment(environment, "HISTORICAL_PROJECTION_MAX_RETRY_DELAY_MS", 60_000),
    multiplier: numberEnvironment(environment, "HISTORICAL_PROJECTION_BACKOFF_MULTIPLIER", 2)
  };
}

export async function abortableWorkerDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, { signal });
}

function validateConfig(config: WorkerBackoffConfig): void {
  if (!Number.isSafeInteger(config.baseRetryDelayMs) || config.baseRetryDelayMs < 0) {
    throw new Error("baseRetryDelayMs must be a non-negative integer");
  }
  if (!Number.isSafeInteger(config.maxRetryDelayMs) || config.maxRetryDelayMs < config.baseRetryDelayMs) {
    throw new Error("maxRetryDelayMs must be an integer at least as large as baseRetryDelayMs");
  }
  if (!Number.isFinite(config.multiplier) || config.multiplier < 1) {
    throw new Error("multiplier must be at least 1");
  }
}

function integerEnvironment(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = numberEnvironment(environment, name, fallback);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function numberEnvironment(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}
