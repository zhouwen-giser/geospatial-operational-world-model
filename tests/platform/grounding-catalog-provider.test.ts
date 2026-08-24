import { describe, expect, it } from "vitest";
import { getContractSchemaHash } from "../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError } from "../../packages/platform/provider-sdk/src/index.js";
import { catalogScopeDigest, decodeCatalogCursor, encodeCatalogCursor } from "../../services/providers/grounding-catalog-provider/src/cursor.js";
import { createGroundingCatalogProvider } from "../../services/providers/grounding-catalog-provider/src/provider.js";
import type { CatalogSqlPool } from "../../services/providers/grounding-catalog-provider/src/types.js";

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
});
