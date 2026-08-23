import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProviderExecutionRequest } from "../../packages/platform/contract-runtime/src/index.js";
import {
  getContractSchema,
  validateAgainstSchema,
  validateContract,
  validateSchemaSet
} from "../../packages/platform/contract-runtime/src/index.js";
import { runProviderConformance } from "../../packages/platform/conformance-kit/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { buildGeometryProviderBridgeApp } from "../../services/providers/geometry-provider-bridge/src/app.js";
import { createGeometryProviderBridge } from "../../services/providers/geometry-provider-bridge/src/provider.js";
import {
  POC_GEOS_VERSION,
  POC_INTEGRATION_VERSION,
  POC_OPENAPI_SHA256,
  POC_SOURCE_ZIP_SHA256
} from "../../services/providers/geometry-provider-bridge/src/schemas.js";
import { endpointConfigurationDigest } from "../../services/providers/geometry-provider-bridge/src/upstream-client.js";
import {
  GEOMETRY_OPERATION_IDS,
  UNSUPPORTED_GEOMETRY_OPERATION_IDS,
  type GeometryOperationId,
  type GeometryProviderBridgeOptions,
  type PocOperationRequest
} from "../../services/providers/geometry-provider-bridge/src/types.js";

const NOW = new Date("2026-08-23T00:00:00.000Z");
const POINT = { type: "Point" as const, coordinates: [116.4, 39.9] };
const OTHER_POINT = { type: "Point" as const, coordinates: [116.5, 39.8] };
const POLYGON = {
  type: "Polygon" as const,
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]
};
const OPERAND = {
  geometry: POINT,
  coordinateSpace: "EPSG:4326",
  coordinateLayout: "XY" as const
};

function bridgeOptions(fetchImplementation: typeof globalThis.fetch, overrides: Partial<GeometryProviderBridgeOptions> = {}): GeometryProviderBridgeOptions {
  const endpointId = "geometry-poc-test";
  const baseUrl = "http://127.0.0.1:39087";
  return {
    endpoint: {
      endpointId,
      baseUrl,
      approvalStatus: "APPROVED",
      configurationDigest: endpointConfigurationDigest(endpointId, baseUrl)
    },
    attestation: {
      sourceZipSha256: POC_SOURCE_ZIP_SHA256,
      openApiSha256: POC_OPENAPI_SHA256,
      engine: "GEOS-WASM-WORKER-POOL",
      geosVersion: POC_GEOS_VERSION,
      integration: "geos-wasm",
      integrationVersion: POC_INTEGRATION_VERSION,
      workerPoolEnabled: true,
      projectLicense: "UNSPECIFIED"
    },
    fetch: fetchImplementation,
    now: () => NOW,
    receiptId: (() => {
      let sequence = 0;
      return () => `receipt_geometry_${++sequence}`;
    })(),
    ...overrides
  };
}

function operationInput(operationId: GeometryOperationId): unknown {
  switch (operationId) {
    case "geometry.validate":
      return { geometry: POINT };
    case "geometry.predicate":
      return { a: OPERAND, b: { ...OPERAND, geometry: OTHER_POINT }, predicate: "intersects" };
    case "geometry.buffer":
      return { input: OPERAND, distance: 1000, distanceUnit: "COORDINATE_SPACE_UNITS", planarAcknowledged: true };
    case "geometry.remove-repeated-points":
      return { input: OPERAND, tolerance: 0, toleranceUnit: "COORDINATE_SPACE_UNITS" };
    case "geometry.simplify":
    case "geometry.simplify-preserve-topology":
      return { input: OPERAND, tolerance: 0.01, toleranceUnit: "COORDINATE_SPACE_UNITS" };
    case "geometry.intersection":
    case "geometry.union":
    case "geometry.difference":
    case "geometry.symmetric-difference":
    case "geometry.closest-point":
    case "geometry.shortest-line":
      return { a: OPERAND, b: { ...OPERAND, geometry: OTHER_POINT } };
    default:
      return { input: OPERAND };
  }
}

