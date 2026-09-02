import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import {
  GeometryServiceError,
  type AdapterExecution,
  type GeometryEngineAdapter,
  type GeometryErrorPayload,
  type OperationRequest,
} from "@geospatial/geometry-contract";

interface QueueItem {
  id: number;
  request: OperationRequest;
  resolve: (value: AdapterExecution) => void;
  reject: (reason: unknown) => void;
}

interface WorkerSlot {
  index: number;
  worker: Worker;
  ready: boolean;
  replacing: boolean;
  current: QueueItem | undefined;
  timer: NodeJS.Timeout | undefined;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  rejectReady: (reason: unknown) => void;
}

export interface GeosWorkerPoolOptions {
  size?: number;
  operationTimeoutMs?: number;
  /** Maximum requests waiting behind active workers. Set to 0 to disable waiting. */
  maxQueueSize?: number;
  workerUrl?: URL;
}

export interface GeosWorkerPoolStats {
  workers: number;
  readyWorkers: number;
  activeRequests: number;
  queuedRequests: number;
  maxQueueSize: number;
  totalCapacity: number;
  closing: boolean;
}

/**
 * Process-local isolation for synchronous GEOS/WASM calls. Each worker owns one
 * reentrant GEOS context. A timeout terminates and replaces the worker, providing
 * real pre-emption that an in-event-loop Promise.race cannot provide.
 */
export class GeosWorkerPoolAdapter implements GeometryEngineAdapter {
  readonly name = "GEOS-WASM-WORKER-POOL";
  version = "uninitialized";
  readonly size: number;
  readonly operationTimeoutMs: number;
  readonly maxQueueSize: number;
  private readonly workerUrl: URL;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: QueueItem[] = [];
  private nextId = 1;
  private closing = false;
  private initializing: Promise<void> | undefined;

  constructor(options: GeosWorkerPoolOptions = {}) {
    const defaultSize = Math.max(1, Math.min(4, availableParallelism() - 1));
    this.size = Math.max(1, Math.min(32, Math.floor(options.size ?? defaultSize)));
    this.operationTimeoutMs = Math.max(1, Math.floor(options.operationTimeoutMs ?? 2_000));
    this.maxQueueSize = Math.max(0, Math.min(100_000, Math.floor(options.maxQueueSize ?? 256)));
    this.workerUrl = options.workerUrl ?? new URL("./worker-entry.js", import.meta.url);
  }

