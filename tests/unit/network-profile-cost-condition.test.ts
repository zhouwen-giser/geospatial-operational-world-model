import { describe, expect, it } from "vitest";
import {
  buildNetworkTopology,
  createConditionSnapshot,
  createCostProfile,
  createTravelProfile,
  evaluateArcCost,
  isArcEligible,
  type MaterializedNetworkBuild,
  type MaterializedNetworkFeature
} from "../../packages/network-foundation/src/index.js";

function feature(id: string, latitude: number, properties: Record<string, unknown>): MaterializedNetworkFeature {
  return {
    featureReferenceKey: `wrf_${id.repeat(32)}`,
    featureVersion: "1",
    layerKey: "road-centerline",
    contentHash: `sha256:${id.repeat(64)}`,
    positions: [0, 1].map((longitude) => ({
      longitudeNanodegrees: longitude * 1_000_000,
      latitudeNanodegrees: latitude * 1_000_000,
      elevationMm: 0
    })),
    properties: { ...properties, oneway: true, defaultSpeedMmPerS: 10_000 }
  };
}

const build: MaterializedNetworkBuild = {
  adapterKind: "CATALOG_VECTOR_LAYER",
  dataset: {
    datasetReferenceKey: `wrf_${"f".repeat(32)}`,
    datasetVersion: "1",
    datasetKind: "NETWORK",
    contentHash: `sha256:${"f".repeat(64)}`,
    dataScopeKey: "profile-test",
    datasetScopeKey: "profile-test"
  },
  buildPolicy: {
    version: "network-build-policy-v1",
    coordinatePrecisionNanodegrees: 1,
    defaultElevationMm: 0,
    connectAtGradeIntersections: true
  },
  features: [
    feature("1", 0, { roadClass: "PRIMARY", surface: "ASPHALT" }),
    feature("2", 1, { roadClass: "TRACK", surface: "GRAVEL" }),
    feature("3", 2, { roadClass: "SERVICE", surface: "DIRT" })
  ],
  sourceContentHash: `sha256:${"e".repeat(64)}`,
  graphIdentityHash: `sha256:${"d".repeat(64)}`,
  warnings: []
};

const roadProfile = createTravelProfile({
  profileKey: "road-vehicle",
  version: "1",
  vehicleClass: "ROAD_VEHICLE",
  allowedRoadClasses: ["PRIMARY"],
  allowedSurfaces: ["ASPHALT"],
  onewayPolicy: "STRICT",
  maximumSpeedMmPerS: 20_000,
  requiredAccessMask: 0
});
const ugvProfile = createTravelProfile({
  profileKey: "ugv",
  version: "1",
  vehicleClass: "UGV",
  allowedRoadClasses: ["TRACK", "SERVICE"],
  allowedSurfaces: ["GRAVEL", "DIRT"],
  onewayPolicy: "STRICT",
  maximumSpeedMmPerS: 20_000,
  requiredAccessMask: 0
});
const costProfile = createCostProfile({
  profileKey: "balanced",
  version: "1",
  weights: { distance: 200_000, time: 300_000, risk: 200_000, energy: 200_000, surface: 100_000 }
});

