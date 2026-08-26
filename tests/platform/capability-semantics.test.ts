import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogRevisions, semanticVocabularyHash, validateContract, type CapabilityDescriptor, type CapabilityProviderManifest } from "../../packages/platform/contract-runtime/src/index.js";
import { buildGatewayApp } from "../../services/gateway/world-capability-gateway/src/app.js";
import { projectCapabilitySemantics } from "../../services/gateway/world-capability-gateway/src/capability-semantics.js";
import { CapabilityRegistry } from "../../services/gateway/world-capability-gateway/src/registry.js";
import type { ProviderClient } from "../../services/gateway/world-capability-gateway/src/types.js";
import { createSouthboundOperationLock } from "../../scripts/generate-wsgs-operation-lock.js";

const sourceSlugs = ["reference-catalog", "world-evidence", "spatial", "h3-interactive", "network", "route", "road-coverage", "platform-validation", "dataset-catalog"];
const officialDescriptors: CapabilityDescriptor[] = sourceSlugs.flatMap((slug) => JSON.parse(readFileSync(new URL(`../../contracts/manifests/providers/${slug}-provider.json`, import.meta.url), "utf8")).capabilities);
function descriptor(operationId: string): CapabilityDescriptor {
  const declared = officialDescriptors.find((c) => c.operationId === operationId);
  if (!declared) throw new Error(`Missing official test contract ${operationId}`);
  return structuredClone(declared);
}
const revision = `sha256:${"7".repeat(64)}`;

describe("capability semantic projection", () => {
  it("admits Stable consumer operations only after all gates and segregates Preview from Experimental", () => {
    const pending = createSouthboundOperationLock(officialDescriptors,revision,false);
    expect(pending.defaultOperations).toEqual([]);
    const admitted = createSouthboundOperationLock(officialDescriptors,revision,true);
    expect(admitted.defaultOperations.map((c)=>c.operationId)).toEqual(officialDescriptors.filter((c)=>c.maturity==="STABLE").map((c)=>c.operationId).sort());
    expect(admitted.previewOperations.every((c)=>c.maturity==="PREVIEW")).toBe(true);
    expect([...admitted.defaultOperations,...admitted.previewOperations].some((c)=>c.operationId==="spatial.join")).toBe(false);
    expect(JSON.stringify(admitted)).not.toMatch(/providerId|https?:|transportToken|containerName|SELECT\s.+FROM/iu);
    expect(createSouthboundOperationLock([...officialDescriptors].reverse(),revision,true)).toEqual(admitted);
    expect(() => createSouthboundOperationLock([{...descriptor("route.plan"),semanticProfile:undefined} as never],revision,true)).toThrow("missing explicit semantics");
  });
  it("projects only current registry entries with deterministic candidate/exact semantics", () => {
    const descriptors = [descriptor("h3.geometry.cover"), descriptor("spatial.find-in-area"), descriptor("coverage.road.plan")];
    const first = projectCapabilitySemantics(descriptors, revision);
    const second = projectCapabilitySemantics([...descriptors].reverse(), revision);
    expect(first).toEqual(second);
    expect(first.profiles.find((item) => item.operationId === "h3.geometry.cover")).toMatchObject({ semanticProfile: { spatialSemantics: "CANDIDATE", exactVerification: { operationId: "spatial.find-intersections", operationVersion: "1.0" } } });
    expect(first.profiles.find((item) => item.operationId === "spatial.find-in-area")).toMatchObject({ semanticProfile: { spatialSemantics: "EXACT", relationSemantics: ["INSIDE"] } });
    expect(first.profiles.find((item) => item.operationId === "coverage.road.plan")).toMatchObject({ semanticProfile: { resultNature: "PLAN", freshnessSemantics: "SNAPSHOT_CURRENTNESS" } });
    expect(first.catalogHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(projectCapabilitySemantics(descriptors.slice(1), revision).profiles.some((item) => item.operationId === "h3.geometry.cover")).toBe(false);
  });

  it("serves the ten locked semantic profiles from the live Gateway registry", async () => {
    const operationIds = [
      "reference.resolve", "world.get-current-state", "spatial.find-in-area", "h3.geometry.cover",
      "network.snap.point", "route.plan", "coverage.road.plan", "result.validate",
      "snapshot.validate", "catalog.search"
    ];
    const manifest: CapabilityProviderManifest = {
      providerProtocolVersion: "1.0", manifestSchemaVersion: "1.1",
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
    const registry = new CapabilityRegistry({ profile: "world-platform" });
    registry.register({ approvalId: "semantic-projection-test", approved: true, endpoint: new URL("http://127.0.0.1:36200/"), client, manifest });
    const app = buildGatewayApp({ registry, directExecution: {} as never, authenticate: async () => ({ principalRef: "test", authenticationMethod: "TEST", authenticatedAt: new Date(0).toISOString() }) });
    try {
      const response = await app.inject({ method: "GET", url: "/v1/capability-semantics" });
      expect(response.statusCode).toBe(200);
      const catalog = response.json();
      expect(catalog.profiles.map((profile: { operationId: string }) => profile.operationId).sort()).toEqual([...operationIds].sort());
      expect(catalog.profiles.find((profile: { operationId: string }) => profile.operationId === "h3.geometry.cover")).toMatchObject({ semanticProfile: { spatialSemantics: "CANDIDATE", exactVerification: { operationId: "spatial.find-intersections", operationVersion: "1.0" } } });
      expect(catalog.profiles.find((profile: { operationId: string }) => profile.operationId === "coverage.road.plan")).toMatchObject({ semanticProfile: { resultNature: "PLAN", freshnessSemantics: "SNAPSHOT_CURRENTNESS" } });
      const detail = await app.inject({ method: "GET", url: "/v1/capability-semantics/coverage.road.plan/1.0" });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ operationId: "coverage.road.plan", operationVersion: "1.0" });
    } finally {
      await app.close();
    }
  });
});

