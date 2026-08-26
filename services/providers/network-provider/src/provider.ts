import semanticProfiles0 from "./semantic-profiles.network.json" with { type: "json" };
import { declaredSemanticProfile } from "../../../../packages/platform/provider-sdk/src/declared-semantics.js";
const DECLARED_SEMANTICS = { ...semanticProfiles0 };
import { getContractSchemaHash, type CapabilityDescriptor, type CapabilityProviderManifest } from "../../../../packages/platform/contract-runtime/src/index.js";
import { createProviderRuntime, sha256, type ProviderOperation, type ProviderRuntime } from "../../../../packages/platform/provider-sdk/src/index.js";
import { NetworkRepository, NETWORK_OPERATION_IDS, type NetworkOperationId } from "../../../../packages/network-query-core/src/index.js";
import { NETWORK_SCHEMA_LOCKS, schemasFor } from "./schemas.js";
import type { NetworkProviderOptions } from "../../../../packages/network-query-core/src/index.js";

export interface NetworkProvider { runtime: ProviderRuntime; repository: NetworkRepository; }

export function createNetworkProvider(options: NetworkProviderOptions): NetworkProvider {
  const repository = new NetworkRepository(options);
  const operations = NETWORK_OPERATION_IDS.map((operationId) => operation(operationId, repository));
  const policy = {
    version: "gowm-network-provider-policy/1.0", readContract: "gowm_network_v1", baseTableAccess: false,
    scopeBeforeQuery: true, readOnlyTransaction: true, isolation: "REPEATABLE READ",
    algorithms: ["directed-dijkstra", "turn-product-state", "independent-replay"], maximumSegments: options.maximumSegments ?? 100_000
  } as const;
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0", manifestSchemaVersion: "1.1",
    provider: {
      providerId: "gowm.network", providerVersion: "1.0.0", owner: "gowm-platform",
      implementationDigest: sha256({ providerId: "gowm.network", version: "1.0.0", readContract: "gowm_network_v1", operations: operations.map(({ descriptor }) => ({ operationId: descriptor.operationId, inputSchemaHash: descriptor.inputSchemaHash, outputSchemaHash: descriptor.outputSchemaHash })) }),
      sourceRef: "urn:gowm:source:in-tree:network-provider:1.0.0"
    },
    endpoints: { manifest: "/v1/manifest", liveness: "/health/live", readiness: "/health/ready", execute: "/v1/operations/{operationId}:execute", job: "/v1/jobs/{jobId}" },
    capabilities: operations.map(({ descriptor }) => descriptor)
  };
  return {
    repository,
    runtime: createProviderRuntime({ manifest, operations, policyVersion: policy.version, policyDigest: sha256(policy), ...(options.now === undefined ? {} : { now: options.now }), ...(options.receiptId === undefined ? {} : { receiptId: options.receiptId }) })
  };
}

function operation(operationId: NetworkOperationId, repository: NetworkRepository): ProviderOperation {
  const schemas = schemasFor(operationId);
  const lock = NETWORK_SCHEMA_LOCKS[operationId];
  const matrix = operationId === "network.path.cost-matrix";
  const descriptor: CapabilityDescriptor = {
    operationId, operationVersion: "1.0", semanticProfile: declaredSemanticProfile(DECLARED_SEMANTICS, operationId, "1.0"), semanticRole: "FOUNDATION_DATA_QUERY", dataBinding: "WORLD_SNAPSHOT_BOUND",
    resultSemantics: operationId === "network.path.verify" ? "VALIDATION" : operationId.includes("path") ? "DERIVED_ANALYSIS" : "DATA_QUERY",
    executionBindings: ["SYNC_HTTP", "VERSIONED_SQL_CONTRACT", ...(matrix ? ["ASYNC_JOB" as const] : [])],
    criticalPathPolicy: "REMOTE_ONLY", maturity: lock.maturity,
    inputSchemaUri: schemas.inputSchemaUri, inputSchemaHash: schemas.inputSchemaHash,
    outputSchemaUri: schemas.outputSchemaUri, outputSchemaHash: schemas.outputSchemaHash,
    scopePolicy: "DATA_SCOPE_REQUIRED",
    execution: { mode: lock.mode, defaultTimeoutMs: 10_000, maximumTimeoutMs: matrix ? 60_000 : 30_000, costClass: matrix ? "HIGH" : "MEDIUM" },
    limits: { maximumInputBytes: 1_048_576, maximumOutputBytes: 16_777_216, maximumRows: 100_000, maximumCandidates: operationId.startsWith("network.snap") ? 20 : 100_000, ...(matrix ? { maximumBatchItems: 64 } : {}) },
    snapshotPolicy: { dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{ name: "request", schemaUri: schemas.inputSchemaUri, schemaHash: schemas.inputSchemaHash, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }],
      outputs: [{ name: "result", schemaUri: schemas.outputSchemaUri, schemaHash: schemas.outputSchemaHash, valueKind: matrix ? "ROW_SET" : "ANY", unitSemantics: "UNSPECIFIED" },
        ...(operationId === "network.snap.point" ? [{
          name: "directedState", path: "/candidates/0/state",
          schemaUri: "urn:gowm:v0.6.2:directed-network-state", schemaHash: getContractSchemaHash("urn:gowm:v0.6.2:directed-network-state"),
          valueKind: "ANY" as const, unitSemantics: "UNSPECIFIED" as const
        }] : [])]
    }
  };
  return {
    descriptor, inputSchema: schemas.input, outputSchema: schemas.output,
    inputSchemaLockHash: schemas.inputSchemaHash, outputSchemaLockHash: schemas.outputSchemaHash,
    method: { engine: "PostgreSQL+GOWM Product-State", engineVersion: "18/1.0", methodId: `gowm-network-v1/${operationId}`, methodVersion: "1.0", artifacts: [{ kind: "DATABASE", name: "gowm_network_v1", version: "migration-043" }] },
    async handle(input, context) {
      const dataScopeKey = context.security.dataScopeClaim;
      const datasetScopeKey = context.security.datasetScopeClaims?.[0];
      const result = await repository.execute(operationId, input, { ...(dataScopeKey === undefined ? {} : { dataScopeKey }), ...(datasetScopeKey === undefined ? {} : { datasetScopeKey }) }, context.deadline.remainingMs());
      return { status: result.status ?? "COMPLETED", value: result.output, dataSnapshot: result.dataSnapshot, consumption: { rows: result.rows, candidates: result.candidates }, warnings: result.warnings, changes: { repairApplied: false, typeChanged: false } };
    }
  };
}
