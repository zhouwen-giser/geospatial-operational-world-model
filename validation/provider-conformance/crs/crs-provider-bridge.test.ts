import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProviderExecutionRequest } from "../../../packages/platform/contract-runtime/src/index.js";
import { runProviderConformance } from "../../../packages/platform/conformance-kit/src/index.js";
import { ProviderProtocolError } from "../../../packages/platform/provider-sdk/src/index.js";
import { POC_OPENAPI_SHA256, POC_SOURCE_ZIP_SHA256 } from "../../../services/providers/crs-provider-bridge/src/schemas.js";
import { createCrsProviderBridge } from "../../../services/providers/crs-provider-bridge/src/provider.js";
import { endpointConfigurationDigest } from "../../../services/providers/crs-provider-bridge/src/upstream-client.js";
import type { CrsProviderBridgeOptions } from "../../../services/providers/crs-provider-bridge/src/types.js";

const PROJ_DB_DIGEST = `sha256:${"a".repeat(64)}` as const;
const GRID_DIGEST = `sha256:${"b".repeat(64)}` as const;

describe("CRS provider bridge", () => {
  it("registers only the six fixed operations and locks the approved endpoint", () => {
    const calls: string[] = [];
    const bridge = createCrsProviderBridge(options(fixtureFetch(calls)));
    expect(bridge.runtime.manifest.capabilities.map((capability) => capability.operationId)).toEqual([
      "crs.check-source",
      "crs.normalize.point",
      "crs.normalize.points",
      "crs.normalize.geometry",
      "crs.normalize.feature",
      "crs.normalize.feature-collection"
    ]);
    expect(bridge.runtime.manifest.capabilities.some((capability) => capability.operationId === "crs.normalize")).toBe(false);
    const lockedManifest = JSON.parse(readFileSync(
      new URL("../../../contracts/manifests/providers/crs-provider.json", import.meta.url),
      "utf8"
    )) as unknown;
    expect(bridge.runtime.manifest).toEqual(lockedManifest);
    const sourceLock = JSON.parse(readFileSync(
      new URL("../../../contracts/manifests/providers/crs-provider-source-lock.json", import.meta.url),
      "utf8"
    )) as { licenseStatus: string; redistributionAllowed: boolean; sourceSha256: string; openApiSha256: string };
    expect(sourceLock).toMatchObject({
      licenseStatus: "UNSPECIFIED",
      redistributionAllowed: false,
      sourceSha256: POC_SOURCE_ZIP_SHA256.slice("sha256:".length),
      openApiSha256: POC_OPENAPI_SHA256.slice("sha256:".length)
    });
    expect(() => createCrsProviderBridge({
      ...options(fixtureFetch(calls)),
      endpoint: {
        endpointId: "crs-poc-test",
        baseUrl: "http://127.0.0.1:18086",
        approvalStatus: "APPROVED",
        configurationDigest: `sha256:${"0".repeat(64)}`
      }
    })).toThrowError(ProviderProtocolError);
  });

  it("passes Provider SDK conformance and rejects caller-selected target CRS", async () => {
    const calls: string[] = [];
    const bridge = createCrsProviderBridge(options(fixtureFetch(calls)));
    const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, "crs.normalize.point");
    const request = providerRequest(descriptor, { sourceCrs: "EPSG:3857", coordinate: [111319.49079327357, 0] });
    const report = await runProviderConformance({
      runtime: bridge.runtime,
      validRequest: request,
      differentInput: { sourceCrs: "EPSG:3857", coordinate: [222638.98158654713, 0] },
      unknownFieldInput: {
        sourceCrs: "EPSG:3857",
        targetCrs: "EPSG:32652",
        coordinate: [111319.49079327357, 0]
      },
      deadlineRequest: {
        ...request,
        requestId: "request-deadline",
        idempotencyKey: "idempotency-deadline",
        executionPolicy: { ...request.executionPolicy, deadlineAt: new Date(Date.now() - 1_000).toISOString() }
      }
    });
    expect(report, JSON.stringify(report, null, 2)).toMatchObject({ passed: true });
    expect(calls.every((url) => !url.includes("32652"))).toBe(true);
  });

  it("normalizes a 3857 point and emits complete CRS receipt attestations", async () => {
    const calls: string[] = [];
    const bridge = createCrsProviderBridge(options(fixtureFetch(calls)));
    const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, "crs.normalize.point");
    const result = await bridge.runtime.execute(providerRequest(
      descriptor,
      { sourceCrs: "EPSG:3857", coordinate: [111319.49079327357, 0] },
      "request-point",
      "idempotency-point"
    ));
    expect(result.output?.value).toMatchObject({
      coordinate: [1, 0],
      crs: "EPSG:4326",
      axisOrder: ["longitude", "latitude"]
    });
    expect(result.dataSnapshot).toBeUndefined();
    expect(result.evidenceReferences).toEqual([]);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({
      inputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      outputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      method: { engine: "PROJ", engineVersion: "9.5.1" }
    });
    expect(result.computeSnapshot.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "DATABASE", name: "proj.db", digest: PROJ_DB_DIGEST }),
      expect.objectContaining({ kind: "GRID", name: "offline-grid-bundle", digest: GRID_DIGEST })
    ]));
    expect(result.receipts[0]?.warnings).toEqual(expect.arrayContaining([
      "crs.source=EPSG:3857",
      "crs.target=EPSG:4326",
      "crs.axis=TRADITIONAL_GIS:longitude,latitude",
      "crs.proj=9.5.1",
      `crs.projDb=${PROJ_DB_DIGEST}`,
      `crs.gridBundle=${GRID_DIGEST}`,
      "crs.strictBestOperation=true",
      "crs.networkEnabled=false"
    ]));
    expect(calls).toEqual(["http://127.0.0.1:18086/v1/normalize/point"]);
  });

  it("preserves Z byte-for-number and reports that Z was not transformed", async () => {
    const bridge = createCrsProviderBridge(options(fixtureFetch([])));
    const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, "crs.normalize.point");
    const result = await bridge.runtime.execute(providerRequest(
      descriptor,
      { sourceCrs: "EPSG:3857", coordinate: [111319.49079327357, 0, 123.456] },
      "request-z",
      "idempotency-z"
    ));
    expect(result.output?.value).toMatchObject({ coordinate: [1, 0, 123.456], zTransformed: false });
    expect(result.receipts[0]?.warnings).toContain("crs.warning=Z_NOT_TRANSFORMED");
  });

  it("rejects a malformed successful provider response against the locked schema", async () => {
    const invalidFetch: typeof fetch = async () => jsonResponse({
      ...pointResponse([1, 0]),
      unexpectedProviderField: "must fail closed"
    });
    const bridge = createCrsProviderBridge(options(invalidFetch));
    const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, "crs.normalize.point");
    await expect(bridge.runtime.execute(providerRequest(
      descriptor,
      { sourceCrs: "EPSG:3857", coordinate: [111319.49079327357, 0] },
      "request-schema",
      "idempotency-schema"
    ))).rejects.toMatchObject({ code: "SCHEMA_MISMATCH" });
  });

  it("fails closed when an offline grid is missing and never retries a fallback", async () => {
    let callCount = 0;
    const gridMissingFetch: typeof fetch = async () => {
      callCount += 1;
      return jsonResponse({
        error: {
          code: "GRID_NOT_AVAILABLE",
          message: "strict best operation needs a missing grid",
          retryable: false
        }
      }, 422);
    };
    const bridge = createCrsProviderBridge(options(gridMissingFetch));
    const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, "crs.normalize.point");
    await expect(bridge.runtime.execute(providerRequest(
      descriptor,
      { sourceCrs: "EPSG:4267", coordinate: [-75, 40] },
      "request-grid",
      "idempotency-grid"
    ))).rejects.toMatchObject({
      code: "PROVIDER_NOT_READY",
      retryable: false,
      details: { upstreamCode: "GRID_NOT_AVAILABLE" }
    });
    expect(callCount).toBe(1);
  });

  it("maps all operations to explicit upstream routes, including GET source check", async () => {
    const calls: string[] = [];
    const bridge = createCrsProviderBridge(options(fixtureFetch(calls)));
    const cases: Array<[string, unknown]> = [
      ["crs.check-source", { sourceCrs: "EPSG:3857" }],
      ["crs.normalize.points", { sourceCrs: "EPSG:3857", coordinates: [[0, 0], [111319.49079327357, 0]] }],
      ["crs.normalize.geometry", { sourceCrs: "EPSG:3857", geometry: { type: "Point", coordinates: [111319.49079327357, 0] } }],
      ["crs.normalize.feature", { sourceCrs: "EPSG:3857", feature: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [111319.49079327357, 0] } } }],
      ["crs.normalize.feature-collection", { sourceCrs: "EPSG:3857", featureCollection: { type: "FeatureCollection", features: [] } }]
    ];
    for (const [operationId, input] of cases) {
      const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, operationId);
      await bridge.runtime.execute(providerRequest(
        descriptor,
        input,
        `request-${operationId.replaceAll(".", "-")}`,
        `idempotency-${operationId.replaceAll(".", "-")}`
      ));
    }
    expect(calls).toEqual([
      "http://127.0.0.1:18086/v1/crs/3857",
      "http://127.0.0.1:18086/v1/normalize/points",
      "http://127.0.0.1:18086/v1/normalize/geometry",
      "http://127.0.0.1:18086/v1/normalize/feature",
      "http://127.0.0.1:18086/v1/normalize/feature-collection"
    ]);
  });
});

