import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalSha256, validateContract } from "../../packages/platform/contract-runtime/src/index.js";

const manifest = JSON.parse(readFileSync(new URL("../../contracts/manifests/providers/spatial-provider.json", import.meta.url), "utf8"));
export const profile = {
  profileVersion: "1.0", domain: "SPATIAL", acceptedReferenceKinds: [], producedReferenceKinds: [],
  relationSemantics: ["INTERSECTS"], spatialSemantics: "EXACT", timeSemantics: "SNAPSHOT",
  resultNature: "FACT", negativeEvidencePolicy: "NO_DATA_IS_UNKNOWN", freshnessSemantics: "SNAPSHOT_CURRENTNESS"
};

describe("explicit Manifest 1.1 contract", () => {
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
