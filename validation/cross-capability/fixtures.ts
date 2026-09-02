import type {
  CapabilityDescriptor,
  PlatformCommonDefinitionsReferenceKey
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  createH3AnalysisProvider,
  createH3InteractiveProvider,
  H3_ANALYSIS_OPERATION_IDS,
  H3_INTERACTIVE_OPERATION_IDS,
  lockedAttestation,
  type H3OperationId,
  type H3ToolkitResult,
  type H3ToolkitUpstream
} from "../../packages/integrations/h3-toolkit-bridge/src/index.js";
import {
  MemoryAuditSink,
  CapabilityRegistry,
  DirectExecutionService,
  InProcessProviderClient,
  MemoryGatewayIdempotencyStore,
  MemoryGatewayRecordStore,
  MemoryQueryPlanStore,
  ProviderCircuitBreaker,
  QueryPlanValidator,
  WorldQueryRuntime
} from "../../services/gateway/world-capability-gateway/src/index.js";
import { createCrsProviderBridge } from "../../services/providers/crs-provider-bridge/src/provider.js";
import {
  POC_OPENAPI_SHA256 as CRS_OPENAPI_SHA256,
  POC_SOURCE_ZIP_SHA256 as CRS_SOURCE_ZIP_SHA256
} from "../../services/providers/crs-provider-bridge/src/schemas.js";
import { endpointConfigurationDigest as crsEndpointDigest } from "../../services/providers/crs-provider-bridge/src/upstream-client.js";
import type { CrsProviderBridgeOptions } from "../../services/providers/crs-provider-bridge/src/types.js";
import { createGeometryProviderBridge } from "../../services/providers/geometry-provider-bridge/src/provider.js";
import {
  POC_GEOS_VERSION,
  POC_INTEGRATION_VERSION,
  POC_OPENAPI_SHA256 as GEOMETRY_OPENAPI_SHA256,
  POC_SOURCE_ZIP_SHA256 as GEOMETRY_SOURCE_ZIP_SHA256
} from "../../services/providers/geometry-provider-bridge/src/schemas.js";
import { endpointConfigurationDigest as geometryEndpointDigest } from "../../services/providers/geometry-provider-bridge/src/upstream-client.js";
import type {
  GeometryProviderBridgeOptions,
  PocOperationRequest
} from "../../services/providers/geometry-provider-bridge/src/types.js";
import { createGowmSituationProvider } from "../../services/providers/gowm-situation-provider/src/provider.js";
import type {
  GowmSituationReadPort,
  SituationRankedRequest
} from "../../services/providers/gowm-situation-provider/src/types.js";
import { createSpatialProviderBridge } from "../../services/providers/spatial-provider-bridge/src/provider.js";
import type {
  SpatialSqlClient,
  SpatialSqlPool,
  SpatialSqlResult
} from "../../services/providers/spatial-provider-bridge/src/types.js";
import type { Geometry, SituationCell } from "../../packages/world-model-core/src/types.js";
import type { ProviderRuntime } from "../../packages/platform/provider-sdk/src/index.js";

export const TOKYO_CELL = "892f5a32d97ffff";
export const TOKYO_NEIGHBOR = "892f5a32d83ffff";

export const WORLD_REFERENCE: PlatformCommonDefinitionsReferenceKey = {
  namespace: "gowm",
  kind: "WORLD_OBJECT",
  id: "wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  version: "7"
};

export const FILTERED_WORLD_REFERENCE: PlatformCommonDefinitionsReferenceKey = {
  namespace: "gowm",
  kind: "WORLD_OBJECT",
  id: "wrf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  version: "7"
};

const DATASET_REFERENCE: PlatformCommonDefinitionsReferenceKey = {
  namespace: "gowm",
  kind: "DATASET",
  id: "wrf_dddddddddddddddddddddddddddddddd",
  version: "7"
};

const CRS_SCALE = 111_319.49079327357;
const CURSOR_SECRET = "p13-spatial-cursor-secret-0000000000000000000000";

export interface SqlCall {
  text: string;
  values: readonly unknown[];
}

export class CrossCapabilitySpatialPool implements SpatialSqlPool {
  readonly calls: SqlCall[] = [];

