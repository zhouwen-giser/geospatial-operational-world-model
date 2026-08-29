import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProviderExecutionRequest } from "../../../packages/platform/contract-runtime/src/index.js";
import { validateAgainstSchema, validateContract } from "../../../packages/platform/contract-runtime/src/index.js";
import { runProviderConformance } from "../../../packages/platform/conformance-kit/src/index.js";
import { ProviderProtocolError } from "../../../packages/platform/provider-sdk/src/index.js";
import { buildSpatialProviderBridgeApp } from "../../../services/providers/spatial-provider-bridge/src/app.js";
import { buildSpatialQuery } from "../../../services/providers/spatial-provider-bridge/src/sql.js";
import { dataScopeDigest, encodeSpatialCursor } from "../../../services/providers/spatial-provider-bridge/src/cursor.js";
import { createSpatialProviderBridge } from "../../../services/providers/spatial-provider-bridge/src/provider.js";
import {
  GOWM_SPATIAL_V1_CATALOG_FEATURE_MIGRATION_SHA256,
  GOWM_SPATIAL_V1_MIGRATION_SHA256,
  SPATIAL_CONTRACT_TREE_SHA256,
  SPATIAL_DEFINITIONS_SCHEMA_SHA256,
  SPATIAL_OPENAPI_SHA256,
  SPATIAL_OPERATION_IDS,
  SPATIAL_OPERATION_SCHEMAS,
  SPATIAL_SOURCE_ZIP_SHA256,
  type SpatialOperationId
} from "../../../services/providers/spatial-provider-bridge/src/schemas.js";
import type {
  SpatialProviderBridgeOptions
} from "../../../services/providers/spatial-provider-bridge/src/provider.js";
import type {
  SpatialSqlClient,
  SpatialSqlPool,
  SpatialSqlResult
} from "../../../services/providers/spatial-provider-bridge/src/types.js";

