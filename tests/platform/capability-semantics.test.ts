import { describe, expect, it } from "vitest";
import type { CapabilityDescriptor } from "../../packages/platform/contract-runtime/src/index.js";
import { projectCapabilitySemantics } from "../../services/gateway/world-capability-gateway/src/capability-semantics.js";

function descriptor(operationId: string): CapabilityDescriptor {
  return {
    operationId, operationVersion: "1.0", semanticRole: "DOMAIN_ANALYSIS", dataBinding: "WORLD_SNAPSHOT_BOUND",
    resultSemantics: "DERIVED_ANALYSIS", executionBindings: ["SYNC_HTTP"], criticalPathPolicy: "REMOTE_ONLY", maturity: "STABLE",
    inputSchemaUri: "urn:test:input", inputSchemaHash: `sha256:${"1".repeat(64)}`,
    outputSchemaUri: "urn:test:output", outputSchemaHash: `sha256:${"2".repeat(64)}`,
    scopePolicy: "DATA_SCOPE_REQUIRED", execution: { mode: "SYNC", defaultTimeoutMs: 1000, maximumTimeoutMs: 1000, costClass: "LOW" },
    limits: { maximumInputBytes: 1, maximumOutputBytes: 1, maximumRows: 1, maximumCandidates: 1 },
    snapshotPolicy: { dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" },
    ports: { inputs: [], outputs: [] }
  };
}

describe("capability semantic projection", () => {
  it("projects only current registry entries with deterministic candidate/exact semantics", () => {
    const descriptors = [descriptor("h3.geometry.cover"), descriptor("spatial.find-in-area"), descriptor("coverage.road.plan")];
    const first = projectCapabilitySemantics(descriptors, "registry-7");
    const second = projectCapabilitySemantics([...descriptors].reverse(), "registry-7");
    expect(first).toEqual(second);
    expect(first.profiles.find((item) => item.operationId === "h3.geometry.cover")).toMatchObject({ spatialSemantics: "CANDIDATE", exactVerificationOperation: "spatial.find-intersections" });
    expect(first.profiles.find((item) => item.operationId === "spatial.find-in-area")).toMatchObject({ spatialSemantics: "EXACT", relationSemantics: ["INSIDE"] });
    expect(first.profiles.find((item) => item.operationId === "coverage.road.plan")).toMatchObject({ resultNature: "PLAN", freshnessSemantics: "SNAPSHOT_CURRENTNESS" });
    expect(first.catalogHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(projectCapabilitySemantics(descriptors.slice(1), "registry-8").profiles.some((item) => item.operationId === "h3.geometry.cover")).toBe(false);
  });
});
