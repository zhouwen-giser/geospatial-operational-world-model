import { ProviderProtocolError } from "./errors.js";

export type ScopePolicy = "IDENTITY_ONLY" | "REQUEST_CONTEXT" | "DATA_SCOPE_REQUIRED" | "DATASET_SCOPE_REQUIRED";

export interface TrustedSecurityContext {
  principalRef: string;
  dataScopeClaim?: string;
  datasetScopeClaims?: readonly string[];
  requestContext?: Readonly<Record<string, string>>;
}

export function assertTrustedScope(policy: ScopePolicy, context: TrustedSecurityContext): void {
  if (!context.principalRef.trim()) {
    throw new ProviderProtocolError("SCOPE_REQUIRED", "trusted principal identity is required");
  }
  if (policy === "DATA_SCOPE_REQUIRED" && !context.dataScopeClaim?.trim()) {
    throw new ProviderProtocolError("SCOPE_REQUIRED", "data scope claim is required");
  }
  if (policy === "DATASET_SCOPE_REQUIRED" && !(context.datasetScopeClaims?.length)) {
    throw new ProviderProtocolError("SCOPE_REQUIRED", "at least one dataset scope claim is required");
  }
}

export function assertDataScope(expected: string, context: TrustedSecurityContext): void {
  if (context.dataScopeClaim !== expected) {
    throw new ProviderProtocolError("SCOPE_DENIED", "requested resource is outside the trusted data scope");
  }
}

export function assertDatasetScope(expected: string, context: TrustedSecurityContext): void {
  if (!context.datasetScopeClaims?.includes(expected)) {
    throw new ProviderProtocolError("SCOPE_DENIED", "requested dataset is outside the trusted dataset scope");
  }
}
