import { canonicalSortStrings } from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { GatewayPrincipal } from "./types.js";

/**
 * Stable authorization and idempotency boundary for one trusted caller scope.
 * Authentication timestamps and methods deliberately do not alter replay
 * identity; changing either trusted scope claim does.
 */
export function principalContextHash(principal: Pick<
  GatewayPrincipal,
  "principalRef" | "servicePrincipalRef" | "actorRef" | "dataScopeClaim" | "datasetScopeClaim" | "effectiveDataScopes" | "effectiveDatasetScopes" | "allowedOperations"
>): `sha256:${string}` {
  const scopes = normalizePrincipalScopes(principal);
  return sha256({
    principalRef: principal.principalRef,
    servicePrincipalRef: principal.servicePrincipalRef ?? principal.principalRef,
    actorRef: principal.actorRef ?? principal.principalRef,
    effectiveDataScopes: scopes.effectiveDataScopes,
    effectiveDatasetScopes: scopes.effectiveDatasetScopes,
    allowedOperations: canonicalSortStrings(principal.allowedOperations ?? [])
  });
}

export function normalizePrincipalScopes(principal: Pick<
  GatewayPrincipal,
  "dataScopeClaim" | "datasetScopeClaim" | "effectiveDataScopes" | "effectiveDatasetScopes"
>): {
  effectiveDataScopes: readonly [] | readonly [string];
  effectiveDatasetScopes: readonly [] | readonly [string];
  dataScopeClaim?: string;
  datasetScopeClaim?: string;
} {
  const dataScopes = canonicalSortStrings(principal.effectiveDataScopes ?? (principal.dataScopeClaim === undefined ? [] : [principal.dataScopeClaim]));
  const datasetScopes = canonicalSortStrings(principal.effectiveDatasetScopes ?? (principal.datasetScopeClaim === undefined ? [] : [principal.datasetScopeClaim]));
  if (dataScopes.length > 1 || datasetScopes.length > 1) {
    throw scopeDenied("MULTI_SCOPE_UNSUPPORTED");
  }
  if (dataScopes.some((value) => value.trim().length === 0) || datasetScopes.some((value) => value.trim().length === 0)) {
    throw scopeDenied("EMPTY_SCOPE_UNSUPPORTED");
  }
  if (principal.dataScopeClaim !== undefined && dataScopes[0] !== principal.dataScopeClaim) {
    throw scopeDenied("DATA_SCOPE_ALIAS_MISMATCH");
  }
  if (principal.datasetScopeClaim !== undefined && datasetScopes[0] !== principal.datasetScopeClaim) {
    throw scopeDenied("DATASET_SCOPE_ALIAS_MISMATCH");
  }
  const effectiveDataScopes = dataScopes.length === 0 ? [] as const : [dataScopes[0]!] as const;
  const effectiveDatasetScopes = datasetScopes.length === 0 ? [] as const : [datasetScopes[0]!] as const;
  return {
    effectiveDataScopes,
    effectiveDatasetScopes,
    ...(effectiveDataScopes[0] === undefined ? {} : { dataScopeClaim: effectiveDataScopes[0] }),
    ...(effectiveDatasetScopes[0] === undefined ? {} : { datasetScopeClaim: effectiveDatasetScopes[0] })
  };
}

function scopeDenied(reason: string): ProviderProtocolError {
  return new ProviderProtocolError("SCOPE_DENIED", "Gateway principal scope set is invalid", {
    retryable: false,
    details: { reason }
  });
}

export function operationAllowed(principal: GatewayPrincipal, operationId: string, operationVersion: string): boolean {
  return principal.allowedOperations === undefined || principal.allowedOperations.includes(`${operationId}@${operationVersion}`);
}
