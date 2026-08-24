import { randomUUID } from "node:crypto";
import type pg from "pg";
import { loadConfig } from "../../../packages/world-model-core/src/config.js";
import { ObservationRepository } from "../../../packages/runtime/src/observation-repository.js";
import { EventRepository } from "../../../packages/runtime/src/event-repository.js";
import { ProjectionProcessor } from "../../../packages/runtime/src/projection.js";
import { WorldEventBus } from "../../../packages/runtime/src/bus.js";
import { OperationalProjectionRepository } from "../../../packages/runtime/src/operational-projection-repository.js";

export interface WorkerTickResult {
  claimed: number;
  projected: number;
  failed: number;
  eventsPublished: number;
  operationalProjected: number;
}

export class ProjectionWorker {
  private readonly config = loadConfig();
  private readonly observations: ObservationRepository;
  private readonly events: EventRepository;
  private readonly processor: ProjectionProcessor;
  private readonly operational: OperationalProjectionRepository;
  private readonly bus = new WorldEventBus();
  private readonly workerName = `${process.env.HOSTNAME ?? "local"}-${randomUUID()}`;

  constructor(pool: pg.Pool) {
    this.observations = new ObservationRepository(pool);
    this.events = new EventRepository(pool);
    this.processor = new ProjectionProcessor(pool);
    this.operational = new OperationalProjectionRepository(pool);
  }

  async tick(): Promise<WorkerTickResult> {
    const ids = await this.observations.claimBatch(this.workerName, this.config.projectionBatchSize);
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
    const operationalProjected = await this.operational.projectPending(this.config.projectionBatchSize);
    const eventsPublished = await this.relayEvents();
    return { claimed: ids.length, projected, failed, eventsPublished, operationalProjected };
  }

  async relayEvents(): Promise<number> {
    let published = 0;
    const pending = await this.events.unpublished(this.config.projectionBatchSize);
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
}
