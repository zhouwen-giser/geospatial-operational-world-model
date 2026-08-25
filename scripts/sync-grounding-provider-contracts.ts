import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

import { createGroundingCatalogProvider } from "../services/providers/grounding-catalog-provider/src/provider.js";
import { createOperationalRealityProvider } from "../services/providers/operational-reality-provider/src/provider.js";
import type { CatalogSqlPool, GroundingCatalogMode } from "../services/providers/grounding-catalog-provider/src/types.js";
import { sha256 } from "../packages/platform/provider-sdk/src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const cursorSecret = "GroundingContractSynchronizationSecret_2026";
const pool: CatalogSqlPool = {
  async connect() {
    throw new Error("contract synchronization must not connect to PostgreSQL");
  }
};
const targets: Array<[GroundingCatalogMode, string]> = [
  ["reference", "reference-catalog-provider.json"],
  ["dataset", "dataset-catalog-provider.json"],
  ["evidence", "world-evidence-provider.json"]
];

let stale = false;
const catalogProviders = new Map<string, ReturnType<typeof createGroundingCatalogProvider>>();
for (const [mode, filename] of targets) {
  const provider = createGroundingCatalogProvider({ mode, pool, cursorSecret });
  catalogProviders.set(provider.runtime.manifest.provider.providerId, provider);
  const path = resolve(repositoryRoot, "contracts", "manifests", "providers", filename);
  const expected = `${JSON.stringify(provider.runtime.manifest, null, 2)}\n`;
  if (check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== expected) {
      process.stderr.write(`Stale Grounding Provider contract artifact: ${path}\n`);
      stale = true;
    }
  } else {
    await writeFile(path, expected, "utf8");
  }
}

const operationalProvider = createOperationalRealityProvider({ pool: pool as unknown as pg.Pool });
const operationalManifestPath = resolve(repositoryRoot,"contracts","manifests","providers","operational-reality-provider.json");
const operationalExpected = `${JSON.stringify(operationalProvider.runtime.manifest,null,2)}\n`;
if (check) {
  if (await readFile(operationalManifestPath,"utf8").catch(()=>"")!==operationalExpected) {
    process.stderr.write(`Stale Operational Reality Provider contract artifact: ${operationalManifestPath}\n`);
    stale=true;
  }
} else await writeFile(operationalManifestPath,operationalExpected,"utf8");

const registryPath=resolve(repositoryRoot,"config","grounding-gateway-registry.json");
const registry=JSON.parse(await readFile(registryPath,"utf8")) as {configVersion:string;providers:Array<Record<string,unknown>>};
registry.providers=registry.providers.map((entry) => {
  const provider = catalogProviders.get(String(entry.providerId));
  return provider === undefined ? entry : {
    ...entry,
    providerVersion: provider.runtime.manifest.provider.providerVersion,
    implementationDigest: provider.runtime.manifest.provider.implementationDigest,
    manifestHash: sha256(provider.runtime.manifest)
  };
});
const operationalEntry={
  providerId:"gowm.operational-reality",providerVersion:"1.0.0",
  implementationDigest:operationalProvider.runtime.manifest.provider.implementationDigest,
  manifestHash:sha256(operationalProvider.runtime.manifest),
  manifestPath:"contracts/manifests/providers/operational-reality-provider.json",
  endpoint:"http://operational-reality-provider:8094",approvalId:"operational-reality-v1.0",
  approvedBy:"gowm-release-operator",transportTokenEnv:"OPERATIONAL_REALITY_PROVIDER_TRANSPORT_TOKEN",
  allowPlaintextPrivateNetwork:true
};
registry.providers=registry.providers.filter((entry)=>entry.providerId!=="gowm.operational-reality");
registry.providers.push(operationalEntry);
const registryExpected=`${JSON.stringify(registry,null,2)}\n`;
if (check) {
  if (await readFile(registryPath,"utf8")!==registryExpected) {
    process.stderr.write(`Stale Grounding Gateway registry artifact: ${registryPath}\n`);stale=true;
  }
} else await writeFile(registryPath,registryExpected,"utf8");

if (stale) process.exitCode = 1;
else process.stdout.write(check ? "GROUNDING_PROVIDER_CONTRACTS_CURRENT\n" : "GROUNDING_PROVIDER_CONTRACTS_SYNCED\n");
