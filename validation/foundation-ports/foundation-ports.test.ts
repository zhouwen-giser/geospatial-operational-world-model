import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { Geometry } from "../../packages/world-model-core/src/types.js";
import {
  canonicalSha256,
  getContractSchemaHash,
  validateContract
} from "../../packages/platform/contract-runtime/src/index.js";
import {
  FoundationPortError,
  FoundationReceiptFactory,
  canonicalJson,
  sha256,
  type Clock,
  type IdFactory,
  type LocalSqlExecutor,
  type SqlQueryResult
} from "../../packages/platform/foundation-ports/src/index.js";
import {
  Canonical4326CrsNormalizationAdapter,
  ExistingGeometryValidationAdapter,
  FOUNDATION_OPERATION_SCHEMAS,
  H3PgLocalAdapter,
  H3_PG_INDEX_POINTS_SQL,
  H3_PG_PROJECT_POINT_SQL
} from "../../packages/integrations/foundation-local/src/index.js";
import { ProjectionProcessor } from "../../packages/runtime/src/projection.js";

const FIXED_TIME = "2026-08-23T00:00:00.000Z";
const ENGINE_DIGEST = `sha256:${"a".repeat(64)}` as `sha256:${string}`;

class FixedClock implements Clock {
  now(): Date {
    return new Date(FIXED_TIME);
  }
}

class SequenceIds implements IdFactory {
  private value = 0;

  nextId(): string {
    this.value += 1;
    return `test-${this.value}`;
  }
}

class FakeSql implements LocalSqlExecutor {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(private readonly responder: (text: string, values: readonly unknown[]) => unknown[]) {}

  async query<Row>(text: string, values: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    return { rows: this.responder(text, values) as Row[] };
  }
}

function receiptFactory(): FoundationReceiptFactory {
  return new FoundationReceiptFactory(new FixedClock(), new SequenceIds());
}

// Compile-time proof that a transaction-local pg client satisfies the port.
function asLocalSqlExecutor(client: pg.PoolClient): LocalSqlExecutor {
  return client;
}

void asLocalSqlExecutor;

function validPolygon(): Geometry {
  return {
    type: "Polygon",
    coordinates: [[[116.39, 39.89], [116.41, 39.89], [116.41, 39.91], [116.39, 39.89]]]
  };
}