const CURSOR_SECRET = "spatial-conformance-cursor-secret-0000000000000000";
const WORLD_REFERENCE = reference("WORLD_OBJECT", "wrf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "7");
const WORLD_REFERENCE_2 = reference("WORLD_OBJECT", "wrf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "7");
const LAYER_REFERENCE = reference("LAYER_FEATURE", "wrf_cccccccccccccccccccccccccccccccc", "3");
const DATASET_REFERENCE = reference("DATASET", "wrf_dddddddddddddddddddddddddddddddd", "7");
const AREA = {
  type: "Polygon",
  coordinates: [[[116, 39], [117, 39], [117, 40], [116, 40], [116, 39]]]
} as const;

describe("Spatial provider bridge", () => {
  it("locks the ten formal operations, maturity, source, and generated manifest", () => {
    const bridge = createSpatialProviderBridge(options(new MockPool()));
    expect(bridge.runtime.manifest.capabilities.map((capability) => capability.operationId)).toEqual(SPATIAL_OPERATION_IDS);
    expect(bridge.runtime.manifest.capabilities.filter((capability) => capability.maturity === "STABLE").map((capability) => capability.operationId)).toEqual([
      "spatial.find-nearby", "spatial.find-in-area", "spatial.find-intersections"
    ]);
    expect(bridge.runtime.manifest.capabilities.filter((capability) => capability.maturity === "EXPERIMENTAL").map((capability) => capability.operationId)).toEqual([
      "spatial.join", "spatial.aggregate"
    ]);
    expect(bridge.runtime.manifest.capabilities.every((capability) =>
      capability.scopePolicy === "DATA_SCOPE_REQUIRED" &&
      capability.dataBinding === "WORLD_SNAPSHOT_BOUND" &&
      capability.executionBindings.includes("VERSIONED_SQL_CONTRACT")
    )).toBe(true);
    expect(validateContract("capability-provider-manifest.schema.json", bridge.runtime.manifest)).toMatchObject({ valid: true });

    const manifest = JSON.parse(readFileSync(
      new URL("../../../contracts/manifests/providers/spatial-provider.json", import.meta.url),
      "utf8"
    )) as unknown;
    expect(bridge.runtime.manifest).toEqual(manifest);

    const sourceLock = JSON.parse(readFileSync(
      new URL("../../../contracts/manifests/providers/spatial-provider-source-lock.json", import.meta.url),
      "utf8"
    )) as Record<string, unknown>;
    expect(sourceLock).toMatchObject({
      licenseStatus: "APPROVED",
      license: "Apache-2.0",
      redistributionAllowed: true,
      sourceCopiedIntoGowm: false,
      sourceSha256: SPATIAL_SOURCE_ZIP_SHA256.slice("sha256:".length),
      openApiSha256: SPATIAL_OPENAPI_SHA256.slice("sha256:".length),
      contractTreeSha256: SPATIAL_CONTRACT_TREE_SHA256.slice("sha256:".length),
      canonicalDefinitionsSha256: SPATIAL_DEFINITIONS_SCHEMA_SHA256.slice("sha256:".length),
      readContractMigrationSha256: GOWM_SPATIAL_V1_MIGRATION_SHA256.slice("sha256:".length),
      catalogFeatureReadContractMigrationSha256: GOWM_SPATIAL_V1_CATALOG_FEATURE_MIGRATION_SHA256.slice("sha256:".length)
    });
  });

  it("keeps every operation input strict and rejects unknown caller fields", () => {
    for (const operationId of SPATIAL_OPERATION_IDS) {
      const schema = SPATIAL_OPERATION_SCHEMAS[operationId].input;
      const valid = validInput(operationId);
      expect(validateAgainstSchema(schema, valid), operationId).toMatchObject({ valid: true });
      expect(validateAgainstSchema(schema, { ...valid, arbitrarySql: "DROP TABLE world_object" }), operationId)
        .toMatchObject({ valid: false });
    }
    expect(validateAgainstSchema(SPATIAL_OPERATION_SCHEMAS["spatial.find-nearby"].input, {
      location: [116.4, 39.9, 12], radiusM: 1_000
    })).toMatchObject({ valid: true });
    expect(validateAgainstSchema(SPATIAL_OPERATION_SCHEMAS["spatial.find-nearby"].input, {
      location: [181, 39.9], radiusM: 1_000
    })).toMatchObject({ valid: false });
    expect(validateAgainstSchema(SPATIAL_OPERATION_SCHEMAS["spatial.find-intersections"].input, {
      geometry: { type: "Point", coordinates: [116.4, 39.9] },
      candidateReferences: [WORLD_REFERENCE.id]
    })).toMatchObject({ valid: false });
  });

  it("passes Provider SDK conformance and requires an attested DataScope", async () => {
    const bridge = createSpatialProviderBridge(options(new MockPool()));
    const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, "spatial.find-nearby");
    const request = providerRequest(descriptor, validInput("spatial.find-nearby"));
    const report = await runProviderConformance({
      runtime: bridge.runtime,
      validRequest: request,
      differentInput: { location: { longitude: 117, latitude: 40 }, radiusM: 1_000 },
      unknownFieldInput: { ...validInput("spatial.find-nearby"), arbitrarySql: "SELECT * FROM public.world_object" },
      deadlineRequest: {
        ...request,
        requestId: "request-spatial-deadline",
        idempotencyKey: "idempotency-spatial-deadline",
        executionPolicy: { ...request.executionPolicy, deadlineAt: "2026-08-22T23:59:59.000Z" }
      }
    });
    expect(report, JSON.stringify(report, null, 2)).toMatchObject({ passed: true });
  });

  it("serves the Provider Protocol over HTTP and keeps readiness on contract views", async () => {
    const pool = new MockPool();
    const bridge = createSpatialProviderBridge(options(pool));
    const app = buildSpatialProviderBridgeApp(bridge, "test-provider-transport-token-32-bytes-minimum");
    try {
      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toMatchObject({ ready: true, providerId: "gowm.spatial-analysis.bridge", operationCount: 10 });
      const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, "spatial.find-nearby");
      const response = await app.inject({
        method: "POST",
        url: "/v1/operations/spatial.find-nearby:execute",
        headers: { authorization: "Bearer test-provider-transport-token-32-bytes-minimum" },
        payload: providerRequest(descriptor, validInput("spatial.find-nearby"), "request-http", "idempotency-http")
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "COMPLETED", operation: { operationId: "spatial.find-nearby" } });

      const mismatch = await app.inject({
        method: "POST",
        url: "/v1/operations/spatial.find-nearest:execute",
        headers: { authorization: "Bearer test-provider-transport-token-32-bytes-minimum" },
        payload: providerRequest(descriptor, validInput("spatial.find-nearby"), "request-http-mismatch", "idempotency-http-mismatch")
      });
      expect(mismatch.statusCode).toBe(422);
      expect(mismatch.json()).toMatchObject({ error: { code: "SCHEMA_MISMATCH", stage: "REQUEST_VALIDATION" } });
      expect(pool.calls.filter((call) => call.text.includes("LIMIT 0"))).toHaveLength(7);
      expect(pool.calls.every((call) => !call.text.includes("public."))).toBe(true);
    } finally {
      await app.close();
    }
    const mismatched = buildSpatialProviderBridgeApp(createSpatialProviderBridge(options(new MockPool(), {
      postgisVersion: "3.5.0"
    })), "test-provider-transport-token-32-bytes-minimum");
    try {
      const ready = await mismatched.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toMatchObject({
        ready: false,
        reasons: ["gowm_spatial_v1 read contract is unavailable"]
      });
      expect(JSON.stringify(ready.json())).not.toContain("attestation mismatch");
    } finally {
      await mismatched.close();
    }
  });

  it("executes all formal operations through static contract-view SQL", async () => {
    const pool = new MockPool();
    const bridge = createSpatialProviderBridge(options(pool));
    for (const operationId of SPATIAL_OPERATION_IDS) {
      const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, operationId);
      const result = await bridge.runtime.execute(providerRequest(
        descriptor,
        validInput(operationId),
        `request-${operationId.replaceAll(".", "-")}`,
        `idempotency-${operationId.replaceAll(".", "-")}`
      ));
      expect(result.status, operationId).toBe("COMPLETED");
      expect(result.output?.schemaHash, operationId).toBe(descriptor.outputSchemaHash);
      expect(result.dataSnapshot, operationId).toMatchObject({
        consistency: "CONSISTENT_AT_START",
        resources: [{ referenceKey: DATASET_REFERENCE, authority: "GOWM Foundation", pinning: "AT_LEAST" }]
      });
      expect(result.computeSnapshot, operationId).toMatchObject({
        engine: { name: "PostGIS", version: "3.6.4" },
        artifacts: expect.arrayContaining([{ kind: "DATABASE", name: "gowm_spatial_v1", version: "migration-012", digest: GOWM_SPATIAL_V1_MIGRATION_SHA256 }])
      });
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]?.warnings).toContain("spatial.snapshot=CONSISTENT_AT_START");
      expect(result.evidenceReferences.length, operationId).toBeGreaterThan(0);
    }
    expect(pool.operationQueries()).toHaveLength(10);
    expect(pool.operationQueries().every((call) => call.text.includes("gowm_spatial_v1."))).toBe(true);
  });

  it("returns opaque references with freshness, confidence, provenance, evidence, and canonical receipts", async () => {
    const pool = new MockPool();
    const bridge = createSpatialProviderBridge(options(pool));
    const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, "spatial.find-nearby");
    const result = await bridge.runtime.execute(providerRequest(descriptor, {
      location: [116.4, 39.9, 12],
      radiusM: 1_000,
      limit: 10
    }));
    const output = result.output?.value as Record<string, unknown>;
    const objects = output.objects as Array<Record<string, unknown>>;
    expect(objects[0]).toMatchObject({
      referenceKey: WORLD_REFERENCE,
      worldVersion: 7,
      confidence: 0.91,
      freshnessMs: 2_000,
      distanceM: 12.5,
      provenance: { authority: "GOWM Foundation", sourceObservationId: "observation:test", summary: { evidenceKind: "OBSERVED" } }
    });
    expect(JSON.stringify(output)).not.toContain("internal-object-id");
    expect(result.evidenceReferences[0]).toMatchObject({
      evidenceId: WORLD_REFERENCE.id,
      evidenceType: "CURRENT_PROJECTION_SOURCE",
      referenceKey: WORLD_REFERENCE,
      worldVersion: 7
    });
    expect(result.dataSnapshot?.consistency).not.toBe("PINNED");
    expect(result.receipts[0]).toMatchObject({
      operationId: "spatial.find-nearby",
      method: { engine: "PostGIS", engineVersion: "3.6.4", methodId: "gowm-spatial-v1/find-nearby" }
    });
    expect(result.receipts[0]?.warnings).toContain("spatial.locationZIgnored=true");
    expect(pool.operationQueries()[0]?.values.slice(0, 2)).toEqual([116.4, 39.9]);
  });

  it("returns exact catalog LAYER_FEATURE references from intersection queries while retaining WORLD_OBJECT support", async () => {
    const pool = new MockPool({ layerFeatureIntersections: true });
    const bridge = createSpatialProviderBridge(options(pool));
    const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, "spatial.find-intersections");
    const request = providerRequest(descriptor, {
      geometry: { type: "Point", coordinates: [116.4, 39.9] },
      candidateReferences: [LAYER_REFERENCE],
      includeGeometry: true,
      limit: 10
    });
    request.securityContext.datasetScopeClaim = "roads";
    const result = await bridge.runtime.execute(request);
    const output = result.output?.value as { objects: Array<Record<string, unknown>> };
    expect(output.objects[0]).toMatchObject({
      referenceKey: LAYER_REFERENCE,
      objectType: "road",
      worldVersion: 3,
      geometry: { type: "Point", coordinates: [116.4, 39.9] }
    });
    expect(result.evidenceReferences[0]).toMatchObject({
      evidenceId: LAYER_REFERENCE.id,
      evidenceType: "LAYER_VERSION",
      referenceKey: LAYER_REFERENCE,
      worldVersion: 3,
      schemaUri: "urn:gowm:foundation:gowm_spatial_v1:catalog_feature_reference:1"
    });
    expect(descriptor.semanticProfile).toMatchObject({
      acceptedReferenceKinds: ["LAYER_FEATURE", "WORLD_OBJECT"],
      producedReferenceKinds: ["LAYER_FEATURE", "WORLD_OBJECT"]
    });
    const query = pool.operationQueries()[0];
    expect(query?.text).toContain("gowm_spatial_v1.catalog_feature_reference");
    expect(query?.text).toMatch(/FROM gowm_spatial_v1\.current_object object_source[\s\S]*?UNION[\s\S]*?FROM gowm_spatial_v1\.catalog_feature_reference feature_source/u);
    expect(query?.values).toContain(JSON.stringify([LAYER_REFERENCE]));
    expect(pool.calls).toContainEqual({
      text: "SELECT set_config('gowm.dataset_scope_key', $1::text, true)",
      values: ["roads"]
    });
  });

  it("opens a read-only repeatable-read transaction and establishes SQL-level scope before querying", async () => {
    const pool = new MockPool();
    const bridge = createSpatialProviderBridge(options(pool));
    const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, "spatial.find-in-area");
    await bridge.runtime.execute(providerRequest(descriptor, validInput("spatial.find-in-area")));
    expect(pool.calls.map((call) => call.text)).toEqual(expect.arrayContaining([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT set_config('statement_timeout', $1::text, true)",
      "SELECT set_config('lock_timeout', $1::text, true)",
      "SELECT gowm_spatial_v1.set_data_scope($1::text)",
      "COMMIT"
    ]));
    const begin = pool.calls.findIndex((call) => call.text.startsWith("BEGIN"));
    const scope = pool.calls.findIndex((call) => call.text.includes("set_data_scope"));
    const operation = pool.calls.findIndex((call) => call.text.includes("/* spatial.find-in-area */"));
    expect(begin).toBeLessThan(scope);
    expect(scope).toBeLessThan(operation);
    expect(pool.calls[scope]?.values).toEqual(["scope-a"]);
    expect(pool.calls.some((call) => call.text.includes("public."))).toBe(false);
  });

  it("binds signed keyset cursors to operation, scopes, and world plus catalog snapshots", async () => {
    const pool = new MockPool({ objectPageRows: 2 });
    const bridge = createSpatialProviderBridge(options(pool));
    const descriptor = descriptorFor(bridge.runtime.manifest.capabilities, "spatial.find-in-area");
    const first = await bridge.runtime.execute(providerRequest(
      descriptor,
      { ...validInput("spatial.find-in-area"), limit: 1 },
      "request-page-one",
      "idempotency-page-one"
    ));
    const firstOutput = first.output?.value as { page: { nextCursor?: string } };
    expect(firstOutput.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

    const beforeSameScope = pool.operationQueries().length;
    await bridge.runtime.execute(providerRequest(
      descriptor,
      { ...validInput("spatial.find-in-area"), limit: 1, cursor: firstOutput.page.nextCursor },
      "request-page-two",
      "idempotency-page-two"
    ));
    const secondQuery = pool.operationQueries()[beforeSameScope];
    expect(secondQuery?.text).toContain("reference_key->>'id' >");
    expect(secondQuery?.values).toContain(WORLD_REFERENCE.id);

    const beforeOtherScope = pool.operationQueries().length;
    await expect(bridge.runtime.execute(providerRequest(
      descriptor,
      { ...validInput("spatial.find-in-area"), limit: 1, cursor: firstOutput.page.nextCursor },
      "request-cross-scope",
      "idempotency-cross-scope",
      "scope-b"
    ))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(pool.operationQueries()).toHaveLength(beforeOtherScope);

    const stale = encodeSpatialCursor({
      v: 1,
      operationId: "spatial.find-in-area",
      scopeDigest: dataScopeDigest("scope-a"),
      snapshotVersion: "6",
      sort: "id",
      id: WORLD_REFERENCE.id
    }, CURSOR_SECRET);
    await expect(bridge.runtime.execute(providerRequest(
      descriptor,
      { ...validInput("spatial.find-in-area"), cursor: stale },
      "request-stale-cursor",
      "idempotency-stale-cursor"
    ))).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const staleCatalog = encodeSpatialCursor({
      v: 1,
      operationId: "spatial.find-in-area",
      scopeDigest: dataScopeDigest("scope-a"),
      snapshotVersion: `7:sha256:${"d".repeat(64)}`,
      sort: "id",
      id: WORLD_REFERENCE.id
    }, CURSOR_SECRET);
    await expect(bridge.runtime.execute(providerRequest(
      descriptor,
      { ...validInput("spatial.find-in-area"), cursor: staleCatalog },
      "request-stale-catalog-cursor",
      "idempotency-stale-catalog-cursor"
    ))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("enforces candidate budgets and maps database denials without leaking database details", async () => {
    expect(() => createSpatialProviderBridge(options(new MockPool(), { maximumCandidates: 50_001 })))
      .toThrowError("maximumCandidates must not exceed 50000");
    const overflow = new MockPool({ candidateCount: 3 });
    const overflowBridge = createSpatialProviderBridge(options(overflow, { maximumCandidates: 2 }));
    const descriptor = descriptorFor(overflowBridge.runtime.manifest.capabilities, "spatial.find-nearby");
    await expect(overflowBridge.runtime.execute(providerRequest(
      descriptor,
      validInput("spatial.find-nearby"),
      "request-overflow",
      "idempotency-overflow"
    ))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false });
    expect(overflow.calls.some((call) => call.text === "ROLLBACK")).toBe(true);

    const denied = new MockPool({ scopeError: Object.assign(new Error("secret database role and table"), { code: "42501" }) });
    const deniedBridge = createSpatialProviderBridge(options(denied));
    const deniedDescriptor = descriptorFor(deniedBridge.runtime.manifest.capabilities, "spatial.find-nearby");
    await expect(deniedBridge.runtime.execute(providerRequest(
      deniedDescriptor,
      validInput("spatial.find-nearby"),
      "request-denied",
      "idempotency-denied"
    ))).rejects.toMatchObject({ code: "SCOPE_DENIED", message: "spatial data scope is unavailable" });
  });

  it("uses exact predicates, KNN candidate ordering, fixed field maps, and parameter placeholders", () => {
    const limits = { maximumRows: 10_000, maximumCandidates: 50_000, maximumEvidenceReferences: 1_000 };
    const nearby = buildSpatialQuery("spatial.find-nearby", validInput("spatial.find-nearby"), undefined, limits);
    const nearest = buildSpatialQuery("spatial.find-nearest", validInput("spatial.find-nearest"), undefined, limits);
    const inArea = buildSpatialQuery("spatial.find-in-area", validInput("spatial.find-in-area"), undefined, limits);
    const intersections = buildSpatialQuery("spatial.find-intersections", validInput("spatial.find-intersections"), undefined, limits);
    const summary = buildSpatialQuery("spatial.summarize-area", validInput("spatial.summarize-area"), undefined, limits);
    expect(nearby.text).toContain("ST_DWithin");
    expect(nearby.text).toContain("ST_Distance");
    expect(nearest.text).toContain("<->");
    expect(nearest.text).toContain("ST_Distance");
    expect(inArea.text).toContain("ST_Covers(q.geom, co.geometry_wgs84)");
    expect(intersections.text).toContain("ST_Intersects(co.geometry_wgs84, q.geom)");
    expect(inArea.text).toContain("jsonb_array_elements");
    expect(intersections.text).toContain("jsonb_array_elements");
    expect(inArea.text).not.toContain(WORLD_REFERENCE.id);
    expect(inArea.values).toContain(JSON.stringify([WORLD_REFERENCE]));
    expect(summary.text).toContain("co.object_type AS group_key");
    for (const query of [nearby, nearest, inArea, intersections, summary]) {
      expect(query.text).not.toContain("scope-a");
      expect(query.text).toMatch(/\$1/u);
      expect(query.text).toContain("gowm_spatial_v1.");
      expect(query.text).not.toMatch(/\b(?:world_object|world_object_state|spatial_object)\b(?!\s+co|\s+l|\s+r|\s+o)/u);
    }
    expect(() => buildSpatialQuery(
      "spatial.find-intersections",
      {
        geometry: { type: "Point", coordinates: [116.4, 39.9] },
        candidateReferences: [WORLD_REFERENCE, WORLD_REFERENCE_2]
      },
      undefined,
      { ...limits, maximumCandidates: 1 }
    )).toThrowError(ProviderProtocolError);
  });
});

interface MockPoolOptions {
  objectPageRows?: number;
  candidateCount?: number;
  scopeError?: Error & { code?: string };
  layerFeatureIntersections?: boolean;
}

interface SqlCall {
  text: string;
  values: readonly unknown[];
}

class MockPool implements SpatialSqlPool {
  readonly calls: SqlCall[] = [];

  constructor(private readonly settings: MockPoolOptions = {}) {}

  async connect(): Promise<SpatialSqlClient> {
    return {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = []
      ): Promise<SpatialSqlResult<Row>> => {
        this.calls.push({ text, values });
        if (text.includes("set_data_scope") && this.settings.scopeError) throw this.settings.scopeError;
        const rows = this.rows(text);
        return { rows: rows as Row[], rowCount: rows.length };
      },
      release: () => undefined
    };
  }

  operationQueries(): SqlCall[] {
    return this.calls.filter((call) => /\/\* spatial\.[a-z-]+ \*\//u.test(call.text));
  }

  private rows(text: string): Record<string, unknown>[] {
    if (text.includes("postgis_lib_version()")) return [{ postgis_version: "3.6.4" }];
    if (text.includes("/* gowm_spatial_v1 snapshot */")) {
      return [{
        dataset_reference_key: DATASET_REFERENCE,
        current_world_version: "7",
        catalog_snapshot_version: `sha256:${"e".repeat(64)}`,
        snapshot_consistency: "CONSISTENT_AT_START",
        captured_at: "2026-08-23T00:00:00.000Z"
      }];
    }
    const candidateCount = this.settings.candidateCount ?? (this.settings.objectPageRows ?? 1);
    if (text.includes("/* spatial.count-in-area */")) {
      return [{
        result_count: 1,
        candidate_count: candidateCount,
        source_references: [WORLD_REFERENCE],
        evidence_rows: [{ referenceKey: WORLD_REFERENCE, worldVersion: 7, observedAt: "2026-08-22T23:59:58.000Z" }]
      }];
    }
    if (text.includes("/* spatial.summarize-area */")) {
      return [{
        total: 1,
        candidate_count: candidateCount,
        groups: [{ key: "vehicle", count: 1 }],
        source_references: [WORLD_REFERENCE],
        evidence_rows: [{ referenceKey: WORLD_REFERENCE, worldVersion: 7, observedAt: "2026-08-22T23:59:58.000Z" }]
      }];
    }
    if (text.includes("/* spatial.join */")) {
      return [{
        left_reference_key: WORLD_REFERENCE,
        right_reference_key: WORLD_REFERENCE_2,
        distance_m: null,
        rank: null,
        candidate_count: candidateCount
      }];
    }
    if (text.includes("/* spatial.aggregate */")) {
      return [{
        area_reference_key: LAYER_REFERENCE,
        object_reference_key: WORLD_REFERENCE,
        object_type: "vehicle",
        subtype: "test",
        status: "ACTIVE",
        source: "fixture",
        properties: { battery: 81 },
        world_version: 7,
        observed_at: "2026-08-22T23:59:58.000Z",
        candidate_count: candidateCount
      }];
    }
    if (/\/\* spatial\.[a-z-]+ \*\//u.test(text)) {
      const count = this.settings.objectPageRows ?? 1;
      return Array.from({ length: count }, (_, index) => objectRow(
        index === 0 ? WORLD_REFERENCE : WORLD_REFERENCE_2,
        candidateCount,
        text.includes("find-containing-area") || text.includes("find-intersections") && this.settings.layerFeatureIntersections
          ? LAYER_REFERENCE
          : undefined
      ));
    }
    return [];
  }
}

function objectRow(
  worldReference: ReturnType<typeof reference>,
  candidateCount: number,
  layerReference?: ReturnType<typeof reference>
): Record<string, unknown> {
  const selected = layerReference ?? worldReference;
  return {
    reference_key: selected,
    object_type: layerReference ? "road" : "vehicle",
    subtype: "test",
    status: "ACTIVE",
    source: layerReference ? null : "fixture",
    properties: { label: "safe-public-property" },
    observed_at: layerReference ? null : "2026-08-22T23:59:58.000Z",
    received_at: layerReference ? null : "2026-08-22T23:59:59.000Z",
    updated_at: "2026-08-23T00:00:00.000Z",
    world_version: Number(selected.version),
    confidence: layerReference ? null : 0.91,
    freshness_ms: 2_000,
    source_observation_id: layerReference ? null : "observation:test",
    provenance_summary: { evidenceKind: "OBSERVED" },
    distance_m: layerReference ? null : 12.5,
    geometry: layerReference ? { type: "Point", coordinates: [116.4, 39.9] } : null,
    candidate_count: candidateCount
  };
}

function options(pool: SpatialSqlPool, overrides: Partial<SpatialProviderBridgeOptions> = {}): SpatialProviderBridgeOptions {
  return {
    pool,
    cursorSecret: CURSOR_SECRET,
    postgisVersion: "3.6.4",
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 1_000,
    maximumRows: 10_000,
    maximumCandidates: 50_000,
    maximumEvidenceReferences: 1_000,
    now: () => new Date("2026-08-23T00:00:00.000Z"),
    receiptId: () => "receipt-spatial-test",
    ...overrides
  };
}

function validInput(operationId: SpatialOperationId): Record<string, unknown> {
  switch (operationId) {
    case "spatial.find-nearby": return { location: { longitude: 116.4, latitude: 39.9 }, radiusM: 1_000, limit: 10 };
    case "spatial.find-nearest": return { location: { longitude: 116.4, latitude: 39.9 }, maxDistanceM: 10_000, limit: 10 };
    case "spatial.find-in-area": return { geometry: AREA, candidateReferences: [WORLD_REFERENCE], limit: 10 };
    case "spatial.find-intersections": return { geometry: { type: "Point", coordinates: [116.4, 39.9] }, candidateReferences: [WORLD_REFERENCE], limit: 10 };
    case "spatial.find-near-route": return { route: { type: "LineString", coordinates: [[116.3, 39.8], [116.5, 40]] }, distanceM: 100, limit: 10 };
    case "spatial.find-containing-area": return { geometry: { type: "Point", coordinates: [116.4, 39.9] }, layerKeys: ["administrative-area"], limit: 10 };
    case "spatial.count-in-area": return { geometry: AREA, objectTypes: ["vehicle"] };
    case "spatial.summarize-area": return { geometry: AREA, groupBy: "objectType", objectTypes: ["vehicle"] };
    case "spatial.join": return { relation: "intersects", leftObjectTypes: ["vehicle"], rightObjectTypes: ["incident"], resultLimit: 10 };
    case "spatial.aggregate": return { relation: "covers", areaLayerKeys: ["administrative-area"], objectTypes: ["vehicle"], metrics: [{ name: "objectCount", op: "count" }] };
  }
}

function providerRequest(
  descriptor: { operationId: string; operationVersion: string; inputSchemaHash: string; outputSchemaHash: string },
  input: unknown,
  requestId = "request-spatial-conformance",
  idempotencyKey = "idempotency-spatial-conformance",
  dataScopeClaim = "scope-a"
): ProviderExecutionRequest {
  const issuedAt = new Date(Date.now() - 60_000);
  const authenticatedAt = new Date(issuedAt.getTime() - 60_000);
  const expiresAt = new Date(Date.now() + 10 * 60_000);
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
      dataScopeClaim,
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
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      maximumInputBytes: 16 * 1024 * 1024,
      maximumResultBytes: 16 * 1024 * 1024,
      maximumRows: 10_000,
      maximumCandidates: 50_000,
      maximumVertices: 100_000,
      maximumCostClass: "HIGH"
    }
  };
}

function descriptorFor<T extends { operationId: string }>(descriptors: readonly T[], operationId: string): T {
  const descriptor = descriptors.find((candidate) => candidate.operationId === operationId);
  if (!descriptor) throw new Error(`missing descriptor ${operationId}`);
  return descriptor;
}

function reference(kind: string, id: string, version: string) {
  return { namespace: "gowm", kind, id, version };
}
