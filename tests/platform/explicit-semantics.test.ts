import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalSha256, validateContract } from "../../packages/platform/contract-runtime/src/index.js";
import type { CapabilityDescriptor } from "../../packages/platform/contract-runtime/src/index.js";
import { EMPTY_EVIDENCE, checkSemanticRules, checkCrossCapability, inspectSchema, inspectSql, inspectTypeScript, materializeProfile, operationKey, validateVocabularyExtension, type ImplementationEvidence } from "../../packages/platform/semantic-conformance/src/index.js";

const manifest = JSON.parse(readFileSync(new URL("../../contracts/manifests/providers/spatial-provider.json", import.meta.url), "utf8"));
export const profile = {
  profileVersion: "1.0", domain: "SPATIAL", acceptedReferenceKinds: [], producedReferenceKinds: [],
  relationSemantics: ["INTERSECTS"], spatialSemantics: "EXACT", timeSemantics: "SNAPSHOT",
  resultNature: "FACT", negativeEvidencePolicy: "NO_DATA_IS_UNKNOWN", freshnessSemantics: "SNAPSHOT_CURRENTNESS"
};

describe("explicit Manifest 1.1 contract", () => {
  it("allows vocabulary additions but rejects removed or redefined meanings", () => {
    const baseline={vocabularyId:"test",terms:[{id:"INSIDE",definition:"exact covered-by"}]};
    expect(validateVocabularyExtension(baseline,{...baseline,terms:[...baseline.terms,{id:"NEW",definition:"new meaning"}]})).toEqual([]);
    expect(validateVocabularyExtension(baseline,{...baseline,terms:[]})).toHaveLength(1);
    expect(validateVocabularyExtension(baseline,{...baseline,terms:[{id:"INSIDE",definition:"bbox overlap"}]})).toHaveLength(1);
    expect(validateVocabularyExtension(baseline,{...baseline,terms:[...baseline.terms,...baseline.terms]})).toHaveLength(1);
  });
  it("keeps legacy execution manifests parseable, but requires every 1.1 profile", () => {
    const legacy = structuredClone(manifest);
    delete legacy.manifestSchemaVersion;
    for (const c of legacy.capabilities) delete c.semanticProfile;
    expect(validateContract("capability-provider-manifest.schema.json", legacy).valid).toBe(true);
    const explicit = { ...legacy, manifestSchemaVersion: "1.1" };
    expect(validateContract("capability-provider-manifest.schema.json", explicit).valid).toBe(false);
    explicit.capabilities = explicit.capabilities.map((c: object) => ({ ...c, semanticProfile: profile }));
    expect(validateContract("capability-provider-manifest.schema.json", explicit).valid).toBe(true);
    expect(validateContract("urn:gowm:v0.6.2:capability-provider-manifest-v1.1", explicit).valid).toBe(true);
    expect(validateContract("urn:gowm:v0.6.2:capability-provider-manifest-v1.1", legacy).valid).toBe(false);
    expect(validateContract("capability-provider-manifest.schema.json", { ...explicit, providerProtocolVersion: "1.1" }).valid).toBe(false);
    expect(canonicalSha256(explicit)).not.toBe(canonicalSha256(legacy));
  });

  it("rejects unknown reference, relation and normalized-status terms and missing fields", () => {
    for (const bad of [
      { ...profile, acceptedReferenceKinds: ["DEVICE"] },
      { ...profile, relationSemantics: ["WITHIN"] },
      { ...profile, relationSemantics: ["IN_AREA"] },
      { ...profile, domainStatus: { path: "/status", mapping: { NO_DATA: "FALSE" } } },
      { ...profile, spatialSemantics: undefined },
      { ...profile, relationSemantics: ["INTERSECTS", "INTERSECTS"] }
    ]) expect(validateContract("urn:gowm:v0.6.2:capability-semantic-profile", bad).valid).toBe(false);
  });
});