  async connect(): Promise<SpatialSqlClient> {
    return {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = []
      ): Promise<SpatialSqlResult<Row>> => {
        this.calls.push({ text, values });
        const rows = this.rows(text);
        return { rows: rows as Row[], rowCount: rows.length };
      },
      release: () => undefined
    };
  }

  operationQueries(): SqlCall[] {
    return this.calls.filter((call) => /\/\* spatial\.[a-z-]+ \*\//u.test(call.text));
  }

  scopeClaims(): string[] {
    return this.calls
      .filter((call) => call.text.includes("set_data_scope"))
      .map((call) => String(call.values[0]));
  }

  private rows(text: string): Record<string, unknown>[] {
    if (text.includes("postgis_lib_version()")) return [{ postgis_version: "3.6.4" }];
    if (text.includes("/* gowm_spatial_v1 snapshot */")) {
      return [{
        dataset_reference_key: DATASET_REFERENCE,
        current_world_version: "7",
        snapshot_consistency: "CONSISTENT_AT_START",
        captured_at: "2026-08-23T00:00:00.000Z"
      }];
    }
    if (/\/\* spatial\.(?:find-nearby|find-in-area|find-intersections) \*\//u.test(text)) {
      return [spatialObjectRow()];
    }
    return [];
  }
}

export class CrossCapabilityH3Upstream implements H3ToolkitUpstream {
  readonly attestation = lockedAttestation("TEST_DOUBLE");
  readonly supportedOperations = [...H3_INTERACTIVE_OPERATION_IDS, ...H3_ANALYSIS_OPERATION_IDS];
  readonly calls: Array<{ operationId: H3OperationId; input: unknown }> = [];

  async execute(operationId: H3OperationId, input: unknown): Promise<H3ToolkitResult> {
    this.calls.push({ operationId, input: structuredClone(input) });
    return {
      data: h3Result(operationId),
      warnings: [],
      meta: { toolkitVersion: "0.3.0", engine: "h3-js", engineVersion: "4.5.0" }
    };
  }

  async readiness() {
    return {
      ready: true,
      reasons: [],
      sourceGitCommit: this.attestation.sourceGitCommit,
      toolkitVersion: "0.3.0" as const,
      engineVersion: "4.5.0" as const
    };
  }
}

export class CrossCapabilitySituationPort implements GowmSituationReadPort {
  readonly calls: Array<{ method: string; dataScopeKey: string; indexes?: string[] }> = [];
  private readonly referencesByCell = new Map<string, PlatformCommonDefinitionsReferenceKey[]>([
    [TOKYO_CELL, [WORLD_REFERENCE]],
    [TOKYO_NEIGHBOR, [FILTERED_WORLD_REFERENCE]]
  ]);

  async getCells(dataScopeKey: string, indexes: string[]): Promise<SituationCell[]> {
    this.calls.push({ method: "getCells", dataScopeKey, indexes: [...indexes] });
    return indexes.map((h3Index) => situationCell(h3Index));
  }

  async candidateReferences(
    dataScopeKey: string,
    indexes: string[],
    _maximumReferences: number
  ): Promise<PlatformCommonDefinitionsReferenceKey[]> {
    this.calls.push({ method: "candidateReferences", dataScopeKey, indexes: [...indexes] });
    const references = indexes.flatMap((index) => this.referencesByCell.get(index) ?? []);
    return [...new Map(references.map((reference) => [JSON.stringify(reference), reference])).values()]
      .map((reference) => structuredClone(reference));
  }

  async areaCells(dataScopeKey: string, _area: Geometry, _resolution: number): Promise<SituationCell[]> {
    this.calls.push({ method: "areaCells", dataScopeKey });
    return [situationCell(TOKYO_CELL)];
  }

  async ranked(dataScopeKey: string, _options: SituationRankedRequest): Promise<SituationCell[]> {
    this.calls.push({ method: "ranked", dataScopeKey });
    return [situationCell(TOKYO_CELL)];
  }

  async worldVersion(dataScopeKey: string): Promise<number> {
    this.calls.push({ method: "worldVersion", dataScopeKey });
    return 7;
  }

  async readiness() {
    return { ready: true, reasons: [] };
  }
}

