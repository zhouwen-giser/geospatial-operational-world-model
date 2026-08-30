import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalSha256, catalogRevisions, compareUnicodeCodePoints, validateContract, type WorldPlatformProviderSet } from "../packages/platform/contract-runtime/src/index.js";
import { loadControlledProviderDeployments, type ControlledProviderDeployment } from "../services/gateway/world-capability-gateway/src/config.js";
import { CapabilityRegistry } from "../services/gateway/world-capability-gateway/src/registry.js";
import { operationKey } from "../packages/platform/semantic-conformance/src/index.js";

export function assembleWorldPlatformRegistry(deployments: readonly ControlledProviderDeployment[], policy: WorldPlatformProviderSet) {
  if (!validateContract("urn:gowm:v0.6.2:world-platform-provider-set", policy).valid) throw new Error("Invalid Provider Set contract");
  const requiredExclusions = ["OBSERVATION_WRITE", "DEVICE_COMMAND", "SDAR_A2A", "DYNAMIC_MCP_DISCOVERY", "ARBITRARY_SQL"];
  if (requiredExclusions.some((c) => !policy.excludedClasses.includes(c as WorldPlatformProviderSet["excludedClasses"][number]))) throw new Error("Provider Set must exclude all non-world-query classes");
  const allowed = [...policy.requiredProviders, ...policy.optionalProviders];
  if (new Set(allowed).size !== allowed.length) throw new Error("Required and optional Provider sets overlap");
  const ids = new Set<string>(), operations = new Set<string>();
  const providers = [...deployments].sort((a,b) => compareUnicodeCodePoints(a.providerId, b.providerId));
  const registry = new CapabilityRegistry({ profile: "world-platform" });
  for (const entry of providers) {
    const identity = entry.approvedManifest.provider;
    if (identity.providerId !== entry.providerId || identity.providerVersion !== entry.providerVersion || identity.implementationDigest !== entry.implementationDigest || canonicalSha256(entry.approvedManifest) !== entry.manifestHash) throw new Error(`Manifest identity/hash mismatch: ${entry.providerId}`);
    if (!allowed.includes(entry.providerId)) throw new Error(`Provider is outside controlled required/optional set: ${entry.providerId}`);
    if (ids.has(entry.providerId)) throw new Error(`Duplicate provider fragment: ${entry.providerId}`);
    ids.add(entry.providerId);
    for (const c of entry.approvedManifest.capabilities) {
      if (operations.has(operationKey(c))) throw new Error(`Operation collision: ${operationKey(c)}`);
      operations.add(operationKey(c));
    }
    registry.register({ ...entry, manifest: entry.approvedManifest, approved: true,
      client: { providerId: entry.providerId, manifest: async () => entry.approvedManifest,
        health: async () => { throw new Error("Registry builder does not claim runtime health"); },
        execute: async () => { throw new Error("Registry builder cannot execute capabilities"); } }
    });
  }
  const missing = policy.requiredProviders.filter((id) => !ids.has(id));
  if (missing.length) throw new Error(`Missing required providers: ${missing.join(", ")}`);
  const revisions = catalogRevisions(providers.map((p) => ({ manifest: p.approvedManifest, approvalId: p.approvalId })));
  const registryDocument = { configVersion: "1.0", registryProfile: "world-platform", providers: providers.map(({ approvedManifest: _manifest, ...entry }) => ({ ...entry, endpoint: entry.endpoint.origin })) };
  const report = { schemaVersion: "1.0", providerCount: providers.length, operationCount: operations.size, ...revisions,
    missingRequiredProviders: missing, operationCollisions: [], warnings: policy.optionalProviders.filter((id) => !ids.has(id)).map((id) => `Optional provider absent: ${id}`), status: "PASS" };
  if (!validateContract("urn:gowm:v0.6.2:world-platform-registry-build-report", report).valid) throw new Error("Invalid registry build report");
  return { registryDocument, report, catalog: registry.catalog() };
}

export async function buildWorldPlatformRegistry(
  write = false,
  root = resolve(fileURLToPath(new URL("..", import.meta.url))),
  reportDirectory = process.env.GOWM_REPORT_DIRECTORY?.trim() || "reports/gowm-v0.7.1/pr-b/world-platform"
) {
  const config = resolve(root, "config");
  const fragments = (await readdir(config)).filter((p) =>
    p.endsWith("gateway-registry.json") &&
    p !== "world-platform-gateway-registry.json" &&
    p !== "wsgs-sample-gateway-registry.json"
  ).sort();
  if (!fragments.length) throw new Error("No controlled Registry fragments discovered");
  const deployments = (await Promise.all(fragments.map((p) => loadControlledProviderDeployments(resolve(config, p))))).flat();
  const policy: WorldPlatformProviderSet = JSON.parse(await readFile(resolve(config, "world-platform-provider-set.json"), "utf8"));
  const result = assembleWorldPlatformRegistry(deployments, policy);
  const artifacts = {
    "config/world-platform-gateway-registry.json": result.registryDocument,
    [`${reportDirectory}/world-platform-registry-build-report.json`]: result.report,
    [`${reportDirectory}/world-platform-catalog-summary.json`]: {
      fragments, providerCount: result.report.providerCount, operationCount: result.report.operationCount,
      providers: deployments.map((p) => ({ providerId: p.providerId, manifestPath: p.manifestPath, manifestHash: p.manifestHash, operationCount: p.approvedManifest.capabilities.length })),
      maturities: Object.fromEntries(["STABLE", "PREVIEW", "EXPERIMENTAL", "DEPRECATED", "RETIRED"].map((m) => [m, result.catalog.filter((c) => c.maturity === m).length]))
    }
  };
  for (const [name, value] of Object.entries(artifacts)) {
    const path = resolve(root, name), bytes = `${JSON.stringify(value,null,2)}\n`;
    if (write) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    else if (await readFile(path,"utf8").catch(() => "") !== bytes) throw new Error(`Stale generated registry artifact: ${name}`);
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildWorldPlatformRegistry(process.argv.includes("--write"));
  process.stdout.write(`WORLD_PLATFORM_REGISTRY_PASS ${JSON.stringify(result.report)}\n`);
}