describe("offline semantic rules and implementation evidence", () => {
  function base(): { c: CapabilityDescriptor; e: ImplementationEvidence } {
    const c = structuredClone(manifest.capabilities.find((c: CapabilityDescriptor) => c.operationId === "spatial.find-intersections"));
    c.semanticProfile = structuredClone(profile);
    return { c, e: { ...EMPTY_EVIDENCE, exactSpatial: true, implementation: true, blackBox: true } };
  }
  const cases: Array<[string, (c: CapabilityDescriptor, e: ImplementationEvidence) => void]> = [
    ["S001", (_c, e) => { e.referenceInput = true; }],
    ["S002", (_c, e) => { e.referenceOutput = true; }],
    ["S003", (c) => { c.semanticProfile!.freshnessSemantics = "NONE"; }],
    ["S004", (c) => { c.dataBinding = "WORLD_INDEPENDENT"; c.resultSemantics = "TRANSFORMATION"; }],
    ["S005", (_c, e) => { e.candidateOnly = true; }],
    ["S006", (c) => { c.semanticProfile!.exactVerification = { operationId: "absent.verifier", operationVersion: "1.0" }; }],
    ["S007", (c) => { delete (c.semanticProfile as any).negativeEvidencePolicy; }],
    ["S008", (c, e) => { e.domainStatuses = ["NO_DATA"]; c.semanticProfile!.domainStatus = { path: "/status", mapping: { NO_DATA: "COMPLETED" } }; }],
    ["S009", (_c, e) => { e.exactSpatial = false; }],
    ["S010", (c) => { c.semanticProfile!.relationSemantics = ["NEAR"]; }],
    ["S011", (c) => { c.semanticProfile!.resultNature = "PLAN"; }],
    ["S012", (c, e) => { c.resultSemantics = "DERIVED_ANALYSIS"; c.semanticProfile!.resultNature = "PLAN"; c.semanticProfile!.freshnessSemantics = "NONE"; e.outputFeatures = ["validUntil"]; }],
    ["S013", (c) => { c.scopePolicy = "REQUEST_CONTEXT"; }],
    ["S014", (c, e) => { c.maturity = "STABLE"; e.blackBox = false; }]
  ];
  it.each(cases)("%s accepts the complete contract and rejects contrary evidence", (rule, mutate) => {
    const { c, e } = base();
    expect(checkSemanticRules(c, e)).toEqual([]);
    mutate(c, e);
    const failures = checkSemanticRules(c, e);
    expect(failures.some((f) => f.rule === rule)).toBe(true);
    expect(checkSemanticRules(c, e)).toEqual(failures);
  });
  it("distinguishes unresolved evidence, conflict and deterministic resolved output without mutating inputs", () => {
    const { c, e } = base(), original = structuredClone(c);
    expect(materializeProfile({ descriptor: c, evidence: e, catalog: [c] }).status).toBe("INSUFFICIENT_CONTRACT");
    expect(materializeProfile({ descriptor: c, declaration: c.semanticProfile!, evidence: { ...e, exactSpatial: false }, catalog: [c] }).status).toBe("CONFLICT");
    const input = { descriptor: c, declaration: c.semanticProfile!, evidence: e, catalog: [c] };
    expect(materializeProfile(input)).toEqual(materializeProfile(input));
    expect(materializeProfile(input).status).toBe("RESOLVED");
    expect(c).toEqual(original);
  });
  it("uses SQL AST so comments and literals cannot forge an exact predicate", async () => {
    expect((await inspectSql("SELECT a && b FROM spatial_data /* ST_Intersects(a,b) */")).bboxOnly).toBe(true);
    expect((await inspectSql("SELECT 'ST_Within(a,b)' FROM spatial_data")).exact).toBe(false);
    const exact = await inspectSql("SELECT ST_Intersects(a,b) FROM spatial_data WHERE a && b");
    expect(exact.exact).toBe(true);
    expect(exact.bboxOnly).toBe(false);
    expect((await inspectSql("SELECT ST_DWithin(a::geography,b::geography,100,true)")).geographyDistance).toBe(true);
    await expect(inspectSql("invalid SQL !")).rejects.toThrow();
  });
  it("inspects TypeScript handlers and rejects static/dynamic sibling imports", () => {
    const result = inspectTypeScript('import { x } from "../../other/src/provider.js"; async function handle() { return import("../../other/src/repo.js"); }', "/repo/services/providers/own/src/provider.ts", "/repo");
    expect(result.symbols).toContain("handle");
    expect(result.siblingImports).toHaveLength(2);
    expect(result.diagnostics).toBe(0);
  });
  it("recognizes legacy generic ReferenceKey structures without inventing an enum", () => {
    const schema = { type:"object", required:["namespace","kind","id","version"], properties:Object.fromEntries(["namespace","kind","id","version"].map((k) => [k,{type:"string"}])) };
    const inspected = inspectSchema(schema, () => { throw new Error("unexpected ref"); });
    expect(inspected.referencePaths).toEqual([""]);
    expect(inspected.referenceKinds).toEqual([]);
    const { c,e } = base(); e.referenceOutput = inspected.referencePaths.length > 0;
    expect(checkSemanticRules(c,e).some((i) => i.rule === "S002")).toBe(true);
    const geometry = inspectSchema({type:"object",properties:{geometry:{oneOf:["Polygon","MultiPolygon"].map((type)=>({type:"object",required:["type","coordinates"],properties:{type:{const:type},coordinates:{type:"array"}}}))}}},()=>{throw new Error("unexpected ref");});
    expect(geometry.geometryTypes["/geometry"]).toEqual(["MultiPolygon","Polygon"]);
    expect(geometry.geometryTypes["/missing"]).toBeUndefined();
  });
  it("rejects duplicate operations, missing validators and cyclic or retired exact verification targets", () => {
    const { c, e } = base(), target = structuredClone(c);
    target.operationId = "test.exact-verifier";
    c.semanticProfile!.exactVerification = { operationId: target.operationId, operationVersion: "1.0" };
    target.semanticProfile!.exactVerification = { operationId: c.operationId, operationVersion: "1.0" };
    e.verificationPorts = true;
    expect(checkSemanticRules(c, e, [c,target]).some((i) => i.message.includes("cycle"))).toBe(true);
    delete target.semanticProfile!.exactVerification;
    target.maturity = "RETIRED";
    expect(checkSemanticRules(c, e, [c,target]).some((i) => i.rule === "S006")).toBe(true);
    const issues = checkCrossCapability([c,c], new Map([[operationKey(c),e]]));
    expect(issues.some((i) => i.message.includes("more than once"))).toBe(true);
    expect(issues.some((i) => i.message.includes("snapshot validator"))).toBe(true);
    c.semanticProfile!.producedReferenceKinds = ["QUERY_RESULT"];
    expect(checkCrossCapability([c], new Map([[operationKey(c),e]])).some((i) => i.message.includes("result validator"))).toBe(true);
  });
});