  async initialize(): Promise<void> {
    if (this.slots.length === this.size && this.slots.every((slot) => slot.ready)) return;
    this.initializing ??= (async () => {
      this.closing = false;
      for (let index = this.slots.length; index < this.size; index += 1) {
        this.slots.push(this.createSlot(index));
      }
      await Promise.all(this.slots.map((slot) => slot.readyPromise));
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  async execute(request: OperationRequest): Promise<AdapterExecution> {
    await this.initialize();
    if (this.closing) {
      throw new GeometryServiceError({
        code: "ENGINE_ERROR",
        message: "GEOS worker pool is closing",
        operation: request.operation,
        recoverable: true,
      });
    }
    if (!this.hasImmediateCapacity() && this.queue.length >= this.maxQueueSize) {
      throw new GeometryServiceError({
        code: "RESOURCE_LIMIT",
        message: `GEOS worker queue is full (${this.queue.length}/${this.maxQueueSize})`,
        operation: request.operation,
        recoverable: true,
        suggestion: "Retry with backoff, reduce client concurrency, or increase the explicitly bounded worker queue after load testing.",
        details: {
          kind: "overload",
          resource: "worker_queue",
          workers: this.size,
          activeRequests: this.activeCount(),
          queuedRequests: this.queue.length,
          maxQueueSize: this.maxQueueSize,
        },
      });
    }
    return new Promise<AdapterExecution>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, request, resolve, reject });
      this.dispatch();
    });
  }

  stats(): GeosWorkerPoolStats {
    return {
      workers: this.size,
      readyWorkers: this.slots.filter((slot) => slot.ready && !slot.replacing).length,
      activeRequests: this.activeCount(),
      queuedRequests: this.queue.length,
      maxQueueSize: this.maxQueueSize,
      totalCapacity: this.size + this.maxQueueSize,
      closing: this.closing,
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    const closingError = new GeometryServiceError({
      code: "ENGINE_ERROR",
      message: "GEOS worker pool closed",
      recoverable: true,
    });
    for (const item of this.queue.splice(0)) item.reject(closingError);
    const workers = this.slots.splice(0);
    for (const slot of workers) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.current?.reject(closingError);
    }
    await Promise.allSettled(workers.map((slot) => slot.worker.terminate()));
    this.version = "closed";
  }

  private createSlot(index: number): WorkerSlot {
    let resolveReady!: () => void;
    let rejectReady!: (reason: unknown) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const worker = new Worker(this.workerUrl, {
      // `node --input-type=module -e ...` is useful for probes, but Node rejects
      // that flag when a Worker has a file URL. Normal runtime flags are retained.
      execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
    });
    const slot: WorkerSlot = {
      index,
      worker,
      ready: false,
      replacing: false,
      current: undefined,
      timer: undefined,
      readyPromise,
      resolveReady,
      rejectReady,
    };

    worker.on("message", (message: WorkerMessage) => this.onMessage(slot, message));
    worker.on("error", (error) => this.replaceSlot(slot, error));
    worker.on("exit", (code) => {
      if (code !== 0 && !slot.replacing && !this.closing) {
        this.replaceSlot(slot, new Error(`GEOS worker exited with code ${code}`));
      }
    });
    return slot;
  }

  private onMessage(slot: WorkerSlot, message: WorkerMessage): void {
    if (message.type === "ready") {
      slot.ready = true;
      this.version = message.version;
      slot.resolveReady();
      this.dispatch();
      return;
    }
    const current = slot.current;
    if (!current || current.id !== message.id) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.current = undefined;
    if (message.ok) current.resolve(message.result);
    else current.reject(new GeometryServiceError(message.error));
    this.dispatch();
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (!slot.ready || slot.replacing || slot.current || this.queue.length === 0) continue;
      const item = this.queue.shift()!;
      slot.current = item;
      slot.timer = setTimeout(() => {
        if (slot.current?.id !== item.id) return;
        slot.current = undefined;
        item.reject(new GeometryServiceError({
          code: "OPERATION_TIMEOUT",
          message: `Geometry operation exceeded ${this.operationTimeoutMs} ms and its worker was terminated`,
          operation: item.request.operation,
          recoverable: true,
          suggestion: "Simplify/split the geometry, provide a precision grid, or use the future async job API.",
        }));
        this.replaceSlot(slot, new Error("operation timeout"));
      }, this.operationTimeoutMs);
      slot.worker.postMessage({ id: item.id, request: item.request });
    }
  }

  private activeCount(): number {
    return this.slots.reduce((count, slot) => count + (slot.current ? 1 : 0), 0);
  }

  private hasImmediateCapacity(): boolean {
    return this.slots.some((slot) => slot.ready && !slot.replacing && !slot.current);
  }

  private replaceSlot(slot: WorkerSlot, reason: unknown): void {
    if (slot.replacing || this.closing) return;
    slot.replacing = true;
    slot.ready = false;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    const current = slot.current;
    slot.current = undefined;
    if (current) {
      current.reject(new GeometryServiceError({
        code: "ENGINE_ERROR",
        message: reason instanceof Error ? reason.message : String(reason),
        operation: current.request.operation,
        recoverable: true,
        suggestion: "Retry once; the failed worker has been replaced.",
      }));
    }
    if (!slot.ready) slot.rejectReady(reason);
    void slot.worker.terminate().finally(() => {
      if (this.closing) return;
      const replacement = this.createSlot(slot.index);
      const position = this.slots.indexOf(slot);
      if (position >= 0) this.slots[position] = replacement;
      void replacement.readyPromise.then(() => this.dispatch()).catch(() => undefined);
    });
  }
}

type WorkerMessage =
  | { type: "ready"; version: string }
  | { type: "result"; id: number; ok: true; result: AdapterExecution }
  | { type: "result"; id: number; ok: false; error: GeometryErrorPayload };
