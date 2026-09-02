import { validateAgainstSchema } from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  ProviderProtocolError,
  readBoundedJsonResponse,
  sha256,
  type DeadlineContext,
  type TraceContext
} from "../../../../packages/platform/provider-sdk/src/index.js";
import {
  GEOMETRY_OPERATION_SCHEMAS,
  POC_GEOS_VERSION,
  POC_INTEGRATION_VERSION
} from "./schemas.js";
import type {
  ApprovedGeometryEndpoint,
  GeometryDeploymentAttestation,
  GeometryOperand,
  GeometryOperationId,
  GeometryPrecision,
  GeometryUpstreamErrorPayload,
  PocGeometryOperation,
  PocGeometryResult,
  PocOperationRequest,
  PocScalarResult,
  PocValidationResult,
  Sha256Digest
} from "./types.js";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POC_EXECUTE_PATH = "/v1/geometry/execute";

const DIRECT_OPERATION: Readonly<Partial<Record<GeometryOperationId, PocGeometryOperation>>> = Object.freeze({
  "geometry.validate": "validate",
  "geometry.normalize": "normalize",
  "geometry.force-2d": "force_2d",
  "geometry.remove-repeated-points": "remove_repeated_points",
  "geometry.centroid": "centroid",
  "geometry.bounding-box": "bounding_box",
  "geometry.geometry-hash": "geometry_hash",
  "geometry.make-valid": "make_valid",
  "geometry.buffer": "buffer",
  "geometry.intersection": "intersection",
  "geometry.union": "union",
  "geometry.difference": "difference",
  "geometry.symmetric-difference": "symmetric_difference",
  "geometry.simplify": "simplify",
  "geometry.simplify-preserve-topology": "simplify_preserve_topology",
  "geometry.convex-hull": "convex_hull",
  "geometry.closest-point": "closest_point",
  "geometry.shortest-line": "shortest_line"
});

const PREDICATES = new Set<PocGeometryOperation>([
  "equals", "disjoint", "intersects", "touches", "crosses", "within",
  "contains", "overlaps", "covers", "covered_by", "relate"
]);

export interface GeometryAdmissionStats {
  activeRequests: number;
  queuedRequests: number;
  maximumInFlight: number;
  maximumQueueSize: number;
}

export interface GeometryReadiness {
  ready: boolean;
  reasons: string[];
  bridge: GeometryAdmissionStats;
  upstream?: {
    engine: string;
    engineVersion: string;
    workerPool: {
      workers: number;
      readyWorkers: number;
      activeRequests: number;
      queuedRequests: number;
      maxQueueSize: number;
      totalCapacity: number;
      closing: boolean;
    };
  };
}

export type GeometryUpstreamResult = PocGeometryResult | PocScalarResult | PocValidationResult;

export class GeometryUpstreamClient {
  readonly baseUrl: string;
  private readonly admission: AdmissionGate;

  constructor(
    endpoint: ApprovedGeometryEndpoint,
    private readonly attestation: GeometryDeploymentAttestation,
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    maximumInFlight = 32,
    maximumQueueSize = 128
  ) {
    this.baseUrl = assertApprovedEndpoint(endpoint);
    assertDeploymentAttestation(attestation);
    this.admission = new AdmissionGate(maximumInFlight, maximumQueueSize);
  }

