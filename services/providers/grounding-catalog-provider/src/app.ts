import Fastify, { type FastifyInstance } from "fastify";
import type { PlatformError, ProviderExecutionRequest } from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderTransportAuthenticator,
  newOpaqueId,
  ProviderProtocolError
} from "../../../../packages/platform/provider-sdk/src/index.js";
import type { GroundingCatalogProvider } from "./provider.js";

export function buildGroundingCatalogApp(provider: GroundingCatalogProvider, transportToken: string): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const authenticate = createProviderTransportAuthenticator(transportToken);
  app.addHook("onRequest", async (request) => {
    if (request.method === "POST" && request.url.startsWith("/v1/operations/")) authenticate(request.headers.authorization);
  });
  app.get("/v1/manifest", async () => provider.runtime.manifest);
  app.get("/health/live", async () => provider.runtime.health());
  app.get("/health/ready", async (_request, reply) => {
    const readiness = await provider.repository.readiness(provider.mode);
    return reply.code(readiness.ready ? 200 : 503).send({
      ready: readiness.ready,
      providerId: provider.runtime.manifest.provider.providerId,
      operationCount: provider.runtime.manifest.capabilities.length,
      reasons: readiness.reasons
    });
  });
  app.get("/v1/jobs/:jobId", async (request, reply) => reply.code(404).send({ error: "JOB_NOT_FOUND", jobId: (request.params as { jobId: string }).jobId }));
  app.post("/v1/operations/*", async (request, reply) => {
    const suffix = (request.params as { "*": string })["*"];
    if (!suffix.endsWith(":execute")) throw new ProviderProtocolError("OPERATION_NOT_FOUND", "operation route is not registered");
    const operationId = suffix.slice(0, -":execute".length);
    const body = request.body as ProviderExecutionRequest;
    if (body?.operation?.operationId !== operationId) throw new ProviderProtocolError("SCHEMA_MISMATCH", "route operation does not match request operation");
    const trace = request.headers["x-gowm-trace-id"] ?? request.headers.traceparent;
    return reply.send(await provider.runtime.execute(body, Array.isArray(trace) ? trace[0] : trace));
  });
  app.setErrorHandler((error, request, reply) => {
    const mapped = error instanceof ProviderProtocolError ? error : new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "grounding catalog execution failed", { cause: error });
    const requestId = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u.test(request.id) ? request.id : newOpaqueId("catalog_request");
    const payload: PlatformError = {
      schemaVersion: "1.0",
      requestId,
      error: {
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.retryable,
        stage: ["INVALID_REQUEST", "SCHEMA_MISMATCH"].includes(mapped.code) ? "REQUEST_VALIDATION" : "PROVIDER_EXECUTION",
        providerId: provider.runtime.manifest.provider.providerId,
        ...(mapped.details === undefined ? {} : { details: { ...mapped.details } })
      }
    };
    return reply.code(mapped.httpStatus).send(payload);
  });
  return app;
}
