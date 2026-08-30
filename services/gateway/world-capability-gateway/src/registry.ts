import type { CapabilityDescriptor } from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  compareUnicodeCodePoints,
  validateContract,
  catalogRevisions,
  validateProviderManifestSemantics
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError } from "../../../../packages/platform/provider-sdk/src/errors.js";
import type { ControlledProviderBinding, ProviderHealth, ResolvedCapability } from "./types.js";

const EXECUTABLE_MATURITY = new Set(["EXPERIMENTAL", "PREVIEW", "STABLE", "DEPRECATED"]);

function operationKey(operationId: string, operationVersion: string): string {
  return `${operationId}@${operationVersion}`;
}

export function assertControlledProviderEndpoint(endpoint: URL, allowPlaintextPrivateNetwork = false): void {
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new ProviderProtocolError("INVALID_REQUEST", "provider endpoint must use HTTP or HTTPS");
  }
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    throw new ProviderProtocolError("INVALID_REQUEST", "provider endpoint must not contain credentials, query, or fragment");
  }
  if (endpoint.pathname !== "/") {
    throw new ProviderProtocolError("INVALID_REQUEST", "provider endpoint must be an origin URL");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !local) {
    const privateContainerDns = /^[a-z][a-z0-9-]{0,62}$/iu.test(endpoint.hostname);
    if (!allowPlaintextPrivateNetwork || !privateContainerDns) {
      throw new ProviderProtocolError(
        "INVALID_REQUEST",
        "non-local provider endpoint must use HTTPS unless an isolated single-label container endpoint is attested"
      );
    }
  }
}

export class CapabilityRegistry {
  readonly #routes = new Map<string, ResolvedCapability>();
  readonly #bindings = new Map<string, ControlledProviderBinding>();
  constructor(private readonly options: { profile?: "legacy" | "world-platform"; vocabularyHash?: `sha256:${string}` } = {}) {}

  register(binding: ControlledProviderBinding): void {
    if (!binding.approved || !binding.approvalId.trim()) {
      throw new ProviderProtocolError("SCOPE_DENIED", "provider registration requires explicit approval");
    }
    assertControlledProviderEndpoint(binding.endpoint, binding.allowPlaintextPrivateNetwork === true);
    const validation = validateContract("capability-provider-manifest.schema.json", binding.manifest);
    if (!validation.valid) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "controlled provider manifest is invalid", {
        details: { issues: validation.issues }
      });
    }
    if (this.options.profile === "world-platform" && binding.manifest.manifestSchemaVersion !== "1.1") {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "World Platform registry requires Manifest 1.1 with explicit semantics");
    }
    const semantics = validateProviderManifestSemantics(binding.manifest);
    if (!semantics.valid) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "controlled provider manifest semantic validation failed", {
        details: { issues: semantics.issues }
      });
    }
    const providerId = binding.manifest.provider.providerId;
    if (binding.client.providerId !== providerId) {
      throw new ProviderProtocolError("SCHEMA_MISMATCH", "provider client identity does not match its manifest");
    }
    if (this.#bindings.has(providerId)) {
      throw new ProviderProtocolError("INVALID_REQUEST", `provider ${providerId} is already registered`);
    }

    const manifest = structuredClone(binding.manifest);
    const pending = new Map<string, ResolvedCapability>();
    for (const descriptor of manifest.capabilities) {
      const key = operationKey(descriptor.operationId, descriptor.operationVersion);
      if (this.#routes.has(key) || pending.has(key)) {
        throw new ProviderProtocolError("INVALID_REQUEST", `operation route ${key} is already registered`);
      }
      pending.set(key, {
        descriptor,
        manifest,
        endpoint: new URL(binding.endpoint.toString()),
        client: binding.client,
        approvalId: binding.approvalId
      });
    }
    this.#bindings.set(providerId, { ...binding, manifest });
    for (const [key, route] of pending) this.#routes.set(key, route);
  }

  resolve(operationId: string, operationVersion: string, allowExperimental = false): ResolvedCapability {
    const route = this.#routes.get(operationKey(operationId, operationVersion));
    if (!route) throw new ProviderProtocolError("VERSION_NOT_FOUND", `operation ${operationId}@${operationVersion} is not registered`);
    const maturity = route.descriptor.maturity;
    if (!EXECUTABLE_MATURITY.has(maturity) || (maturity === "EXPERIMENTAL" && !allowExperimental)) {
      throw new ProviderProtocolError("SCOPE_DENIED", `operation maturity ${maturity} is not executable for this caller`);
    }
    return route;
  }

  get(operationId: string, operationVersion: string): ResolvedCapability | undefined {
    return this.#routes.get(operationKey(operationId, operationVersion));
  }

  catalog(): CapabilityDescriptor[] {
    return [...this.#routes.values()]
      .map(({ descriptor }) => structuredClone(descriptor))
      .sort((left, right) => compareUnicodeCodePoints(operationKey(left.operationId, left.operationVersion), operationKey(right.operationId, right.operationVersion)));
  }

  async health(): Promise<Record<string, ProviderHealth>> {
    const checks = [...this.#bindings.entries()].map(async ([providerId, binding]) => {
      try {
        return [providerId, await binding.client.health()] as const;
      } catch {
        return [providerId, {
          live: false,
          ready: false,
          checkedAt: new Date().toISOString(),
          detail: "health check failed"
        }] as const;
      }
    });
    return Object.fromEntries(await Promise.all(checks));
  }

  get revision(): string {
    return this.contractCatalogRevision;
  }

  get contractCatalogRevision(): string {
    return catalogRevisions([...this.#bindings.values()], this.options.vocabularyHash).contractCatalogRevision;
  }

  get bindingRevision(): string {
    return catalogRevisions([...this.#bindings.values()], this.options.vocabularyHash).bindingRevision;
  }

  semanticDescriptors(): CapabilityDescriptor[] {
    return [...this.#routes.values()].filter((r) => r.manifest.manifestSchemaVersion === "1.1").map((r) => structuredClone(r.descriptor));
  }
}
