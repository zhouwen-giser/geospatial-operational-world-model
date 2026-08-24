import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  validateContract,
  validateProviderManifestSemantics,
  type CapabilityProviderManifest
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { sha256, validateProviderTransportToken } from "../../../../packages/platform/provider-sdk/src/index.js";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u;
const PROVIDER_ID = /^[a-z][a-z0-9.-]{2,127}$/u;
const VERSION = /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface ControlledProviderDeploymentLock {
  providerId: string;
  providerVersion: string;
  implementationDigest: `sha256:${string}`;
  manifestHash: `sha256:${string}`;
  manifestPath: string;
  endpoint: URL;
  approvalId: string;
  approvedBy: string;
  transportTokenEnv: string;
  allowPlaintextPrivateNetwork: boolean;
}

export interface ControlledProviderDeployment extends ControlledProviderDeploymentLock {
  approvedManifest: CapabilityProviderManifest;
}

export interface GatewayProviderDeployment extends ControlledProviderDeployment {
  transportToken: string;
}

export interface ControlledProviderRegistryDocument {
  configVersion: "1.0";
  providers: ControlledProviderDeploymentLock[];
}

export interface GatewayServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  gatewayId: string;
  policyVersion: string;
  attestationIssuer: string;
  sharedToken: string;
  principalRef: string;
  dataScopeClaim?: string;
  datasetScopeClaim?: string;
  allowExperimental: boolean;
  queryWorkerPollMs: number;
  queryWorkerLeaseSeconds: number;
  queryWorkerMaximumClaimsPerTick: number;
  providers: GatewayProviderDeployment[];
  registryConfigPath: string;
}

export async function loadGatewayServerConfig(env: NodeJS.ProcessEnv = process.env): Promise<GatewayServerConfig> {
  const registryConfigPath = resolve(env.GATEWAY_PROVIDER_REGISTRY_PATH?.trim() || "config/capability-gateway-registry.json");
  const controlledProviders = await loadControlledProviderDeployments(registryConfigPath);
  const providers = controlledProviders.map((deployment) => ({
    ...deployment,
    transportToken: validateProviderTransportToken(env[deployment.transportTokenEnv])
  }));
  const sharedToken = required(env, "GATEWAY_AUTH_SHARED_TOKEN");
  if (Buffer.byteLength(sharedToken, "utf8") < 32) throw new Error("GATEWAY_AUTH_SHARED_TOKEN must contain at least 32 bytes");
  const databaseUrl = required(env, "DATABASE_URL");
  const database = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error("DATABASE_URL must use PostgreSQL");
  const dataScopeClaim = optional(env, "GATEWAY_DATA_SCOPE_CLAIM");
  const datasetScopeClaim = optional(env, "GATEWAY_DATASET_SCOPE_CLAIM");
  return {
    host: env.GATEWAY_HOST?.trim() || "0.0.0.0",
    port: tcpPort(env.GATEWAY_PORT, 8090, "GATEWAY_PORT"),
    databaseUrl,
    gatewayId: identifier(env.GATEWAY_ID ?? "gowm-capability-gateway", "GATEWAY_ID"),
    policyVersion: identifier(env.GATEWAY_POLICY_VERSION ?? "gowm-capability-policy:0.2", "GATEWAY_POLICY_VERSION"),
    attestationIssuer: identifier(env.GATEWAY_ATTESTATION_ISSUER ?? "gowm-capability-gateway", "GATEWAY_ATTESTATION_ISSUER"),
    sharedToken,
    principalRef: identifier(required(env, "GATEWAY_RUNTIME_PRINCIPAL_REF"), "GATEWAY_RUNTIME_PRINCIPAL_REF"),
    ...(dataScopeClaim === undefined ? {} : { dataScopeClaim }),
    ...(datasetScopeClaim === undefined ? {} : { datasetScopeClaim }),
    allowExperimental: env.GATEWAY_ALLOW_EXPERIMENTAL === "true",
    queryWorkerPollMs: boundedInteger(env.GATEWAY_QUERY_WORKER_POLL_MS, 1_000, 100, 60_000, "GATEWAY_QUERY_WORKER_POLL_MS"),
    queryWorkerLeaseSeconds: boundedInteger(env.GATEWAY_QUERY_WORKER_LEASE_SECONDS, 600, 1, 3_600, "GATEWAY_QUERY_WORKER_LEASE_SECONDS"),
    queryWorkerMaximumClaimsPerTick: boundedInteger(env.GATEWAY_QUERY_WORKER_MAX_CLAIMS, 8, 1, 64, "GATEWAY_QUERY_WORKER_MAX_CLAIMS"),
    providers,
    registryConfigPath
  };
}

export async function loadControlledProviderDeployments(
  registryConfigPath = resolve("config/capability-gateway-registry.json")
): Promise<ControlledProviderDeployment[]> {
  const document = parseControlledProviderRegistryDocument(
    JSON.parse(await readFile(registryConfigPath, "utf8")) as unknown
  );
  const repositoryRoot = resolve(registryConfigPath, "..", "..");
  return Promise.all(document.providers.map((deployment) =>
    loadApprovedManifest(deployment, repositoryRoot)
  ));
}

