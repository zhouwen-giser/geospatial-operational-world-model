import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../packages/platform/contract-runtime/src/index.js";
import {
  deterministicUuidV5,
  loadSampleWorldInputs,
  realizeSampleWorld,
  stableReferenceId
} from "../../scripts/sample-world/model.js";

const EPOCH = "2026-08-27T03:00:00Z";
const SEED = "sample-world-generator-test-seed";

describe("deterministic WSGS sample-world realization", () => {
  it("loads the complete authoritative fixture set with a canonical source hash", async () => {
    const inputs = await loadSampleWorldInputs();

    expect(inputs.sourceFixtureHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(inputs.catalog.datasets).toHaveLength(4);
    expect(inputs.catalog.layers).toHaveLength(6);
    expect(inputs.features.visible.features).toHaveLength(7);
    expect(inputs.features.hidden.features).toHaveLength(2);
    expect(inputs.objects).toHaveLength(7);
    expect(inputs.references).toHaveLength(16);
    expect(inputs.observations).toHaveLength(7);
    expect(inputs.mutations).toHaveLength(1);
    expect(inputs.expectedCases).toHaveLength(13);
  });

  it("produces identical artifact bytes and hashes for identical epoch and seed", async () => {
    const first = await realizeSampleWorld({ epoch: EPOCH, seed: SEED });
    const second = await realizeSampleWorld({ epoch: EPOCH, seed: SEED });

    expect(second.fixture).toEqual(first.fixture);
    expect(second.referenceMap).toEqual(first.referenceMap);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.artifacts).toEqual(first.artifacts);
    expect(first.fixture.generatedArtifactHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.fixture.realizationHash).toBe(first.manifest.realizationHash);
    expect(first.manifest.generatedAt).toBe("2026-08-27T03:00:00.000Z");
    const { realizationHash: _, ...manifestCore } = first.manifest;
    expect(first.manifest.realizationHash).toBe(canonicalSha256(manifestCore));
  });

  it("uses locale-independent canonical ordering for non-ASCII fixture text", async () => {
    const first = await realizeSampleWorld({ epoch: EPOCH, seed: SEED });
    const originalLocaleCompare = String.prototype.localeCompare;
    const second = await (async () => {
      try {
        String.prototype.localeCompare = function localeCompareMustNotAffectRealization(): never {
          throw new Error("sample-world realization must not depend on localeCompare");
        };
        return await realizeSampleWorld({ epoch: EPOCH, seed: SEED });
      } finally {
        String.prototype.localeCompare = originalLocaleCompare;
      }
    })();

    expect(second.manifest).toEqual(first.manifest);
    expect(second.artifacts).toEqual(first.artifacts);
    expect(first.objects.find((object) => object.fixtureObjectKey === "ugv-002")?.aliases)
      .toEqual(["二号车", "北门巡逻车"]);
  });

  it("uses repository-compatible deterministic identities and separates key versions", async () => {
    const realization = await realizeSampleWorld({ epoch: EPOCH, seed: SEED });
    const entries = realization.referenceMap.entries;

    expect(entries).toHaveLength(26);
    expect(entries.filter((entry) => entry.targetKind === "DATASET")).toHaveLength(4);
    expect(entries.filter((entry) => entry.targetKind === "LAYER")).toHaveLength(6);
    expect(entries.every((entry) => /^wrf_[0-9a-f]{32}$/u.test(entry.referenceId))).toBe(true);
    expect(entries.every((entry) => /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(entry.entityId))).toBe(true);

    const object = entries.find((entry) => entry.fixtureKey === "ugv-002");
    expect(object).toMatchObject({
      targetKind: "WORLD_OBJECT",
      identityReferenceKey: { version: "1" },
      currentWorldReferenceKey: { version: "1" }
    });
    expect(object?.currentCatalogReferenceKey).toBeUndefined();

    const feature = entries.find((entry) => entry.fixtureKey === "zone-a");
    expect(feature).toMatchObject({
      targetKind: "LAYER_FEATURE",
      identityReferenceKey: { version: "1" },
      currentCatalogReferenceKey: { version: "1.0.0" }
    });
    expect(feature?.currentWorldReferenceKey).toBeUndefined();

    const projection = entries.find((entry) => entry.fixtureKey === "sample-current-world");
    expect(projection?.currentCatalogReferenceKey?.version).toBe(realization.fixture.realizationId);
    const exactReferenceId = `wrf_${createHash("sha256")
      .update("sample://gowm/wsgs/v1\0wsgs-demo\0WORLD_OBJECT\0ugv-002")
      .digest("hex")
      .slice(0, 32)}`;
    expect(stableReferenceId("sample://gowm/wsgs/v1", "wsgs-demo", "WORLD_OBJECT", "ugv-002"))
      .toBe(exactReferenceId);
    expect(stableReferenceId("sample://gowm/wsgs/v1", "wsgs-demo", "WORLD_OBJECT", "ugv-002"))
      .not.toBe(stableReferenceId("sample://gowm/wsgs/v1", "wsgs-hidden", "WORLD_OBJECT", "ugv-002"));
  });

  it("normalizes abstract expected inputs into executable Gateway operation inputs", async () => {
    const realization = await realizeSampleWorld({ epoch: EPOCH, seed: SEED });
    const byId = new Map(realization.expectedCases.map((value) => [value.caseId, value]));
    const unique = byId.get("REF-UNIQUE-2");
    const nearby = byId.get("SPATIAL-NEARBY-UGV2");
    const intersections = byId.get("SPATIAL-ROADS-INTERSECT-ZONE-A");

    expect(unique?.inputTemplate).toEqual({
      schemaVersion: "1.0",
      mentions: [{ mentionId: "REF-UNIQUE-2", surfaceText: "2号车" }],
      context: { anchorReferenceKeys: [] },
      limitPerMention: 20
    });
    expect(nearby?.inputTemplate).toMatchObject({
      location: [113.932, 22.542],
      radiusM: 250,
      crs: "EPSG:4326"
    });
    expect((intersections?.inputTemplate as Record<string, unknown>).candidateReferences).toHaveLength(3);
    expect(JSON.stringify(realization.expectedCases)).not.toMatch(/ReferenceFixtureKey|maximumDistanceM|layerFixtureKey/u);
    expect(unique?.expectedReferenceKeys).toEqual([
      realization.referenceMap.entries.find((entry) => entry.fixtureKey === "ugv-002")?.referenceId
    ]);
  });

  it("keeps entity identity stable while making a different epoch a distinct realization", async () => {
    const first = await realizeSampleWorld({ epoch: EPOCH, seed: SEED });
    const next = await realizeSampleWorld({ epoch: "2026-08-27T04:00:00Z", seed: SEED });
    const alternateSeed = await realizeSampleWorld({ epoch: EPOCH, seed: `${SEED}-alternate` });
    const identity = (fixtureKey: string, realization: typeof first) =>
      realization.referenceMap.entries.find((entry) => entry.fixtureKey === fixtureKey)?.identityReferenceKey;
    const entityId = (fixtureKey: string, realization: typeof first) =>
      realization.referenceMap.entries.find((entry) => entry.fixtureKey === fixtureKey)?.entityId;

    expect(next.fixture.sourceFixtureHash).toBe(first.fixture.sourceFixtureHash);
    expect(next.fixture.realizationId).not.toBe(first.fixture.realizationId);
    expect(alternateSeed.fixture.realizationId).not.toBe(first.fixture.realizationId);
    expect(identity("ugv-002", next)).toEqual(identity("ugv-002", first));
    expect(entityId("ugv-002", alternateSeed)).toBe(entityId("ugv-002", first));
    expect(next.observations[0]?.observationId).not.toBe(first.observations[0]?.observationId);
    expect(next.observations[0]?.observedAt).not.toBe(first.observations[0]?.observedAt);
  });

  it("writes exactly the returned canonical artifact bytes without exposing the seed", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "gowm-wsgs-sample-generator-"));
    try {
      const realization = await realizeSampleWorld({ epoch: EPOCH, seed: SEED, outputDir });
      const firstArtifact = realization.artifacts[0]!;
      expect(await readFile(join(outputDir, firstArtifact.path), "utf8")).toBe(firstArtifact.content);
      expect(JSON.parse(await readFile(join(outputDir, "sample-world-realization-manifest.json"), "utf8")))
        .toEqual(realization.manifest);
      expect(JSON.stringify(realization)).not.toContain(SEED);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("implements RFC 4122 UUIDv5 and rejects timezone-ambiguous epochs", async () => {
    expect(deterministicUuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"))
      .toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    await expect(realizeSampleWorld({ epoch: "2026-08-27T03:00:00", seed: SEED }))
      .rejects.toThrow("explicit UTC offset");
  });
});