export interface CrossCapabilityHarness {
  registry: CapabilityRegistry;
  runtime: WorldQueryRuntime;
  store: MemoryQueryPlanStore;
  spatialPool: CrossCapabilitySpatialPool;
  h3Upstream: CrossCapabilityH3Upstream;
  situationPort: CrossCapabilitySituationPort;
  descriptor(operationId: string): CapabilityDescriptor;
}

export function createCrossCapabilityHarness(): CrossCapabilityHarness {
  const spatialPool = new CrossCapabilitySpatialPool();
  const h3Upstream = new CrossCapabilityH3Upstream();
  const situationPort = new CrossCapabilitySituationPort();
  const crs = createCrsProviderBridge(crsOptions());
  const geometry = createGeometryProviderBridge(geometryOptions());
  const h3Interactive = createH3InteractiveProvider({ upstream: h3Upstream });
  const h3Analysis = createH3AnalysisProvider({ upstream: h3Upstream });
  const spatial = createSpatialProviderBridge({
    pool: spatialPool,
    cursorSecret: CURSOR_SECRET,
    postgisVersion: "3.6.4",
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 1_000,
    maximumRows: 10_000,
    maximumCandidates: 50_000,
    maximumEvidenceReferences: 1_000,
    receiptId: sequentialId("receipt_spatial_p13")
  });
  const situation = createGowmSituationProvider({
    port: situationPort,
    acceptedDataScope: "default",
    receiptId: sequentialId("receipt_situation_p13")
  });

  const registry = new CapabilityRegistry();
  [crs.runtime, geometry.runtime, h3Interactive.runtime, h3Analysis.runtime, situation.runtime, spatial.runtime]
    .forEach((provider, index) => register(registry, provider, 35_100 + index));
  const records = new MemoryGatewayRecordStore();
  const directExecution = new DirectExecutionService({
    registry,
    circuits: new ProviderCircuitBreaker(),
    idempotency: new MemoryGatewayIdempotencyStore(),
    audit: new MemoryAuditSink(),
    gatewayId: "gateway-p13-cross-capability",
    policyVersion: "gateway-p13-cross-capability/1.0",
    attestationIssuer: "gateway-p13-cross-capability",
    records
  });
  const store = new MemoryQueryPlanStore();
  const runtime = new WorldQueryRuntime({
    validator: new QueryPlanValidator(registry),
    directExecution,
    store,
    autoRunAsync: false
  });
  return {
    registry,
    runtime,
    store,
    spatialPool,
    h3Upstream,
    situationPort,
    descriptor(operationId: string): CapabilityDescriptor {
      return registry.resolve(operationId, "1.0", true).descriptor;
    }
  };
}

export function projectedPosition(longitude: number, latitude: number): [number, number] {
  return [longitude * CRS_SCALE, latitude * CRS_SCALE];
}

export function projectedPolygon(coordinates: readonly (readonly [number, number])[]) {
  return {
    type: "Polygon" as const,
    coordinates: [coordinates.map(([longitude, latitude]) => projectedPosition(longitude, latitude))]
  };
}

function register(registry: CapabilityRegistry, runtime: ProviderRuntime, port: number): void {
  registry.register({
    approvalId: `approval-p13-${runtime.manifest.provider.providerId}`,
    approved: true,
    endpoint: new URL(`http://127.0.0.1:${port}/`),
    client: new InProcessProviderClient(runtime),
    manifest: runtime.manifest
  });
}

function crsOptions(): CrsProviderBridgeOptions {
  const endpointId = "crs-p13-fixture";
  const baseUrl = "http://127.0.0.1:18086";
  return {
    endpoint: {
      endpointId,
      baseUrl,
      approvalStatus: "APPROVED" as const,
      configurationDigest: crsEndpointDigest(endpointId, baseUrl)
    },
    attestation: {
      sourceZipSha256: CRS_SOURCE_ZIP_SHA256,
      openApiSha256: CRS_OPENAPI_SHA256,
      projVersion: "9.5.1",
      integration: "gdal-async" as const,
      integrationVersion: "3.12.3",
      projDbVersion: "EPSG-v12.013",
      projDbSha256: `sha256:${"a".repeat(64)}` as const,
      gridBundleVersion: "p13-offline-grid-v1",
      gridBundleSha256: `sha256:${"b".repeat(64)}` as const,
      strictBestOperation: true as const,
      networkEnabled: false as const
    },
    fetch: crsFetch(),
    receiptId: sequentialId("receipt_crs_p13")
  };
}