describe("Foundation processing receipts", () => {
  it("canonicalizes object keys and emits stable sha256 hashes", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
    expect(sha256({ a: 1, b: 2 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );
  });

  it("rejects values that cannot be hashed without ambiguity", () => {
    expect(() => sha256({ value: undefined })).toThrowError(FoundationPortError);
    expect(() => sha256({ value: Number.NaN })).toThrowError(FoundationPortError);
    expect(() => sha256({ value: new Date(FIXED_TIME) })).toThrowError(FoundationPortError);
  });

  it("fails closed on a well-formed but incorrect operation schema hash", () => {
    const factory = receiptFactory();
    expect(() => factory.complete({
      startedAt: factory.start(),
      operationId: "geometry.validate",
      operationVersion: "1.0",
      schemas: {
        inputSchemaHash: `sha256:${"b".repeat(64)}`,
        outputSchemaHash: FOUNDATION_OPERATION_SCHEMAS.geometryValidate.outputSchemaHash
      },
      engine: { name: "gowm.spatial-engine", version: "0.1.0" },
      method: { methodId: "validateGeometry", methodVersion: "1.0.0" },
      policyVersion: "gowm.geometry-validation/1.0",
      policy: { repairMode: "REJECT" },
      input: { geometry: validPolygon() },
      result: { valid: true, issues: [], repairApplied: false, policyVersion: "gowm.geometry-validation/1.0" },
      changes: { repairApplied: false, typeChanged: false }
    })).toThrowError(expect.objectContaining({
      code: "FOUNDATION_SCHEMA_HASH_MISMATCH",
      stage: "SNAPSHOT",
      retryable: false
    }));
  });

  it("accepts the default UUID receipt identifier under the canonical pattern", () => {
    const factory = new FoundationReceiptFactory(new FixedClock());
    const execution = factory.complete({
      startedAt: factory.start(),
      operationId: "geometry.validate",
      operationVersion: "1.0",
      schemas: FOUNDATION_OPERATION_SCHEMAS.geometryValidate,
      engine: { name: "gowm.spatial-engine", version: "0.1.0" },
      method: { methodId: "validateGeometry", methodVersion: "1.0.0" },
      policyVersion: "gowm.geometry-validation/1.0",
      policy: { repairMode: "REJECT" },
      input: { geometry: validPolygon() },
      result: { valid: true, issues: [], repairApplied: false, policyVersion: "gowm.geometry-validation/1.0" },
      changes: { repairApplied: false, typeChanged: false }
    });

    expect(execution.receipt.receiptId).toMatch(
      /^foundation:geometry\.validate:1\.0:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(validateContract("ExecutionReceipt", execution.receipt).valid).toBe(true);
  });
});

describe("GeometryValidationPort", () => {
  it("wraps the existing validator and records compute-only provenance", async () => {
    const adapter = new ExistingGeometryValidationAdapter(receiptFactory());
    const execution = await adapter.assertValid(validPolygon());

    expect(execution.result).toEqual({
      valid: true,
      issues: [],
      repairApplied: false,
      policyVersion: "gowm.geometry-validation/1.0"
    });
    expect(execution.receipt).toMatchObject({
      receiptId: "foundation:geometry.validate:1.0:test-1",
      operationId: "geometry.validate",
      operationVersion: "1.0",
      providerId: "gowm.foundation-local",
      providerVersion: "0.2.0",
      generatedAt: FIXED_TIME,
      durationMs: 0,
      method: {
        engine: "gowm.spatial-engine",
        engineVersion: "0.1.0",
        methodId: "validateGeometry",
        methodVersion: "1.0.0"
      },
      changes: {
        repairApplied: false,
        typeChanged: false,
        inputGeometryType: "Polygon",
        outputGeometryType: "Polygon"
      },
      warnings: []
    });
    expect(execution.executionContext).toEqual({
        executionBinding: "EMBEDDED_LOCAL",
        criticalPathPolicy: "LOCAL_ONLY",
        remoteDependency: false,
        evidenceSemantics: "COMPUTE_ONLY_NOT_WORLD_EVIDENCE"
    });
    expect(execution.computeSnapshot.schemas).toEqual({
      inputSchemaHash: getContractSchemaHash("urn:gowm:capability:geometry.validate:input:1.0"),
      outputSchemaHash: getContractSchemaHash("urn:gowm:capability:geometry.validate:output:1.0")
    });
    expect(execution.receipt.computeSnapshotHash).toBe(canonicalSha256(execution.computeSnapshot));
    expect(validateContract("ExecutionReceipt", execution.receipt).valid).toBe(true);
    expect(validateContract("ComputeSnapshotContext", execution.computeSnapshot).valid).toBe(true);
    expect(execution.receipt.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(execution.receipt.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects invalid geometry before projection and never repairs it", async () => {
    const adapter = new ExistingGeometryValidationAdapter(receiptFactory());
    const invalid: Geometry = {
      type: "Polygon",
      coordinates: [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]]
    };
    const before = structuredClone(invalid);

    const validation = await adapter.validate(invalid);
    expect(validation.result.valid).toBe(false);
    expect(validation.result.issues).toContain("Polygon ring self-intersects");
    expect(validation.result.repairApplied).toBe(false);
    expect(invalid).toEqual(before);

    await expect(adapter.assertValid(invalid)).rejects.toMatchObject({
      code: "FOUNDATION_GEOMETRY_INVALID",
      retryable: false,
      stage: "REQUEST_VALIDATION",
      receipt: { operationId: "geometry.validate" },
      details: { repairApplied: false, fallbackApplied: false }
    });
    expect(invalid).toEqual(before);
  });

  it("fails closed if an unversioned repair mode is forced at runtime", () => {
    expect(() => new ExistingGeometryValidationAdapter(
      receiptFactory(),
      { policyVersion: "unsafe", repairMode: "MAKE_VALID" } as never
    )).toThrowError(expect.objectContaining({
      code: "FOUNDATION_REPAIR_POLICY_DENIED",
      stage: "POLICY",
      retryable: false
    }));
  });
});

describe("CrsNormalizationPort", () => {
  it("keeps the canonical 4326 ingest path local and records an identity receipt", async () => {
    const receipts = receiptFactory();
    const geometry = new ExistingGeometryValidationAdapter(receipts);
    const adapter = new Canonical4326CrsNormalizationAdapter(geometry, receipts);
    const input: Geometry = { type: "Point", coordinates: [116.4, 39.9, 30] };

    const execution = await adapter.normalizeGeometry({ sourceCrs: "EPSG:4326", geometry: input });

    expect(execution.result).toMatchObject({
      geometry: input,
      sourceCrs: "EPSG:4326",
      targetCrs: "EPSG:4326",
      axisOrder: ["longitude", "latitude"],
      coordinateCount: 1,
      zTransformed: false,
      normalizationMethod: "CANONICAL_IDENTITY",
      transformation: {
        engine: "GOWM",
        engineVersion: "0.2.0",
        integration: "foundation-local",
        integrationVersion: "0.2.0",
        sourceCrs: "EPSG:4326",
        targetCrs: "EPSG:4326",
        strictBestOperation: true,
        networkEnabled: false,
        cacheHit: false
      }
    });
    expect(execution.result.geometry).not.toBe(input);
    expect(execution.receipt).toMatchObject({
      receiptId: "foundation:crs.normalize.geometry:1.0:test-2",
      operationId: "crs.normalize.geometry",
      providerId: "gowm.foundation-local",
      providerVersion: "0.2.0",
      method: {
        engine: "gowm.canonical-geometry-identity",
        methodId: "canonical-epsg4326-identity"
      }
    });
    expect(execution.computeSnapshot.schemas).toEqual({
      inputSchemaHash: getContractSchemaHash("urn:gowm:capability:crs.normalize.geometry:input:1.0"),
      outputSchemaHash: getContractSchemaHash("urn:gowm:capability:crs.normalize.geometry:output:1.0")
    });
    expect(execution.supportingReceipts).toHaveLength(1);
    expect(execution.supportingReceipts[0]?.receipt.operationId).toBe("geometry.validate");
  });

  it("does not silently fall back when a coordinate transformation is required", async () => {
    const adapter = new Canonical4326CrsNormalizationAdapter(
      new ExistingGeometryValidationAdapter(receiptFactory()),
      receiptFactory()
    );

    await expect(adapter.normalizeGeometry({
      sourceCrs: "EPSG:3857",
      geometry: { type: "Point", coordinates: [12_958_075, 4_857_942] }
    })).rejects.toMatchObject({
      code: "FOUNDATION_CRS_TRANSFORMATION_UNAVAILABLE",
      retryable: false,
      stage: "POLICY",
      details: {
        sourceCrs: "EPSG:3857",
        fallbackApplied: false,
        licenseStatus: "UNSPECIFIED",
        redistributionAllowed: false
      }
    });
  });
});

describe("H3LocalAdapter", () => {
  it("executes h3.index.points@1.0 through static parameterized h3-pg SQL", async () => {
    const sql = new FakeSql((text, values) => {
      expect(text).toBe(H3_PG_INDEX_POINTS_SQL);
      expect(values).toEqual([[139.7671], [35.6812], 9]);
      return [{ ordinal: "0", index: "892f5a32d97ffff", engine_resolution: "9" }];
    });
    const adapter = new H3PgLocalAdapter(sql, {
      h3PgVersion: "4.5.0",
      engineDigest: ENGINE_DIGEST,
      receipts: receiptFactory()
    });

    const execution = await adapter.indexPoints({
      points: [{ longitude: 139.7671, latitude: 35.6812 }],
      resolution: 9
    });

    expect(execution.result).toEqual([{ index: "892f5a32d97ffff", resolution: 9 }]);
    expect(execution.receipt).toMatchObject({
      operationId: "h3.index.points",
      operationVersion: "1.0",
      providerId: "gowm.foundation-local",
      providerVersion: "0.2.0",
      method: {
        engine: "h3-pg",
        engineVersion: "4.5.0",
        methodId: "h3_latlng_to_cell",
        methodVersion: "1.0.0"
      }
    });
    expect(execution.computeSnapshot).toMatchObject({
      engine: { name: "h3-pg", version: "4.5.0", digest: ENGINE_DIGEST },
      operation: { operationId: "h3.index.points", operationVersion: "1.0" },
      schemas: {
        inputSchemaHash: getContractSchemaHash("urn:gowm:capability:h3.index.points:input:1.0"),
        outputSchemaHash: getContractSchemaHash("urn:gowm:capability:h3.index.points:output:1.0")
      },
      artifacts: [{ kind: "DATABASE", name: "h3-pg", version: "4.5.0", digest: ENGINE_DIGEST }]
    });
    expect(execution.executionContext.remoteDependency).toBe(false);
    expect(execution.receipt.computeSnapshotHash).toBe(canonicalSha256(execution.computeSnapshot));
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0]?.text).toContain("$1::double precision[]");
    expect(sql.calls[0]?.text).not.toContain("139.7671");
  });

  it("projects the Foundation R7-R10 set locally and marks it candidate-only", async () => {
    const cells = new Map<number, string>([
      [7, "8731aa428ffffff"],
      [8, "8831aa4287fffff"],
      [9, "8931aa42867ffff"],
      [10, "8a31aa428657fff"]
    ]);
    const sql = new FakeSql((text, values) => {
      expect(text).toBe(H3_PG_PROJECT_POINT_SQL);
      expect(values).toEqual([116.4, 39.9, [7, 8, 9, 10]]);
      return (values[2] as number[]).map((resolution, ordinal) => ({
        ordinal,
        resolution,
        index: cells.get(resolution),
        engine_resolution: resolution
      }));
    });
    const adapter = new H3PgLocalAdapter(sql, { h3PgVersion: "4.5.0", receipts: receiptFactory() });

    const execution = await adapter.projectPoint({ point: { longitude: 116.4, latitude: 39.9 } });

    expect(execution.result).toEqual({
      cells: {
        "7": "8731aa428ffffff",
        "8": "8831aa4287fffff",
        "9": "8931aa42867ffff",
        "10": "8a31aa428657fff"
      },
      candidateOnly: true,
      exactSpatialAuthority: "POSTGIS"
    });
    expect(execution.receipt.operationId).toBe("gowm.foundation.h3.project-point");
    expect(sql.calls).toHaveLength(1);
  });

  it("validates inputs and engine output without fallback", async () => {
    const sql = new FakeSql(() => [
      { ordinal: 0, index: "892f5a32d97ffff", engine_resolution: 8 }
    ]);
    const adapter = new H3PgLocalAdapter(sql, { h3PgVersion: "4.5.0", receipts: receiptFactory() });

    await expect(adapter.indexPoints({
      points: [{ longitude: 139.7671, latitude: 35.6812 }],
      resolution: 9
    })).rejects.toMatchObject({
      code: "FOUNDATION_INVALID_ENGINE_RESULT",
      retryable: false,
      details: { fallbackApplied: false }
    });
    await expect(adapter.indexPoints({
      points: [{ longitude: 181, latitude: 0 }],
      resolution: 9
    })).rejects.toMatchObject({ code: "FOUNDATION_H3_INVALID_COORDINATE" });
    await expect(adapter.projectPoint({
      point: { longitude: 0, latitude: 0 },
      resolutions: [9, 9]
    })).rejects.toMatchObject({ code: "FOUNDATION_H3_INVALID_RESOLUTION" });
  });

  it("returns a typed retryable error for local database failure", async () => {
    const sql: LocalSqlExecutor = {
      async query<Row>(): Promise<SqlQueryResult<Row>> {
        throw new Error("database unavailable");
      }
    };
    const adapter = new H3PgLocalAdapter(sql, { h3PgVersion: "4.5.0", receipts: receiptFactory() });

    await expect(adapter.indexPoints({
      points: [{ longitude: 0, latitude: 0 }],
      resolution: "STREET"
    })).rejects.toMatchObject({
      code: "FOUNDATION_LOCAL_ENGINE_FAILURE",
      stage: "PROVIDER_EXECUTION",
      retryable: true,
      details: { operationId: "h3.index.points" }
    });
  });
});

describe("Foundation critical-path isolation", () => {
  it("contains no remote transport or Gateway client in production adapter source", async () => {
    const sources = await Promise.all([
      "crs-normalization-adapter.ts",
      "geometry-validation-adapter.ts",
      "h3-pg-local-adapter.ts"
    ].map((name) => readFile(
      resolve(process.cwd(), "packages", "integrations", "foundation-local", "src", name),
      "utf8"
    )));
    const productionSource = sources.join("\n");

    expect(productionSource).not.toMatch(/https?:\/\//i);
    expect(productionSource).not.toMatch(/\bfetch\s*\(/i);
    expect(productionSource).not.toMatch(/\baxios\b/i);
    expect(productionSource).not.toMatch(/gateway[-_ ]client/i);
    expect(productionSource).not.toMatch(/provider[-_ ]client/i);
  });

  it("wires CRS, Geometry, H3, and atomic receipts into the production projection transaction", async () => {
    const source = await readFile(
      resolve(process.cwd(), "packages", "runtime", "src", "projection.ts"),
      "utf8"
    );

    expect(source).toContain("Canonical4326CrsNormalizationAdapter");
    expect(source).toContain("normalizeGeometry({");
    expect(source).toContain('sourceCrs: "EPSG:4326"');
    expect(source).toContain("projectPoint({");
    expect(source).toContain('"GEOMETRY_VALIDATION"');
    expect(source).toContain('"CRS_NORMALIZATION"');
    expect(source).toContain('"H3_INDEXING"');
    expect(source).toContain("INSERT INTO foundation_processing_receipt");
    expect(source).not.toContain("h3_latlng_to_cell(");
  });

  it("rejects invalid geometry before the production projection mutates current state", async () => {
    const queries: string[] = [];
    let released = false;
    const client = {
      async query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> {
        queries.push(text);
        if (text.includes("FROM world_observation o")) {
          return {
            rows: [{
              observation_id: "obs-invalid-geometry",
              observer_type: "Sensor",
              observer_id: "sensor-1",
              subject_type: "Vehicle",
              subject_id: "vehicle-1",
              observation_type: "POSITION",
              geometry_json: {
                type: "Polygon",
                coordinates: [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]]
              },
              value: {},
              confidence: 1,
              observed_at: FIXED_TIME,
              received_at: FIXED_TIME,
              source: "test",
              correlation_id: "correlation-1",
              metadata: {},
              schema_version: "1.2",
              data_scope_key: "scope-1",
              projected_at: null,
              entity_binding_status: null
            }]
          };
        }
        return { rows: [] };
      },
      release(): void {
        released = true;
      }
    };
    const pool = {
      async connect() {
        return client;
      }
    } as unknown as pg.Pool;
    const processor = new ProjectionProcessor(pool, () => {
      throw new Error("H3 must not execute for invalid geometry");
    });

    await expect(processor.process("obs-invalid-geometry")).rejects.toMatchObject({
      code: "FOUNDATION_GEOMETRY_INVALID",
      stage: "REQUEST_VALIDATION",
      retryable: false
    });
    expect(queries).toHaveLength(3);
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toContain("FROM world_observation o");
    expect(queries[2]).toBe("ROLLBACK");
    expect(queries.join("\n")).not.toContain("INSERT INTO world_object");
    expect(queries.join("\n")).not.toContain("world_object_state");
    expect(released).toBe(true);
  });

  it("continues canonical geometry processing while every remote request fails", async () => {
    const originalFetch = globalThis.fetch;
    let remoteAttempts = 0;
    globalThis.fetch = async () => {
      remoteAttempts += 1;
      throw new Error("simulated remote outage");
    };
    try {
      const receipts = receiptFactory();
      const geometry = new ExistingGeometryValidationAdapter(receipts);
      const crs = new Canonical4326CrsNormalizationAdapter(geometry, receipts);
      const execution = await crs.normalizeGeometry({
        sourceCrs: "EPSG:4326",
        geometry: { type: "Point", coordinates: [116.4, 39.9] }
      });

      expect(execution.result.normalizationMethod).toBe("CANONICAL_IDENTITY");
      expect(remoteAttempts).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
