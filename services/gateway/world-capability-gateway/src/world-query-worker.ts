import type { QueryJobContext } from "./query-plan-store.js";

export interface WorldQueryClaimStore {
  claimNext(workerId: string, leaseSeconds: number): Promise<QueryJobContext | undefined>;
}

export interface WorldQueryRunner {
  run(jobId: string): Promise<unknown>;
}

export interface PostgresWorldQueryWorkerOptions {
  workerId: string;
  leaseSeconds: number;
  pollIntervalMs: number;
  maximumClaimsPerTick: number;
  onError?: () => void;
}

/** Single-process bounded worker; PostgreSQL SKIP LOCKED provides replica coordination. */
export class PostgresWorldQueryWorker {
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #stopping = false;

  constructor(
    private readonly store: WorldQueryClaimStore,
    private readonly runner: WorldQueryRunner,
    private readonly options: PostgresWorldQueryWorkerOptions
  ) {
    if (!options.workerId.trim() || options.workerId.length > 128) throw new TypeError("workerId must contain 1-128 characters");
    if (!Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds < 1 || options.leaseSeconds > 3_600) {
      throw new TypeError("leaseSeconds must be between 1 and 3600");
    }
    if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 100) {
      throw new TypeError("pollIntervalMs must be at least 100");
    }
    if (!Number.isSafeInteger(options.maximumClaimsPerTick) || options.maximumClaimsPerTick < 1 || options.maximumClaimsPerTick > 64) {
      throw new TypeError("maximumClaimsPerTick must be between 1 and 64");
    }
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopping) return;
    this.#timer = setInterval(() => this.#schedule(), this.options.pollIntervalMs);
    this.#timer.unref();
    queueMicrotask(() => this.#schedule());
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }

  #schedule(): void {
    if (this.#stopping || this.#inFlight !== undefined) return;
    const work = this.#drain()
      .catch(() => {
        if (this.options.onError) this.options.onError();
        else process.stderr.write("world query worker cycle failed\n");
      })
      .finally(() => {
        if (this.#inFlight === work) this.#inFlight = undefined;
      });
    this.#inFlight = work;
  }

  async #drain(): Promise<void> {
    for (let claimed = 0; claimed < this.options.maximumClaimsPerTick && !this.#stopping; claimed += 1) {
      const context = await this.store.claimNext(this.options.workerId, this.options.leaseSeconds);
      if (!context) return;
      await this.runner.run(context.job.jobId);
    }
  }
}
