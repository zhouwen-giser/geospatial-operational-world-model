import { getContractSchema, type CapabilityDescriptor, type CapabilityProviderManifest } from "../../../../packages/platform/contract-runtime/src/index.js";
import { createProviderRuntime, sha256, type ProviderOperation, type ProviderRuntime } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { RoadCoverageEngine } from "./engine.js";

export type RoadCoverageOperationId =
  | "coverage.road.validate"
  | "coverage.road.select-obligations"
  | "coverage.road.plan"
  | "coverage.road.verify"
  | "coverage.road.expand-geojson";

interface OperationLock {
  operationId: RoadCoverageOperationId;
  executionMode: "SYNC" | "ASYNC" | "SYNC_OR_ASYNC";
  inputSchemaUri: string;
  inputSchemaHash: `sha256:${string}`;
  outputSchemaUri: string;
  outputSchemaHash: `sha256:${string}`;
  resultSemantics: "VALIDATION" | "DERIVED_ANALYSIS";
  engineMethod: keyof RoadCoverageEngine;
}

export const ROAD_COVERAGE_OPERATION_LOCKS = [
  {
    operationId: "coverage.road.validate",
    executionMode: "SYNC",
    inputSchemaUri: "urn:gowm:v0.6:road-coverage-request",
    inputSchemaHash: "sha256:01a1ff79cfdb0277f25e500c4fd6662564e25e15ad03be7f241d03047cc2100e",
    outputSchemaUri: "urn:gowm:v0.6:coverage-validation-result",
    outputSchemaHash: "sha256:f8df6f34dca1ffeab2dcbca60be2dfecc408a3312b359816fc16be4ca125f55a",
    resultSemantics: "VALIDATION",
    engineMethod: "validate"
  },
  {
    operationId: "coverage.road.select-obligations",
    executionMode: "SYNC",
    inputSchemaUri: "urn:gowm:v0.6:road-coverage-request",
    inputSchemaHash: "sha256:01a1ff79cfdb0277f25e500c4fd6662564e25e15ad03be7f241d03047cc2100e",
    outputSchemaUri: "urn:gowm:v0.6:coverage-obligation-set",
    outputSchemaHash: "sha256:f453949199ebdf7eea944c5eac3fbff95bfc52cdb0f8a33abecb38fe6448cbbe",
    resultSemantics: "DERIVED_ANALYSIS",
    engineMethod: "selectObligations"
  },
  {
    operationId: "coverage.road.plan",
    executionMode: "ASYNC",
    inputSchemaUri: "urn:gowm:v0.6:road-coverage-request",
    inputSchemaHash: "sha256:01a1ff79cfdb0277f25e500c4fd6662564e25e15ad03be7f241d03047cc2100e",
    outputSchemaUri: "urn:gowm:v0.6:coverage-result-set",
    outputSchemaHash: "sha256:6780705366b28bf95ee1868b48587839f50acbe5aa950b3ed256b7d64bd30c50",
    resultSemantics: "DERIVED_ANALYSIS",
    engineMethod: "plan"
  },
  {
    operationId: "coverage.road.verify",
    executionMode: "SYNC_OR_ASYNC",
    inputSchemaUri: "urn:gowm:v0.6:coverage-verification-request",
    inputSchemaHash: "sha256:f8f242440dbb82ea5790ae163455a838d53da451e0481fa36c2b111c423dfcfa",
    outputSchemaUri: "urn:gowm:v0.6:coverage-verification-report",
    outputSchemaHash: "sha256:56063206dc0164bd273a69784a4cc91a9211130f7f71aa2dbbf776cbe20f9584",
    resultSemantics: "VALIDATION",
    engineMethod: "verify"
  },
  {
    operationId: "coverage.road.expand-geojson",
    executionMode: "SYNC",
    inputSchemaUri: "urn:gowm:v0.6:coverage-expand-request",
    inputSchemaHash: "sha256:64f0a1a67d9802a0d41f087f3482158ba7bafa5722dd94cda5314786beb24f37",
    outputSchemaUri: "urn:gowm:v0.6:coverage-geojson-result",
    outputSchemaHash: "sha256:e5c8b4845f9f0717750adb2b5f1b0303f00fd302c1cb962a0336af37474c1b0b",
    resultSemantics: "DERIVED_ANALYSIS",
    engineMethod: "expandGeoJson"
  }
] as const satisfies readonly OperationLock[];

