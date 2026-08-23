import { sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { GatewayPrincipal } from "./types.js";

/**
 * Stable authorization and idempotency boundary for one trusted caller scope.
 * Authentication timestamps and methods deliberately do not alter replay
 * identity; changing either trusted scope claim does.
 */
export function principalContextHash(principal: Pick<
  GatewayPrincipal,
  "principalRef" | "dataScopeClaim" | "datasetScopeClaim"
>): `sha256:${string}` {
  return sha256({
    principalRef: principal.principalRef,
    dataScopeClaim: principal.dataScopeClaim ?? null,
    datasetScopeClaim: principal.datasetScopeClaim ?? null
  });
}
