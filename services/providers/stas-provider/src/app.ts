import Fastify, { type FastifyInstance } from "fastify";
import type { PlatformError, ProviderExecutionRequest } from "../../../../packages/platform/contract-runtime/src/index.js";
import { createProviderTransportAuthenticator, newOpaqueId, ProviderProtocolError, type ProviderRuntime } from "../../../../packages/platform/provider-sdk/src/index.js";

export function buildStasProviderApp(runtime: ProviderRuntime, transportToken: string, readiness: () => Promise<{ ready: boolean; reasons: string[] }>): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const authenticate = createProviderTransportAuthenticator(transportToken);
  app.addHook("onRequest", async (request) => {
    if (request.method === "POST" && request.url.startsWith("/v1/operations/")) authenticate(request.headers.authorization);
  });

  app.get("/v1/manifest", async () => runtime.manifest);
  app.get("/health/live", async () => runtime.health());
  app.get("/health/ready", async (_request, reply) => {
    const state = await readiness();
    return reply.code(state.ready ? 200 : 503).send({ ...runtime.readiness(), ...state });
  });
  app.get("/v1/jobs/:jobId", async (request, reply) => reply.code(404).send({
    error: "JOB_NOT_FOUND",
    jobId: (request.params as { jobId: string }).jobId
  }));

  app.post("/v1/operations/*", async (request, reply) => {
    const suffix = (request.params as { "*": string })["*"];
    if (!suffix.endsWith(":execute")) {
      throw new ProviderProtocolError("OPERATION_NOT_FOUND", "operation route is not registered");
    }
    const operationId = suffix.slice(0, -":execute".length);
    const body = request.body as ProviderExecutionRequest;
    if (body?.operation?.operationId !== operationId) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "route operation does not match request operation");
    }
    const traceparent = request.headers.traceparent;
    return reply.send(await runtime.execute(body, Array.isArray(traceparent) ? traceparent[0] : traceparent));
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = error instanceof ProviderProtocolError
      ? error
      : new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "STAS provider execution failed", { cause: error });
    const requestId = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/.test(request.id)
      ? request.id
      : newOpaqueId("provider-request");
    const payload: PlatformError = {
      schemaVersion: "1.0",
      requestId,
      error: {
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.retryable,
        stage: ["INVALID_REQUEST", "SCHEMA_MISMATCH"].includes(mapped.code) ? "REQUEST_VALIDATION" : "PROVIDER_EXECUTION",
        providerId: runtime.manifest.provider.providerId,
        ...(mapped.details === undefined ? {} : { details: { ...mapped.details } })
      }
    };
    return reply.code(mapped.httpStatus).send(payload);
  });
  return app;
}
