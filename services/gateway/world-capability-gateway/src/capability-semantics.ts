import { canonicalSha256, validateContract, type CapabilityDescriptor, type CapabilitySemanticCatalogV1 } from "../../../../packages/platform/contract-runtime/src/index.js";

/** Pure projection of explicit provider contracts. Legacy descriptors are omitted, never inferred. */
export function projectCapabilitySemantics(
  descriptors: readonly CapabilityDescriptor[], contractCatalogRevision: string, bindingRevision = contractCatalogRevision
): CapabilitySemanticCatalogV1 {
  const profiles = descriptors.filter((c) => c.semanticProfile !== undefined).map((c) => {
    const semanticProfile = structuredClone(c.semanticProfile!);
    if (!validateContract("urn:gowm:v0.6.2:capability-semantic-profile", semanticProfile).valid) throw new Error("Invalid explicit semantic profile");
    return { operationId: c.operationId, operationVersion: c.operationVersion, semanticProfile, semanticProfileHash: canonicalSha256(semanticProfile) };
  }).sort((a,b) => `${a.operationId}@${a.operationVersion}`.localeCompare(`${b.operationId}@${b.operationVersion}`));
  return { schemaVersion: "1.1", registryRevision: contractCatalogRevision, contractCatalogRevision, bindingRevision, profiles, catalogHash: canonicalSha256(profiles) };
}
