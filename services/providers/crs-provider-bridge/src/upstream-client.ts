import { validateAgainstSchema } from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  ProviderProtocolError,
  readBoundedJsonResponse,
  sha256,
  type DeadlineContext,
  type TraceContext
} from "../../../../packages/platform/provider-sdk/src/index.js";
import { CRS_OPERATION_SCHEMAS } from "./schemas.js";
import type {
  ApprovedCrsEndpoint,
  CrsDeploymentAttestation,
  CrsOperationId,
  Sha256Digest
} from "./types.js";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

interface UpstreamRoute {
  method: "GET" | "POST";
  path(input: Record<string, unknown>): string;
  body(input: Record<string, unknown>): unknown;
}

const ROUTES: Readonly<Record<CrsOperationId, UpstreamRoute>> = {
  "crs.check-source": {
    method: "GET",
    path: (input) => `/v1/crs/${epsgCode(input.sourceCrs)}`,
    body: () => undefined
  },
  "crs.normalize.point": fixedPost("/v1/normalize/point"),
  "crs.normalize.points": fixedPost("/v1/normalize/points"),
  "crs.normalize.geometry": fixedPost("/v1/normalize/geometry"),
  "crs.normalize.feature": fixedPost("/v1/normalize/feature"),
  "crs.normalize.feature-collection": fixedPost("/v1/normalize/feature-collection")
};

export interface CrsReadiness {
  ready: boolean;
  reasons: string[];
  upstream?: {
    engine: string;
    engineVersion: string;
    integration: string;
    integrationVersion: string;
    networkEnabled: boolean;
    strictBestOperation: boolean;
  };
}

export class CrsUpstreamClient {
  readonly baseUrl: string;

  constructor(
    endpoint: ApprovedCrsEndpoint,
    private readonly attestation: CrsDeploymentAttestation,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch
  ) {
    this.baseUrl = assertApprovedEndpoint(endpoint);
    assertDeploymentAttestation(attestation);
  }

  async execute(
    operationId: CrsOperationId,
    input: unknown,
    deadline: DeadlineContext,
    trace: TraceContext
  ): Promise<unknown> {
    const route = ROUTES[operationId];
    const record = asRecord(input, "validated bridge input");
    const url = joinBasePath(this.baseUrl, route.path(record));
    const body = route.body(record);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: route.method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "x-request-id": trace.requestId,
          "x-gowm-trace-id": trace.traceId
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: deadline.signal,
        redirect: "error"
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "CRS upstream is unavailable", {
        retryable: true,
        details: { endpointClass: "registry-approved-crs-provider" },
        cause: error
      });
    }

    const payload = await readJson(response, deadline.signal);
    if (!response.ok) throw mapUpstreamError(response.status, payload);
    const validation = validateAgainstSchema(CRS_OPERATION_SCHEMAS[operationId].upstreamOutput, payload);
    if (!validation.valid) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "CRS upstream response violates the locked contract", {
        retryable: false,
        details: { operationId, issues: validation.issues }
      });
    }
    return payload;
  }

  async readiness(timeoutMs = 2_000): Promise<CrsReadiness> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await this.fetchImplementation(joinBasePath(this.baseUrl, "/health/ready"), {
        headers: { accept: "application/json" },
        signal: controller.signal,
        redirect: "error"
      });
      const payload = await readJson(response, controller.signal);
      if (!response.ok) return { ready: false, reasons: [`upstream readiness returned HTTP ${response.status}`] };
      const record = asRecord(payload, "upstream readiness");
      const engine = asRecord(record.engine, "upstream readiness engine");
      const actual = {
        engine: stringValue(engine.engine),
        engineVersion: stringValue(engine.engineVersion),
        integration: stringValue(engine.integration),
        integrationVersion: stringValue(engine.integrationVersion),
        networkEnabled: booleanValue(engine.networkEnabled, "upstream readiness engine.networkEnabled"),
        strictBestOperation: booleanValue(engine.strictBestOperation, "upstream readiness engine.strictBestOperation")
      };
      const reasons: string[] = [];
      if (record.status !== "ready") reasons.push("upstream status is not ready");
      if (actual.engine !== "PROJ") reasons.push("upstream engine is not PROJ");
      if (actual.engineVersion !== this.attestation.projVersion) reasons.push("PROJ version differs from deployment attestation");
      if (actual.integration !== this.attestation.integration) reasons.push("integration differs from deployment attestation");
      if (actual.integrationVersion !== this.attestation.integrationVersion) reasons.push("integration version differs from deployment attestation");
      if (actual.networkEnabled !== false) reasons.push("PROJ network policy is not OFF");
      if (actual.strictBestOperation !== true) reasons.push("strict best-operation policy is not enabled");
      return { ready: reasons.length === 0, reasons, upstream: actual };
    } catch (error) {
      return { ready: false, reasons: [error instanceof Error ? error.message : String(error)] };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function endpointConfigurationDigest(endpointId: string, baseUrl: string): Sha256Digest {
  return sha256({ endpointId, baseUrl: normalizeBaseUrl(baseUrl) });
}

function fixedPost(path: string): UpstreamRoute {
  return { method: "POST", path: () => path, body: (input) => input };
}

function epsgCode(value: unknown): number {
  if (typeof value !== "string") throw new ProviderProtocolError("INVALID_REQUEST", "sourceCrs must be a string");
  if (/^WGS\s*84$/iu.test(value.trim())) return 4326;
  const match = /^EPSG\s*:\s*([1-9][0-9]{0,5})$/iu.exec(value.trim());
  if (!match) throw new ProviderProtocolError("INVALID_REQUEST", "sourceCrs must be an EPSG identifier");
  return Number(match[1]);
}

function assertApprovedEndpoint(endpoint: ApprovedCrsEndpoint): string {
  if (endpoint.approvalStatus !== "APPROVED") {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "CRS endpoint is not registry-approved", { retryable: false });
  }
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u.test(endpoint.endpointId)) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "CRS endpoint ID is invalid", { retryable: false });
  }
  if (!DIGEST.test(endpoint.configurationDigest)) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "CRS endpoint approval digest is invalid", { retryable: false });
  }
  const baseUrl = normalizeBaseUrl(endpoint.baseUrl);
  if (endpoint.configurationDigest !== endpointConfigurationDigest(endpoint.endpointId, baseUrl)) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "CRS endpoint does not match its registry approval digest", {
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
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "CRS registry endpoint is not an absolute URL", {
      retryable: false,
      cause: error
    });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "CRS registry endpoint uses a forbidden URL form", {
      retryable: false
    });
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

