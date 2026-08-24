import { describe, expect, it } from "vitest";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { verifyRouteCandidate } from "../../services/providers/route-planning-provider/src/verifier.js";
import type { LoadedNetwork, NetworkArc, Row } from "../../services/providers/network-provider/src/types.js";

const arcs: NetworkArc[] = [arc("arc_" + "1".repeat(64), "a", "b", 100), arc("arc_" + "2".repeat(64), "b", "c", 200), arc("arc_" + "3".repeat(64), "b", "d", 300)];
const network: LoadedNetwork = {
  routingSnapshot: { networkDatasetVersion: "1", graphVersion: "g1", travelProfileVersion: "t1", costProfileVersion: "c1", graphContentHash: `sha256:${"a".repeat(64)}`, costContentHash: `sha256:${"b".repeat(64)}` },
  graph: {}, arcs, turnRules: [{ sequence: [arcs[0]!.key, arcs[2]!.key], ruleType: "FORBIDDEN", penaltyUnits: 0 }],
  dataSnapshot: { consistency: "PINNED", capturedAt: "2026-08-25T00:00:00.000Z", scopeDigest: `sha256:${"c".repeat(64)}`, resources: [] }
};

describe("independent route verifier", () => {
  it("accepts exact fixed-point replay and rejects metric mutation", () => {
    const valid = candidate([segment(arcs[0]!, 100), segment(arcs[1]!, 200)]);
    expect(verifyRouteCandidate(network, valid).status).toBe("VALID");
    const mutated = structuredClone(valid); (mutated.metrics as Row).distanceMm = 301;
    expect(verifyRouteCandidate(network, mutated).status).toBe("INVALID");
  });

  it("rejects an inserted forbidden turn without importing solver helpers", () => {
    const illegal = candidate([segment(arcs[0]!, 100), segment(arcs[2]!, 300)]);
    expect(verifyRouteCandidate(network, illegal).status).toBe("INVALID");
    expect((verifyRouteCandidate(network, illegal).checks as Row[]).find((check) => check.code === "TURN_LEGALITY")?.status).toBe("FAIL");
  });

  it("marks a valid immutable candidate stale when graph/profile/condition freshness changes", () => {
    const valid = candidate([segment(arcs[0]!, 100), segment(arcs[1]!, 200)]);
    expect(verifyRouteCandidate(network, valid, { graphCurrent: true, profileCurrent: true, conditionCurrent: false }).status).toBe("STALE");
  });
});

function arc(key: string, source: string, target: string, distanceMm: number): NetworkArc { return { id: key, key, source, target, direction: "FORWARD", headingMicrodegrees: 0, distanceMm, durationMs: distanceMm * 2, riskMicroUnits: distanceMm * 3, energyMwh: distanceMm * 4, combinedCostUnits: distanceMm * 5, conditionPenaltyUnits: 0 }; }
function segment(value: NetworkArc, distanceMm: number): Row { return { graphVersion: "g1", arcKey: value.key, startFractionPpm: 0, endFractionPpm: 1_000_000, segmentRole: "ROUTE", distanceMm, durationMs: distanceMm * 2, riskMicroUnits: distanceMm * 3, energyMwh: distanceMm * 4, turnPenaltyUnits: 0 }; }
function candidate(segments: Row[]): Row { const metrics = segments.reduce<{ distanceMm: number; durationMs: number; riskMicroUnits: number; energyMwh: number; combinedCostUnits: number }>((sum, item) => ({ distanceMm: sum.distanceMm + Number(item.distanceMm), durationMs: sum.durationMs + Number(item.durationMs), riskMicroUnits: sum.riskMicroUnits + Number(item.riskMicroUnits), energyMwh: sum.energyMwh + Number(item.energyMwh), combinedCostUnits: sum.combinedCostUnits + Number(item.distanceMm) * 5 }), { distanceMm: 0, durationMs: 0, riskMicroUnits: 0, energyMwh: 0, combinedCostUnits: 0 }); return { rank: 1, routeSignature: sha256({ segments: segments.map((item) => [item.arcKey, item.startFractionPpm, item.endFractionPpm]) }), segments, metrics }; }
