import { describe, expect, it } from "vitest";
import {
  CatalogNetworkBuildAdapter,
  materializeOsmArtifactPreview,
  networkArcKey,
  networkEdgeKey,
  networkNodeKey,
  type NetworkBuildRequest,
  type NetworkCatalogRepository,
  type NetworkDatasetVersion,
  type SourceLineFeature
} from "../../packages/network-foundation/src/index.js";

const dataset: NetworkDatasetVersion = {
  datasetReferenceKey: `wrf_${"1".repeat(32)}`,
  datasetVersion: "2026-08-24",
  datasetKind: "NETWORK",
  contentHash: `sha256:${"2".repeat(64)}`,
  dataScopeKey: "scope-a",
  datasetScopeKey: "tenant-a"
};

const features: SourceLineFeature[] = [
  {
    featureReferenceKey: `wrf_${"b".repeat(32)}`,
    featureVersion: "1",
    layerKey: "road-centerline",
    contentHash: `sha256:${"4".repeat(64)}`,
    coordinates: [[1.0000000004, 2, 3], [2, 2, 3]],
    properties: { surface: "paved", oneway: false }
  },
  {
    featureReferenceKey: `wrf_${"a".repeat(32)}`,
    featureVersion: "1",
    layerKey: "road-centerline",
    contentHash: `sha256:${"3".repeat(64)}`,
    coordinates: [[0, 0], [1, 0]],
    properties: { oneway: true }
  }
];

const request: NetworkBuildRequest = {
  dataScopeKey: "scope-a",
  datasetScopeKey: "tenant-a",
  datasetReferenceKey: dataset.datasetReferenceKey,
  datasetVersion: dataset.datasetVersion,
  buildPolicy: {
    version: "network-build-policy-v1",
    coordinatePrecisionNanodegrees: 10,
    defaultElevationMm: 0,
    connectAtGradeIntersections: true
  },
  allowedLayerKeys: ["road-centerline"]
};

class FixtureRepository implements NetworkCatalogRepository {
  constructor(private readonly source: readonly SourceLineFeature[], private readonly sourceDataset = dataset) {}
  async getDatasetVersion(): Promise<NetworkDatasetVersion> { return this.sourceDataset; }
  async listLineFeatures(): Promise<readonly SourceLineFeature[]> { return this.source; }
}

describe("network catalog build adapter", () => {
  it("materializes NETWORK catalog features deterministically", async () => {
    const left = await new CatalogNetworkBuildAdapter(new FixtureRepository(features)).materialize(request);
    const right = await new CatalogNetworkBuildAdapter(new FixtureRepository([...features].reverse())).materialize(request);
    expect(left.adapterKind).toBe("CATALOG_VECTOR_LAYER");
    expect(left.features.map((feature) => feature.featureReferenceKey)).toEqual([
      `wrf_${"a".repeat(32)}`, `wrf_${"b".repeat(32)}`
    ]);
    expect(left.sourceContentHash).toBe(right.sourceContentHash);
    expect(left.graphIdentityHash).toBe(right.graphIdentityHash);
    expect(left.features[0]?.positions[0]?.elevationMm).toBe(0);
    expect(left.features[1]?.positions[0]?.longitudeNanodegrees).toBe(1_000_000_000);
  });

  it("rejects non-network, unauthorized-layer, and zero-length inputs", async () => {
    await expect(new CatalogNetworkBuildAdapter(new FixtureRepository(features, { ...dataset, datasetKind: "VECTOR" })).materialize(request))
      .rejects.toThrow("not NETWORK");
    await expect(new CatalogNetworkBuildAdapter(new FixtureRepository([{ ...features[0]!, layerKey: "buildings" }])).materialize(request))
      .rejects.toThrow("unauthorized layer");
    await expect(new CatalogNetworkBuildAdapter(new FixtureRepository([{ ...features[0]!, coordinates: [[1, 1], [1, 1]] }])).materialize(request))
      .rejects.toThrow("zero-length");
  });

  it("keeps OSM artifacts explicitly PREVIEW with locked provenance", () => {
    const result = materializeOsmArtifactPreview({
      dataset,
      buildPolicy: request.buildPolicy,
      artifactContentHash: `sha256:${"f".repeat(64)}`,
      license: "ODbL-1.0",
      attribution: "© OpenStreetMap contributors",
      sourceUrl: "https://www.openstreetmap.org/export",
      sourceVersion: "fixture-2026-08-25",
      features
    });
    expect(result.adapterKind).toBe("OSM_ARTIFACT_PREVIEW");
    expect(result.warnings).toContain("OSM_ARTIFACT_PREVIEW is not a Stable catalog authority");
    expect(result.warnings[1]).toContain("sha256:");
    expect(result.warnings).toContain("license=ODbL-1.0");
    expect(result.warnings).toContain("attribution=© OpenStreetMap contributors");
  });

  it("derives stable graph-internal Node, Edge and directed Arc keys", () => {
    const sourceNodeKey = networkNodeKey(request.buildPolicy.version, {
      longitudeNanodegrees: 0, latitudeNanodegrees: 0, elevationMm: 0
    }, "endpoint:0");
    const targetNodeKey = networkNodeKey(request.buildPolicy.version, {
      longitudeNanodegrees: 1_000_000_000, latitudeNanodegrees: 0, elevationMm: 0
    }, "endpoint:1");
    const edgeKey = networkEdgeKey({
      buildPolicyVersion: request.buildPolicy.version,
      sourceFeatureReferenceKey: features[1]!.featureReferenceKey,
      sourceFeatureVersion: "1",
      splitStartPpm: 0,
      splitEndPpm: 1_000_000,
      sourceNodeKey,
      targetNodeKey
    });
    expect(sourceNodeKey).toMatch(/^nd_[0-9a-f]{64}$/u);
    expect(edgeKey).toMatch(/^ed_[0-9a-f]{64}$/u);
    expect(networkArcKey(edgeKey, "FORWARD")).toMatch(/^ar_[0-9a-f]{64}$/u);
    expect(networkArcKey(edgeKey, "FORWARD")).not.toBe(networkArcKey(edgeKey, "REVERSE"));
  });
});
