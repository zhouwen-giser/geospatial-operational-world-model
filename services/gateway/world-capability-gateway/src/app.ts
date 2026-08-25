import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type {
  GatewayExecuteRequest,
  PlatformError,
  WorldQuerySubmission
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { newOpaqueId, ProviderProtocolError } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { DirectExecutionService } from "./direct-execution.js";
import type { CapabilityRegistry } from "./registry.js";
import type { GatewayRecordStore } from "./records.js";
import type { GatewayPrincipal } from "./types.js";
import type { WorldQueryRuntime } from "./query-plan-runtime.js";
import { publicErrorMessage, redactPublicDetails } from "./redaction.js";
import { projectCapabilitySemantics } from "./capability-semantics.js";

export interface GatewayAppOptions {
  registry: CapabilityRegistry;
  directExecution: DirectExecutionService;
  authenticate(request: FastifyRequest): Promise<GatewayPrincipal>;
  records?: GatewayRecordStore;
  worldQueries?: WorldQueryRuntime;
  readiness?: () => Promise<boolean>;
  logger?: boolean;
}

export function buildGatewayApp(options: GatewayAppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16 * 1024 * 1024,
    requestIdHeader: "x-request-id"
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = error instanceof ProviderProtocolError
      ? error
      : new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "Gateway request failed", { cause: error });
    const nodeId = identifierDetail(mapped.details, "nodeId");
    const providerId = identifierDetail(mapped.details, "providerId");
    const publicDetails = redactPublicDetails(mapped.details);
    const payload: PlatformError = {
      schemaVersion: "1.0",
      requestId: normalizeRequestId(request.id),
      error: {
        code: mapped.code,
        message: publicErrorMessage(mapped.code),
        retryable: mapped.retryable,
        stage: stageFor(mapped.code, mapped.details),
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(providerId === undefined ? {} : { providerId }),
        ...(publicDetails === undefined ? {} : { details: publicDetails })
      }
    };
    return reply.code(mapped.httpStatus).send(payload);
  });

  app.get("/health", async () => {
    const providers = await options.registry.health();
    const ready = Object.values(providers).every((health) => health.ready);
    return { status: ready ? "ok" : "degraded", service: "world-capability-gateway", providers };
  });

  // Process/registry liveness is intentionally independent of downstream
  // Provider health. `/health` retains the full degradation inventory.
  app.get("/health/live", async () => ({ status: "ok", service: "world-capability-gateway" }));
  app.get("/health/ready", async (_request, reply) => {
    const ready = await (options.readiness?.().catch(() => false) ?? Promise.resolve(true));
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ok" : "not_ready",
      service: "world-capability-gateway",
      registryVersion: options.registry.revision,
      capabilityCount: options.registry.catalog().length
    });
  });

  app.get("/v1/capabilities", async () => ({
    registryVersion: options.registry.revision,
    capabilities: options.registry.catalog()
  }));

  app.get("/v1/capabilities/:operationId", async (request, reply) => {
    const operationId = (request.params as { operationId: string }).operationId;
    const versions = options.registry.catalog().filter((descriptor) => descriptor.operationId === operationId);
    return versions.length
      ? { registryVersion: options.registry.revision, operationId, versions }
      : reply.code(404).send(platformError(normalizeRequestId(request.id), "OPERATION_NOT_FOUND", "operation is not registered", "REGISTRY_RESOLUTION"));
  });

  app.get("/v1/capability-semantics", async () =>
    projectCapabilitySemantics(options.registry.catalog(), options.registry.revision)
  );

  app.get("/v1/capability-semantics/:operationId/:operationVersion", async (request, reply) => {
    const { operationId, operationVersion } = request.params as { operationId: string; operationVersion: string };
    const profile = projectCapabilitySemantics(options.registry.catalog(), options.registry.revision).profiles
      .find((candidate) => candidate.operationId === operationId && candidate.operationVersion === operationVersion);
    return profile ?? reply.code(404).send(platformError(normalizeRequestId(request.id), "VERSION_NOT_FOUND", "semantic profile is not registered", "REGISTRY_RESOLUTION"));
  });

  app.post("/v1/operations/*", async (request, reply) => {
    const suffix = (request.params as { "*": string })["*"];
    if (!suffix.endsWith(":execute")) {
      return reply.code(404).send(platformError(normalizeRequestId(request.id), "OPERATION_NOT_FOUND", "operation route is not registered", "REGISTRY_RESOLUTION"));
    }
    const operationId = suffix.slice(0, -":execute".length);
    if (!/^[a-z][a-z0-9.-]{2,127}$/.test(operationId)) {
      throw new ProviderProtocolError("INVALID_REQUEST", "invalid operation id in route");
    }
    const principal = await options.authenticate(request);
    const result = await options.directExecution.execute(operationId, request.body as GatewayExecuteRequest, principal);
    return reply.header("Idempotent-Replay", result.replayed ? "true" : "false").send(result.result);
  });

  if (options.worldQueries) {
    app.post("/v1/world-queries", async (request, reply) => {
      const principal = await options.authenticate(request);
      const prefer = Array.isArray(request.headers.prefer)
        ? request.headers.prefer.join(",")
        : request.headers.prefer ?? "";
      const mode = /(?:^|,)\s*respond-async\s*(?:,|$)/iu.test(prefer) ? "ASYNC" : "SYNC";
      const submitted = await options.worldQueries!.submit(request.body as WorldQuerySubmission, principal, mode);
      reply.header("Idempotent-Replay", submitted.replayed ? "true" : "false");
      if (mode === "ASYNC" && submitted.result === undefined) return reply.code(202).send(submitted.job);
      return submitted.result ?? submitted.job;
    });

    app.get("/v1/world-queries/:queryId", async (request, reply) => {
      const principal = await options.authenticate(request);
      const queryId = (request.params as { queryId: string }).queryId;
      const job = await options.worldQueries!.get(queryId, principal);
      return job ?? reply.code(404).send(platformError(
        normalizeRequestId(request.id),
        "JOB_NOT_FOUND",
        "world query is not registered",
        "REGISTRY_RESOLUTION"
      ));
    });

    app.post("/v1/world-queries/*", async (request, reply) => {
      const suffix = (request.params as { "*": string })["*"];
      if (!suffix.endsWith(":cancel")) {
        return reply.code(404).send(platformError(
          normalizeRequestId(request.id),
          "JOB_NOT_FOUND",
          "world query route is not registered",
          "REGISTRY_RESOLUTION"
        ));
      }
      const queryId = suffix.slice(0, -":cancel".length);
      if (!queryId) throw new ProviderProtocolError("INVALID_REQUEST", "world query id is required");
      const principal = await options.authenticate(request);
      const job = await options.worldQueries!.cancel(queryId, principal);
      return job ?? reply.code(404).send(platformError(
        normalizeRequestId(request.id),
        "JOB_NOT_FOUND",
        "world query is not registered",
        "REGISTRY_RESOLUTION"
      ));
    });
  }

  app.get("/v1/jobs/:jobId", async (request, reply) => {
    const principal = await options.authenticate(request);
    const jobId = (request.params as { jobId: string }).jobId;
    // Generic record stores do not carry caller ownership. Fail closed and
    // expose only world-query jobs whose persisted principal context matches.
    const job = await options.worldQueries?.getJob(jobId, principal);
    return job ?? reply.code(404).send(platformError(normalizeRequestId(request.id), "JOB_NOT_FOUND", "job is not registered", "REGISTRY_RESOLUTION"));
  });

  app.get("/v1/receipts/:receiptId", async (request, reply) => {
    await options.authenticate(request);
    const receiptId = (request.params as { receiptId: string }).receiptId;
    const receipt = await options.records?.getReceipt(receiptId);
    return receipt ?? reply.code(404).send(platformError(normalizeRequestId(request.id), "RECEIPT_NOT_FOUND", "receipt is not registered", "REGISTRY_RESOLUTION"));
  });

  return app;
}

