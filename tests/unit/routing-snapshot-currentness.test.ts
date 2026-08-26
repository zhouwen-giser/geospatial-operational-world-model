import { describe, expect, it } from "vitest";
import { RoutingSnapshotCurrentnessEvaluator, type RoutingSnapshot } from "../../packages/network-query-core/src/index.js";

const snapshot: RoutingSnapshot = {
  networkDatasetVersion: "roads/1", graphVersion: "graph/1", travelProfileVersion: "ugv/1", costProfileVersion: "cost/1",
  conditionSnapshotId: "conditions/1", sourceWorldVersion: 7,
  graphContentHash: `sha256:${"1".repeat(64)}`, costContentHash: `sha256:${"2".repeat(64)}`, conditionContentHash: `sha256:${"3".repeat(64)}`
};

describe("routing snapshot currentness", () => {
  it("keeps frozen plan validity separate when a condition becomes stale", () => {
    const evaluator = new RoutingSnapshotCurrentnessEvaluator();
    const result = evaluator.evaluate(snapshot, { ...snapshot, conditionSnapshotId: "conditions/2", conditionContentHash: `sha256:${"4".repeat(64)}` }, "2026-08-25T00:00:00.000Z");
    expect(result.currentness).toBe("STALE");
    expect(result.staleDimensions).toEqual(["CONDITION"]);
    expect(evaluator.planValidation("VALID", result)).toMatchObject({ planValidity: "VALID", currentness: "STALE", usable: "REVALIDATE", staleDimensions: ["CONDITION"] });
  });

  it("reports unknown source-world currentness independently", () => {
    const { sourceWorldVersion: _sourceWorldVersion, ...currentWithoutWorld } = snapshot;
    const result = new RoutingSnapshotCurrentnessEvaluator().evaluate(snapshot, currentWithoutWorld);
    expect(result.currentness).toBe("UNKNOWN");
    expect(result.dimensions.sourceWorld).toBe("UNKNOWN");
  });

  it.each([
    ["GRAPH", { graphVersion: "graph/2" }],
    ["TRAVEL_PROFILE", { travelProfileVersion: "ugv/2" }],
    ["COST_PROFILE", { costProfileVersion: "cost/2" }],
    ["CONDITION", { conditionSnapshotId: "conditions/2" }],
    ["SOURCE_WORLD", { sourceWorldVersion: 8 }]
  ] as const)("reports %s changes without mutating the frozen snapshot", (dimension, change) => {
    const requested = structuredClone(snapshot);
    const result = new RoutingSnapshotCurrentnessEvaluator().evaluate(requested, { ...snapshot, ...change });
    expect(result).toMatchObject({ currentness: "STALE", staleDimensions: [dimension], requestedSnapshot: snapshot });
    expect(requested).toEqual(snapshot);
  });

  it("distinguishes unavailable authority from an unknown optional condition", () => {
    const evaluator = new RoutingSnapshotCurrentnessEvaluator();
    expect(evaluator.evaluate(snapshot, undefined)).toMatchObject({ currentness: "UNAVAILABLE", staleDimensions: [] });
    const { conditionSnapshotId: _conditionId, conditionContentHash: _conditionHash, ...withoutCondition } = snapshot;
    expect(evaluator.evaluate(snapshot, withoutCondition)).toMatchObject({ currentness: "UNKNOWN", dimensions: { condition: "UNKNOWN" } });
  });
});
