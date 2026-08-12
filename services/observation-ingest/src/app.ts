import { isDeepStrictEqual } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import type { ObservationEnvelope } from "../../../packages/world-model-core/src/types.js";
import { ObservationEnvelopeSchema } from "../../../packages/world-model-core/src/schema.js";
import { loadConfig } from "../../../packages/world-model-core/src/config.js";
import { validateGeometry } from "../../../packages/spatial-engine/src/geometry.js";
import { validateObservationTime } from "../../../packages/observation-model/src/fusion.js";
import { databasePool } from "../../../packages/runtime/src/db.js";
import { ObservationRepository } from "../../../packages/runtime/src/observation-repository.js";
import { WorldEventBus } from "../../../packages/runtime/src/bus.js";
import { EventRepository } from "../../../packages/runtime/src/event-repository.js";

export function buildObservationApp(): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const config = loadConfig();
  const repository = new ObservationRepository(databasePool());
  const eventRepository = new EventRepository(databasePool());
  const bus = new WorldEventBus();

  app.get("/health", async () => ({ status: "ok", service: "observation-ingest", timestamp: new Date().toISOString() }));

  app.post("/observations", async (request, reply) => {
    const parsed = ObservationEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_observation", issues: parsed.error.issues });
    const now = new Date();
    const raw = parsed.data;
    const receivedAtWasSupplied = raw.receivedAt !== undefined;
    const observation = {
      ...raw,
      receivedAt: raw.receivedAt ?? now.toISOString(),
      correlationId: raw.correlationId ?? raw.observationId
    } as ObservationEnvelope;
    const geometryErrors = observation.geometry ? validateGeometry(observation.geometry) : [];
    if (geometryErrors.length) return reply.code(422).send({ error: "invalid_geometry", issues: geometryErrors });

    const timeValidation = validateObservationTime(
      observation,
      now.getTime(),
      config.maxFutureSkewMs,
      config.maxLateArrivalMs
    );
    if (!timeValidation.valid && timeValidation.reason !== "late") {
      return reply.code(422).send({ error: "invalid_observation_time", reason: timeValidation.reason });
    }

    const result = await repository.insert(observation, timeValidation.reason === "late"
      ? { status: "late", project: false, rejectionReason: "late_arrival" }
      : { status: "accepted", project: true });

    if (result.status === "duplicate" && !sameObservation(result.observation, observation, receivedAtWasSupplied)) {
      return reply.code(409).send({
        error: "idempotency_conflict",
        observationId: observation.observationId,
        message: "observationId already exists with a different immutable payload"
      });
    }

    let busPublished = false;
    if (result.status === "accepted") {
      try {
        await bus.publishObservation(observation);
        busPublished = true;
      } catch (error) {
        request.log.warn({ err: error }, "MQTT unavailable; durable projection queue retained the observation");
      }
    }
    if (result.event) {
      try {
        await bus.publishEvent(result.event);
        await eventRepository.markPublished(result.event.eventId);
      } catch (error) {
        request.log.warn({ err: error }, "ObservationReceived event remains in event outbox");
      }
    }

    return reply.code(result.status === "duplicate" ? 200 : 202).send({
      observationId: observation.observationId,
      status: result.status,
      projectionQueued: result.status === "accepted",
      busPublished,
      receivedAt: observation.receivedAt,
      correlationId: observation.correlationId
    });
  });

  app.get("/observations/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const observation = await repository.get(id);
    return observation ? observation : reply.code(404).send({ error: "observation_not_found", id });
  });

  app.get("/observations", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return repository.query({
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.observerId ? { observerId: query.observerId } : {}),
      ...(query.observationType ? { observationType: query.observationType } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      limit: query.limit ? Number(query.limit) : 1_000
    });
  });

  app.addHook("onClose", async () => bus.drain());
  return app;
}

function sameObservation(existing: ObservationEnvelope, incoming: ObservationEnvelope, compareReceivedAt: boolean): boolean {
  const normalize = (value: ObservationEnvelope) => ({
    ...value,
    observedAt: new Date(value.observedAt).toISOString(),
    receivedAt: compareReceivedAt ? new Date(value.receivedAt).toISOString() : undefined
  });
  return isDeepStrictEqual(normalize(existing), normalize(incoming));
}