  async execute(
    operationId: GeometryOperationId,
    input: unknown,
    deadline: DeadlineContext,
    trace: TraceContext
  ): Promise<GeometryUpstreamResult> {
    const upstreamRequest = mapUpstreamRequest(operationId, input);
    return this.admission.run(deadline.signal, async () => {
      let response: Response;
      try {
        response = await this.fetchImplementation(`${this.baseUrl}${POC_EXECUTE_PATH}`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-request-id": trace.requestId,
            "x-gowm-trace-id": trace.traceId
          },
          body: JSON.stringify(upstreamRequest),
          signal: deadline.signal,
          redirect: "error"
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new ProviderProtocolError("PROVIDER_NOT_READY", "Geometry upstream is unavailable", {
          retryable: true,
          details: { endpointClass: "registry-approved-geometry-provider" },
          cause: error
        });
      }

      const payload = await readJson(response, deadline.signal);
      if (!response.ok) throw mapUpstreamError(response.status, payload);
      const validation = validateAgainstSchema(GEOMETRY_OPERATION_SCHEMAS[operationId].upstreamOutput, payload, {
        schemaName: `geometry-upstream:${operationId}`
      });
      if (!validation.valid) {
        throw new ProviderProtocolError("SCHEMA_MISMATCH", "Geometry upstream response violates the locked contract", {
          retryable: false,
          details: { operationId, issues: validation.issues }
        });
      }
      assertExecutionAttestation(payload, upstreamRequest.operation, this.attestation);
      return payload as GeometryUpstreamResult;
    });
  }

  stats(): GeometryAdmissionStats {
    return this.admission.stats();
  }

