import type { CapabilityProviderManifest } from "../../contract-runtime/src/index.js";
import { assertContract, validateSemanticManifest } from "../../contract-runtime/src/index.js";
import { sha256 } from "./canonical.js";
import { ProviderProtocolError } from "./errors.js";
import type { ProviderOperation } from "./types.js";

export function assertManifestMatchesOperations(
  manifest: CapabilityProviderManifest,
  operations: readonly ProviderOperation[]
): void {
  assertContract("capability-provider-manifest.schema.json", manifest);
  const semantic = validateSemanticManifest(manifest);
  if (!semantic.valid) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider manifest fails semantic validation", {
      details: { issues: semantic.issues }
    });
  }
  const byKey = new Map(operations.map((operation) => [
    `${operation.descriptor.operationId}@${operation.descriptor.operationVersion}`,
    operation
  ]));
  if (byKey.size !== operations.length) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider runtime has duplicate operation id/version");
  }
  for (const descriptor of manifest.capabilities) {
    const key = `${descriptor.operationId}@${descriptor.operationVersion}`;
    const operation = byKey.get(key);
    if (!operation) throw new ProviderProtocolError("SCHEMA_MISMATCH", `manifest operation ${key} has no handler`);
    if (operation.descriptor !== descriptor && JSON.stringify(operation.descriptor) !== JSON.stringify(descriptor)) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", `runtime descriptor ${key} differs from manifest`);
    }
    if (sha256(operation.inputSchema) !== descriptor.inputSchemaHash) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", `input schema hash mismatch for ${key}`);
    }
    if (sha256(operation.outputSchema) !== descriptor.outputSchemaHash) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", `output schema hash mismatch for ${key}`);
    }
    byKey.delete(key);
  }
  if (byKey.size) {
    throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider runtime exposes handlers absent from its manifest", {
      details: { operations: [...byKey.keys()] }
    });
  }
}
