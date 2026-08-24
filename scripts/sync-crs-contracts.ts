import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCrsProviderBridge } from "../services/providers/crs-provider-bridge/src/provider.js";
import {
  CRS_OPERATION_SCHEMAS,
  POC_OPENAPI_SHA256,
  POC_SOURCE_ZIP_SHA256
} from "../services/providers/crs-provider-bridge/src/schemas.js";
import { endpointConfigurationDigest } from "../services/providers/crs-provider-bridge/src/upstream-client.js";
import type { CrsOperationId } from "../services/providers/crs-provider-bridge/src/types.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const endpointId = "crs-poc-test";
const baseUrl = "http://127.0.0.1:18086";
const bridge = createCrsProviderBridge({
  endpoint: {
    endpointId,
    baseUrl,
    approvalStatus: "APPROVED",
    configurationDigest: endpointConfigurationDigest(endpointId, baseUrl)
  },
  attestation: {
    sourceZipSha256: POC_SOURCE_ZIP_SHA256,
    openApiSha256: POC_OPENAPI_SHA256,
    projVersion: "9.5.1",
    integration: "gdal-async",
    integrationVersion: "3.12.3",
    projDbVersion: "EPSG-v12.013",
    projDbSha256: `sha256:${"a".repeat(64)}`,
    gridBundleVersion: "empty-v1",
    gridBundleSha256: `sha256:${"b".repeat(64)}`,
    strictBestOperation: true,
    networkEnabled: false
  },
  fetch: async () => {
    throw new Error("contract synchronization must not call the CRS upstream");
  }
});

const files = new Map<string, string>();
for (const [operationId, schemas] of Object.entries(CRS_OPERATION_SCHEMAS) as Array<
  [CrsOperationId, (typeof CRS_OPERATION_SCHEMAS)[CrsOperationId]]
>) {
  if (operationId === "crs.normalize.geometry") continue;
  const directory = resolve(repositoryRoot, "contracts", "capabilities", operationId);
  files.set(resolve(directory, "input-1.0.schema.json"), `${JSON.stringify(schemas.input, null, 2)}\n`);
  files.set(resolve(directory, "output-1.0.schema.json"), `${JSON.stringify(schemas.output, null, 2)}\n`);
}
files.set(
  resolve(repositoryRoot, "contracts", "manifests", "providers", "crs-provider.json"),
  `${JSON.stringify(bridge.runtime.manifest, null, 2)}\n`
);

let stale = false;
for (const [path, expected] of files) {
  if (check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== expected) {
      process.stderr.write(`Stale CRS contract artifact: ${path}\n`);
      stale = true;
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, expected, "utf8");
  }
}

if (stale) process.exitCode = 1;
else process.stdout.write(check ? "CRS_CONTRACTS_CURRENT\n" : "CRS_CONTRACTS_SYNCED\n");
