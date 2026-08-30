import { canonicalSha256 } from "./canonical-json.js";
import { compareUnicodeCodePoints } from "./canonical-order.js";
import type { CapabilityProviderManifest } from "./generated/contracts.js";
import references from "../../../../contracts/gowm-v0.7/vocabularies/reference-kind-vocabulary.v2.json" with { type: "json" };
import relations from "../../../../contracts/gowm-v0.6.2/vocabularies/relation-semantic-vocabulary.v1.json" with { type: "json" };
import statuses from "../../../../contracts/gowm-v0.6.2/vocabularies/normalized-result-status-vocabulary.v1.json" with { type: "json" };

export const semanticVocabularyHash = canonicalSha256({ references, relations, statuses });
export interface CatalogBindingIdentity { manifest: CapabilityProviderManifest; approvalId: string }
export function catalogRevisions(bindings: readonly CatalogBindingIdentity[], vocabularyHash = semanticVocabularyHash) {
  const ordered = [...bindings].sort((a,b) => compareUnicodeCodePoints(a.manifest.provider.providerId, b.manifest.provider.providerId));
  const contracts = ordered.map(({ manifest }) => ({
    providerId: manifest.provider.providerId,
    providerVersion: manifest.provider.providerVersion,
    manifestSchemaVersion: manifest.manifestSchemaVersion ?? "1.0",
    capabilities: [...manifest.capabilities].sort((a,b) => compareUnicodeCodePoints(`${a.operationId}@${a.operationVersion}`, `${b.operationId}@${b.operationVersion}`)).map((c) => ({ operationId: c.operationId, operationVersion: c.operationVersion, contractHash: canonicalSha256(c) }))
  }));
  const bindingIdentities = ordered.map(({ manifest, approvalId }) => ({
    providerId: manifest.provider.providerId, providerVersion: manifest.provider.providerVersion,
    implementationDigest: manifest.provider.implementationDigest, manifestHash: canonicalSha256(manifest), approvalId
  }));
  return { contractCatalogRevision: canonicalSha256({ vocabularyHash, providers: contracts }), bindingRevision: canonicalSha256(bindingIdentities) };
}
