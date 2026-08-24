import { describe, expect, it } from "vitest";
import {
  advanceSequenceAutomaton,
  buildNetworkTopology,
  compileTurnRestrictions,
  type MaterializedNetworkBuild,
  type MaterializedNetworkFeature
} from "../../packages/network-foundation/src/index.js";

function feature(id: string, start: number, end: number): MaterializedNetworkFeature {
  return {
    featureReferenceKey: `wrf_${id.repeat(32)}`,
    featureVersion: "1",
    layerKey: "road-centerline",
    contentHash: `sha256:${id.repeat(64)}`,
    positions: [start, end].map((longitude) => ({
      longitudeNanodegrees: longitude * 1_000_000,
      latitudeNanodegrees: 0,
      elevationMm: 0
    })),
    properties: { oneway: true }
  };
}

const features = [feature("1", 0, 1), feature("2", 1, 2), feature("3", 2, 3)];
const build: MaterializedNetworkBuild = {
  adapterKind: "CATALOG_VECTOR_LAYER",
  dataset: {
    datasetReferenceKey: `wrf_${"f".repeat(32)}`,
    datasetVersion: "1",
    datasetKind: "NETWORK",
    contentHash: `sha256:${"f".repeat(64)}`,
    dataScopeKey: "turn-test",
    datasetScopeKey: "turn-test"
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

function fixture() {
  const topology = buildNetworkTopology(build);
  const viaNodeKey = topology.nodes.find((node) => node.position.longitudeNanodegrees === 1_000_000)?.nodeKey;
  if (!viaNodeKey) throw new Error("turn fixture via node is unavailable");
  return { topology, viaNodeKey };
}

describe("turn restriction compiler", () => {
  it("resolves pairwise source features to one valid directed Arc pair", () => {
    const { topology, viaNodeKey } = fixture();
    const compiled = compileTurnRestrictions({
      topology,
      pairwise: [{
        restrictionReferenceKey: "restriction:pair:1",
        fromFeatureReferenceKey: features[0]!.featureReferenceKey,
        viaNodeKey,
        toFeatureReferenceKey: features[1]!.featureReferenceKey,
        ruleType: "FORBIDDEN"
      }],
      sequences: []
    });
    expect(compiled.pairwiseRules).toHaveLength(1);
    expect(compiled.pairwiseRules[0]).toMatchObject({ viaNodeKey, ruleType: "FORBIDDEN", penaltyUnits: 0 });
    expect(compiled.diagnostics).toEqual([]);
  });

  it("compiles multi-edge rules and overlapping deterministic automaton matches", () => {
    const { topology } = fixture();
    const compiled = compileTurnRestrictions({
      topology,
      pairwise: [],
      sequences: [
        {
          restrictionReferenceKey: "restriction:sequence:forbidden",
          featureReferenceKeys: features.map((item) => item.featureReferenceKey),
          ruleType: "FORBIDDEN"
        },
        {
          restrictionReferenceKey: "restriction:sequence:penalty",
          featureReferenceKeys: features.slice(1).map((item) => item.featureReferenceKey),
          ruleType: "PENALTY",
          penaltyUnits: 7
        }
      ]
    });
    const arcs = compiled.sequenceRules.find((rule) => rule.arcSequence.length === 3)?.arcSequence;
    if (!arcs) throw new Error("compiled three-Arc sequence is unavailable");
    let state = 0;
    state = advanceSequenceAutomaton(compiled.automaton, state, arcs[0]!).stateId;
    state = advanceSequenceAutomaton(compiled.automaton, state, arcs[1]!).stateId;
    const matched = advanceSequenceAutomaton(compiled.automaton, state, arcs[2]!);
    expect(matched.matchedRuleKeys).toHaveLength(2);
    expect(matched.forbidden).toBe(true);
    expect(matched.penaltyUnits).toBe(7);
  });

  it("reproduces rule, automaton and content hashes independent of input order", () => {
    const { topology, viaNodeKey } = fixture();
    const pairwise = [{
      restrictionReferenceKey: "restriction:pair:1",
      fromFeatureReferenceKey: features[0]!.featureReferenceKey,
      viaNodeKey,
      toFeatureReferenceKey: features[1]!.featureReferenceKey,
      ruleType: "FORBIDDEN" as const
    }];
    const sequences = [
      {
        restrictionReferenceKey: "restriction:sequence:1",
        featureReferenceKeys: features.map((item) => item.featureReferenceKey),
        ruleType: "FORBIDDEN" as const
      },
      {
        restrictionReferenceKey: "restriction:sequence:2",
        featureReferenceKeys: features.slice(1).map((item) => item.featureReferenceKey),
        ruleType: "PENALTY" as const,
        penaltyUnits: 3
      }
    ];
    const left = compileTurnRestrictions({ topology, pairwise, sequences });
    const right = compileTurnRestrictions({ topology, pairwise: [...pairwise].reverse(), sequences: [...sequences].reverse() });
    expect(left).toEqual(right);
  });

  it("records unresolved hard rules as activation-blocking FATAL diagnostics", () => {
    const { topology, viaNodeKey } = fixture();
    const compiled = compileTurnRestrictions({
      topology,
      pairwise: [{
        restrictionReferenceKey: "restriction:missing:hard",
        fromFeatureReferenceKey: features[0]!.featureReferenceKey,
        viaNodeKey,
        toFeatureReferenceKey: `wrf_${"a".repeat(32)}`,
        ruleType: "ALLOWED_ONLY"
      }],
      sequences: []
    });
    expect(compiled.diagnostics).toEqual([expect.objectContaining({
      severity: "FATAL",
      issueCode: "UNRESOLVED_HARD_TURN_RESTRICTION",
      activationBlocking: true,
      reason: "ZERO_MATCHES"
    })]);
  });

  it("records unresolved penalty rules as non-blocking WARNING diagnostics", () => {
    const { topology } = fixture();
    const compiled = compileTurnRestrictions({
      topology,
      pairwise: [],
      sequences: [{
        restrictionReferenceKey: "restriction:missing:soft",
        featureReferenceKeys: [features[0]!.featureReferenceKey, `wrf_${"a".repeat(32)}`],
        ruleType: "PENALTY",
        penaltyUnits: 5
      }]
    });
    expect(compiled.diagnostics).toEqual([expect.objectContaining({
      severity: "WARNING",
      issueCode: "UNRESOLVED_SOFT_TURN_RESTRICTION",
      activationBlocking: false
    })]);
  });

  it("fails closed on inconsistent penalty values", () => {
    const { topology, viaNodeKey } = fixture();
    expect(() => compileTurnRestrictions({
      topology,
      pairwise: [{
        restrictionReferenceKey: "restriction:bad-penalty",
        fromFeatureReferenceKey: features[0]!.featureReferenceKey,
        viaNodeKey,
        toFeatureReferenceKey: features[1]!.featureReferenceKey,
        ruleType: "FORBIDDEN",
        penaltyUnits: 1
      }],
      sequences: []
    })).toThrow("turn restriction penalty is inconsistent");
  });
});
