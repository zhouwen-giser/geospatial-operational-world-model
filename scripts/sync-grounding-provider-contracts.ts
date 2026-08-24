import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGroundingCatalogProvider } from "../services/providers/grounding-catalog-provider/src/provider.js";
import type { CatalogSqlPool, GroundingCatalogMode } from "../services/providers/grounding-catalog-provider/src/types.js";

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
for (const [mode, filename] of targets) {
  const provider = createGroundingCatalogProvider({ mode, pool, cursorSecret });
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

if (stale) process.exitCode = 1;
else process.stdout.write(check ? "GROUNDING_PROVIDER_CONTRACTS_CURRENT\n" : "GROUNDING_PROVIDER_CONTRACTS_SYNCED\n");
