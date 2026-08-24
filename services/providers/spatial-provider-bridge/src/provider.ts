import type {
  CapabilityDescriptor,
  CapabilityProviderManifest
} from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  sha256,
  type ProviderOperation,
  type ProviderRuntime
} from "../../../../packages/platform/provider-sdk/src/index.js";
import { GowmSpatialV1Repository } from "./repository.js";
import {
  GOWM_SPATIAL_V1_MIGRATION_SHA256,
  SPATIAL_CONTRACT_TREE_SHA256,
  SPATIAL_DEFINITIONS_SCHEMA_SHA256,
  SPATIAL_OPENAPI_SHA256,
  SPATIAL_OPERATION_IDS,
  SPATIAL_OPERATION_SCHEMAS,
  SPATIAL_SOURCE_ZIP_SHA256,
  type SpatialOperationId
} from "./schemas.js";
import type { SpatialRepositoryOptions } from "./types.js";

export interface SpatialProviderBridgeOptions extends SpatialRepositoryOptions {
  postgisVersion: string;
  now?: () => Date;
  receiptId?: () => string;
}

export interface SpatialProviderBridge {
  runtime: ProviderRuntime;
  repository: GowmSpatialV1Repository;
}

export function createSpatialProviderBridge(options: SpatialProviderBridgeOptions): SpatialProviderBridge {
  if (!options.postgisVersion.trim()) throw new Error("postgisVersion is required");
  const repository = new GowmSpatialV1Repository(options);
  const operations = SPATIAL_OPERATION_IDS.map((operationId) => operation(operationId, repository, options.postgisVersion));
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0",
    provider: {
      providerId: "gowm.spatial-analysis.bridge",
      providerVersion: "0.2.0",
      owner: "gowm-platform",
      implementationDigest: sha256({
        provider: "gowm.spatial-analysis.bridge",
        version: "0.2.0",
        readContract: "gowm_spatial_v1",
        migrationDigest: GOWM_SPATIAL_V1_MIGRATION_SHA256,
        sourceZipDigest: SPATIAL_SOURCE_ZIP_SHA256,
        sourceOpenApiDigest: SPATIAL_OPENAPI_SHA256,
        sourceContractTreeDigest: SPATIAL_CONTRACT_TREE_SHA256,
        canonicalDefinitionsDigest: SPATIAL_DEFINITIONS_SCHEMA_SHA256,
        operations: Object.fromEntries(SPATIAL_OPERATION_IDS.map((operationId) => [operationId, {
          inputSchemaHash: SPATIAL_OPERATION_SCHEMAS[operationId].inputSchemaHash,
          outputSchemaHash: SPATIAL_OPERATION_SCHEMAS[operationId].outputSchemaHash
        }]))
      }),
      sourceRef: "urn:gowm:source:zip:spatial-analysis-service:1.0.0"
    },
    endpoints: {
      manifest: "/v1/manifest",
      liveness: "/health/live",
      readiness: "/health/ready",
      execute: "/v1/operations/{operationId}:execute",
      job: "/v1/jobs/{jobId}"
    },
    capabilities: operations.map((candidate) => candidate.descriptor)
  };
  const policy = {
    version: "gowm-spatial-read-policy/1.0",
    readContract: "gowm_spatial_v1",
    baseTableAccess: false,
    readOnlyTransaction: true,
    isolation: "REPEATABLE READ",
    dataScopeEnforcement: "gowm_spatial_v1.set_data_scope",
    snapshotConsistency: "CONSISTENT_AT_START",
    parameterizedSqlOnly: true,
    providerToProviderCalls: false,
    maximumRows: options.maximumRows ?? 10_000,
    maximumCandidates: options.maximumCandidates ?? 50_000
  } as const;
  return {
    repository,
    runtime: createProviderRuntime({
      manifest,
      operations,
      policyVersion: policy.version,
      policyDigest: sha256(policy),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.receiptId === undefined ? {} : { receiptId: options.receiptId })
    })
  };
}

