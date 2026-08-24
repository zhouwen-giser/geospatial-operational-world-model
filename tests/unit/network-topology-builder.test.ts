import { describe, expect, it } from "vitest";
import {
  buildNetworkTopology,
  type MaterializedNetworkBuild,
  type MaterializedNetworkFeature
} from "../../packages/network-foundation/src/index.js";

function feature(id: string, coordinates: Array<[number, number, number?]>, properties: Record<string, unknown> = {}): MaterializedNetworkFeature {
  return {
    featureReferenceKey: `wrf_${id.repeat(32)}`,
    featureVersion: "1",
    layerKey: "road-centerline",
    contentHash: `sha256:${id.repeat(64)}`,
    positions: coordinates.map(([longitude, latitude, elevation = 0]) => ({
      longitudeNanodegrees: longitude * 1_000_000_000,
      latitudeNanodegrees: latitude * 1_000_000_000,
      elevationMm: elevation * 1000
    })),
    properties
  };
}

function materialized(features: readonly MaterializedNetworkFeature[]): MaterializedNetworkBuild {
  return {
    adapterKind: "CATALOG_VECTOR_LAYER",
    dataset: {
      datasetReferenceKey: `wrf_${"f".repeat(32)}`,
      datasetVersion: "1",
      datasetKind: "NETWORK",
      contentHash: `sha256:${"f".repeat(64)}`,
      dataScopeKey: "scope-a",
      datasetScopeKey: "tenant-a"
    },
    buildPolicy: {
      version: "network-build-policy-v1",
      coordinatePrecisionNanodegrees: 1,
      defaultElevationMm: 0,
      connectAtGradeIntersections: true
    },
    features,
    sourceContentHash: `sha256:${"e".repeat(64)}`,
    graphIdentityHash: `sha256:${"d".repeat(64)}`,
    warnings: []
  };
}

describe("network topology builder", () => {
  it("splits at-grade intersections into one shared node and directed arcs", () => {
    const topology = buildNetworkTopology(materialized([
      feature("1", [[-1, 0], [1, 0]]),
      feature("2", [[0, -1], [0, 1]])
    ]));
    expect(topology.nodes).toHaveLength(5);
    expect(topology.edges).toHaveLength(4);
    expect(topology.arcs).toHaveLength(8);
    const degrees = new Map<string, number>();
    for (const edge of topology.edges) {
      degrees.set(edge.sourceNodeKey, (degrees.get(edge.sourceNodeKey) ?? 0) + 1);
      degrees.set(edge.targetNodeKey, (degrees.get(edge.targetNodeKey) ?? 0) + 1);
    }
    expect(Math.max(...degrees.values())).toBe(4);
  });

  it.each([
    { name: "bridge", leftProperties: { bridge: true }, rightProperties: {} },
    { name: "tunnel", leftProperties: { tunnel: true }, rightProperties: {} },
    { name: "layer", leftProperties: { layerLevel: 1 }, rightProperties: { layerLevel: 0 } }
  ] as const)("does not create a false $name-grade crossing", ({ leftProperties, rightProperties }) => {
    const topology = buildNetworkTopology(materialized([
      feature("1", [[-1, 0], [1, 0]], leftProperties),
      feature("2", [[0, -1], [0, 1]], rightProperties)
    ]));
    expect(topology.nodes).toHaveLength(4);
    expect(topology.edges).toHaveLength(2);
    expect(topology.arcs).toHaveLength(4);
  });

  it("preserves parallel ways as distinct physical edges", () => {
    const topology = buildNetworkTopology(materialized([
      feature("1", [[0, 0], [1, 0]]),
      feature("2", [[0, 0.001], [1, 0.001]])
    ]));
    expect(topology.edges).toHaveLength(2);
    expect(new Set(topology.edges.map((edge) => edge.edgeKey)).size).toBe(2);
  });

  it("omits illegal reverse arcs and orients every Arc to its endpoints", () => {
    const forward = buildNetworkTopology(materialized([feature("1", [[0, 0], [1, 0]], { oneway: true })]));
    expect(forward.arcs).toHaveLength(1);
    expect(forward.arcs[0]?.direction).toBe("FORWARD");
    const reverse = buildNetworkTopology(materialized([feature("1", [[0, 0], [1, 0]], { oneway: -1 })]));
    expect(reverse.arcs).toHaveLength(1);
    expect(reverse.arcs[0]?.direction).toBe("REVERSE");
    expect(reverse.arcs[0]?.positions[0]).toEqual(reverse.nodes.find((node) => node.nodeKey === reverse.arcs[0]?.sourceNodeKey)?.position);
    expect(reverse.arcs[0]?.positions.at(-1)).toEqual(reverse.nodes.find((node) => node.nodeKey === reverse.arcs[0]?.targetNodeKey)?.position);
  });

  it("reproduces topology/content hashes independent of feature order", () => {
    const features = [feature("1", [[-1, 0], [1, 0]]), feature("2", [[0, -1], [0, 1]])];
    const left = buildNetworkTopology(materialized(features));
    const right = buildNetworkTopology(materialized([...features].reverse()));
    expect(left.topologyHash).toBe(right.topologyHash);
    expect(left.contentHash).toBe(right.contentHash);
    expect(left.nodes).toEqual(right.nodes);
    expect(left.edges).toEqual(right.edges);
    expect(left.arcs).toEqual(right.arcs);
  });

  it("fails closed on a zero-length source segment", () => {
    expect(() => buildNetworkTopology(materialized([feature("1", [[0, 0], [0, 0]])])))
      .toThrow("network segment length is invalid");
  });
});
