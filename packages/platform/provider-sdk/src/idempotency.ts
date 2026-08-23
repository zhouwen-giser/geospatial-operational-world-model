import { sha256 } from "./canonical.js";
import { ProviderProtocolError } from "./errors.js";

interface Entry<T> {
  payloadHash: string;
  result: Promise<T>;
}

/** Process-local helper for provider replay. Gateway durability is PostgreSQL-backed. */
export class IdempotencyCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #maximumEntries: number;

  constructor(maximumEntries = 10_000) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) throw new TypeError("maximumEntries must be positive");
    this.#maximumEntries = maximumEntries;
  }

  execute(key: string, payload: unknown, action: () => Promise<T>): Promise<T> {
    const payloadHash = sha256(payload);
    const existing = this.#entries.get(key);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ProviderProtocolError("IDEMPOTENCY_CONFLICT", "idempotency key was already used with different input");
      }
      return existing.result;
    }
    if (this.#entries.size >= this.#maximumEntries) {
      throw new ProviderProtocolError("OVERLOADED", "provider idempotency cache is full", { retryable: true });
    }
    const result = action().catch((error) => {
      this.#entries.delete(key);
      throw error;
    });
    this.#entries.set(key, { payloadHash, result });
    return result;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}