function joinBasePath(baseUrl: string, path: string): string {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "CRS bridge route allowlist contains an invalid path");
  }
  return `${baseUrl}${path}`;
}

function assertDeploymentAttestation(attestation: CrsDeploymentAttestation): void {
  for (const [name, digest] of Object.entries({
    sourceZipSha256: attestation.sourceZipSha256,
    openApiSha256: attestation.openApiSha256,
    projDbSha256: attestation.projDbSha256,
    gridBundleSha256: attestation.gridBundleSha256
  })) {
    if (!DIGEST.test(digest)) {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", `${name} is not a SHA-256 digest`, { retryable: false });
    }
  }
  if (attestation.strictBestOperation !== true || attestation.networkEnabled !== false) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "CRS deployment policy must be strict-best and network-off", {
      retryable: false
    });
  }
  for (const [name, version] of Object.entries({
    projVersion: attestation.projVersion,
    integrationVersion: attestation.integrationVersion,
    projDbVersion: attestation.projDbVersion,
    gridBundleVersion: attestation.gridBundleVersion
  })) {
    if (!version.trim()) {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", `${name} is required`, { retryable: false });
    }
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  return readBoundedJsonResponse(response, {
    maximumBytes: MAX_RESPONSE_BYTES,
    peerLabel: "CRS upstream",
    signal
  });
}

function mapUpstreamError(status: number, payload: unknown): ProviderProtocolError {
  const envelope = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  const upstreamCode = typeof envelope?.code === "string" ? envelope.code : "UNCLASSIFIED_UPSTREAM_ERROR";
  const details = { upstreamStatus: status, upstreamCode };
  if (upstreamCode === "GRID_REQUIRED" || upstreamCode === "GRID_NOT_AVAILABLE") {
    return new ProviderProtocolError("PROVIDER_NOT_READY", "Required offline CRS grid is unavailable; fallback is forbidden", {
      retryable: false,
      details
    });
  }
  if (status === 429) return new ProviderProtocolError("OVERLOADED", "CRS upstream is overloaded", { details });
  if (status === 502 || status === 503 || status === 504) {
    return new ProviderProtocolError("PROVIDER_NOT_READY", "CRS upstream is not ready", { details });
  }
  if (status === 400 || status === 413 || status === 422) {
    return new ProviderProtocolError(status === 413 ? "BUDGET_EXCEEDED" : "INVALID_REQUEST", "CRS request was rejected", {
      retryable: false,
      details
    });
  }
  return new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "CRS upstream execution failed", { details });
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ProviderProtocolError("SCHEMA_MISMATCH", `${name} must be a JSON object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", `${name} must be a boolean`, { retryable: false });
  }
  return value;
}
