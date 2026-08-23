import {
  ProviderProtocolError,
  readBoundedJsonResponse,
  sha256,
  type DeadlineContext,
  type TraceContext
} from "../../../platform/provider-sdk/src/index.js";
import { assertH3ToolkitAttestation, lockedAttestation } from "./source-lock.js";
import type {
  ApprovedH3ToolkitEndpoint,
  H3OperationId,
  H3ToolkitReadiness,
  H3ToolkitResult,
  H3ToolkitUpstream,
  Sha256Digest
} from "./types.js";

const HTTP_OPERATIONS = [
  "h3.index.points",
  "h3.geometry.cover",
  "h3.neighborhood.disk",
  "h3.analytics.aggregate",
  "h3.analytics.coverage",
  "h3.analytics.flow"
] as const satisfies readonly H3OperationId[];

const ROUTES: Readonly<Record<(typeof HTTP_OPERATIONS)[number], string>> = Object.freeze({
  "h3.index.points": "/v1/h3/index",
  "h3.geometry.cover": "/v1/h3/polygon/cover",
  "h3.neighborhood.disk": "/v1/h3/neighbors",
  "h3.analytics.aggregate": "/v1/h3/aggregate",
  "h3.analytics.coverage": "/v1/h3/coverage",
  "h3.analytics.flow": "/v1/h3/flow"
});

const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export class H3ToolkitHttpClient implements H3ToolkitUpstream {
  readonly attestation = lockedAttestation("TOOLKIT_HTTP_V1");
  readonly supportedOperations: readonly H3OperationId[] = HTTP_OPERATIONS;
  readonly baseUrl: string;

  constructor(
    private readonly endpoint: ApprovedH3ToolkitEndpoint,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch
  ) {
    this.baseUrl = assertApprovedEndpoint(endpoint);
    assertH3ToolkitAttestation(this.attestation);
  }

  async execute(
    operationId: H3OperationId,
    input: unknown,
    deadline: DeadlineContext,
    trace: TraceContext
  ): Promise<H3ToolkitResult> {
    if (!isHttpOperation(operationId)) {
      throw new ProviderProtocolError(
        "OPERATION_NOT_FOUND",
        `${operationId} is not exposed by the locked Toolkit v0.3.0 HTTP API; use the locked package adapter`,
        { retryable: false }
      );
    }
    const body = operationId === "h3.geometry.cover"
      ? { ...asRecord(input, "H3 cover input"), output: "cells" }
      : input;
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.baseUrl}${ROUTES[operationId]}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-request-id": trace.requestId,
          "x-gowm-trace-id": trace.traceId,
          ...(this.endpoint.authorization === undefined ? {} : { authorization: this.endpoint.authorization })
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
        redirect: "error"
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "H3 Toolkit upstream is unavailable", {
        retryable: true,
        details: { endpointClass: "registry-approved-h3-toolkit" },
        cause: error
      });
    }
    const payload = await readJson(response, deadline.signal);
    if (!response.ok) throw mapUpstreamError(response.status, payload);
    return parseSuccess(payload);
  }

  async readiness(timeoutMs = 2_000): Promise<H3ToolkitReadiness> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await this.fetchImplementation(`${this.baseUrl}/ready`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
        redirect: "error"
      });
      const payload = await readJson(response, controller.signal);
      const record = asRecord(payload, "Toolkit readiness response");
      const reasons: string[] = [];
      if (!response.ok) reasons.push(`upstream readiness returned HTTP ${response.status}`);
      if (record.status !== "ready") reasons.push("upstream status is not ready");
      if (record.toolkitVersion !== this.attestation.toolkitVersion) reasons.push("Toolkit version differs from source lock");
      return readiness(reasons);
    } catch (error) {
      return readiness([error instanceof Error ? error.message : String(error)]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function h3EndpointConfigurationDigest(endpointId: string, baseUrl: string): Sha256Digest {
  return sha256({ endpointId, baseUrl: normalizeBaseUrl(baseUrl) });
}

function isHttpOperation(operationId: H3OperationId): operationId is (typeof HTTP_OPERATIONS)[number] {
  return (HTTP_OPERATIONS as readonly string[]).includes(operationId);
}

function assertApprovedEndpoint(endpoint: ApprovedH3ToolkitEndpoint): string {
  if (endpoint.approvalStatus !== "APPROVED") {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "H3 Toolkit endpoint is not registry-approved", {
      retryable: false
    });
  }
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u.test(endpoint.endpointId)) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "H3 Toolkit endpoint ID is invalid", { retryable: false });
  }
  if (!DIGEST.test(endpoint.configurationDigest)) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "H3 Toolkit endpoint digest is invalid", { retryable: false });
  }
  const baseUrl = normalizeBaseUrl(endpoint.baseUrl);
  if (endpoint.configurationDigest !== h3EndpointConfigurationDigest(endpoint.endpointId, baseUrl)) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "H3 Toolkit endpoint differs from its approval digest", {
      retryable: false
    });
  }
  return baseUrl;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "H3 Toolkit endpoint is not an absolute URL", {
      retryable: false,
      cause: error
    });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "H3 Toolkit endpoint uses a forbidden URL form", {
      retryable: false
    });
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  return readBoundedJsonResponse(response, {
    maximumBytes: MAX_RESPONSE_BYTES,
    peerLabel: "H3 Toolkit",
    signal
  });
}

