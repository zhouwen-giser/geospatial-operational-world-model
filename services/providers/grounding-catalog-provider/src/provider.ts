import semanticProfiles0 from "./semantic-profiles.reference.json" with { type: "json" };
import semanticProfiles1 from "./semantic-profiles.dataset.json" with { type: "json" };
import semanticProfiles2 from "./semantic-profiles.evidence.json" with { type: "json" };
import { declaredSemanticProfile } from "../../../../packages/platform/provider-sdk/src/declared-semantics.js";
const DECLARED_SEMANTICS = { ...semanticProfiles0, ...semanticProfiles1, ...semanticProfiles2 };
import {
  getContractSchemaHash,
  type CapabilityDescriptor,
  type CapabilityProviderManifest
} from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  sha256,
  type ProviderOperation,
  type ProviderRuntime
} from "../../../../packages/platform/provider-sdk/src/index.js";
import {
  GroundingCatalogRepository,
  REFERENCE_RESOLUTION_POLICY_IDENTITY
} from "./repository.js";
import {
  GROUNDING_CATALOG_FEATURE_MIGRATION_SHA256,
  GROUNDING_CATALOG_OPERATION_SCHEMAS,
  operationsForMode,
  type GroundingCatalogOperationId
} from "./schemas.js";
import type { GroundingCatalogMode, GroundingCatalogRepositoryOptions } from "./types.js";

export interface GroundingCatalogProviderOptions extends GroundingCatalogRepositoryOptions {
  mode: GroundingCatalogMode;
  now?: () => Date;
  receiptId?: () => string;
}

export interface GroundingCatalogProvider {
  mode: GroundingCatalogMode;
  runtime: ProviderRuntime;
  repository: GroundingCatalogRepository;
}

export function groundingCatalogImplementationIdentity(mode: GroundingCatalogMode) {
  const providerId = providerIdForMode(mode);
  const operationIds = operationsForMode(mode);
  return {
    providerId,
    version: "1.0.0",
    readContract: readContractForMode(mode),
    ...(mode === "reference" ? { resolutionPolicy: REFERENCE_RESOLUTION_POLICY_IDENTITY } : {}),
    ...(mode === "evidence" ? { catalogFeatureMigrationDigest: GROUNDING_CATALOG_FEATURE_MIGRATION_SHA256 } : {}),
    operations: operationIds.map((operationId) => ({
      operationId,
      inputSchemaHash: GROUNDING_CATALOG_OPERATION_SCHEMAS[operationId].inputSchemaHash,
      outputSchemaHash: GROUNDING_CATALOG_OPERATION_SCHEMAS[operationId].outputSchemaHash
    }))
  } as const;
}

export function groundingCatalogPolicy(mode: GroundingCatalogMode) {
  return {
    version: mode === "reference" ? "gowm-reference-catalog-policy/1.1" : `gowm-${mode}-catalog-policy/1.0`,
    readContract: readContractForMode(mode),
    ...(mode === "reference" ? { resolutionPolicy: REFERENCE_RESOLUTION_POLICY_IDENTITY } : {}),
    scopeBeforeQuery: true,
    baseTableAccess: false,
    readOnlyTransaction: true,
    isolation: "REPEATABLE READ",
    stableOrdering: "reference_key ASC",
    signedScopeBoundCursors: true,
    providerToProviderCalls: false
  } as const;
}