function options(fetchImplementation: typeof fetch): CrsProviderBridgeOptions {
  const endpointId = "crs-poc-test";
  const baseUrl = "http://127.0.0.1:18086";
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
      projVersion: "9.5.1",
      integration: "gdal-async",
      integrationVersion: "3.12.3",
      projDbVersion: "EPSG-v12.013",
      projDbSha256: PROJ_DB_DIGEST,
      gridBundleVersion: "empty-v1",
      gridBundleSha256: GRID_DIGEST,
      strictBestOperation: true,
      networkEnabled: false
    },
    fetch: fetchImplementation,
    now: () => new Date("2026-08-23T00:00:00.000Z"),
    receiptId: () => "receipt-crs-test"
  };
}

function providerRequest(
  descriptor: { operationId: string; operationVersion: string; inputSchemaHash: string; outputSchemaHash: string },
  input: unknown,
  requestId = "request-conformance",
  idempotencyKey = "idempotency-conformance"
): ProviderExecutionRequest {
  const issuedAt = new Date(Date.now() - 60_000);
  const authenticatedAt = new Date(issuedAt.getTime() - 60_000);
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const deadlineAt = new Date(Date.now() + 60_000);
  return {
    providerProtocolVersion: "1.0",
    requestId,
    gatewayRequestId: `gateway-${requestId}`,
    idempotencyKey,
    operation: {
      operationId: descriptor.operationId,
      operationVersion: descriptor.operationVersion,
      inputSchemaHash: descriptor.inputSchemaHash,
      outputSchemaHash: descriptor.outputSchemaHash
    },
    input,
    securityContext: {
      principalRef: "principal:test",
      authenticationMethod: "test-attestation",
      authenticatedAt: authenticatedAt.toISOString(),
      scopeAttestation: {
        issuer: "gowm-test-gateway",
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        claimDigest: `sha256:${"c".repeat(64)}`
      }
    },
    gatewayContext: {
      gatewayId: "gateway-test",
      registryVersion: "test-registry/1",
      policyVersion: "test-policy/1"
    },
    executionPolicy: {
      deadlineAt: deadlineAt.toISOString(),
      maximumInputBytes: 16 * 1024 * 1024,
      maximumResultBytes: 16 * 1024 * 1024,
      maximumBatchItems: 100_000,
      maximumVertices: 100_000,
      maximumCostClass: "LOW"
    }
  };
}

