import { validateContract, type CapabilitySemanticProfileV1 } from "../../contract-runtime/src/index.js";
import { ProviderProtocolError } from "./errors.js";

/** Exact lookup of provider-owned, offline materialized declarations. No inferred fields. */
export function declaredSemanticProfile(
  declarations: Readonly<Record<string, unknown>>, operationId: string, operationVersion: string
): CapabilitySemanticProfileV1 {
  const value = declarations[`${operationId}@${operationVersion}`];
  const result = validateContract("urn:gowm:v0.6.2:capability-semantic-profile", value);
  if (!result.valid) throw new ProviderProtocolError("SCHEMA_MISMATCH", `Explicit semantic declaration missing or invalid for ${operationId}@${operationVersion}`);
  return structuredClone(value) as CapabilitySemanticProfileV1;
}
