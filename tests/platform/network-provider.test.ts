import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256 } from "../../packages/platform/provider-sdk/src/index.js";
import { ProviderProtocolError } from "../../packages/platform/provider-sdk/src/index.js";
import { matrix, shortestPath, verifyPath } from "../../services/providers/network-provider/src/engine.js";
import { createNetworkProvider } from "../../services/providers/network-provider/src/provider.js";
import type { LoadedNetwork, NetworkArc, NetworkSqlPool, RoutingSnapshot, TurnRule } from "../../services/providers/network-provider/src/types.js";

const unavailablePool: NetworkSqlPool = { async connect() { throw new Error("manifest test must not connect"); } };
const snapshot: RoutingSnapshot = {
  networkDatasetVersion: "dataset-v1", graphVersion: "graph-v1", travelProfileVersion: "road-v1", costProfileVersion: "balanced-v1",
  graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}`, capturedAt: "2026-08-25T00:00:00.000Z"
};
const key = (digit: string): string => `arc_${digit.repeat(32)}`;
const arc = (digit: string, source: string, target: string, distanceMm: number, extras: Partial<NetworkArc> = {}): NetworkArc => ({
  id: digit, key: key(digit), source, target, direction: "FORWARD", headingMicrodegrees: 0,
  distanceMm, durationMs: distanceMm * 2, riskMicroUnits: distanceMm * 3, energyMwh: distanceMm * 4,
  combinedCostUnits: distanceMm * 5, conditionPenaltyUnits: 0, ...extras
});
const network = (arcs: NetworkArc[], turnRules: TurnRule[] = []): LoadedNetwork => ({
  routingSnapshot: snapshot, graph: {}, arcs, turnRules,
  dataSnapshot: {
    capturedAt: snapshot.capturedAt!, consistency: "PINNED", scopeDigest: `sha256:${"3".repeat(64)}`,
    resources: [{ authority: "test", pinning: "PINNED", referenceKey: { namespace: "gowm", kind: "DATASET", id: `wrf_${"4".repeat(32)}`, version: "v1" } }]
  }
});

describe("gowm.network provider", () => {
  it("registers the frozen operation set and raw schema-byte hashes", () => {
    const provider = createNetworkProvider({ pool: unavailablePool });
    const frozen = JSON.parse(readFileSync(resolve("contracts/gowm-v0.5/manifests/providers/network-provider.json"), "utf8")) as { operations: Array<Record<string, string>> };
    expect(provider.runtime.manifest.provider.providerId).toBe("gowm.network");
    expect(provider.runtime.manifest.capabilities).toHaveLength(11);
    expect(provider.runtime.manifest.capabilities.map((item) => item.operationId)).toEqual(frozen.operations.map((item) => item.operationId));
    for (const [index, descriptor] of provider.runtime.manifest.capabilities.entries()) {
      const lock = frozen.operations[index]!;
      expect(descriptor).toMatchObject({ operationId: lock.operationId, operationVersion: lock.operationVersion, maturity: lock.maturity, inputSchemaHash: lock.inputSchemaHash, outputSchemaHash: lock.outputSchemaHash, scopePolicy: "DATA_SCOPE_REQUIRED" });
      for (const direction of ["input", "output"] as const) {
        const file = lock[`${direction}SchemaFile`];
        const expected = `sha256:${createHash("sha256").update(readFileSync(resolve(file!))).digest("hex")}`;
        expect(lock[`${direction}SchemaHash`]).toBe(expected);
      }
    }
  });

  it("computes exact partial directed paths and bounded matrices", () => {
    const a = arc("a", "n1", "n2", 100);
    const b = arc("b", "n2", "n3", 200);
    const result = shortestPath(network([a, b]), { arcKey: a.key, fractionPpm: 250_000, direction: "FORWARD" }, { arcKey: b.key, fractionPpm: 500_000, direction: "FORWARD" }, "SHORTEST_DISTANCE", 10);
    expect(result.status).toBe("COMPLETED");
    expect(result.segments).toEqual([
      expect.objectContaining({ arcKey: a.key, startFractionPpm: 250_000, endFractionPpm: 1_000_000, distanceMm: 75 }),
      expect.objectContaining({ arcKey: b.key, startFractionPpm: 0, endFractionPpm: 500_000, distanceMm: 100 })
    ]);
    expect((result.metrics as Record<string, number>).distanceMm).toBe(175);
    const output = matrix(network([a, b]), [
      { arcKey: a.key, fractionPpm: 250_000, direction: "FORWARD" },
      { arcKey: b.key, fractionPpm: 500_000, direction: "FORWARD" }
    ], "SHORTEST_DISTANCE", 10, Date.now, Number.POSITIVE_INFINITY);
    expect(output.entries).toEqual([
      { fromIndex: 0, toIndex: 0, reachable: true, costUnits: 0 },
      { fromIndex: 0, toIndex: 1, reachable: true, costUnits: 175 },
      { fromIndex: 1, toIndex: 0, reachable: false },
      { fromIndex: 1, toIndex: 1, reachable: true, costUnits: 0 }
    ]);
    expect(() => shortestPath(network([a, b]), { arcKey: a.key, fractionPpm: 0, direction: "FORWARD" }, { arcKey: b.key, fractionPpm: 1_000_000, direction: "FORWARD" }, "SHORTEST_DISTANCE", 1)).toThrow(ProviderProtocolError);
  });

  it("enforces pairwise and multi-edge restrictions and charges a penalty once", () => {
    const a = arc("a", "n1", "n2", 10);
    const b = arc("b", "n2", "n3", 10);
    const c = arc("c", "n2", "n4", 20);
    const d = arc("d", "n4", "n3", 20);
    const e = arc("e", "n3", "n5", 10);
    const pairForbidden: TurnRule = { sequence: [a.key, b.key], ruleType: "FORBIDDEN", penaltyUnits: 0 };
    const detour = shortestPath(network([a, b, c, d, e], [pairForbidden]), { arcKey: a.key, fractionPpm: 0, direction: "FORWARD" }, { arcKey: e.key, fractionPpm: 1_000_000, direction: "FORWARD" }, "SHORTEST_DISTANCE", 10);
    expect((detour.segments as Array<Record<string, unknown>>).map((item) => item.arcKey)).toEqual([a.key, c.key, d.key, e.key]);

    const sequenceForbidden: TurnRule = { sequence: [a.key, b.key, e.key], ruleType: "FORBIDDEN", penaltyUnits: 0 };
    const sequenceDetour = shortestPath(network([a, b, c, d, e], [sequenceForbidden]), { arcKey: a.key, fractionPpm: 0, direction: "FORWARD" }, { arcKey: e.key, fractionPpm: 1_000_000, direction: "FORWARD" }, "SHORTEST_DISTANCE", 10);
    expect((sequenceDetour.segments as Array<Record<string, unknown>>).map((item) => item.arcKey)).toEqual([a.key, c.key, d.key, e.key]);
    const crossLeg = shortestPath(network([b, e], [sequenceForbidden]), { arcKey: b.key, fractionPpm: 500_000, direction: "FORWARD" }, { arcKey: e.key, fractionPpm: 1_000_000, direction: "FORWARD" }, "SHORTEST_DISTANCE", 10, false, Date.now, Number.POSITIVE_INFINITY, new Set(), [a.key, b.key]);
    expect(crossLeg.status).toBe("NO_PATH");

    const penalty: TurnRule = { sequence: [a.key, b.key], ruleType: "PENALTY", penaltyUnits: 7 };
    const penalized = shortestPath(network([a, b, e], [penalty]), { arcKey: a.key, fractionPpm: 0, direction: "FORWARD" }, { arcKey: e.key, fractionPpm: 1_000_000, direction: "FORWARD" }, "WEIGHTED", 10);
    expect((penalized.metrics as Record<string, number>).combinedCostUnits).toBe(157);
    expect((penalized.segments as Array<Record<string, number>>).reduce((sum, item) => sum + (item.turnPenaltyUnits ?? 0), 0)).toBe(7);
  });

  it("independently rejects continuity, turn, metric, and result-hash mutations", () => {
    const a = arc("a", "n1", "n2", 10);
    const b = arc("b", "n2", "n3", 10);
    const result = shortestPath(network([a, b]), { arcKey: a.key, fractionPpm: 0, direction: "FORWARD" }, { arcKey: b.key, fractionPpm: 1_000_000, direction: "FORWARD" }, "SHORTEST_DISTANCE", 10);
    expect(verifyPath(network([a, b]), result).status).toBe("VALID");
    const mutated = structuredClone(result);
    (mutated.segments as Array<Record<string, unknown>>)[1]!.distanceMm = 999;
    expect(verifyPath(network([a, b]), mutated).status).toBe("INVALID");
    const forbiddenNetwork = network([a, b], [{ sequence: [a.key, b.key], ruleType: "FORBIDDEN", penaltyUnits: 0 }]);
    const { resultHash: _ignored, ...replayCore } = result;
    const turnMutated = { ...replayCore, resultHash: sha256(replayCore) };
    expect((verifyPath(forbiddenNetwork, turnMutated).checks as Array<Record<string, string>>).find((item) => item.code === "TURN_LEGALITY")?.status).toBe("FAIL");
  });
});
