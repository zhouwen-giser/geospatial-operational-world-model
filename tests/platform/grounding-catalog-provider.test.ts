import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getContractSchemaHash } from "../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { catalogScopeDigest, decodeCatalogCursor, encodeCatalogCursor } from "../../services/providers/grounding-catalog-provider/src/cursor.js";
import { decodeEvidenceCursor, encodeEvidenceCursor } from "../../services/providers/grounding-catalog-provider/src/evidence-cursor.js";
import { createGroundingCatalogProvider } from "../../services/providers/grounding-catalog-provider/src/provider.js";
import { GroundingCatalogRepository, projectedPosition } from "../../services/providers/grounding-catalog-provider/src/repository.js";
import type { CatalogSqlClient, CatalogSqlPool } from "../../services/providers/grounding-catalog-provider/src/types.js";
import { loadControlledProviderDeployments } from "../../services/gateway/world-capability-gateway/src/config.js";

const pool: CatalogSqlPool = {
  async connect() {
    throw new Error("manifest tests do not connect");
  }
};
const cursorSecret = "GowmCatalogCursorSecret_2026_Alpha_Bravo";

describe("grounding catalog providers", () => {
  it("packs only authoritative projected coordinates for the typed Point port", () => {
    expect(projectedPosition({position:{longitude:121,latitude:31,altitude:12}})).toEqual({type:"Point",coordinates:[121,31,12]});
    for (const state of [{}, {position:{longitude:0}}, {position:{longitude:181,latitude:0}}, {position:{longitude:0,latitude:NaN}}]) {
      expect(projectedPosition(state)).toBeUndefined();
    }
    const manifest = createGroundingCatalogProvider({mode:"evidence",pool,cursorSecret}).runtime.manifest;
    expect(manifest.capabilities.find((c)=>c.operationId==="world.get-current-state")?.ports?.outputs.find((p)=>p.name==="position"))
      .toMatchObject({path:"/facts/0/position",valueKind:"GEOMETRY",schemaHash:getContractSchemaHash("urn:gowm:v0.6.2:geojson-point")});
  });
  it.each(["world.get-current-state", "world.get-geometry", "world.get-provenance"])("serializes and receipts %s with absent optional dates", async (operationId) => {
    const referenceKey = { namespace: "gowm", kind: "WORLD_OBJECT", id: `wrf_${"1".repeat(32)}`, version: "1" };
    const client: CatalogSqlClient = {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string) {
        let rows: Record<string, unknown>[] = [];
        if (text.includes("scope_resource")) rows = [{ reference_key_value: { ...referenceKey, kind: "DATA_SCOPE" } }];
        else if (text.includes("GREATEST")) rows = [{ world_version: "1" }];
        else if (text.startsWith("SELECT * FROM gowm_evidence_v1.")) rows = [{ reference_key_value: referenceKey, world_version: "1", state: {}, object_type: "AREA", confidence: 1, freshness_ms: null, geometry: { type: "Point", coordinates: [0, 0] }, geometry_type: "POINT", bbox: [0, 0, 0, 0], crs: "EPSG:4326", observed_at: null, received_at: null }];
        return { rows: rows as Row[], rowCount: rows.length };
      }, release() {}
    };
    const provider = createGroundingCatalogProvider({ mode: "evidence", pool: { async connect() { return client; } }, cursorSecret });
    const descriptor = provider.runtime.manifest.capabilities.find((c) => c.operationId === operationId)!;
    const now = new Date().toISOString(), deadlineAt = new Date(Date.now() + 10_000).toISOString();
    const output = await provider.runtime.execute({
      providerProtocolVersion: "1.0", requestId: "world-optional-fields", gatewayRequestId: "world-optional-fields", idempotencyKey: operationId,
      operation: { operationId, operationVersion: "1.0", inputSchemaHash: descriptor.inputSchemaHash, outputSchemaHash: descriptor.outputSchemaHash }, input: { schemaVersion: "1.0", referenceKey },
      securityContext: { principalRef: "test", authenticationMethod: "UNIT", authenticatedAt: now, dataScopeClaim: "scope", scopeAttestation: { issuer: "test", issuedAt: now, expiresAt: deadlineAt, claimDigest: sha256({ scope: "scope" }) } },
      gatewayContext: { gatewayId: "test", registryVersion: "1", policyVersion: "1" }, executionPolicy: { deadlineAt, maximumInputBytes: 1_048_576, maximumResultBytes: 1_048_576, maximumCostClass: "MEDIUM" }
    });
    expect(output.status).toBe("COMPLETED");
    expect(output.receipts[0]?.outputHash).toBe(sha256(output.output?.value));
    expect(output.output?.value).toEqual(JSON.parse(JSON.stringify(output.output?.value)));
  });

  it("registers Reference read operations with canonical hashes and delegates validation to the platform", () => {
    const provider = createGroundingCatalogProvider({ mode: "reference", pool, cursorSecret });
    expect(provider.runtime.manifest.provider.providerId).toBe("gowm.reference-catalog");
    expect(provider.runtime.manifest.capabilities.map((capability) => capability.operationId)).toEqual([
      "reference.get", "reference.resolve", "reference.batch-get", "reference.search"
    ]);
    for (const capability of provider.runtime.manifest.capabilities) {
      expect(capability.scopePolicy).toBe("DATA_SCOPE_REQUIRED");
      expect(capability.dataBinding).toBe("WORLD_SNAPSHOT_BOUND");
      expect(capability.inputSchemaHash).toBe(getContractSchemaHash(capability.inputSchemaUri));
      expect(capability.outputSchemaHash).toBe(getContractSchemaHash(capability.outputSchemaUri));
    }
    expect(provider.runtime.manifest.capabilities.find((capability) => capability.operationId === "reference.resolve")?.ports.outputs).toContainEqual({
      name: "candidateReferenceKey",
      path: "/resolutions/0/candidates/0/candidate/referenceKey",
      schemaUri: "urn:gowm:v0.4:reference-key",
      schemaHash: getContractSchemaHash("urn:gowm:v0.4:reference-key"),
      valueKind: "REFERENCE_KEY",
      unitSemantics: "UNSPECIFIED"
    });
  });

  it("registers Dataset/Layer/Feature operations as dataset-scoped", () => {
    const provider = createGroundingCatalogProvider({ mode: "dataset", pool, cursorSecret });
    expect(provider.runtime.manifest.provider.providerId).toBe("gowm.dataset-catalog");
    expect(provider.runtime.manifest.capabilities.map((capability) => capability.operationId)).toEqual([
      "dataset.get", "dataset.list", "layer.get", "layer.list", "layer.find-features", "feature.get",
      "catalog.get", "catalog.search", "catalog.list-versions", "catalog.describe-schema",
      "catalog.get-lineage", "catalog.get-quality", "catalog.get-capabilities"
    ]);
    for (const capability of provider.runtime.manifest.capabilities) {
      expect(capability.scopePolicy).toBe("DATASET_SCOPE_REQUIRED");
      expect(capability.dataBinding).toBe("DATASET_VERSION_BOUND");
      expect(capability.snapshotPolicy.dataSnapshot).toBe("REQUIRED");
    }
  });

  it("dispatches catalog operations to the Data Product projection", async () => {
    const referenceKey = {
      namespace: "gowm",
      kind: "DATASET",
      id: "wrf_60000000000000000000000000000001",
      version: "dataset-v1"
    };
    const dataset = {
      reference_key: referenceKey.id,
      reference_key_value: referenceKey,
      name: "Road network",
      version: referenceKey.version,
      dataset_kind: "NETWORK",
      schema_version: "1.0",
      crs: "EPSG:4326",
      valid_from: null,
      valid_to: null,
      quality: { validationStatus: "VALIDATED" },
      lineage: ["urn:test:network-source"],
      content_hash: `sha256:${"a".repeat(64)}`,
      published_at: "2026-08-25T00:00:00.000Z",
      retired_at: null,
      spatial_extent: null
    };
    const client: CatalogSqlClient = {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string) {
        let rows: Record<string, unknown>[] = [];
        if (text.includes("FROM gowm_catalog_v1.dataset ORDER BY")) rows = [dataset];
        else if (text.includes("FROM gowm_catalog_v1.scope_resource")) rows = [{ reference_key_value: referenceKey }];
        else if (text.includes("FROM gowm_catalog_v1.dataset dataset")) rows = [dataset];
        else if (text.includes("FROM gowm_catalog_v1.dataset_version")) rows = [{ ...dataset, published_at: new Date("2026-08-25T00:00:00.000Z") }];
        else if (text.includes("FROM gowm_catalog_v1.active_capability")) rows = [
          { operation_id: "coverage.road.plan", data_binding: "WORLD_SNAPSHOT_BOUND" },
          { operation_id: "world.get-current-state", data_binding: "WORLD_SNAPSHOT_BOUND" },
          { operation_id: "spatial.find-in-area", data_binding: "DATASET_VERSION_BOUND" }
        ];
        return { rows: rows as Row[], rowCount: rows.length };
      },
      release() {}
    };
    const catalogPool: CatalogSqlPool = {
      async connect() {
        return client;
      }
    };
    const repository = new GroundingCatalogRepository({ pool: catalogPool, cursorSecret });
    const execution = await repository.execute("catalog.search", {
      schemaVersion: "1.0",
      dataKinds: ["NETWORK"],
      limit: 10
    }, { dataScopeKey: "default", datasetScopeKey: "tenant-a" }, 5_000);
    expect(execution.output).toMatchObject({
      schemaVersion: "1.0",
      items: [{ referenceKey, dataKind: "NETWORK", currentVersion: "dataset-v1", supportedCapabilities: ["coverage.road.plan"] }]
    });
    const versions = await repository.execute("catalog.list-versions", { schemaVersion: "1.0", referenceKey }, { dataScopeKey: "default", datasetScopeKey: "tenant-a" }, 5_000);
    expect(versions.output).toMatchObject({ value: [{ version: "dataset-v1", published_at: "2026-08-25T00:00:00.000Z", retired_at: null }] });
    const bounded = new GroundingCatalogRepository({ pool: catalogPool, cursorSecret, maximumCandidates: 1 });
    const emptyPage = await bounded.execute("catalog.search", { schemaVersion: "1.0", requiredCapabilities: ["missing.operation"], limit: 1 }, { dataScopeKey: "default", datasetScopeKey: "tenant-a" }, 5_000);
    expect(emptyPage.output).toMatchObject({ items: [], truncated: true, nextCursor: expect.any(String) });
  });

  it("registers World Evidence and Result Registry read operations as data-scoped", () => {
    const provider = createGroundingCatalogProvider({ mode: "evidence", pool, cursorSecret });
    expect(provider.runtime.manifest.provider.providerId).toBe("gowm.world-evidence");
    expect(provider.runtime.manifest.capabilities.map((capability) => capability.operationId)).toEqual([
      "world.get-current-state", "world.get-geometry", "world.get-provenance",
      "world.get-observations", "world.get-event-timeline", "world.get-state-history",
      "result.get", "reference-set.get-members"
    ]);
    for (const capability of provider.runtime.manifest.capabilities) {
      expect(capability.scopePolicy).toBe("DATA_SCOPE_REQUIRED");
      expect(capability.dataBinding).toBe("WORLD_SNAPSHOT_BOUND");
      expect(capability.inputSchemaHash).toBe(getContractSchemaHash(capability.inputSchemaUri));
      expect(capability.outputSchemaHash).toBe(getContractSchemaHash(capability.outputSchemaUri));
    }
  });

  it("binds signed cursors to operation, scope, and snapshot", () => {
    const scopeDigest = catalogScopeDigest("default", "tenant-a");
    const cursor = encodeCatalogCursor({
      v: 1,
      operationId: "layer.find-features",
      scopeDigest,
      snapshotVersion: "sha256:fixture",
      after: "wrf_24000000000000000000000000000001"
    }, cursorSecret);
    expect(decodeCatalogCursor(cursor, {
      operationId: "layer.find-features",
      scopeDigest,
      snapshotVersion: "sha256:fixture"
    }, cursorSecret)?.after).toBe("wrf_24000000000000000000000000000001");
    expect(() => decodeCatalogCursor(cursor, {
      operationId: "layer.find-features",
      scopeDigest: catalogScopeDigest("default", "tenant-b"),
      snapshotVersion: "sha256:fixture"
    }, cursorSecret)).toThrow(ProviderProtocolError);
    expect(() => decodeCatalogCursor(`${cursor}x`, {
      operationId: "layer.find-features",
      scopeDigest,
      snapshotVersion: "sha256:fixture"
    }, cursorSecret)).toThrow(ProviderProtocolError);
  });

  it("binds evidence cursors to timeline kind, scope, and immutable snapshot", () => {
    const scopeDigest = catalogScopeDigest("default");
    const cursor = encodeEvidenceCursor({
      v: 1,
      operationId: "world.get-event-timeline",
      scopeDigest,
      snapshotVersion: "sha256:evidence-snapshot",
      time: "2026-08-24T09:00:00.000Z",
      tie: "64",
      id: "00000000-0000-0000-0000-000000000611"
    }, cursorSecret);
    expect(decodeEvidenceCursor(cursor, {
      operationId: "world.get-event-timeline",
      scopeDigest,
      snapshotVersion: "sha256:evidence-snapshot"
    }, cursorSecret)?.tie).toBe("64");
    expect(() => decodeEvidenceCursor(cursor, {
      operationId: "world.get-observations",
      scopeDigest,
      snapshotVersion: "sha256:evidence-snapshot"
    }, cursorSecret)).toThrow(ProviderProtocolError);
    expect(() => decodeEvidenceCursor(cursor, {
      operationId: "world.get-event-timeline",
      scopeDigest,
      snapshotVersion: "sha256:changed"
    }, cursorSecret)).toThrow(ProviderProtocolError);
  });

  it("loads the controlled Grounding Gateway registry with current full manifests", async () => {
    const deployments = await loadControlledProviderDeployments(resolve("config/grounding-gateway-registry.json"));
    expect(deployments.map((deployment) => deployment.providerId)).toEqual([
      "gowm.reference-catalog", "gowm.dataset-catalog", "gowm.world-evidence", "gowm.operational-reality", "gowm.platform-validation"
    ]);
    const capabilities = deployments.flatMap((deployment) => deployment.approvedManifest.capabilities);
    expect(capabilities).toHaveLength(37);
    expect(new Set(capabilities.map((capability) => `${capability.operationId}@${capability.operationVersion}`)).size).toBe(capabilities.length);
    expect(deployments.every((deployment) =>
      deployment.approvedManifest.provider.implementationDigest === deployment.implementationDigest
    )).toBe(true);
    const modes = ["reference", "dataset", "evidence"] as const;
    for (const [index, mode] of modes.entries()) {
      expect(deployments[index]?.approvedManifest).toEqual(
        createGroundingCatalogProvider({ mode, pool, cursorSecret }).runtime.manifest
      );
    }
  });
});
