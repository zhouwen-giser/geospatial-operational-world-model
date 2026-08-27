import { sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { GatewayPrincipal } from "./types.js";

/**
 * Stable authorization and idempotency boundary for one trusted caller scope.
 * Authentication timestamps and methods deliberately do not alter replay
 * identity; changing either trusted scope claim does.
 */
export function principalContextHash(principal: Pick<
  GatewayPrincipal,
  "principalRef" | "servicePrincipalRef" | "actorRef" | "dataScopeClaim" | "datasetScopeClaim" | "allowedOperations"
>): `sha256:${string}` {
  return sha256({
    principalRef: principal.principalRef,
    servicePrincipalRef: principal.servicePrincipalRef ?? principal.principalRef,
    actorRef: principal.actorRef ?? principal.principalRef,
    dataScopeClaim: principal.dataScopeClaim ?? null,
    datasetScopeClaim: principal.datasetScopeClaim ?? null,
    allowedOperationSetHash: sha256([...(principal.allowedOperations ?? [])].sort())
  });
}

export function operationAllowed(principal: GatewayPrincipal, operationId: string, operationVersion: string): boolean {
  return principal.allowedOperations === undefined || principal.allowedOperations.includes(`${operationId}@${operationVersion}`);
}
