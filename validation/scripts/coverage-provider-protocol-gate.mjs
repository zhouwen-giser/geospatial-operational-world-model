import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateContract } from "../../dist/packages/platform/contract-runtime/src/index.js";
import { sha256 } from "../../dist/packages/platform/provider-sdk/src/index.js";
import { createRoadCoverageProvider, ROAD_COVERAGE_OPERATION_LOCKS } from "../../dist/services/providers/road-coverage-provider/src/provider.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runId = process.env.GOWM_V06_RUN_ID;
if (!runId || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(runId)) throw new Error("GOWM_V06_RUN_ID is invalid");
const unused = async () => { throw new Error("unexpected engine operation"); };
const engine = { validate: unused, selectObligations: unused, plan: unused, verify: unused, expandGeoJson: unused };
const provider = createRoadCoverageProvider({
  ...engine,
  async validate() {
    return {
      status: "COMPLETED",
      value: {
        schemaVersion: "1.0", valid: true, violations: [], warnings: [],
        normalizedSummary: { routeCount: 1, selectionMode: "CLIPPED_INSIDE_AREA", serviceMode: "BOTH_DIRECTIONS", endpointMode: "RETURN_TO_START", requestedAlternativeCount: 2 }
      },
      dataSnapshot: {
        consistency: "PINNED", capturedAt: "2026-08-25T03:00:00.000Z", scopeDigest: `sha256:${"a".repeat(64)}`,
        resources: [{ authority: "gowm_network_v1", pinning: "PINNED", referenceKey: { namespace: "gowm", kind: "DATASET", id: `wrf_${"1".repeat(32)}`, version: "graph-v1" } }]
      },
      evidenceReferences: [], consumption: { rows: 1, candidates: 0 }, warnings: [], changes: { repairApplied: false, typeChanged: false }
    };
  }
});
const manifest = provider.runtime.manifest;
const capabilities = new Map(manifest.capabilities.map((value) => [value.operationId, value]));
const schemaHashes = [];
for (const lock of ROAD_COVERAGE_OPERATION_LOCKS) {
  for (const [uri, expected] of [[lock.inputSchemaUri, lock.inputSchemaHash], [lock.outputSchemaUri, lock.outputSchemaHash]]) {
    const name = uri.slice(uri.lastIndexOf(":") + 1);
    const bytes = await readFile(resolve(root, `contracts/gowm-v0.6/${name}.schema.json`));
    schemaHashes.push({ uri, expected, actual: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
  }
}
const fixture = JSON.parse(await readFile(resolve(root, "contracts/gowm-v0.6/examples/closed-clipped-both-directions.json"), "utf8"));
const validateDescriptor = capabilities.get("coverage.road.validate");
if (validateDescriptor === undefined) throw new Error("validate descriptor missing");
const deadlineAt = new Date(Date.now() + 10_000).toISOString();
const result = await provider.runtime.execute({
  providerProtocolVersion: "1.0", requestId: "coverage-provider-gate-request", gatewayRequestId: "coverage-provider-gate-gateway",
  idempotencyKey: "coverage-provider-gate-idempotency",
  operation: { operationId: validateDescriptor.operationId, operationVersion: validateDescriptor.operationVersion, inputSchemaHash: validateDescriptor.inputSchemaHash, outputSchemaHash: validateDescriptor.outputSchemaHash },
  input: fixture.value,
  securityContext: {
    principalRef: "principal:coverage-provider-gate", authenticationMethod: "TEST_ATTESTED", authenticatedAt: new Date().toISOString(),
    dataScopeClaim: "coverage-provider-gate", datasetScopeClaim: "dataset-a",
    scopeAttestation: { issuer: "gateway-gate", issuedAt: new Date().toISOString(), expiresAt: deadlineAt, claimDigest: sha256({ scope: "coverage-provider-gate", dataset: "dataset-a" }) }
  },
  gatewayContext: { gatewayId: "gateway-gate", registryVersion: "registry-1", policyVersion: "policy-1" },
  executionPolicy: { deadlineAt, maximumInputBytes: 1_048_576, maximumResultBytes: 1_048_576, maximumCostClass: "MEDIUM" }
});
const sourceFiles = await Promise.all([
  "services/providers/road-coverage-provider/src/provider.ts",
  "services/providers/road-coverage-provider/src/engine.ts"
].map((path) => readFile(resolve(root, path), "utf8")));
const resultSetSchema = await readFile(resolve(root, "contracts/gowm-v0.6/coverage-result-set.schema.json"), "utf8");
const checks = {
  platformManifestContract: validateContract("capability-provider-manifest.schema.json", manifest).valid,
  exactFiveOperations: manifest.capabilities.map(({ operationId }) => operationId).join("|") === ROAD_COVERAGE_OPERATION_LOCKS.map(({ operationId }) => operationId).join("|"),
  frozenSchemaByteHashes: schemaHashes.every(({ actual, expected }) => actual === expected),
  stableMaturity: manifest.capabilities.every(({ maturity }) => maturity === "STABLE"),
  executionModes: ROAD_COVERAGE_OPERATION_LOCKS.every((lock) => capabilities.get(lock.operationId)?.execution.mode === lock.executionMode),
  planUsesGatewayAsyncJob: capabilities.get("coverage.road.plan")?.execution.mode === "ASYNC" && capabilities.get("coverage.road.plan")?.executionBindings.includes("ASYNC_JOB"),
  scopeAndSnapshotRequired: manifest.capabilities.every((value) => value.scopePolicy === "DATA_SCOPE_REQUIRED" && value.snapshotPolicy.dataSnapshot === "REQUIRED" && value.snapshotPolicy.computeSnapshot === "REQUIRED"),
  providerEnvelopeContract: validateContract("capability-result-envelope.schema.json", result).valid,
  computeAndDataSnapshots: result.dataSnapshot?.resources[0]?.authority === "gowm_network_v1" && result.computeSnapshot.schemas.inputSchemaHash === validateDescriptor.inputSchemaHash,
  receiptsEvidenceSeparated: result.receipts.length === 1 && result.evidenceReferences.length === 0 && result.output?.value.receipts === undefined && result.output?.value.evidenceReferences === undefined,
  geometryOnDemand: !resultSetSchema.includes('"geometry"') && !resultSetSchema.includes('"coordinates"'),
  noProviderHttpDependency: sourceFiles.every((source) => !/fetch\s*\(|HttpProviderClient|gowm\.network|gowm\.route-planning/u.test(source)),
  noUpperLayerDependency: sourceFiles.every((source) => !/WSGS|SACS|SDAR|SMPP|A2A/u.test(source))
};
const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
if (failed.length > 0) throw new Error(`coverage provider protocol gate failed: ${failed.join(", ")}`);
const evidence = {
  schemaVersion: "1.0", runId, status: "PASS", providerId: manifest.provider.providerId,
  providerVersion: manifest.provider.providerVersion, implementationDigest: manifest.provider.implementationDigest,
  operations: manifest.capabilities.map((value) => ({ operationId: value.operationId, operationVersion: value.operationVersion, maturity: value.maturity, executionMode: value.execution.mode, inputSchemaHash: value.inputSchemaHash, outputSchemaHash: value.outputSchemaHash })),
  checks, validateExecution: { status: result.status, resultHash: result.execution.resultHash, receiptId: result.receipts[0]?.receiptId, dataSnapshot: result.dataSnapshot, computeSnapshotHash: result.receipts[0]?.computeSnapshotHash }
};
const directory = resolve(root, "reports/gowm-v0.6");
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, `p00-provider-${runId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`GOWM_COVERAGE_PROVIDER_PROTOCOL_PASS ${runId} checks=${Object.keys(checks).length} operations=${manifest.capabilities.length}\n`);
