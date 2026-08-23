import type { ProviderRuntime } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { ProviderClient, ProviderHealth } from "./types.js";

export class InProcessProviderClient implements ProviderClient {
  readonly providerId: string;

  constructor(readonly runtime: ProviderRuntime) {
    this.providerId = runtime.manifest.provider.providerId;
  }

  async manifest() {
    return structuredClone(this.runtime.manifest);
  }

  async health(): Promise<ProviderHealth> {
    const live = this.runtime.health();
    const ready = this.runtime.readiness();
    return {
      live: live.live,
      ready: ready.ready,
      checkedAt: new Date().toISOString(),
      ...(ready.reasons.length ? { detail: ready.reasons.join("; ") } : {})
    };
  }

  async execute(operationId: string, request: Parameters<ProviderRuntime["execute"]>[0]) {
    if (operationId !== request.operation.operationId) throw new TypeError("route operation differs from request operation");
    return this.runtime.execute(request);
  }
}
