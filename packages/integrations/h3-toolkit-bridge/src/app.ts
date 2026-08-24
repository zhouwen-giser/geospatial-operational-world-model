import Fastify, { type FastifyInstance } from "fastify";
import type {
  PlatformError,
  ProviderExecutionRequest
} from "../../../platform/contract-runtime/src/index.js";
import {
  createProviderTransportAuthenticator,
  newOpaqueId,
  ProviderProtocolError
} from "../../../platform/provider-sdk/src/index.js";
import type { H3ProviderBridge } from "./provider.js";

export function buildH3ProviderApp(bridge: H3ProviderBridge, transportToken: string): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: bridge.bodyLimitBytes });
  const authenticate = createProviderTransportAuthenticator(transportToken);
  app.addHook("onRequest", async (request) => {
    if (request.method === "POST" && request.url.startsWith("/v1/operations/")) authenticate(request.headers.authorization);
  });

  app.get("/v1/manifest", async () => bridge.runtime.manifest);
  app.get("/health/live", async () => bridge.runtime.health());
  app.get("/health/ready", async (_request, reply) => {
    const upstream = await bridge.upstream.readiness();
    return reply.code(upstream.ready ? 200 : 503).send({
      ready: upstream.ready,
      providerId: bridge.runtime.manifest.provider.providerId,
      operationCount: bridge.operationIds.length,
      reasons: upstream.reasons,
      upstream: {
        sourceGitCommit: upstream.sourceGitCommit,
        toolkitVersion: upstream.toolkitVersion,
        engineVersion: upstream.engineVersion
      }
    });
  });
  app.get("/v1/jobs/:jobId", async (request, reply) => reply.code(404).send({
    error: "JOB_NOT_FOUND",
    jobId: (request.params as { jobId: string }).jobId,
    reason: "H3 v0.2 bridges advertise synchronous execution only; oversized work is rejected"
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
    const trace = request.headers["x-gowm-trace-id"] ?? request.headers.traceparent;
    return reply.send(await bridge.runtime.execute(body, Array.isArray(trace) ? trace[0] : trace));
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = error instanceof ProviderProtocolError
      ? error
      : new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "H3 bridge execution failed", { cause: error });
    const requestId = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u.test(request.id)
      ? request.id
      : newOpaqueId("provider_request");
    const payload: PlatformError = {
      schemaVersion: "1.0",
      requestId,
      error: {
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.retryable,
        stage: ["INVALID_REQUEST", "SCHEMA_MISMATCH"].includes(mapped.code)
          ? "REQUEST_VALIDATION"
          : "PROVIDER_EXECUTION",
        providerId: bridge.runtime.manifest.provider.providerId,
        ...(mapped.details === undefined ? {} : { details: { ...mapped.details } })
      }
    };
    return reply.code(mapped.httpStatus).send(payload);
  });
  return app;
}