export interface RoadCoverageProvider {
  engine: RoadCoverageEngine;
  runtime: ProviderRuntime;
}

export function createRoadCoverageProvider(engine: RoadCoverageEngine): RoadCoverageProvider {
  const operations = ROAD_COVERAGE_OPERATION_LOCKS.map((lock) => operation(lock, engine));
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0",
    provider: {
      providerId: "gowm.road-coverage-planning",
      providerVersion: "1.0.0",
      owner: "gowm-platform",
      implementationDigest: sha256({
        provider: "gowm.road-coverage-planning",
        version: "1.0.0",
        networkReadContract: "gowm_network_v1",
        coverageRuntime: "coverage_planner",
        operations: ROAD_COVERAGE_OPERATION_LOCKS
      }),
      sourceRef: "urn:gowm:source:in-tree:road-coverage-provider:1.0.0"
    },
    endpoints: {
      manifest: "/v1/manifest",
      liveness: "/health/live",
      readiness: "/health/ready",
      execute: "/v1/operations/{operationId}:execute",
      job: "/v1/jobs/{jobId}"
    },
    capabilities: operations.map(({ descriptor }) => descriptor)
  };
  return {
    engine,
    runtime: createProviderRuntime({
      manifest,
      operations,
      policyVersion: "gowm-road-coverage-policy/1.0",
      policyDigest: sha256({
        networkAuthority: "gowm_network_v1",
        coverageRuntime: "coverage_planner",
        gatewayJobAuthority: true,
        independentVerification: true,
        geometryExpansion: "ON_DEMAND"
      })
    })
  };
}

function operation(lock: OperationLock, engine: RoadCoverageEngine): ProviderOperation {
  const asynchronous = lock.executionMode !== "SYNC";
  const descriptor: CapabilityDescriptor = {
    operationId: lock.operationId,
    operationVersion: "1.0",
    semanticRole: "DOMAIN_ANALYSIS",
    dataBinding: "WORLD_SNAPSHOT_BOUND",
    resultSemantics: lock.resultSemantics,
    executionBindings: ["SYNC_HTTP", "VERSIONED_SQL_CONTRACT", ...(asynchronous ? ["ASYNC_JOB" as const] : [])],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: "STABLE",
    inputSchemaUri: lock.inputSchemaUri,
    inputSchemaHash: lock.inputSchemaHash,
    outputSchemaUri: lock.outputSchemaUri,
    outputSchemaHash: lock.outputSchemaHash,
    scopePolicy: "DATA_SCOPE_REQUIRED",
    execution: {
      mode: lock.executionMode,
      defaultTimeoutMs: lock.executionMode === "SYNC" ? 30_000 : 300_000,
      maximumTimeoutMs: 3_600_000,
      costClass: lock.operationId === "coverage.road.plan" ? "HIGH" : "MEDIUM"
    },
    limits: {
      maximumInputBytes: 1_048_576,
      maximumOutputBytes: 16_777_216,
      maximumRows: 1_000_000,
      maximumCandidates: 100_000,
      maximumBatchItems: 1_000
    },
    snapshotPolicy: { dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{ name: "request", schemaUri: lock.inputSchemaUri, schemaHash: lock.inputSchemaHash, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }],
      outputs: [{ name: "result", schemaUri: lock.outputSchemaUri, schemaHash: lock.outputSchemaHash, valueKind: "ANY", unitSemantics: "UNSPECIFIED" }]
    }
  };
  return {
    descriptor,
    inputSchema: getContractSchema(lock.inputSchemaUri),
    outputSchema: getContractSchema(lock.outputSchemaUri),
    inputSchemaLockHash: lock.inputSchemaHash,
    outputSchemaLockHash: lock.outputSchemaHash,
    method: {
      engine: "GOWM Road Coverage Planning",
      engineVersion: "0.6.0",
      methodId: `gowm-road-coverage/${lock.operationId}`,
      methodVersion: "1.0",
      artifacts: [
        { kind: "DATABASE", name: "gowm_network_v1+coverage_planner", version: "migration-051" },
        { kind: "PACKAGE", name: "road-coverage-planning-core+road-coverage-verifier-core", version: "0.6.0" }
      ]
    },
    async handle(input, context) {
      return await engine[lock.engineMethod](input, context);
    }
  };
}

export type { RoadCoverageEngine } from "./engine.js";