  async readiness(timeoutMs = 2_000): Promise<GeometryReadiness> {
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
      if (!response.ok) {
        return {
          ready: false,
          reasons: [`upstream readiness returned HTTP ${response.status}`],
          bridge: this.stats()
        };
      }
      const record = asRecord(payload, "upstream readiness");
      const overload = asRecord(record.overloadProtection, "upstream readiness overloadProtection");
      const worker = asRecord(overload.workerPool, "upstream readiness workerPool");
      const actual = {
        engine: stringValue(record.engine, "upstream readiness engine"),
        engineVersion: stringValue(record.engineVersion, "upstream readiness engineVersion"),
        workerPool: {
          workers: integerValue(worker.workers, "workerPool.workers"),
          readyWorkers: integerValue(worker.readyWorkers, "workerPool.readyWorkers"),
          activeRequests: integerValue(worker.activeRequests, "workerPool.activeRequests"),
          queuedRequests: integerValue(worker.queuedRequests, "workerPool.queuedRequests"),
          maxQueueSize: integerValue(worker.maxQueueSize, "workerPool.maxQueueSize"),
          totalCapacity: integerValue(worker.totalCapacity, "workerPool.totalCapacity"),
          closing: booleanValue(worker.closing, "workerPool.closing")
        }
      };
      const reasons: string[] = [];
      if (record.status !== "ready") reasons.push("upstream status is not ready");
      if (actual.engine !== this.attestation.engine) reasons.push("upstream engine is not the attested GEOS worker pool");
      if (actual.engineVersion !== this.attestation.geosVersion) reasons.push("GEOS version differs from deployment attestation");
      if (actual.workerPool.workers < 1) reasons.push("upstream worker pool has no workers");
      if (actual.workerPool.readyWorkers < 1) reasons.push("upstream worker pool has no ready workers");
      if (actual.workerPool.maxQueueSize < 0 || actual.workerPool.totalCapacity < actual.workerPool.workers) {
        reasons.push("upstream worker pool reports invalid bounded capacity");
      }
      if (actual.workerPool.closing) reasons.push("upstream worker pool is closing");
      return { ready: reasons.length === 0, reasons, bridge: this.stats(), upstream: actual };
    } catch (error) {
      return {
        ready: false,
        reasons: [error instanceof Error ? error.message : String(error)],
        bridge: this.stats()
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function endpointConfigurationDigest(endpointId: string, baseUrl: string): Sha256Digest {
  return sha256({ endpointId, baseUrl: normalizeBaseUrl(baseUrl) });
}

export function mapUpstreamRequest(operationId: GeometryOperationId, input: unknown): PocOperationRequest {
  const record = asRecord(input, "validated geometry input");
  if (operationId === "geometry.validate") {
    return {
      operation: "validate",
      input: { geometry: record.geometry as GeometryOperand["geometry"] },
      options: strictOptions()
    };
  }

  if (operationId === "geometry.predicate") {
    const a = operand(record.a, "a");
    const b = operand(record.b, "b");
    assertSameCoordinateFrame(a, b);
    const predicate = stringValue(record.predicate, "predicate") as PocGeometryOperation;
    if (!PREDICATES.has(predicate)) throw new ProviderProtocolError("INVALID_REQUEST", "predicate is not supported");
    const pattern = record.pattern;
    if (predicate === "relate" && typeof pattern !== "string") {
      throw new ProviderProtocolError("INVALID_REQUEST", "relate requires a DE-9IM pattern");
    }
    if (predicate !== "relate" && pattern !== undefined) {
      throw new ProviderProtocolError("INVALID_REQUEST", "pattern is only valid for the relate predicate");
    }
    return {
      operation: predicate,
      input: envelope(a),
      other: envelope(b),
      ...(typeof pattern === "string" ? { parameters: { pattern } } : {}),
      options: strictOptions()
    };
  }

  const operation = DIRECT_OPERATION[operationId];
  if (!operation) throw new ProviderProtocolError("OPERATION_NOT_FOUND", `${operationId} is not registered`);
  const binary = isBinaryOperation(operationId);
  const primary = operand(binary ? record.a : record.input, binary ? "a" : "input");
  const precision = optionalPrecision(record.precision);
  const request: PocOperationRequest = {
    operation,
    input: envelope(primary),
    options: strictOptions(precision)
  };

  if (binary) {
    const secondary = operand(record.b, "b");
    assertSameCoordinateFrame(primary, secondary);
    request.other = envelope(secondary);
  }

  if (operationId === "geometry.buffer") {
    if (primary.coordinateSpace === "EPSG:4326" && record.planarAcknowledged !== true) {
      throw new ProviderProtocolError(
        "INVALID_REQUEST",
        "EPSG:4326 buffer requires explicit planarAcknowledged=true because distance is in angular coordinate-space units"
      );
    }
    request.options = strictOptions(precision, record.planarAcknowledged === true);
    request.parameters = compact({
      distance: record.distance,
      quadrantSegments: record.quadrantSegments,
      endCapStyle: record.endCapStyle,
      joinStyle: record.joinStyle,
      mitreLimit: record.mitreLimit,
      singleSided: record.singleSided
    });
  } else if (operationId === "geometry.remove-repeated-points") {
    if (record.tolerance !== undefined && record.toleranceUnit !== "COORDINATE_SPACE_UNITS") {
      throw new ProviderProtocolError("INVALID_REQUEST", "tolerance must use coordinate-space units");
    }
    if (record.tolerance !== undefined) request.parameters = { tolerance: record.tolerance };
  } else if (operationId === "geometry.simplify" || operationId === "geometry.simplify-preserve-topology") {
    request.parameters = {
      tolerance: record.tolerance,
      ...(operationId === "geometry.simplify-preserve-topology" ? { preserveBoundary: true } : {})
    };
  }
  return request;
}

function isBinaryOperation(operationId: GeometryOperationId): boolean {
  return [
    "geometry.intersection",
    "geometry.union",
    "geometry.difference",
    "geometry.symmetric-difference",
    "geometry.closest-point",
    "geometry.shortest-line"
  ].includes(operationId);
}

function strictOptions(
  precision?: GeometryPrecision,
  planar?: boolean
): NonNullable<PocOperationRequest["options"]> {
  return {
    mode: "strict",
    repairInvalid: false,
    normalizeOutput: false,
    outputFormat: "geojson",
    ...(planar === undefined ? {} : { planar }),
    ...(precision === undefined ? {} : {
      precision: {
        gridSize: precision.gridSize,
        ...(precision.keepCollapsed === undefined ? {} : { keepCollapsed: precision.keepCollapsed })
      }
    })
  };
}

function optionalPrecision(value: unknown): GeometryPrecision | undefined {
  return value === undefined ? undefined : (asRecord(value, "precision") as unknown as GeometryPrecision);
}

function operand(value: unknown, name: string): GeometryOperand {
  return asRecord(value, name) as unknown as GeometryOperand;
}

function envelope(value: GeometryOperand): NonNullable<PocOperationRequest["input"]> {
  const epsg = /^EPSG:([1-9][0-9]{0,5})$/u.exec(value.coordinateSpace);
  return {
    geometry: value.geometry,
    coordinateLayout: value.coordinateLayout,
    ...(epsg === null ? {} : { srid: Number(epsg[1]) })
  };
}

function assertSameCoordinateFrame(a: GeometryOperand, b: GeometryOperand): void {
  if (a.coordinateSpace !== b.coordinateSpace) {
    throw new ProviderProtocolError("INVALID_REQUEST", "binary geometry operands must use the same coordinate space", {
      retryable: false,
      details: { a: a.coordinateSpace, b: b.coordinateSpace }
    });
  }
  if (a.coordinateLayout !== b.coordinateLayout) {
    throw new ProviderProtocolError("INVALID_REQUEST", "binary geometry operands must use the same coordinate layout", {
      retryable: false,
      details: { a: a.coordinateLayout, b: b.coordinateLayout }
    });
  }
}

function assertExecutionAttestation(
  value: unknown,
  expectedOperation: PocGeometryOperation,
  attestation: GeometryDeploymentAttestation
): void {
  const execution = asRecord(asRecord(value, "geometry upstream response").execution, "geometry upstream execution");
  if (execution.engine !== attestation.engine || execution.engineVersion !== attestation.geosVersion) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "Geometry upstream execution provenance differs from deployment attestation", {
      retryable: false,
      details: {
        expectedEngine: attestation.engine,
        expectedEngineVersion: attestation.geosVersion,
        actualEngine: execution.engine,
        actualEngineVersion: execution.engineVersion
      }
    });
  }
  if (execution.operation !== expectedOperation) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "Geometry upstream returned provenance for a different operation", {
      retryable: false,
      details: { expectedOperation, actualOperation: execution.operation }
    });
  }
}