describe("network profiles, costs and conditions", () => {
  it("filters ROAD_VEHICLE and UGV by road class and surface", () => {
    const topology = buildNetworkTopology(build);
    const edges = new Map(topology.edges.map((edge) => [edge.edgeKey, edge]));
    expect(topology.arcs.filter((arc) => isArcEligible(edges.get(arc.edgeKey)!, arc, roadProfile))).toHaveLength(1);
    expect(topology.arcs.filter((arc) => isArcEligible(edges.get(arc.edgeKey)!, arc, ugvProfile))).toHaveLength(2);
  });

  it("enforces strict one-way by construction", () => {
    const topology = buildNetworkTopology(build);
    expect(topology.arcs).toHaveLength(topology.edges.length);
    expect(topology.arcs.every((arc) => arc.direction === "FORWARD")).toBe(true);
  });

  it("recomputes exact integer distance/duration and deterministic weighted cost", () => {
    const topology = buildNetworkTopology(build);
    const arc = topology.arcs.find((candidate) => topology.edges.find((edge) => edge.edgeKey === candidate.edgeKey)?.roadClass === "PRIMARY")!;
    const edge = topology.edges.find((candidate) => candidate.edgeKey === arc.edgeKey)!;
    const left = evaluateArcCost({
      edge, arc, travelProfile: roadProfile, costProfile,
      baseRiskMicroUnits: 11, baseEnergyMwh: 13, surfacePenaltyUnits: 17
    });
    const right = evaluateArcCost({
      edge, arc, travelProfile: roadProfile, costProfile,
      baseRiskMicroUnits: 11, baseEnergyMwh: 13, surfacePenaltyUnits: 17
    });
    expect(left?.distanceMm).toBe(arc.lengthMm);
    expect(left?.durationMs).toBe(Math.ceil(arc.lengthMm * 1000 / arc.defaultSpeedMmPerS));
    expect(left).toEqual(right);
  });

  it("treats maximumSpeedMmPerS as a traversal cap instead of an eligibility ceiling", () => {
    const topology = buildNetworkTopology(build);
    const sourceArc = topology.arcs.find((candidate) => topology.edges.find((edge) => edge.edgeKey === candidate.edgeKey)?.roadClass === "PRIMARY")!;
    const edge = topology.edges.find((candidate) => candidate.edgeKey === sourceArc.edgeKey)!;
    const arc = { ...sourceArc, defaultSpeedMmPerS: 17_882 };
    const cappedProfile = createTravelProfile({
      ...roadProfile,
      version: "speed-cap-5000",
      maximumSpeedMmPerS: 5_000
    });
    const result = evaluateArcCost({
      edge, arc, travelProfile: cappedProfile, costProfile,
      baseRiskMicroUnits: 0, baseEnergyMwh: 0, surfacePenaltyUnits: 0
    });
    expect(isArcEligible(edge, arc, cappedProfile)).toBe(true);
    expect(result?.speedMmPerS).toBe(5_000);
    expect(result?.durationMs).toBe(Math.ceil(arc.lengthMm * 1000 / 5_000));
  });

  it("pins closure, speed and risk overrides without mutating the Arc or old snapshot", () => {
    const topology = buildNetworkTopology(build);
    const arc = topology.arcs.find((candidate) => topology.edges.find((edge) => edge.edgeKey === candidate.edgeKey)?.roadClass === "PRIMARY")!;
    const edge = topology.edges.find((candidate) => candidate.edgeKey === arc.edgeKey)!;
    const arcBefore = JSON.stringify(arc);
    const baseline = createConditionSnapshot({
      sourceSnapshotVersion: "1",
      observedAt: "2026-08-25T00:00:00Z",
      validUntil: "2026-08-25T01:00:00Z",
      completeness: "COMPLETE",
      sourceContentHash: `sha256:${"1".repeat(64)}`,
      conditions: [],
      metadata: {}
    });
    const changed = createConditionSnapshot({
      sourceSnapshotVersion: "2",
      observedAt: "2026-08-25T00:10:00Z",
      validUntil: "2026-08-25T01:10:00Z",
      completeness: "PARTIAL",
      sourceContentHash: `sha256:${"2".repeat(64)}`,
      conditions: [{
        arcKey: arc.arcKey,
        traversalAllowed: true,
        speedOverrideMmPerS: 5_000,
        riskOverrideMicroUnits: 99,
        costMultiplierPpm: 1_100_000,
        reasonCodes: ["INCIDENT"],
        evidence: [{ source: "condition-fixture", confidencePpm: 900_000 }]
      }],
      metadata: {}
    });
    const oldCost = evaluateArcCost({ edge, arc, travelProfile: roadProfile, costProfile, baseRiskMicroUnits: 11, baseEnergyMwh: 13, surfacePenaltyUnits: 17, conditionSnapshot: baseline });
    const changedCost = evaluateArcCost({ edge, arc, travelProfile: roadProfile, costProfile, baseRiskMicroUnits: 11, baseEnergyMwh: 13, surfacePenaltyUnits: 17, conditionSnapshot: changed });
    expect(changedCost?.durationMs).toBeGreaterThan(oldCost!.durationMs);
    expect(changedCost?.riskMicroUnits).toBe(99);
    expect(evaluateArcCost({ edge, arc, travelProfile: roadProfile, costProfile, baseRiskMicroUnits: 11, baseEnergyMwh: 13, surfacePenaltyUnits: 17, conditionSnapshot: baseline })).toEqual(oldCost);
    expect(JSON.stringify(arc)).toBe(arcBefore);

    const closed = createConditionSnapshot({
      sourceSnapshotVersion: "3",
      observedAt: "2026-08-25T00:20:00Z",
      validUntil: "2026-08-25T01:20:00Z",
      completeness: "PARTIAL",
      sourceContentHash: `sha256:${"3".repeat(64)}`,
      conditions: [{ arcKey: arc.arcKey, traversalAllowed: false, reasonCodes: ["CLOSED"], evidence: [{ source: "operator" }] }],
      metadata: {}
    });
    expect(evaluateArcCost({ edge, arc, travelProfile: roadProfile, costProfile, baseRiskMicroUnits: 11, baseEnergyMwh: 13, surfacePenaltyUnits: 17, conditionSnapshot: closed })).toBeNull();
  });
});
