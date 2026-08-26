import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formalProviderRuntimes } from "./world-platform-provider-runtimes.js";
import { canonicalSha256 } from "../packages/platform/contract-runtime/src/index.js";
import type { ProviderSource } from "./materialize-capability-semantic-profiles.js";

const sources: ProviderSource[] = JSON.parse(await readFile("validation/gowm-v0.6.2/provider-sources.json", "utf8"));
export async function syncWorldPlatformManifests(write = false) {
  const runtimes = formalProviderRuntimes();
  if (runtimes.length !== 15 || new Set(runtimes.map((r) => r.manifest.provider.providerId)).size !== 15) throw new Error("Expected 15 unique actual runtime providers");
  for (const source of sources) {
    const runtime = runtimes.find((r) => r.manifest.provider.providerId === source.providerId);
    if (!runtime) throw new Error(`Missing actual provider runtime ${source.providerId}`);
    const rendered = `${JSON.stringify(runtime.manifest, null, 2)}\n`;
    for (const path of [source.manifestPath, ...(source.aliases ?? [])]) {
      if (write) await writeFile(path, rendered);
      else if (await readFile(path, "utf8") !== rendered) throw new Error(`Manifest differs from executable runtime: ${path}`);
    }
  }
  for (const path of ["config/capability-gateway-registry.json", "config/grounding-gateway-registry.json", "config/planning-gateway-registry.json"]) {
    const config = JSON.parse(await readFile(path, "utf8"));
    const prior = JSON.stringify(config);
    for (const entry of config.providers) {
      const runtime = runtimes.find((r) => r.manifest.provider.providerId === entry.providerId)!;
      entry.manifestHash = canonicalSha256(runtime.manifest);
      entry.implementationDigest = runtime.manifest.provider.implementationDigest;
    }
    if (write) await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
    else if (prior !== JSON.stringify(config)) throw new Error(`Stale controlled registry hashes: ${path}`);
  }
  return runtimes;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtimes = await syncWorldPlatformManifests(process.argv.includes("--write"));
  process.stdout.write(`WORLD_PLATFORM_MANIFESTS_PASS providers=${runtimes.length} operations=${runtimes.reduce((n,r) => n+r.manifest.capabilities.length,0)}\n`);
}
