import { describe, expect, it } from "vitest";

import { PostgresNetworkTopologyWriter, type BuiltNetworkTopology } from "../../packages/network-foundation/src/index.js";

const position = (longitudeNanodegrees: number) => ({ longitudeNanodegrees, latitudeNanodegrees: 0, elevationMm: 0 });

describe("PostgresNetworkTopologyWriter", () => {
  it("persists optional Edge and Arc semantics instead of dropping them", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    let node = 0;
    const database = {
      async query(text: string, values: unknown[]) {
        calls.push({ text, values });
        if (text.includes("INSERT INTO network_node")) return { rows: [{ node_id: String(++node) }] };
        if (text.includes("INSERT INTO network_edge")) return { rows: [{ edge_id: "3" }] };
        return { rows: [{ arc_id: "4" }] };
      }
    };
    const topology: BuiltNetworkTopology = {
      nodes: [
        { nodeKey: "nd_a", position: position(0), topologyIdentity: "source" },
        { nodeKey: "nd_b", position: position(1_000_000_000), topologyIdentity: "target" }
      ],
      edges: [{
        edgeKey: "ed_a", sourceFeatureReferenceKey: "wrf_a", sourceFeatureVersion: "1",
        sourceNodeKey: "nd_a", targetNodeKey: "nd_b", splitStartPpm: 0, splitEndPpm: 1_000_000,
        positions: [position(0), position(1_000_000_000)], lengthMm: 1_000, roadClass: "XODR_TOWN",
        isBridge: false, isTunnel: false, layerLevel: 0, widthMm: 3_750, heightLimitMm: 4_200,
        weightLimitGrams: 12_000_000, laneCount: 1, oneway: "FORWARD_ONLY",
        accessAttributes: { surfaceKnowledge: "MISSING_IN_SOURCE" }
      }],
      arcs: [{
        arcKey: "ar_a", edgeKey: "ed_a", sourceNodeKey: "nd_a", targetNodeKey: "nd_b",
        direction: "FORWARD", positions: [position(0), position(1_000_000_000)], lengthMm: 1_000,
        defaultSpeedMmPerS: 17_882, transitEligible: true, serviceEligible: false, accessMask: 3,
        profileConstraints: { speedSource: "XODR_UNIFORM_SOURCE" }
      }],
      topologyHash: "sha256:topology", contentHash: "sha256:content", diagnostics: []
    };

    await new PostgresNetworkTopologyWriter(database as never).persist({ graphVersionId: "graph", dataScopeKey: "scope", topology });

    const edge = calls.find((call) => call.text.includes("INSERT INTO network_edge"))!;
    expect(edge.text).toContain("width_mm,height_limit_mm,weight_limit_grams");
    expect(edge.text).toContain("lane_count,oneway,access_attributes");
    expect(edge.values.slice(13)).toEqual([3_750, 4_200, 12_000_000, 1, "FORWARD_ONLY", JSON.stringify({ surfaceKnowledge: "MISSING_IN_SOURCE" })]);
    const arc = calls.find((call) => call.text.includes("INSERT INTO network_arc"))!;
    expect(arc.text).toContain("transit_eligible");
    expect(arc.text).toContain("service_eligible,access_mask,profile_constraints");
    expect(arc.values.slice(10)).toEqual([true, false, 3, JSON.stringify({ speedSource: "XODR_UNIFORM_SOURCE" })]);
  });
});