function operation(
  operationId: SpatialOperationId,
  repository: GowmSpatialV1Repository,
  postgisVersion: string
): ProviderOperation {
  const schemas = SPATIAL_OPERATION_SCHEMAS[operationId];
  const descriptor: CapabilityDescriptor = {
    operationId,
    operationVersion: "1.0",
    semanticRole: "FOUNDATION_DATA_QUERY",
    dataBinding: "WORLD_SNAPSHOT_BOUND",
    resultSemantics: "DATA_QUERY",
    executionBindings: ["SYNC_HTTP", "VERSIONED_SQL_CONTRACT"],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: operationId === "spatial.join" || operationId === "spatial.aggregate" ? "EXPERIMENTAL" : "PREVIEW",
    inputSchemaUri: schemas.inputSchemaUri,
    inputSchemaHash: schemas.inputSchemaHash,
    outputSchemaUri: schemas.outputSchemaUri,
    outputSchemaHash: schemas.outputSchemaHash,
    scopePolicy: "DATA_SCOPE_REQUIRED",
    execution: {
      mode: "SYNC",
      defaultTimeoutMs: 10_000,
      maximumTimeoutMs: 30_000,
      costClass: operationId === "spatial.join" || operationId === "spatial.aggregate" ? "HIGH" : "MEDIUM"
    },
    limits: {
      maximumInputBytes: operationId === "spatial.find-in-area" || operationId === "spatial.find-intersections"
        ? 16 * 1024 * 1024
        : 1 * 1024 * 1024,
      maximumOutputBytes: 16 * 1024 * 1024,
      maximumRows: operationId === "spatial.aggregate" ? 100 : 10_000,
      maximumCandidates: 50_000,
      maximumVertices: 100_000
    },
    snapshotPolicy: { dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: schemas.inputSchemaUri,
        schemaHash: schemas.inputSchemaHash,
        valueKind: "ANY",
        unitSemantics: "UNSPECIFIED"
      }],
      outputs: [{
        name: "result",
        schemaUri: schemas.outputSchemaUri,
        schemaHash: schemas.outputSchemaHash,
        valueKind: "ROW_SET",
        unitSemantics: "UNSPECIFIED"
      }]
    }
  };
  return {
    descriptor,
    inputSchema: schemas.input,
    outputSchema: schemas.output,
    method: {
      engine: "PostGIS",
      engineVersion: postgisVersion,
      methodId: `gowm-spatial-v1/${operationId.slice("spatial.".length)}`,
      methodVersion: "1.0",
      artifacts: [{
        kind: "DATABASE",
        name: "gowm_spatial_v1",
        version: "migration-012",
        digest: GOWM_SPATIAL_V1_MIGRATION_SHA256
      }]
    },
    async handle(input, context) {
      const result = await repository.execute(
        operationId,
        input,
        context.security.dataScopeClaim as string,
        context.deadline.remainingMs()
      );
      return {
        status: "COMPLETED",
        value: result.output,
        dataSnapshot: result.dataSnapshot,
        evidenceReferences: result.evidenceReferences,
        consumption: result.consumption,
        warnings: [
          ...result.warnings,
          ...(locationHasIgnoredZ(operationId, input) ? ["spatial.locationZIgnored=true"] : []),
          `spatial.scopeDigest=${result.dataSnapshot.scopeDigest}`,
          "spatial.readContract=gowm_spatial_v1",
          "spatial.snapshot=CONSISTENT_AT_START",
          "spatial.transaction=REPEATABLE_READ_READ_ONLY"
        ],
        changes: { repairApplied: false, typeChanged: false }
      };
    }
  };
}

function locationHasIgnoredZ(operationId: SpatialOperationId, input: unknown): boolean {
  if (operationId !== "spatial.find-nearby" && operationId !== "spatial.find-nearest") return false;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const location = (input as Record<string, unknown>).location;
  return Array.isArray(location) && location.length === 3;
}