function geometryOptions(): GeometryProviderBridgeOptions {
  const endpointId = "geometry-p13-fixture";
  const baseUrl = "http://127.0.0.1:19087";
  return {
    endpoint: {
      endpointId,
      baseUrl,
      approvalStatus: "APPROVED" as const,
      configurationDigest: geometryEndpointDigest(endpointId, baseUrl)
    },
    attestation: {
      sourceZipSha256: GEOMETRY_SOURCE_ZIP_SHA256,
      openApiSha256: GEOMETRY_OPENAPI_SHA256,
      engine: "GEOS-WASM-WORKER-POOL" as const,
      geosVersion: POC_GEOS_VERSION,
      integration: "geos-wasm" as const,
      integrationVersion: POC_INTEGRATION_VERSION,
      workerPoolEnabled: true as const,
      projectLicense: "MIT" as const
    },
    fetch: geometryFetch(),
    receiptId: sequentialId("receipt_geometry_p13")
  };
}

function crsFetch(): typeof fetch {
  return async (input, init) => {
    const url = String(input);
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
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url.endsWith("/v1/normalize/point")) {
      const coordinate = body.coordinate as number[];
      return jsonResponse({ ...crsMetadata(1), coordinate: normalizePosition(coordinate) });
    }
    if (url.endsWith("/v1/normalize/geometry")) {
      const geometry = body.geometry as Record<string, unknown>;
      return jsonResponse({
        ...crsMetadata(coordinateCount(geometry)),
        geometry: transformGeometry(geometry)
      });
    }
    return jsonResponse({ error: { code: "UNSUPPORTED_OPERATION", message: "P13 fixture route is not used" } }, 422);
  };
}

function crsMetadata(coordinates: number): Record<string, unknown> {
  return {
    crs: "EPSG:4326",
    axisOrder: ["longitude", "latitude"],
    coordinateCount: coordinates,
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
    warnings: []
  };
}

function transformGeometry(geometry: Record<string, unknown>): Record<string, unknown> {
  if (geometry.type === "GeometryCollection") {
    return {
      type: "GeometryCollection",
      geometries: (geometry.geometries as Record<string, unknown>[]).map(transformGeometry)
    };
  }
  return { type: geometry.type, coordinates: transformCoordinates(geometry.coordinates) };
}

function transformCoordinates(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (typeof value[0] === "number" && typeof value[1] === "number") return normalizePosition(value as number[]);
  return value.map(transformCoordinates);
}

function normalizePosition(value: number[]): number[] {
  return [round(value[0]! / CRS_SCALE), round(value[1]! / CRS_SCALE), ...value.slice(2)];
}

function coordinateCount(value: unknown): number {
  if (Array.isArray(value)) {
    if (typeof value[0] === "number" && typeof value[1] === "number") return 1;
    return value.reduce((sum, child) => sum + coordinateCount(child), 0);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return coordinateCount(record.coordinates ?? record.geometries ?? []);
  }
  return 0;
}

