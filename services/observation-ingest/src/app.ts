import Fastify, { type FastifyInstance } from "fastify";
import { ObservationInputSchema } from "../../../packages/world-model-core/src/schema.js";
import { loadConfig } from "../../../packages/world-model-core/src/config.js";
import { normalizeObservationInput } from "../../../packages/observation-model/src/canonical.js";
import { validateGeometry } from "../../../packages/spatial-engine/src/geometry.js";
import { validateObservationTime } from "../../../packages/observation-model/src/fusion.js";
import { databasePool } from "../../../packages/runtime/src/db.js";
import { ObservationRepository } from "../../../packages/runtime/src/observation-repository.js";
import { WorldEventBus } from "../../../packages/runtime/src/bus.js";
import { EventRepository } from "../../../packages/runtime/src/event-repository.js";
import { OperationalEventIngestSchema } from "../../../packages/operational-model/src/events.js";
import { OperationalEventRepository } from "../../../packages/runtime/src/operational-event-repository.js";

export function buildObservationApp(): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const config = loadConfig();
  const repository = new ObservationRepository(databasePool());
  const eventRepository = new EventRepository(databasePool());
  const operationalEventRepository = new OperationalEventRepository(databasePool());
  const bus = new WorldEventBus();

  app.get("/health", async () => ({ status: "ok", service: "observation-ingest", timestamp: new Date().toISOString() }));

  app.post("/observations", async (request, reply) => {
    const parsed = ObservationInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_observation", issues: parsed.error.issues });
    const now = new Date();
    const bundle = normalizeObservationInput(parsed.data, now.toISOString());
    const observation = bundle.envelope;
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

    const result = await repository.insert(bundle, timeValidation.reason === "late"
      ? { status: "late", project: false, rejectionReason: "late_arrival" }
      : { status: "accepted", project: bundle.entityBindingStatus !== "CANDIDATE" });

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
      projectionQueued: result.status === "accepted" && bundle.entityBindingStatus !== "CANDIDATE",
      busPublished,
      receivedAt: observation.receivedAt,
      correlationId: observation.correlationId,
      canonicalContractVersion: "1.2",
      inputSchemaVersion: observation.schemaVersion,
      compatibilityAdapter: bundle.compatibilityInputVersion ? "v1.1-to-v1.2" : null,
      timeSolutionId: result.timeSolutionId,
      measurementIds: result.measurementIds ?? [],
      trackletVersionId: result.trackletVersionId ?? null
    });
  });

  app.post("/operational-events", async (request, reply) => {
    const parsed = OperationalEventIngestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: "invalid_operational_event",issues: parsed.error.issues });
    const authorizedScope = request.headers["x-data-scope-key"];
    if (typeof authorizedScope!=="string" || authorizedScope!==parsed.data.dataScopeKey) {
      return reply.code(403).send({ error: "operational_event_scope_denied" });
    }
    try {
      const result = await operationalEventRepository.insert(parsed.data,new Date().toISOString());
      return reply.code(result.status==="duplicate" ? 200 : 202).send({
        eventId: result.event.eventId,
        operationalTaskId: result.event.operationalTaskId,
        status: result.status,
        arrivalClassification: result.arrivalClassification,
        eventTime: result.event.eventTime,
        receivedTime: result.event.receivedTime,
        worldVersion: result.event.worldVersion
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code==="23505") return reply.code(409).send({ error: "operational_event_idempotency_conflict" });
      if (code==="22007") return reply.code(422).send({ error: "operational_event_future_skew" });
      throw error;
    }
  });

  app.get("/observations/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const observation = await repository.get(id);
    return observation ? observation : reply.code(404).send({ error: "observation_not_found", id });
  });

  app.get("/observations/:id/canonical", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const evidence = await repository.getCanonicalEvidence(id);
    return evidence ?? reply.code(404).send({ error: "observation_not_found", id });
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
  app.setErrorHandler((error, _request, reply) => {
    const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    const statusCode = typeof candidate.statusCode === "number" ? candidate.statusCode : 500;
    return reply.code(statusCode).send({
      error: typeof candidate.code === "string" ? candidate.code : "observation_ingest_failed",
      message: statusCode >= 500
        ? "observation ingest failed"
        : typeof candidate.message === "string" ? candidate.message : "observation ingest failed"
    });
  });
  return app;
}
