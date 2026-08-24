import { sha256 } from "../../../../packages/platform/provider-sdk/src/canonical.js";
import { ProviderProtocolError } from "../../../../packages/platform/provider-sdk/src/errors.js";

export interface IdempotentResult<T> {
  value: T;
  replayed: boolean;
}

export interface GatewayIdempotencyScope {
  principalHash: string;
  operationId: string;
  operationVersion: string;
}

export interface GatewayIdempotencyStore<T> {
  execute(scope: GatewayIdempotencyScope, idempotencyKey: string, request: unknown, action: () => Promise<T>): Promise<IdempotentResult<T>>;
}

interface MemoryEntry<T> {
  requestHash: string;
  value: Promise<T>;
}

export class MemoryGatewayIdempotencyStore<T> implements GatewayIdempotencyStore<T> {
  readonly #entries = new Map<string, MemoryEntry<T>>();

  async execute(scope: GatewayIdempotencyScope, idempotencyKey: string, request: unknown, action: () => Promise<T>): Promise<IdempotentResult<T>> {
    const key = `${scope.principalHash}\u0000${scope.operationId}@${scope.operationVersion}\u0000${idempotencyKey}`;
    const requestHash = sha256(request);
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ProviderProtocolError("IDEMPOTENCY_CONFLICT", "idempotency key was reused with a different Gateway request");
      }
      return { value: await existing.value, replayed: true };
    }
    const value = action().catch((error) => {
      this.#entries.delete(key);
      throw error;
    });
    this.#entries.set(key, { requestHash, value });
    return { value: await value, replayed: false };
  }
}