function providerRequest(
  bridge: ReturnType<typeof createGeometryProviderBridge>,
  operationId: GeometryOperationId,
  input = operationInput(operationId),
  suffix = operationId.replaceAll(".", "_")
): ProviderExecutionRequest {
  const descriptor = bridge.runtime.manifest.capabilities.find((candidate) => candidate.operationId === operationId);
  if (!descriptor) throw new Error(`missing descriptor for ${operationId}`);
  const issuedAt = NOW.toISOString();
  const deadlineAt = new Date(NOW.getTime() + 30_000).toISOString();
  const expiresAt = new Date(NOW.getTime() + 60_000).toISOString();
  return {
    providerProtocolVersion: "1.0",
    requestId: `provider_request_${suffix}`,
    gatewayRequestId: `gateway_request_${suffix}`,
    idempotencyKey: `geometry_idem_${suffix}`,
    operation: {
      operationId,
      operationVersion: "1.0",
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash
    },
    input,
    securityContext: {
      principalRef: "principal:geometry-test",
      authenticationMethod: "TEST_ATTESTED",
      authenticatedAt: new Date(NOW.getTime() - 1_000).toISOString(),
      scopeAttestation: {
        issuer: "gateway-test",
        issuedAt,
        expiresAt,
        claimDigest: sha256({ principal: "principal:geometry-test" })
      }
    },
    gatewayContext: {
      gatewayId: "gateway-test",
      registryVersion: "registry-geometry-1",
      policyVersion: "gateway-policy-1"
    },
    executionPolicy: {
      deadlineAt,
      maximumInputBytes: 16 * 1024 * 1024,
      maximumResultBytes: 16 * 1024 * 1024,
      maximumCostClass: "HIGH"
    }
  };
}

function successfulFetch(captured: PocOperationRequest[] = []): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith("/ready")) return readinessResponse();
    const request = JSON.parse(String(init?.body)) as PocOperationRequest;
    captured.push(request);
    return jsonResponse(successPayload(request));
  };
}

function successPayload(request: PocOperationRequest): unknown {
  const execution = {
    engine: "GEOS-WASM-WORKER-POOL",
    engineVersion: "3.13.0-CAPI-1.19.0",
    durationMs: 1.25,
    operation: request.operation,
    deterministicScope: "engine-version-input-options"
  };
  if (request.operation === "validate") {
    return {
      result: true,
      detail: {
        valid: true,
        reason: null,
        location: null,
        simple: true,
        empty: false,
        closed: null,
        ring: null,
        rectangle: null
      },
      summary: geometrySummary(request.input?.geometry ?? POINT),
      warnings: [],
      execution
    };
  }
  if (request.operation === "geometry_hash") {
    return { result: "a".repeat(64), summary: { units: "dimensionless" }, warnings: [], execution };
  }
  if (["equals", "disjoint", "intersects", "touches", "crosses", "within", "contains", "overlaps", "covers", "covered_by", "relate"].includes(request.operation)) {
    return {
      result: request.operation === "relate" ? "T********" : true,
      summary: { units: "dimensionless" },
      warnings: [],
      execution
    };
  }
  const original = request.input?.geometry ?? POINT;
  const result = request.operation === "make_valid"
    ? { type: "MultiPolygon", coordinates: [POLYGON.coordinates] }
    : original;
  return {
    result,
    summary: {
      ...geometrySummary(result),
      inputType: geometryType(original),
      typeChanged: geometryType(original) !== geometryType(result),
      ...(request.options?.precision === undefined ? {} : { precisionGridSize: request.options.precision.gridSize })
    },
    warnings: [],
    execution
  };
}

function geometrySummary(geometry: unknown): Record<string, unknown> {
  return {
    type: geometryType(geometry),
    empty: false,
    valid: true,
    simple: true,
    vertexCount: geometryType(geometry) === "Point" ? 1 : 4,
    coordinateDimension: 2,
    coordinateLayout: "XY"
  };
}