export function parseControlledProviderRegistryDocument(value: unknown): ControlledProviderRegistryDocument {
  const root = record(value, "provider registry document");
  exactKeys(root, ["configVersion", "providers"], "provider registry document");
  if (root.configVersion !== "1.0") throw new Error("provider registry configVersion must be 1.0");
  if (!Array.isArray(root.providers) || root.providers.length === 0 || root.providers.length > 64) {
    throw new Error("provider registry must contain between 1 and 64 providers");
  }
  const providers = root.providers.map((candidate, index) => parseProvider(candidate, index));
  assertUnique(providers.map(({ providerId }) => providerId), "providerId");
  assertUnique(providers.map(({ endpoint }) => endpoint.toString()), "endpoint");
  assertUnique(providers.map(({ approvalId }) => approvalId), "approvalId");
  return { configVersion: "1.0", providers };
}

function parseProvider(value: unknown, index: number): ControlledProviderDeploymentLock {
  const name = `providers[${index}]`;
  const item = record(value, name);
  exactKeys(item, [
    "providerId",
    "providerVersion",
    "implementationDigest",
    "manifestHash",
    "manifestPath",
    "endpoint",
    "approvalId",
    "approvedBy",
    "transportTokenEnv",
    "allowPlaintextPrivateNetwork"
  ], name);
  const providerId = match(item.providerId, PROVIDER_ID, `${name}.providerId`);
  const providerVersion = match(item.providerVersion, VERSION, `${name}.providerVersion`);
  const implementationDigest = match(item.implementationDigest, DIGEST, `${name}.implementationDigest`) as `sha256:${string}`;
  const manifestHash = match(item.manifestHash, DIGEST, `${name}.manifestHash`) as `sha256:${string}`;
  const manifestPath = string(item.manifestPath, `${name}.manifestPath`);
  if (!/^contracts\/manifests\/providers\/[a-z0-9][a-z0-9.-]*-provider\.json$/u.test(manifestPath)) {
    throw new Error(`${name}.manifestPath must be a controlled repo-relative canonical Provider manifest path`);
  }
  const approvalId = match(item.approvalId, IDENTIFIER, `${name}.approvalId`);
  const approvedBy = match(item.approvedBy, IDENTIFIER, `${name}.approvedBy`);
  const transportTokenEnv = match(item.transportTokenEnv, /^[A-Z][A-Z0-9_]{2,127}$/u, `${name}.transportTokenEnv`);
  if (typeof item.allowPlaintextPrivateNetwork !== "boolean") {
    throw new Error(`${name}.allowPlaintextPrivateNetwork must be boolean`);
  }
  const endpoint = new URL(string(item.endpoint, `${name}.endpoint`));
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error(`${name}.endpoint must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return {
    providerId,
    providerVersion,
    implementationDigest,
    manifestHash,
    manifestPath,
    endpoint,
    approvalId,
    approvedBy,
    transportTokenEnv,
    allowPlaintextPrivateNetwork: item.allowPlaintextPrivateNetwork
  };
}

async function loadApprovedManifest(
  deployment: ControlledProviderDeploymentLock,
  repositoryRoot: string
): Promise<ControlledProviderDeployment> {
  const candidate = JSON.parse(await readFile(resolve(repositoryRoot, deployment.manifestPath), "utf8")) as unknown;
  const validation = validateContract("capability-provider-manifest.schema.json", candidate);
  if (!validation.valid) throw new Error(`${deployment.manifestPath} violates the Provider Protocol manifest schema`);
  const approvedManifest = candidate as CapabilityProviderManifest;
  const semantics = validateProviderManifestSemantics(approvedManifest);
  if (!semantics.valid) throw new Error(`${deployment.manifestPath} fails Provider manifest semantic validation`);
  if (
    approvedManifest.provider.providerId !== deployment.providerId ||
    approvedManifest.provider.providerVersion !== deployment.providerVersion ||
    approvedManifest.provider.implementationDigest !== deployment.implementationDigest ||
    sha256(approvedManifest) !== deployment.manifestHash
  ) {
    throw new Error(`${deployment.manifestPath} differs from its controlled registry identity/hash lock`);
  }
  return { ...deployment, approvedManifest: structuredClone(approvedManifest) };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const expected = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`${name} keys differ from the controlled schema`);
  }
}

function assertUnique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`provider registry ${name} values must be unique`);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function match(value: unknown, pattern: RegExp, name: string): string {
  const candidate = string(value, name);
  if (!pattern.test(candidate)) throw new Error(`${name} has an invalid format`);
  return candidate;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function identifier(value: string, name: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`${name} must be a platform identifier`);
  return value;
}

function tcpPort(raw: string | undefined, fallback: number, name: string): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return value;
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