function assertApprovedEndpoint(endpoint: ApprovedGeometryEndpoint): string {
  if (endpoint.approvalStatus !== "APPROVED") {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "Geometry endpoint is not registry-approved", { retryable: false });
  }
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u.test(endpoint.endpointId)) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "Geometry endpoint ID is invalid", { retryable: false });
  }
  if (!DIGEST.test(endpoint.configurationDigest)) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "Geometry endpoint approval digest is invalid", { retryable: false });
  }
  const baseUrl = normalizeBaseUrl(endpoint.baseUrl);
  if (endpoint.configurationDigest !== endpointConfigurationDigest(endpoint.endpointId, baseUrl)) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "Geometry endpoint does not match its registry approval digest", {
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
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "Geometry registry endpoint is not an absolute URL", {
      retryable: false,
      cause: error
    });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "Geometry registry endpoint uses a forbidden URL form", {
      retryable: false
    });
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

function assertDeploymentAttestation(attestation: GeometryDeploymentAttestation): void {
  for (const [name, digest] of Object.entries({
    sourceZipSha256: attestation.sourceZipSha256,
    openApiSha256: attestation.openApiSha256
  })) {
    if (!DIGEST.test(digest)) {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", `${name} is not a SHA-256 digest`, { retryable: false });
    }
  }
  if (attestation.engine !== "GEOS-WASM-WORKER-POOL" || attestation.workerPoolEnabled !== true) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "Geometry deployment must use the preemptible GEOS worker pool", {
      retryable: false
    });
  }
  if (attestation.integration !== "geos-wasm" || attestation.projectLicense !== "MIT") {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "Geometry deployment attestation violates the locked integration/license boundary", {
      retryable: false
    });
  }
  if (!attestation.geosVersion.trim() || !attestation.integrationVersion.trim()) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "Geometry engine and integration versions are required", {
      retryable: false
    });
  }
  if (attestation.geosVersion !== POC_GEOS_VERSION || attestation.integrationVersion !== POC_INTEGRATION_VERSION) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "Geometry deployment versions do not match the locked POC", {
      retryable: false
    });
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  return readBoundedJsonResponse(response, {
    maximumBytes: MAX_RESPONSE_BYTES,
    peerLabel: "Geometry upstream",
    signal
  });
}