function geometryType(geometry: unknown): string {
  return (geometry as { type: string }).type;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function readinessResponse(): Response {
  return jsonResponse({
    status: "ready",
    engine: "GEOS-WASM-WORKER-POOL",
    engineVersion: "3.13.0-CAPI-1.19.0",
    database: "not-required",
    overloadProtection: {
      maxInFlight: 64,
      workerPool: {
        workers: 2,
        readyWorkers: 2,
        activeRequests: 0,
        queuedRequests: 0,
        maxQueueSize: 16,
        totalCapacity: 18,
        closing: false
      }
    }
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

describe("P07 Geometry provider bridge", () => {
  it("registers exactly 19 schema-locked operations and excludes boundary operations", () => {
    const bridge = createGeometryProviderBridge(bridgeOptions(successfulFetch()));
    const ids = bridge.runtime.manifest.capabilities.map((capability) => capability.operationId);
    expect(ids).toEqual(GEOMETRY_OPERATION_IDS);
    expect(new Set(ids).size).toBe(19);
    expect(ids).not.toEqual(expect.arrayContaining([...UNSUPPORTED_GEOMETRY_OPERATION_IDS]));
    expect(validateContract("capability-provider-manifest.schema.json", bridge.runtime.manifest)).toMatchObject({ valid: true });
    expect(validateSchemaSet()).toMatchObject({ valid: true });
    for (const capability of bridge.runtime.manifest.capabilities) {
      expect(capability.inputSchemaUri).toBe(`urn:gowm:capability:${capability.operationId}:input:1.0`);
      expect(capability.outputSchemaUri).toBe(`urn:gowm:capability:${capability.operationId}:output:1.0`);
      expect(capability.inputSchemaHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(capability.outputSchemaHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(capability.snapshotPolicy).toEqual({ dataSnapshot: "NONE", computeSnapshot: "REQUIRED" });
      expect(validateAgainstSchema(
        getContractSchema(capability.inputSchemaUri),
        { ...(operationInput(capability.operationId as GeometryOperationId) as Record<string, unknown>), unexpected: true }
      ).valid).toBe(false);
    }
  });

  it("keeps checked-in operation registration and immutable source/license locks in parity", () => {
    const bridge = createGeometryProviderBridge(bridgeOptions(successfulFetch()));
    const lockedManifest = JSON.parse(readFileSync(fileURLToPath(new URL(
      "../../contracts/manifests/providers/geometry-provider.json",
      import.meta.url
    )), "utf8")) as Record<string, unknown>;
    const registration = JSON.parse(readFileSync(fileURLToPath(new URL(
      "../../services/providers/geometry-provider-bridge/manifests/operation-registration.json",
      import.meta.url
    )), "utf8")) as Record<string, unknown>;
    const sourceLock = JSON.parse(readFileSync(fileURLToPath(new URL(
      "../../contracts/manifests/providers/geometry-provider-source-lock.json",
      import.meta.url
    )), "utf8")) as Record<string, unknown>;
    expect(bridge.runtime.manifest).toEqual(lockedManifest);
    expect(validateContract("capability-provider-manifest.schema.json", lockedManifest).valid).toBe(true);
    expect(registration).toMatchObject({
      providerId: "gowm.geometry.bridge",
      registeredOperations: GEOMETRY_OPERATION_IDS.map((operationId) => `${operationId}@1.0`),
      unregisteredBoundaryOperations: UNSUPPORTED_GEOMETRY_OPERATION_IDS,
      sourcePublication: "PROHIBITED_LICENSE_UNSPECIFIED"
    });
    expect(sourceLock).toMatchObject({
      providerId: "gowm.geometry.bridge",
      sourceSha256: POC_SOURCE_ZIP_SHA256.slice("sha256:".length),
      openApiSha256: POC_OPENAPI_SHA256.slice("sha256:".length),
      licenseStatus: "UNSPECIFIED",
      redistributionAllowed: false,
      engine: "GEOS-WASM-WORKER-POOL",
      integration: "geos-wasm"
    });
    expect(() => createGeometryProviderBridge(bridgeOptions(successfulFetch(), {
      attestation: { ...bridgeOptions(successfulFetch()).attestation, geosVersion: "unexpected" }
    }))).toThrow(/locked POC/u);
  });

  it("keeps validate immutable and disables implicit repair", async () => {
    const captured: PocOperationRequest[] = [];
    const bridge = createGeometryProviderBridge(bridgeOptions(successfulFetch(captured)));
    const input = { geometry: structuredClone(POLYGON) };
    const before = structuredClone(input);
    const result = await bridge.runtime.execute(providerRequest(bridge, "geometry.validate", input, "immutable"));
    expect(input).toEqual(before);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      operation: "validate",
      options: { mode: "strict", repairInvalid: false, normalizeOutput: false, outputFormat: "geojson" }
    });
    expect(result.output?.value).toEqual({
      valid: true,
      issues: [],
      repairApplied: false,
      policyVersion: "gowm-geometry-validation/1.0"
    });
    expect(result.receipts[0]?.changes).toEqual({ repairApplied: false, typeChanged: false });
  });

  it("executes every registered operation against its authoritative input and output schema", async () => {
    const bridge = createGeometryProviderBridge(bridgeOptions(successfulFetch()));
    for (const operationId of GEOMETRY_OPERATION_IDS) {
      const result = await bridge.runtime.execute(providerRequest(bridge, operationId, operationInput(operationId), `all_${operationId.replaceAll(".", "_")}`));
      expect(result.status, operationId).toBe("COMPLETED");
      expect(result.operation).toEqual({ operationId, operationVersion: "1.0" });
      expect(result.receipts[0]?.operationId).toBe(operationId);
    }
  });

  it("repairs only through make-valid and records geometry type change provenance", async () => {
    const captured: PocOperationRequest[] = [];
    const bridge = createGeometryProviderBridge(bridgeOptions(successfulFetch(captured)));
    const input = {
      input: { ...OPERAND, geometry: POLYGON }
    };
    const result = await bridge.runtime.execute(providerRequest(bridge, "geometry.make-valid", input, "make_valid"));
    expect(captured[0]).toMatchObject({ operation: "make_valid", options: { mode: "strict", repairInvalid: false } });
    expect(result.receipts[0]?.changes).toEqual({
      repairApplied: true,
      typeChanged: true,
      inputGeometryType: "Polygon",
      outputGeometryType: "MultiPolygon"
    });
    expect(result.receipts[0]?.warnings).toContain("geometry.repair=explicit-make-valid");
    expect(result.receipts[0]?.inputHash).toMatch(/^sha256:/u);
    expect(result.receipts[0]?.outputHash).toMatch(/^sha256:/u);
    expect(result.computeSnapshot.engine).toMatchObject({ name: "GEOS-WASM-WORKER-POOL", version: "3.13.0-CAPI-1.19.0" });
  });

  it("treats EPSG:4326 buffer distance as angular coordinate-space units", async () => {
    const captured: PocOperationRequest[] = [];
    const bridge = createGeometryProviderBridge(bridgeOptions(successfulFetch(captured)));
    const result = await bridge.runtime.execute(providerRequest(bridge, "geometry.buffer", undefined, "buffer_units"));
    expect(captured[0]).toMatchObject({
      operation: "buffer",
      parameters: { distance: 1000 },
      options: { planar: true, repairInvalid: false }
    });
    expect(JSON.stringify(captured[0])).not.toMatch(/"(?:meters|metres)"/iu);
    expect((result.output?.value as { warnings: string[] }).warnings).toContain(
      "Buffer distance was interpreted as angular coordinate-space degrees under explicit planar acknowledgement."
    );
    expect(JSON.stringify(result)).not.toMatch(/"unit":"(?:meters|metres)"/iu);
  });

  it("rejects mixed coordinate spaces before calling the upstream", async () => {
    let calls = 0;
    const fetchImplementation: typeof globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse({});
    };
    const bridge = createGeometryProviderBridge(bridgeOptions(fetchImplementation));
    const input = {
      a: OPERAND,
      b: { ...OPERAND, geometry: OTHER_POINT, coordinateSpace: "LOCAL:test-grid" }
    };
    await expect(bridge.runtime.execute(providerRequest(bridge, "geometry.intersection", input, "mixed_crs")))
      .rejects.toMatchObject({ code: "INVALID_REQUEST", retryable: false });
    expect(calls).toBe(0);
  });

  it("maps worker timeout to retryable typed failure and recovers on the next request", async () => {
    let call = 0;
    const fetchImplementation: typeof globalThis.fetch = async (_input, init) => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          error: {
            code: "OPERATION_TIMEOUT",
            message: "worker was terminated and replaced",
            recoverable: true
          }
        }, 408);
      }
      const request = JSON.parse(String(init?.body)) as PocOperationRequest;
      return jsonResponse(successPayload(request));
    };
    const bridge = createGeometryProviderBridge(bridgeOptions(fetchImplementation));
    await expect(bridge.runtime.execute(providerRequest(bridge, "geometry.normalize", undefined, "timeout")))
      .rejects.toMatchObject({ code: "DEADLINE_EXCEEDED", retryable: true });
    const recovered = await bridge.runtime.execute(providerRequest(bridge, "geometry.normalize", undefined, "recovered"));
    expect(recovered.status).toBe("COMPLETED");
    expect(call).toBe(2);
  });

  it("rejects a successful upstream payload with unknown fields before receipt assembly", async () => {
    const fetchImplementation: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as PocOperationRequest;
      return jsonResponse({ ...(successPayload(request) as Record<string, unknown>), unexpected: true });
    };
    const bridge = createGeometryProviderBridge(bridgeOptions(fetchImplementation));
    await expect(bridge.runtime.execute(providerRequest(bridge, "geometry.normalize", undefined, "bad_upstream")))
      .rejects.toMatchObject({ code: "SCHEMA_MISMATCH", retryable: false });
  });

  it("bounds its bridge queue, returns retryable overload and drains cleanly", async () => {
    const pending: Array<(response: Response) => void> = [];
    const requests: PocOperationRequest[] = [];
    const fetchImplementation: typeof globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as PocOperationRequest;
      requests.push(request);
      return await new Promise<Response>((resolve) => pending.push(resolve));
    };
    const bridge = createGeometryProviderBridge(bridgeOptions(fetchImplementation, {
      maximumInFlight: 1,
      maximumQueueSize: 1
    }));
    const first = bridge.runtime.execute(providerRequest(bridge, "geometry.normalize", undefined, "queue_first"));
    await waitFor(() => bridge.upstream.stats().activeRequests === 1);
    const second = bridge.runtime.execute(providerRequest(bridge, "geometry.normalize", undefined, "queue_second"));
    await waitFor(() => bridge.upstream.stats().queuedRequests === 1);
    await expect(bridge.runtime.execute(providerRequest(bridge, "geometry.normalize", undefined, "queue_rejected")))
      .rejects.toMatchObject({ code: "OVERLOADED", retryable: true });
    expect(bridge.upstream.stats()).toEqual({ activeRequests: 1, queuedRequests: 1, maximumInFlight: 1, maximumQueueSize: 1 });

    pending[0]?.(jsonResponse(successPayload(requests[0]!)));
    await waitFor(() => requests.length === 2);
    pending[1]?.(jsonResponse(successPayload(requests[1]!)));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(bridge.upstream.stats()).toMatchObject({ activeRequests: 0, queuedRequests: 0 });
  });

  it("passes the Provider SDK conformance kit with fail-closed schema locks", async () => {
    const bridge = createGeometryProviderBridge(bridgeOptions(successfulFetch()));
    const validRequest = providerRequest(bridge, "geometry.validate", { geometry: POINT }, "conformance");
    const deadlineRequest = providerRequest(bridge, "geometry.validate", { geometry: POINT }, "deadline");
    deadlineRequest.executionPolicy.deadlineAt = new Date(Date.now() - 1_000).toISOString();
    const report = await runProviderConformance({
      runtime: bridge.runtime,
      validRequest,
      differentInput: { geometry: OTHER_POINT },
      unknownFieldInput: { geometry: POINT, unexpected: true },
      deadlineRequest
    });
    expect(report.passed, JSON.stringify(report.checks.filter((check) => check.status !== "PASS"))).toBe(true);
  });

  it("serves protocol routes and reports the bounded worker pool readiness", async () => {
    const bridge = createGeometryProviderBridge(bridgeOptions(successfulFetch()));
    const app = buildGeometryProviderBridgeApp(bridge, "test-provider-transport-token-32-bytes-minimum");
    try {
      const manifest = await app.inject({ method: "GET", url: "/v1/manifest" });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.json().capabilities).toHaveLength(19);
      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({
        ready: true,
        operationCount: 19,
        upstream: {
          engine: "GEOS-WASM-WORKER-POOL",
          workerPool: { workers: 2, readyWorkers: 2, maxQueueSize: 16, closing: false }
        }
      });
    } finally {
      await app.close();
    }
  });
});
