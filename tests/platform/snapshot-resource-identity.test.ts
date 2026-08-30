import { describe, expect, it } from "vitest";
import {
  snapshotResourceIdFromArtifact,
  snapshotResourceIdFromDataset,
  snapshotResourceIdFromReferenceKey,
  snapshotResourceEvidenceIdentity,
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
    expect(snapshotResourceIdentity(manifest.resources[0])).toBe(JSON.stringify(["REFERENCE", resourceId]));
    expect(snapshotResourceEvidenceIdentity(manifest.resources[0])).toBe(JSON.stringify(["REFERENCE", resourceId]));
  });

  it("admits maximum legal dataset and artifact identifiers", () => {
    expect(snapshotResourceIdFromDataset("d".repeat(256))).toHaveLength(264);
    expect(snapshotResourceIdFromArtifact("a".repeat(256))).toHaveLength(265);
  });

  it("rejects source identifiers beyond their legal contract boundaries", () => {
    expect(() => snapshotResourceIdFromReferenceKey({ namespace: "n".repeat(256), id: "i".repeat(256) }))
      .toThrow(/namespace violates/u);
    expect(() => snapshotResourceIdFromDataset("d".repeat(257)))
      .toThrow(/between 1 and 256/u);
    expect(() => snapshotResourceIdFromArtifact("a".repeat(257)))
      .toThrow(/between 1 and 256/u);
  });

  it("counts Unicode code points at the legal ReferenceKey boundary", () => {
    const astralId = "😀".repeat(256);
    const resourceId = snapshotResourceIdFromReferenceKey({ namespace: "a" + "n".repeat(63), id: astralId });

    expect([...resourceId]).toHaveLength(321);
    expect(() => snapshotResourceIdFromReferenceKey({ namespace: "scope", id: "😀".repeat(256) }))
      .not.toThrow();
    expect(() => snapshotResourceIdFromReferenceKey({ namespace: "scope", id: "😀".repeat(257) }))
      .toThrow(/between 1 and 256/u);
    expect(() => snapshotResourceIdFromReferenceKey({ namespace: "A", id: "valid" }))
      .toThrow(/namespace violates/u);
  });

  it("keeps internal identities distinct when legal fields contain NUL", () => {
    const left = snapshotResourceIdentity({ resourceKind: "A", resourceId: "B\u0000C" });
    const right = snapshotResourceIdentity({ resourceKind: "A\u0000B", resourceId: "C" });

    expect(left).not.toBe(right);
    expect(JSON.parse(left)).toEqual(["A", "B\u0000C"]);
    expect(JSON.parse(right)).toEqual(["A\u0000B", "C"]);
  });

  it("keeps persisted evidence JSON-safe and unambiguous for delimiter-like identifiers", () => {
    const resource = { resourceKind: "REFERENCE", resourceId: "scope\u0000with:[delimiters]" };
    const evidence = snapshotResourceEvidenceIdentity(resource);

    expect(evidence).toBe('["REFERENCE","scope\\u0000with:[delimiters]"]');
    expect(evidence).not.toContain("\u0000");
    expect(JSON.parse(evidence)).toEqual(["REFERENCE", resource.resourceId]);
  });
});