function parseSuccess(value: unknown): H3ToolkitResult {
  const envelope = asRecord(value, "H3 Toolkit success envelope");
  const meta = asRecord(envelope.meta, "H3 Toolkit response meta");
  if (meta.toolkitVersion !== "0.3.0" || meta.engine !== "h3-js" || meta.engineVersion !== "4.5.0") {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "H3 Toolkit response metadata differs from the source lock", {
      retryable: false
    });
  }
  if (!Array.isArray(meta.warnings) || meta.warnings.some((warning) => typeof warning !== "string")) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "H3 Toolkit response warnings are invalid", { retryable: false });
  }
  return {
    data: envelope.data,
    warnings: [...meta.warnings] as string[],
    meta: { toolkitVersion: "0.3.0", engine: "h3-js", engineVersion: "4.5.0" }
  };
}

function mapUpstreamError(status: number, value: unknown): ProviderProtocolError {
  const record = isRecord(value) && isRecord(value.error) ? value.error : undefined;
  const upstreamCode = typeof record?.code === "string" ? record.code : "UNCLASSIFIED_UPSTREAM_ERROR";
  const details = { upstreamStatus: status, upstreamCode };
  if (status === 408) return new ProviderProtocolError("DEADLINE_EXCEEDED", "H3 Toolkit deadline exceeded", { details });
  if (status === 413) return new ProviderProtocolError("BUDGET_EXCEEDED", "H3 Toolkit budget exceeded", { details });
  if (status === 429) return new ProviderProtocolError("OVERLOADED", "H3 Toolkit is overloaded", { retryable: true, details });
  if ([502, 503, 504].includes(status)) {
    return new ProviderProtocolError("PROVIDER_NOT_READY", "H3 Toolkit is not ready", { retryable: true, details });
  }
  if ([400, 404, 422].includes(status)) {
    return new ProviderProtocolError("INVALID_REQUEST", "H3 Toolkit rejected the request", { retryable: false, details });
  }
  return new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "H3 Toolkit execution failed", { details });
}

function readiness(reasons: string[]): H3ToolkitReadiness {
  return {
    ready: reasons.length === 0,
    reasons,
    sourceGitCommit: "74fc8657072dd58a2f8e4317c1caef8bfd10e024",
    toolkitVersion: "0.3.0",
    engineVersion: "4.5.0"
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ProviderProtocolError("SCHEMA_MISMATCH", `${name} must be a JSON object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