function fixtureFetch(calls: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/health/ready")) {
      return jsonResponse({
        status: "ready",
        engine: {
          engine: "PROJ",
          engineVersion: "9.5.1",
          integration: "gdal-async",
          integrationVersion: "3.12.3",
          gdalVersion: "3.10.3",
          networkEnabled: false,
          strictBestOperation: true
        },
        limits: { maxPoints: 100_000, maxVertices: 100_000, maxRequestBytes: 16 * 1024 * 1024 }
      });
    }
    if (url.endsWith("/v1/crs/3857")) {
      return jsonResponse({
        sourceCrs: "EPSG:3857",
        recognized: true,
        kind: "projected",
        traditionalGisInputOrder: ["easting", "northing"],
        normalizationTarget: "EPSG:4326",
        operationAvailability: "coordinate-and-grid-dependent"
      });
    }
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith("/v1/normalize/point")) {
      const coordinate = body.coordinate as number[];
      return jsonResponse(pointResponse([coordinate[0] === 0 ? 0 : coordinate[0]! / 111319.49079327357, coordinate[1]! / 111319.49079327357, ...coordinate.slice(2)]));
    }
    if (url.endsWith("/v1/normalize/points")) {
      const coordinates = body.coordinates as number[][];
      return jsonResponse({ ...metadata(coordinates.length), coordinates: coordinates.map((coordinate) => [coordinate[0]! / 111319.49079327357, coordinate[1]! / 111319.49079327357, ...coordinate.slice(2)]) });
    }
    if (url.endsWith("/v1/normalize/geometry")) {
      const geometry = body.geometry as { type: string; coordinates?: number[] };
      return jsonResponse({ ...metadata(1), geometry: geometry.type === "Point" ? { ...geometry, coordinates: [1, 0, ...(geometry.coordinates?.slice(2) ?? [])] } : geometry });
    }
    if (url.endsWith("/v1/normalize/feature")) {
      const feature = body.feature as { geometry: { type: string; coordinates?: number[] } | null };
      return jsonResponse({ ...metadata(feature.geometry === null ? 0 : 1), feature: feature.geometry?.type === "Point" ? { ...feature, geometry: { ...feature.geometry, coordinates: [1, 0, ...(feature.geometry.coordinates?.slice(2) ?? [])] } } : feature });
    }
    if (url.endsWith("/v1/normalize/feature-collection")) {
      return jsonResponse({ ...metadata(0), featureCollection: body.featureCollection });
    }
    return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "unhandled fixture route", retryable: false } }, 500);
  };
}

function pointResponse(coordinate: number[]): Record<string, unknown> {
  return {
    ...metadata(1, coordinate.length > 2),
    coordinate
  };
}

function metadata(coordinateCount: number, hasZ = false): Record<string, unknown> {
  return {
    crs: "EPSG:4326",
    axisOrder: ["longitude", "latitude"],
    coordinateCount,
    zTransformed: false,
    transformation: {
      engine: "PROJ",
      engineVersion: "9.5.1",
      integration: "gdal-async",
      integrationVersion: "3.12.3",
      sourceCrs: "EPSG:3857",
      targetCrs: "EPSG:4326",
      strictBestOperation: true,
      networkEnabled: false,
      cacheHit: false
    },
    warnings: hasZ ? [{ code: "Z_NOT_TRANSFORMED", message: "Only x/y were transformed; Z was preserved." }] : []
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function descriptorFor<T extends { operationId: string }>(descriptors: readonly T[], operationId: string): T {
  const descriptor = descriptors.find((candidate) => candidate.operationId === operationId);
  if (!descriptor) throw new Error(`missing descriptor ${operationId}`);
  return descriptor;
}