function mapUpstreamError(status: number, value: unknown): ProviderProtocolError {
  const payload = isRecord(value) ? (value as GeometryUpstreamErrorPayload) : {};
  const error = isRecord(payload.error) ? payload.error : {};
  const code = typeof error.code === "string" ? error.code : "UNKNOWN";
  const message = typeof error.message === "string" ? error.message : `Geometry upstream returned HTTP ${status}`;
  const details = {
    upstreamStatus: status,
    upstreamCode: code,
    ...(isRecord(error.details) ? { upstreamDetails: error.details } : {})
  };
  if (code === "OPERATION_TIMEOUT" || status === 408 || status === 504) {
    return new ProviderProtocolError("DEADLINE_EXCEEDED", message, { retryable: true, details });
  }
  if (code === "RESOURCE_LIMIT" && isRecord(error.details) && error.details.kind === "overload") {
    return new ProviderProtocolError("OVERLOADED", message, { retryable: true, details });
  }
  if (["GEOMETRY_TOO_LARGE", "TOO_MANY_VERTICES", "TOO_MANY_GEOMETRIES", "NESTING_TOO_DEEP", "RESOURCE_LIMIT"].includes(code) || status === 413) {
    return new ProviderProtocolError("BUDGET_EXCEEDED", message, { retryable: error.recoverable === true, details });
  }
  if (status === 400 || status === 422 || [
    "INVALID_GEOMETRY", "UNSUPPORTED_GEOMETRY_TYPE", "INVALID_COORDINATE", "EMPTY_GEOMETRY",
    "TOPOLOGY_EXCEPTION", "PRECISION_ERROR", "SRID_MISMATCH", "PLANAR_ACKNOWLEDGEMENT_REQUIRED",
    "UNSUPPORTED_OPERATION"
  ].includes(code)) {
    return new ProviderProtocolError("INVALID_REQUEST", message, { retryable: false, details });
  }
  if ([502, 503].includes(status) || code === "ENGINE_ERROR") {
    return new ProviderProtocolError("PROVIDER_NOT_READY", message, { retryable: true, details });
  }
  return new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", message, { retryable: false, details });
}

class AdmissionGate {
  private activeRequests = 0;
  private readonly queue: Array<{
    signal: AbortSignal;
    resolve: () => void;
    reject: (reason: unknown) => void;
    abort: () => void;
  }> = [];

  readonly maximumInFlight: number;
  readonly maximumQueueSize: number;

  constructor(maximumInFlight: number, maximumQueueSize: number) {
    this.maximumInFlight = boundedInteger(maximumInFlight, "maximumInFlight", 1, 1_024);
    this.maximumQueueSize = boundedInteger(maximumQueueSize, "maximumQueueSize", 0, 100_000);
  }

  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      return await action();
    } finally {
      this.release();
    }
  }

  stats(): GeometryAdmissionStats {
    return {
      activeRequests: this.activeRequests,
      queuedRequests: this.queue.length,
      maximumInFlight: this.maximumInFlight,
      maximumQueueSize: this.maximumQueueSize
    };
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.activeRequests < this.maximumInFlight) {
      this.activeRequests += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maximumQueueSize) {
      return Promise.reject(new ProviderProtocolError("OVERLOADED", "Geometry bridge admission queue is full", {
        retryable: true,
        details: { ...this.stats() }
      }));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        resolve,
        reject,
        abort: (): void => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError());
        }
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(abortError());
        continue;
      }
      this.activeRequests += 1;
      waiter.resolve();
      break;
    }
  }
}

function abortError(): Error {
  const error = new Error("Geometry bridge request was aborted");
  error.name = "AbortError";
  return error;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", `${name} must be an integer between ${minimum} and ${maximum}`, {
      retryable: false
    });
  }
  return value;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ProviderProtocolError("SCHEMA_MISMATCH", `${name} must be an object`, { retryable: false });
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", `${name} must be a non-empty string`, { retryable: false });
  }
  return value;
}

function integerValue(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", `${name} must be a non-negative integer`, { retryable: false });
  }
  return value as number;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", `${name} must be a boolean`, { retryable: false });
  }
  return value;
}