describe("content addressed catalog and explicit registry compatibility", () => {
  function manifest(slug = "spatial"): CapabilityProviderManifest {
    return JSON.parse(readFileSync(new URL(`../../contracts/manifests/providers/${slug}-provider.json`, import.meta.url), "utf8"));
  }
  function binding(m: CapabilityProviderManifest, port = 36200, ready = true) {
    return {
      manifest: m, approvalId: `approved-${m.provider.providerId}`, approved: true, endpoint: new URL(`http://127.0.0.1:${port}/`),
      client: { providerId: m.provider.providerId, manifest: async () => m,
        health: async () => ({ live: ready, ready, checkedAt: new Date().toISOString() }),
        execute: async () => { throw new Error("unit metadata test must not execute IO"); } } satisfies ProviderClient
    };
  }
  it("is invariant to provider/operation ordering, endpoint, health and Gateway restart", async () => {
    const a = manifest(), b = manifest("reference-catalog");
    const first = new CapabilityRegistry({ profile: "world-platform" });
    first.register(binding(a)); first.register(binding(b, 36201));
    const restarted = new CapabilityRegistry({ profile: "world-platform" });
    restarted.register(binding(b, 36301, false)); restarted.register(binding(a, 36300, false));
    expect(await first.health()).not.toEqual(await restarted.health());
    expect(first.contractCatalogRevision).toEqual(restarted.contractCatalogRevision);
    expect(first.bindingRevision).toEqual(restarted.bindingRevision);
    const unordered = structuredClone(a); unordered.capabilities.reverse();
    expect(catalogRevisions([binding(a)]).contractCatalogRevision).toEqual(catalogRevisions([binding(unordered)]).contractCatalogRevision);
    const before = first.revision;
    a.capabilities[0]!.semanticProfile!.notes = ["external mutation must not affect the registered contract"];
    expect(first.revision).toBe(before);
    expect(first.catalog()[0]!.semanticProfile?.notes).not.toBe(a.capabilities[0]!.semanticProfile!.notes);
  });
  it("changes contract revision for profile, schema, maturity and vocabulary; binding identity stays separate", () => {
    const base = manifest(), initial = catalogRevisions([binding(base)]);
    for (const mutate of [
      (m: CapabilityProviderManifest) => { m.capabilities[0]!.semanticProfile!.notes = ["explicit boundary contract change"]; },
      (m: CapabilityProviderManifest) => { m.capabilities[0]!.inputSchemaHash = `sha256:${"e".repeat(64)}`; },
      (m: CapabilityProviderManifest) => { m.capabilities[0]!.maturity = "DEPRECATED"; }
    ]) { const changed = structuredClone(base); mutate(changed); expect(catalogRevisions([binding(changed)]).contractCatalogRevision).not.toBe(initial.contractCatalogRevision); }
    expect(catalogRevisions([binding(base)], `${semanticVocabularyHash}-new-version`).contractCatalogRevision).not.toBe(initial.contractCatalogRevision);
    const changed = structuredClone(base); changed.provider.implementationDigest = `sha256:${"d".repeat(64)}`;
    const rebound = catalogRevisions([{ ...binding(changed), approvalId: "new-approval" }]);
    expect(rebound.contractCatalogRevision).toBe(initial.contractCatalogRevision);
    expect(rebound.bindingRevision).not.toBe(initial.bindingRevision);
    const oldProfile = projectCapabilitySemantics(base.capabilities, initial.contractCatalogRevision, initial.bindingRevision);
    changed.capabilities[0]!.semanticProfile!.notes = ["changed"];
    const newProfile = projectCapabilitySemantics(changed.capabilities, revision);
    expect(newProfile.catalogHash).not.toBe(oldProfile.catalogHash);
    const key = changed.capabilities[0]!.operationId;
    expect(newProfile.profiles.find((p) => p.operationId === key)!.semanticProfileHash).not.toBe(oldProfile.profiles.find((p) => p.operationId === key)!.semanticProfileHash);
    expect(validateContract("urn:gowm:v0.6.2:capability-semantic-catalog", oldProfile).valid).toBe(true);
  });
  it("keeps legacy direct routing without projecting any implicit semantics and rejects it in world-platform", () => {
    const legacy = manifest(); delete legacy.manifestSchemaVersion;
    for (const c of legacy.capabilities) delete c.semanticProfile;
    const compatible = new CapabilityRegistry(); compatible.register(binding(legacy));
    expect(compatible.resolve(legacy.capabilities[0]!.operationId, "1.0")).toBeDefined();
    expect(compatible.semanticDescriptors()).toEqual([]);
    expect(projectCapabilitySemantics(compatible.catalog(), compatible.revision).profiles).toEqual([]);
    const strict = new CapabilityRegistry({ profile: "world-platform" });
    expect(() => strict.register(binding(legacy))).toThrow("Manifest 1.1");
    legacy.manifestSchemaVersion = "1.1";
    expect(() => strict.register(binding(legacy))).toThrow("manifest is invalid");
    const explicit = manifest(); strict.register(binding(explicit));
    const duplicate = structuredClone(explicit); duplicate.provider.providerId = "gowm.duplicate";
    expect(() => strict.register(binding(duplicate))).toThrow("already registered");
  });
});
