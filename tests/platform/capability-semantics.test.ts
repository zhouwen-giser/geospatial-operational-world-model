import { describe, expect, it } from "vitest";
import type { CapabilityDescriptor, CapabilityProviderManifest } from "../../packages/platform/contract-runtime/src/index.js";
import { buildGatewayApp } from "../../services/gateway/world-capability-gateway/src/app.js";
import { projectCapabilitySemantics } from "../../services/gateway/world-capability-gateway/src/capability-semantics.js";
import { CapabilityRegistry } from "../../services/gateway/world-capability-gateway/src/registry.js";
import type { ProviderClient } from "../../services/gateway/world-capability-gateway/src/types.js";

function descriptor(operationId: string): CapabilityDescriptor {
  return {
    operationId, operationVersion: "1.0", semanticRole: "DOMAIN_ANALYSIS", dataBinding: "WORLD_SNAPSHOT_BOUND",
    resultSemantics: "DERIVED_ANALYSIS", executionBindings: ["SYNC_HTTP"], criticalPathPolicy: "REMOTE_ONLY", maturity: "STABLE",
    inputSchemaUri: "urn:test:input", inputSchemaHash: `sha256:${"1".repeat(64)}`,
    outputSchemaUri: "urn:test:output", outputSchemaHash: `sha256:${"2".repeat(64)}`,
    scopePolicy: "DATA_SCOPE_REQUIRED", execution: { mode: "SYNC", defaultTimeoutMs: 1000, maximumTimeoutMs: 1000, costClass: "LOW" },
    limits: { maximumInputBytes: 1, maximumOutputBytes: 1, maximumRows: 1, maximumCandidates: 1 },
    snapshotPolicy: { dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{ name: "request", schemaUri: "urn:test:input", schemaHash: `sha256:${"1".repeat(64)}`, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }],
      outputs: [{ name: "result", schemaUri: "urn:test:output", schemaHash: `sha256:${"2".repeat(64)}`, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }]
    }
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

  it("serves the ten locked semantic profiles from the live Gateway registry", async () => {
    const operationIds = [
      "reference.resolve", "world.get-current-state", "spatial.find-in-area", "h3.geometry.cover",
      "network.snap.point", "route.plan", "coverage.road.plan", "result.validate",
      "snapshot.validate", "catalog.search"
    ];
    const manifest: CapabilityProviderManifest = {
      providerProtocolVersion: "1.0",
      provider: { providerId: "gowm.semantic-projection-fixture", providerVersion: "1.0.0", owner: "gowm-platform", implementationDigest: `sha256:${"f".repeat(64)}` },
      endpoints: { manifest: "/v1/manifest", liveness: "/health/live", readiness: "/health/ready", execute: "/v1/operations/{operationId}:execute", job: "/v1/jobs/{jobId}" },
      capabilities: operationIds.map(descriptor)
    };
    const client: ProviderClient = {
      providerId: manifest.provider.providerId,
      async manifest() { return manifest; },
      async health() { return { live: true, ready: true, checkedAt: new Date(0).toISOString() }; },
      async execute() { throw new Error("semantic projection test never executes a Provider"); }
    };
    const registry = new CapabilityRegistry();
    registry.register({ approvalId: "semantic-projection-test", approved: true, endpoint: new URL("http://127.0.0.1:36200/"), client, manifest });
    const app = buildGatewayApp({ registry, directExecution: {} as never, authenticate: async () => ({ principalRef: "test", authenticationMethod: "TEST", authenticatedAt: new Date(0).toISOString() }) });
    try {
      const response = await app.inject({ method: "GET", url: "/v1/capability-semantics" });
      expect(response.statusCode).toBe(200);
      const catalog = response.json();
      expect(catalog.profiles.map((profile: { operationId: string }) => profile.operationId).sort()).toEqual([...operationIds].sort());
      expect(catalog.profiles.find((profile: { operationId: string }) => profile.operationId === "h3.geometry.cover")).toMatchObject({ spatialSemantics: "CANDIDATE", exactVerificationOperation: "spatial.find-intersections" });
      expect(catalog.profiles.find((profile: { operationId: string }) => profile.operationId === "coverage.road.plan")).toMatchObject({ resultNature: "PLAN", freshnessSemantics: "SNAPSHOT_CURRENTNESS" });
      const detail = await app.inject({ method: "GET", url: "/v1/capability-semantics/coverage.road.plan/1.0" });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ operationId: "coverage.road.plan", operationVersion: "1.0" });
    } finally {
      await app.close();
    }
  });
});