function geometryFetch(): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith("/ready")) {
      return jsonResponse({
        status: "ready",
        engine: "GEOS-WASM-WORKER-POOL",
        engineVersion: POC_GEOS_VERSION,
        database: "not-required",
        overloadProtection: {
          maxInFlight: 8,
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
    const request = JSON.parse(String(init?.body)) as PocOperationRequest;
    const geometry = request.input?.geometry as Record<string, unknown>;
    if (request.operation === "validate") {
      const valid = !isSelfIntersectingPolygon(geometry);
      return jsonResponse({
        result: valid,
        detail: {
          valid,
          reason: valid ? null : "Self-intersection",
          location: null,
          simple: valid,
          empty: false,
          closed: null,
          ring: null,
          rectangle: null
        },
        summary: geometrySummary(geometry, valid),
        warnings: [],
        execution: geometryExecution("validate")
      });
    }
    if (request.operation === "make_valid") {
      const repaired = repairAsMultiPolygon(geometry);
      return jsonResponse({
        result: repaired,
        summary: {
          ...geometrySummary(repaired, true),
          inputType: String(geometry.type),
          typeChanged: geometry.type !== repaired.type
        },
        warnings: [],
        execution: geometryExecution("make_valid")
      });
    }
    return jsonResponse({ error: { code: "UNSUPPORTED_OPERATION", message: "P13 fixture operation is not used" } }, 422);
  };
}

function geometryExecution(operation: string) {
  return {
    engine: "GEOS-WASM-WORKER-POOL",
    engineVersion: POC_GEOS_VERSION,
    durationMs: 1,
    operation,
    deterministicScope: "engine-version-input-options"
  };
}

function geometrySummary(geometry: Record<string, unknown>, valid: boolean) {
  return {
    type: String(geometry.type),
    empty: false,
    valid,
    simple: valid,
    vertexCount: coordinateCount(geometry),
    coordinateDimension: 2,
    coordinateLayout: "XY"
  };
}

function isSelfIntersectingPolygon(geometry: Record<string, unknown>): boolean {
  if (geometry.type !== "Polygon") return false;
  const rings = geometry.coordinates as number[][][];
  const ring = rings[0];
  if (!ring || ring.length < 5) return false;
  return segmentsIntersect(ring[0]!, ring[1]!, ring[2]!, ring[3]!);
}

function segmentsIntersect(a: number[], b: number[], c: number[], d: number[]): boolean {
  const cross = (p: number[], q: number[], r: number[]) =>
    (q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return abC * abD < 0 && cdA * cdB < 0;
}

function repairAsMultiPolygon(geometry: Record<string, unknown>): Record<string, unknown> {
  const positions = flattenPositions(geometry.coordinates);
  const xs = positions.map((position) => position[0]!);
  const ys = positions.map((position) => position[1]!);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  return {
    type: "MultiPolygon",
    coordinates: [[[
      [minimumX, minimumY],
      [maximumX, minimumY],
      [maximumX, maximumY],
      [minimumX, maximumY],
      [minimumX, minimumY]
    ]]]
  };
}

function flattenPositions(value: unknown): number[][] {
  if (!Array.isArray(value)) return [];
  if (typeof value[0] === "number" && typeof value[1] === "number") return [value as number[]];
  return value.flatMap(flattenPositions);
}

function h3Result(operationId: H3OperationId): unknown {
  if (operationId === "h3.geometry.cover") return [TOKYO_CELL, TOKYO_NEIGHBOR];
  if (operationId === "h3.analytics.flow") {
    return [
      { origin: TOKYO_CELL, destination: TOKYO_NEIGHBOR, count: 1, weight: 0 },
      { origin: TOKYO_NEIGHBOR, destination: TOKYO_CELL, count: 1, weight: 0 }
    ];
  }
  return [];
}

function situationCell(h3Index: string): SituationCell {
  return {
    h3Index,
    resolution: 9,
    metrics: {
      agentCount: 1,
      vehicleCount: 1,
      sensorCount: 1,
      incidentCount: 0,
      observationCount: 2,
      riskScore: 10,
      coverageScore: 95,
      activityScore: 25,
      freshnessScore: 90
    },
    updatedAt: "2026-08-23T00:00:00.000Z",
    worldVersion: 7
  };
}

function spatialObjectRow(): Record<string, unknown> {
  return {
    reference_key: WORLD_REFERENCE,
    object_type: "vehicle",
    subtype: "test",
    status: "ACTIVE",
    source: "controlled-p13-fixture",
    properties: { label: "exact-intersection" },
    observed_at: "2026-08-22T23:59:58.000Z",
    received_at: "2026-08-22T23:59:59.000Z",
    updated_at: "2026-08-23T00:00:00.000Z",
    world_version: 7,
    confidence: 0.91,
    freshness_ms: 2_000,
    source_observation_id: "observation:p13-exact",
    provenance_summary: { evidenceKind: "OBSERVED" },
    distance_m: 12.5,
    geometry: null,
    candidate_count: 2
  };
}

function sequentialId(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}_${++sequence}`;
}

function round(value: number): number {
  return Number(value.toFixed(8));
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
