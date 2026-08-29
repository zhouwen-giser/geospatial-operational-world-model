import type {
  OperationAvailability,
  OperationAvailabilityList
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { operationAllowed } from "./principal-context.js";
import type { ProviderCircuitBreaker } from "./circuit-breaker.js";
import type { CapabilityRegistry } from "./registry.js";
import type { GatewayPrincipal, ProviderHealth } from "./types.js";

interface CachedHealth {
  health: ProviderHealth;
  expiresAt: number;
}

export class OperationAvailabilityService {
  readonly #cache = new Map<string, CachedHealth>();
  readonly #pendingHealth = new Map<string, Promise<ProviderHealth>>();

  constructor(private readonly options: {
    registry: CapabilityRegistry;
    circuits: ProviderCircuitBreaker;
    cacheTtlMs?: number;
    now?: () => Date;
  }) {
    if ((options.cacheTtlMs ?? 5_000) > 5_000) throw new TypeError("availability cache TTL cannot exceed 5000ms");
  }

  async list(principal: GatewayPrincipal): Promise<OperationAvailabilityList> {
    const checkedAt = this.#now().toISOString();
    const descriptors = this.options.registry.catalog().filter((descriptor) =>
      operationAllowed(principal, descriptor.operationId, descriptor.operationVersion)
    );
    const operations = await Promise.all(descriptors.map((descriptor) =>
      this.get(descriptor.operationId, descriptor.operationVersion, principal)
    ));
    return { schemaVersion: "1.0", checkedAt, operations: operations.filter((item): item is OperationAvailability => item !== undefined) };
  }

  async get(operationId: string, operationVersion: string, principal: GatewayPrincipal): Promise<OperationAvailability | undefined> {
    const route = this.options.registry.get(operationId, operationVersion);
    if (!route || !operationAllowed(principal, operationId, operationVersion)) return undefined;
    const checkedAt = this.#now();
    const validUntil = new Date(checkedAt.getTime() + this.#ttl());
    const common = {
      operationId,
      operationVersion,
      maturity: route.descriptor.maturity,
      checkedAt: checkedAt.toISOString(),
      validUntil: validUntil.toISOString(),
      contractCatalogRevision: this.options.registry.contractCatalogRevision,
      bindingRevision: this.options.registry.bindingRevision
    };
    if (["PLANNED", "RETIRED"].includes(route.descriptor.maturity)) {
      return { ...common, availability: "DISABLED", reasonCodes: ["REGISTRY_DISABLED"] };
    }
    if (route.descriptor.maturity === "EXPERIMENTAL" && !(principal.allowExperimental ?? false)) {
      return { ...common, availability: "DISABLED", reasonCodes: ["MATURITY_POLICY"] };
    }
    const circuit = this.options.circuits.state(route.manifest.provider.providerId);
    if (circuit.state === "OPEN") {
      return { ...common, availability: "UNAVAILABLE", reasonCodes: ["CIRCUIT_OPEN"], retryAfterMs: this.options.circuits.resetAfterMs };
    }
    const health = await this.#health(operationId, operationVersion);
    if (health.ready) return { ...common, availability: "AVAILABLE", reasonCodes: ["READY"] };
    if (health.live) return { ...common, availability: "DEGRADED", reasonCodes: ["PROVIDER_NOT_READY"], retryAfterMs: this.#ttl() };
    return { ...common, availability: "UNAVAILABLE", reasonCodes: ["PROVIDER_UNREACHABLE"], retryAfterMs: this.#ttl() };
  }

  async #health(operationId: string, operationVersion: string): Promise<ProviderHealth> {
    const route = this.options.registry.get(operationId, operationVersion);
    if (!route) throw new Error("availability route disappeared");
    const providerId = route.manifest.provider.providerId;
    const now = this.#now().getTime();
    const cached = this.#cache.get(providerId);
    if (cached && cached.expiresAt > now) return cached.health;
    const pending = this.#pendingHealth.get(providerId);
    if (pending) return pending;
    const healthCheck = (async (): Promise<ProviderHealth> => {
      let health: ProviderHealth;
      try {
        health = await route.client.health(new Date(now + this.#ttl()).toISOString());
      } catch {
        health = { live: false, ready: false, checkedAt: this.#now().toISOString() };
      }
      this.#cache.set(providerId, { health, expiresAt: now + this.#ttl() });
      return health;
    })();
    this.#pendingHealth.set(providerId, healthCheck);
    try {
      return await healthCheck;
    } finally {
      this.#pendingHealth.delete(providerId);
    }
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  #ttl(): number {
    return this.options.cacheTtlMs ?? 5_000;
  }
}
