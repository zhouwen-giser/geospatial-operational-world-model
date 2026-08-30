import { describe, expect, it } from "vitest";
import {
  snapshotResourceIdFromArtifact,
  snapshotResourceIdFromDataset,
  snapshotResourceIdFromReferenceKey,
  snapshotResourceIdentity,
  validateContract
} from "../../packages/platform/contract-runtime/src/index.js";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";

describe("v0.7.1 snapshot resource identity", () => {
  it("admits the maximum legal ReferenceKey and validates the resulting manifest", () => {
    const resourceId = snapshotResourceIdFromReferenceKey({
      namespace: `a${"n".repeat(63)}`,
      id: "i".repeat(256)
    });
    const content = {
      querySnapshotId: "snapshot-maximum-reference-key",
      mode: "PINNED",
      consistency: "PINNED",
      capturedAt: "2026-08-30T00:00:00.000Z",
      resources: [{ resourceKind: "REFERENCE", resourceId, version: "1", pinning: "PINNED" }]
    } as const;
    const manifest = { ...content, manifestHash: sha256(content) };

    expect(resourceId).toHaveLength(321);
    expect(validateContract("urn:gowm:v0.7.1:query-snapshot-manifest", manifest)).toMatchObject({ valid: true });
    expect(snapshotResourceIdentity(manifest.resources[0])).toBe(`REFERENCE\u0000${resourceId}`);
  });

  it("admits maximum legal dataset and artifact identifiers", () => {
    expect(snapshotResourceIdFromDataset("d".repeat(256))).toHaveLength(264);
    expect(snapshotResourceIdFromArtifact("a".repeat(256))).toHaveLength(265);
  });

  it("rejects an encoded identity beyond the v0.7.1 resource boundary", () => {
    expect(() => snapshotResourceIdFromReferenceKey({ namespace: "n".repeat(256), id: "i".repeat(256) }))
      .toThrow(/exceeds 512/u);
  });
});