export function createGroundingCatalogProvider(options: GroundingCatalogProviderOptions): GroundingCatalogProvider {
  const repository = new GroundingCatalogRepository(options);
  const operationIds = operationsForMode(options.mode);
  const operations = operationIds.map((operationId) => operation(operationId, repository));
  const implementationIdentity = groundingCatalogImplementationIdentity(options.mode);
  const providerId = implementationIdentity.providerId;
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0", manifestSchemaVersion: "1.1",
    provider: {
      providerId,
      providerVersion: "1.0.0",
      owner: "gowm-platform",
      implementationDigest: sha256(implementationIdentity),
      sourceRef: "urn:gowm:source:in-tree:grounding-catalog:1.0.0"
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
  const policy = groundingCatalogPolicy(options.mode);
  return {
    mode: options.mode,
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

function providerIdForMode(mode: GroundingCatalogMode): "gowm.reference-catalog" | "gowm.dataset-catalog" | "gowm.world-evidence" {
  return mode === "reference" ? "gowm.reference-catalog" : mode === "dataset" ? "gowm.dataset-catalog" : "gowm.world-evidence";
}

function readContractForMode(mode: GroundingCatalogMode): string {
  return mode === "reference" ? "gowm_reference_v1" : mode === "dataset" ? "gowm_catalog_v1" : "gowm_evidence_v1+gowm_result_v1+reference-geometry-composability@062";
}

const STABLE_GROUNDING_OPERATIONS = new Set<GroundingCatalogOperationId>([
  "reference.get",
  "reference.resolve",
  "world.get-current-state",
  "world.get-geometry",
  "world.get-provenance",
  "catalog.get",
  "catalog.search"
]);

function operation(operationId: GroundingCatalogOperationId, repository: GroundingCatalogRepository): ProviderOperation {
  const schemas = GROUNDING_CATALOG_OPERATION_SCHEMAS[operationId];
  const datasetOperation = operationId.startsWith("dataset.") || operationId.startsWith("layer.") || operationId.startsWith("feature.") || operationId.startsWith("catalog.");
  const resultOperation = operationId.startsWith("result.") || operationId.startsWith("reference-set.");
  const evidenceOperation = operationId.startsWith("world.") || operationId.startsWith("result.") || operationId.startsWith("reference-set.");
  const listOperation = operationId.endsWith(".list") || operationId === "catalog.search" || operationId === "catalog.list-versions" || operationId === "layer.find-features" || operationId === "reference.batch-get" || operationId === "reference-set.get-members" || operationId === "world.get-observations" || operationId === "world.get-event-timeline" || operationId === "world.get-state-history";
  const descriptor: CapabilityDescriptor = {
    operationId,
    operationVersion: "1.0", semanticProfile: declaredSemanticProfile(DECLARED_SEMANTICS, operationId, "1.0"),
    semanticRole: "FOUNDATION_DATA_QUERY",
    dataBinding: datasetOperation ? "DATASET_VERSION_BOUND" : "WORLD_SNAPSHOT_BOUND",
    resultSemantics: "DATA_QUERY",
    executionBindings: ["SYNC_HTTP", "VERSIONED_SQL_CONTRACT"],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: STABLE_GROUNDING_OPERATIONS.has(operationId) ? "STABLE" : "PREVIEW",
    inputSchemaUri: schemas.inputSchemaUri,
    inputSchemaHash: schemas.inputSchemaHash,
    outputSchemaUri: schemas.outputSchemaUri,
    outputSchemaHash: schemas.outputSchemaHash,
    scopePolicy: datasetOperation ? "DATASET_SCOPE_REQUIRED" : "DATA_SCOPE_REQUIRED",
    execution: { mode: "SYNC", defaultTimeoutMs: 10_000, maximumTimeoutMs: 30_000, costClass: "MEDIUM" },
    limits: {
      maximumInputBytes: 1_048_576,
      maximumOutputBytes: 16_777_216,
      maximumRows: listOperation ? 1_000 : 100,
      maximumCandidates: 5_000
    },
    snapshotPolicy: { dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{ name: "request", schemaUri: schemas.inputSchemaUri, schemaHash: schemas.inputSchemaHash, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }],
      outputs: [
        { name: "result", schemaUri: schemas.outputSchemaUri, schemaHash: schemas.outputSchemaHash, valueKind: listOperation ? "ROW_SET" : "ANY", unitSemantics: "UNSPECIFIED" },
        ...(["reference.resolve", "reference.search"].includes(operationId) ? [{
          name: "candidateReferenceKey",
          path: "/resolutions/0/candidates/0/candidate/referenceKey",
          schemaUri: "urn:gowm:v0.4:reference-key",
          schemaHash: getContractSchemaHash("urn:gowm:v0.4:reference-key"),
          valueKind: "REFERENCE_KEY" as const,
          unitSemantics: "UNSPECIFIED" as const
        }] : []),
        ...(operationId === "world.get-geometry" ? [{
          name: "geometry",
          path: "/facts/0/geometry",
          schemaUri: "urn:gowm:v0.2:value:object",
          schemaHash: getContractSchemaHash("urn:gowm:v0.2:value:object"),
          valueKind: "GEOMETRY" as const,
          unitSemantics: "ANGULAR_DEGREES" as const
        }] : [])
        ,...(operationId === "world.get-current-state" ? [{
          name: "position", path: "/facts/0/position",
          schemaUri: "urn:gowm:v0.6.2:geojson-point",
          schemaHash: getContractSchemaHash("urn:gowm:v0.6.2:geojson-point"),
          valueKind: "GEOMETRY" as const, unitSemantics: "ANGULAR_DEGREES" as const
        },{
          name: "positionCoordinates", path: "/facts/0/position/coordinates",
          schemaUri: "urn:gowm:v0.6.2:geojson-position",
          schemaHash: getContractSchemaHash("urn:gowm:v0.6.2:geojson-position"),
          valueKind: "ANY" as const, unitSemantics: "ANGULAR_DEGREES" as const
        }] : [])
      ]
    }
  };
  return {
    descriptor,
    inputSchema: schemas.input,
    outputSchema: schemas.output,
    method: {
      engine: "PostgreSQL",
      engineVersion: "18",
      methodId: `${datasetOperation ? "gowm-catalog-v1" : evidenceOperation ? "gowm-evidence-v1" : "gowm-reference-v1"}/${operationId}`,
      methodVersion: "1.0",
      artifacts: [{
        kind: "DATABASE",
        name: datasetOperation ? "gowm_catalog_v1" : resultOperation ? "gowm_result_v1" : evidenceOperation ? "gowm_evidence_v1" : "gowm_reference_v1",
        version: resultOperation ? "migration-022" : evidenceOperation ? "migration-023" : "migration-020"
      }, ...(operationId === "world.get-geometry" ? [{
        kind: "DATABASE" as const,
        name: "gowm_evidence_v1.current_geometry",
        version: "migration-062",
        digest: GROUNDING_CATALOG_FEATURE_MIGRATION_SHA256
      }] : [])]
    },
    async handle(input, context) {
      const dataScopeKey = context.security.dataScopeClaim;
      const datasetScopeKey = context.security.datasetScopeClaims?.[0];
      const result = await repository.execute(operationId, input, {
        ...(dataScopeKey === undefined ? {} : { dataScopeKey }),
        ...(datasetScopeKey === undefined ? {} : { datasetScopeKey })
      }, context.deadline.remainingMs());
      return {
        status: result.status ?? (result.output === undefined ? "NO_DATA" : "COMPLETED"),
        ...(result.output === undefined ? {} : { value: result.output }),
        dataSnapshot: result.dataSnapshot,
        consumption: { rows: result.rows, candidates: result.candidates },
        warnings: result.warnings,
        changes: { repairApplied: false, typeChanged: false }
      };
    }
  };
}