function normalizeRequestId(value: string): string {
  return /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/.test(value) ? value : newOpaqueId("gateway-request");
}

function stageFor(code: string, details?: Readonly<Record<string, unknown>>): PlatformError["error"]["stage"] {
  const requested = details?.stage;
  if (typeof requested === "string" && [
    "REQUEST_VALIDATION",
    "REGISTRY_RESOLUTION",
    "POLICY",
    "PROVIDER_EXECUTION",
    "DAG_VALIDATION",
    "DAG_EXECUTION",
    "SNAPSHOT",
    "RESULT_ASSEMBLY"
  ].includes(requested)) return requested as PlatformError["error"]["stage"];
  if (["INVALID_REQUEST", "SCHEMA_MISMATCH"].includes(code)) return "REQUEST_VALIDATION";
  if (["OPERATION_NOT_FOUND", "VERSION_NOT_FOUND"].includes(code)) return "REGISTRY_RESOLUTION";
  if (["SCOPE_REQUIRED", "SCOPE_DENIED", "BUDGET_EXCEEDED"].includes(code)) return "POLICY";
  return "PROVIDER_EXECUTION";
}

function identifierDetail(details: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/.test(value) ? value : undefined;
}

function platformError(
  requestId: string,
  code: string,
  message: string,
  stage: PlatformError["error"]["stage"]
): PlatformError {
  return { schemaVersion: "1.0", requestId, error: { code, message, retryable: false, stage } };
}
