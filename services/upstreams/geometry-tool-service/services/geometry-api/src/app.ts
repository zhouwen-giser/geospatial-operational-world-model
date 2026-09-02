import { readFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { z } from "zod";
import {
  GeometryServiceError,
  asGeometryServiceError,
  batchRequestSchema,
  binaryGeometryRequestSchema,
  bufferRequestSchema,
  geometryEnvelopeSchema,
  inspectGeometry,
  measureRequestSchema,
  operationRequestSchema,
  predicateRequestSchema,
  resourceLimitsFromEnv,
  simplifyRequestSchema,
  type BatchRequest,
  type CommonOptions,
  type GeometryEnvelope,
  type GeometryOperation,
  type GeometryResult,
  type OperationRequest,
} from "@geospatial/geometry-contract";
import { GeometryCore } from "@geospatial/geometry-core";
import { GeosWasmAdapter, GeosWorkerPoolAdapter } from "@geospatial/geometry-adapter-geos";
import { PostgisAdapter } from "@geospatial/geometry-adapter-postgis";

export interface GeometryApiOptions {
  core?: GeometryCore;
  logger?: boolean;
  maxInFlight?: number;
}

export async function buildGeometryApi(options: GeometryApiOptions = {}): Promise<FastifyInstance> {
  const limits = resourceLimitsFromEnv();
  const core = options.core ?? new GeometryCore({
    limits,
    adapter: process.env.GEOMETRY_ENGINE === "postgis"
      ? new PostgisAdapter()
      : process.env.GEOMETRY_EXECUTION === "inline"
        ? new GeosWasmAdapter()
        : new GeosWorkerPoolAdapter({
            ...(Number(process.env.GEOMETRY_WORKERS) > 0 ? { size: Number(process.env.GEOMETRY_WORKERS) } : {}),
            ...(Number(process.env.GEOMETRY_MAX_WORKER_QUEUE) >= 0 && process.env.GEOMETRY_MAX_WORKER_QUEUE !== undefined
              ? { maxQueueSize: Number(process.env.GEOMETRY_MAX_WORKER_QUEUE) }
              : {}),
            operationTimeoutMs: limits.syncTimeoutMs,
          }),
  });
  const maxInFlight = positiveInteger(options.maxInFlight ?? Number(process.env.GEOMETRY_MAX_IN_FLIGHT), 64, 100_000);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: limits.maxBodyBytes, requestTimeout: limits.syncTimeoutMs + 1_000 });
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "geometry_" });
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();

  const requestCount = new Counter({ name: "geometry_request_count_total", help: "HTTP requests", labelNames: ["method", "route", "status"] as const, registers: [registry] });
  const operationCount = new Counter({ name: "geometry_operation_count_total", help: "Geometry operations", labelNames: ["operation", "status"] as const, registers: [registry] });
  const operationLatency = new Histogram({ name: "geometry_operation_latency_seconds", help: "Geometry operation latency", labelNames: ["operation"] as const, buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2], registers: [registry] });
  const inputVertices = new Histogram({ name: "geometry_input_vertex_count", help: "Input vertices per operation", labelNames: ["operation"] as const, buckets: [1, 10, 100, 1_000, 10_000, 100_000], registers: [registry] });
  const outputVertices = new Histogram({ name: "geometry_output_vertex_count", help: "Output vertices per operation", labelNames: ["operation"] as const, buckets: [1, 10, 100, 1_000, 10_000, 100_000], registers: [registry] });
  const invalidCount = new Counter({ name: "geometry_invalid_geometry_count_total", help: "Invalid geometries", registers: [registry] });
  const repairCount = new Counter({ name: "geometry_repair_count_total", help: "Repairs", registers: [registry] });
  const timeoutCount = new Counter({ name: "geometry_timeout_count_total", help: "Operation timeouts", registers: [registry] });
  const engineErrorCount = new Counter({ name: "geometry_engine_error_count_total", help: "Engine errors", registers: [registry] });
  const httpInFlight = new Gauge({ name: "geometry_http_in_flight", help: "Admitted geometry HTTP requests currently executing", registers: [registry] });
  const httpRejected = new Counter({ name: "geometry_http_rejected_total", help: "Geometry HTTP requests rejected by in-flight load shedding", registers: [registry] });
  const httpAborted = new Counter({ name: "geometry_http_aborted_total", help: "Admitted geometry HTTP requests whose client disconnected before completion", registers: [registry] });
  const workerQueueDepth = new Gauge({
    name: "geometry_worker_queue_depth",
    help: "Requests waiting in the process-local GEOS worker queue",
    registers: [registry],
    collect() { this.set(workerStats(core)?.queuedRequests ?? 0); },
  });
  const workerActive = new Gauge({
    name: "geometry_worker_active_requests",
    help: "GEOS workers currently executing a request",
    registers: [registry],
    collect() { this.set(workerStats(core)?.activeRequests ?? 0); },
  });
  void workerQueueDepth;
  void workerActive;
  const eventLoopP99 = new Gauge({ name: "geometry_event_loop_lag_p99_seconds", help: "Event-loop delay p99", registers: [registry], collect() { this.set(eventLoop.percentile(99) / 1e9); } });
  void eventLoopP99;

  const openapiPath = fileURLToPath(new URL("../../../openapi/geometry-api.openapi.json", import.meta.url));
  const openapi = JSON.parse(readFileSync(openapiPath, "utf8")) as Record<string, unknown>;

  let inFlight = 0;
  const admittedRequests = new WeakSet<object>();
  const releaseAdmission = (request: object): boolean => {
    if (!admittedRequests.delete(request)) return false;
    inFlight = Math.max(0, inFlight - 1);
    httpInFlight.set(inFlight);
    return true;
  };
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "POST" || !request.url.startsWith("/v1/geometry")) return;
    if (inFlight >= maxInFlight) {
      httpRejected.inc();
      return reply.status(503).send(new GeometryServiceError({
        code: "RESOURCE_LIMIT",
        message: `Geometry service is at its HTTP in-flight limit (${inFlight}/${maxInFlight})`,
        recoverable: true,
        suggestion: "Retry with exponential backoff and jitter, or reduce client concurrency.",
        details: { kind: "overload", resource: "http_in_flight", inFlight, maxInFlight },
      }).toJSON());
    }
    inFlight += 1;
    admittedRequests.add(request);
    httpInFlight.set(inFlight);
    reply.raw.once("close", () => {
      const aborted = !reply.raw.writableEnded;
      if (releaseAdmission(request) && aborted) httpAborted.inc();
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    releaseAdmission(request);
    requestCount.inc({ method: request.method, route: request.routeOptions.url ?? "unmatched", status: String(reply.statusCode) });
  });

  app.addHook("onRequestAbort", async (request) => {
    if (releaseAdmission(request)) httpAborted.inc();
  });

  app.setErrorHandler(async (error, request, reply) => {
    const isBodyLimit = (error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE";
    const normalized = isBodyLimit
      ? new GeometryServiceError({ code: "GEOMETRY_TOO_LARGE", message: "Request body exceeds configured byte limit", recoverable: true, suggestion: "Simplify/split input or use the future WKB high-volume endpoint." })
      : error instanceof z.ZodError
        ? new GeometryServiceError({ code: "INVALID_COORDINATE", message: "Request does not match Geometry Contract", recoverable: false, details: { issues: error.issues } })
        : asGeometryServiceError(error);
    if (normalized.code === "OPERATION_TIMEOUT") timeoutCount.inc();
    if (normalized.code === "ENGINE_ERROR" || normalized.code === "TOPOLOGY_EXCEPTION") engineErrorCount.inc();
    const status = statusForError(normalized);
    request.log.warn({ code: normalized.code, operation: normalized.operation }, normalized.message);
    await reply.status(status).send(normalized.toJSON());
  });

  async function run(operation: GeometryOperation, body: unknown, request: OperationRequest): Promise<unknown> {
    const started = performance.now();
    operationCount.inc({ operation, status: "started" });
    for (const envelope of inputEnvelopes(body)) inputVertices.observe({ operation }, inspectGeometry(envelope.geometry).vertexCount);
    try {
      const result = await core.execute(request);
      operationCount.inc({ operation, status: "success" });
      if ("detail" in result && !result.detail.valid) invalidCount.inc();
      if (operation === "make_valid") repairCount.inc();
      if (typeof result.result === "object" && result.result !== null && "type" in result.result) {
        outputVertices.observe({ operation }, inspectGeometry(result.result).vertexCount);
      }
      return result;
    } catch (error) {
      operationCount.inc({ operation, status: "error" });
      throw error;
    } finally {
      operationLatency.observe({ operation }, (performance.now() - started) / 1_000);
    }
  }

  app.get("/health", async () => ({ status: "ok", service: "geometry-api" }));
  app.get("/ready", async (_request, reply) => {
    try {
      await core.initialize();
      return {
        status: "ready",
        engine: core.adapter.name,
        engineVersion: core.adapter.version,
        database: core.adapter.name === "PostGIS-GEOS" ? "required" : "not-required",
        overloadProtection: { maxInFlight, workerPool: workerStats(core) },
      };
    } catch (error) {
      return reply.status(503).send({ status: "not-ready", reason: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/metrics", async (_request, reply) => reply.type(registry.contentType).send(await registry.metrics()));
  app.get("/openapi.json", async () => openapi);

  app.post("/v1/geometry/validate", async (request) => {
    const body = z.object({ input: geometryEnvelopeSchema }).parse(request.body) as unknown as { input: GeometryEnvelope };
    return run("validate", body, { operation: "validate", input: body.input });
  });

  app.post("/v1/geometry/make-valid", async (request) => {
    const body = z.object({ input: geometryEnvelopeSchema, options: z.record(z.string(), z.unknown()).optional() }).parse(request.body) as unknown as { input: GeometryEnvelope; options?: CommonOptions };
    return run("make_valid", body, { operation: "make_valid", input: body.input, ...(body.options ? { options: body.options } : {}) });
  });

  app.post("/v1/geometry/buffer", async (request) => {
    const body = bufferRequestSchema.parse(request.body) as unknown as { input: GeometryEnvelope; options: CommonOptions & Record<string, unknown> & { distance: number } };
    const { distance, mode, repairInvalid, normalizeOutput, precision, planar, outputFormat, ...parameters } = body.options;
    const common: CommonOptions = { ...(mode ? { mode } : {}), ...(repairInvalid === undefined ? {} : { repairInvalid }), ...(normalizeOutput === undefined ? {} : { normalizeOutput }), ...(precision ? { precision } : {}), ...(planar === undefined ? {} : { planar }), ...(outputFormat ? { outputFormat } : {}) };
    return run("buffer", body, { operation: "buffer", input: body.input, parameters: { ...parameters, distance }, options: common });
  });

  for (const [path, operation] of [["intersection", "intersection"], ["union", "union"], ["difference", "difference"]] as const) {
    app.post(`/v1/geometry/${path}`, async (request) => {
      const body = binaryGeometryRequestSchema.parse(request.body) as unknown as { a: GeometryEnvelope; b: GeometryEnvelope; options?: CommonOptions };
      return run(operation, body, { operation, input: body.a, other: body.b, ...(body.options ? { options: body.options } : {}) });
    });
  }

  app.post("/v1/geometry/simplify", async (request) => {
    const body = simplifyRequestSchema.parse(request.body) as unknown as { input: GeometryEnvelope; options: CommonOptions & { tolerance: number; preserveTopology?: boolean; preserveCoverageBoundary?: boolean } };
    const operation = body.options.preserveTopology === false ? "simplify" : "simplify_preserve_topology";
    return run(operation, body, { operation, input: body.input, parameters: { tolerance: body.options.tolerance, preserveBoundary: body.options.preserveCoverageBoundary ?? true }, options: body.options });
  });

  app.post("/v1/geometry/measure", async (request) => {
    const body = measureRequestSchema.parse(request.body) as unknown as { measure: GeometryOperation; input: GeometryEnvelope; other?: GeometryEnvelope; options?: CommonOptions };
    return run(body.measure, body, { operation: body.measure, input: body.input, ...(body.other ? { other: body.other } : {}), ...(body.options ? { options: body.options } : {}) });
  });

  app.post("/v1/geometry/predicate", async (request) => {
    const body = predicateRequestSchema.parse(request.body) as unknown as { predicate: GeometryOperation; a: GeometryEnvelope; b: GeometryEnvelope; pattern?: string; options?: CommonOptions };
    return run(body.predicate, body, { operation: body.predicate, input: body.a, other: body.b, ...(body.pattern ? { parameters: { pattern: body.pattern } } : {}), ...(body.options ? { options: body.options } : {}) });
  });

  app.post("/v1/geometry/batch", async (request) => {
    const body = batchRequestSchema.parse(request.body) as unknown as BatchRequest;
    operationCount.inc({ operation: body.operation, status: "batch_started" });
    const result = await core.batch(body);
    operationCount.inc({ operation: body.operation, status: result.summary.failed > 0 ? "batch_partial" : "batch_success" });
    return result;
  });

  app.post("/v1/geometry/parse", async (request) => {
    const body = z.object({ format: z.enum(["geojson", "wkt", "wkb-hex"]), value: z.unknown(), srid: z.number().int().nonnegative().optional() }).parse(request.body);
    const operation = ({ geojson: "parse_geojson", wkt: "parse_wkt", "wkb-hex": "parse_wkb" } as const)[body.format];
    const key = body.format === "geojson" ? "geojson" : body.format === "wkt" ? "wkt" : "wkbHex";
    return run(operation, body, { operation, parameters: { [key]: body.value, ...(body.srid === undefined ? {} : { srid: body.srid }) } });
  });

  app.post("/v1/geometry/serialize", async (request) => {
    const body = z.object({ input: geometryEnvelopeSchema, format: z.enum(["geojson", "wkt", "wkb-hex"]) }).parse(request.body) as unknown as { input: GeometryEnvelope; format: "geojson" | "wkt" | "wkb-hex" };
    const operation = ({ geojson: "to_geojson", wkt: "to_wkt", "wkb-hex": "to_wkb" } as const)[body.format];
    return run(operation, body, { operation, input: body.input });
  });

  app.post("/v1/geometry/execute", async (request) => {
    const body = operationRequestSchema.parse(request.body) as unknown as OperationRequest;
    return run(body.operation, body, body);
  });

  app.addHook("onClose", async () => {
    eventLoop.disable();
    await core.close();
  });

  return app;
}

function inputEnvelopes(body: unknown): GeometryEnvelope[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  return [record.input, record.a, record.b, record.other].filter((value): value is GeometryEnvelope => Boolean(value && typeof value === "object" && "geometry" in (value as object)));
}

function statusForError(error: GeometryServiceError): number {
  if (error.code === "OPERATION_TIMEOUT") return 408;
  if (error.code === "RESOURCE_LIMIT" && error.details?.kind === "overload") return 503;
  if (["GEOMETRY_TOO_LARGE", "TOO_MANY_VERTICES", "TOO_MANY_GEOMETRIES", "RESOURCE_LIMIT", "NESTING_TOO_DEEP"].includes(error.code)) return 413;
  if (["INVALID_GEOMETRY", "INVALID_COORDINATE", "EMPTY_GEOMETRY", "SRID_MISMATCH", "PLANAR_ACKNOWLEDGEMENT_REQUIRED", "PRECISION_ERROR"].includes(error.code)) return 422;
  if (["UNSUPPORTED_OPERATION", "UNSUPPORTED_GEOMETRY_TYPE", "CRS_TRANSFORMATION_UNSUPPORTED", "GEODESIC_OPERATION_UNSUPPORTED", "SPATIAL_DATASET_OPERATION_UNSUPPORTED", "RASTER_OPERATION_UNSUPPORTED", "ROUTING_OPERATION_UNSUPPORTED", "H3_OPERATION_UNSUPPORTED"].includes(error.code)) return 400;
  return 500;
}

function positiveInteger(value: number, fallback: number, maximum: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(maximum, Math.floor(value)) : fallback;
}

function workerStats(core: GeometryCore): ReturnType<GeosWorkerPoolAdapter["stats"]> | undefined {
  const adapter = core.adapter as GeometryCore["adapter"] & { stats?: GeosWorkerPoolAdapter["stats"] };
  return typeof adapter.stats === "function" ? adapter.stats() : undefined;
}
