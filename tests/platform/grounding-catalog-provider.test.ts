import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getContractSchemaHash } from "../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError } from "../../packages/platform/provider-sdk/src/index.js";
import { catalogScopeDigest, decodeCatalogCursor, encodeCatalogCursor } from "../../services/providers/grounding-catalog-provider/src/cursor.js";
import { decodeEvidenceCursor, encodeEvidenceCursor } from "../../services/providers/grounding-catalog-provider/src/evidence-cursor.js";
import { createGroundingCatalogProvider } from "../../services/providers/grounding-catalog-provider/src/provider.js";
import type { CatalogSqlPool } from "../../services/providers/grounding-catalog-provider/src/types.js";
import { loadControlledProviderDeployments } from "../../services/gateway/world-capability-gateway/src/config.js";

const pool: CatalogSqlPool = {
  async connect() {
    throw new Error("manifest tests do not connect");
  }
};
const cursorSecret = "GowmCatalogCursorSecret_2026_Alpha_Bravo";

describe("grounding catalog providers", () => {
  it("registers the frozen Reference operation set with canonical hashes", () => {
    const provider = createGroundingCatalogProvider({ mode: "reference", pool, cursorSecret });
    expect(provider.runtime.manifest.provider.providerId).toBe("gowm.reference-catalog");
    expect(provider.runtime.manifest.capabilities.map((capability) => capability.operationId)).toEqual([
      "reference.get", "reference.resolve", "reference.validate", "reference.batch-get", "reference.search"
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
      "dataset.get", "dataset.list", "layer.get", "layer.list", "layer.find-features", "feature.get"
    ]);
    for (const capability of provider.runtime.manifest.capabilities) {
      expect(capability.scopePolicy).toBe("DATASET_SCOPE_REQUIRED");
      expect(capability.dataBinding).toBe("DATASET_VERSION_BOUND");
      expect(capability.snapshotPolicy.dataSnapshot).toBe("REQUIRED");
    }
  });

  it("registers the frozen World Evidence and Result Registry operations as data-scoped", () => {
    const provider = createGroundingCatalogProvider({ mode: "evidence", pool, cursorSecret });
    expect(provider.runtime.manifest.provider.providerId).toBe("gowm.world-evidence");
    expect(provider.runtime.manifest.capabilities.map((capability) => capability.operationId)).toEqual([
      "world.get-current-state", "world.get-geometry", "world.get-provenance",
      "world.get-observations", "world.get-event-timeline", "world.get-state-history",
      "result.get", "result.validate", "reference-set.get-members"
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

  it("loads the controlled Grounding Gateway registry with frozen full manifests", async () => {
    const deployments = await loadControlledProviderDeployments(resolve("config/grounding-gateway-registry.json"));
    expect(deployments.map((deployment) => deployment.providerId)).toEqual([
      "gowm.reference-catalog", "gowm.dataset-catalog", "gowm.world-evidence"
    ]);
    expect(deployments.flatMap((deployment) => deployment.approvedManifest.capabilities)).toHaveLength(20);
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
