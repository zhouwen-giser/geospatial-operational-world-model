import semanticProfiles0 from "./semantic-profiles.situation.json" with { type: "json" };
import { declaredSemanticProfile } from "../../../../packages/platform/provider-sdk/src/declared-semantics.js";
const DECLARED_SEMANTICS = { ...semanticProfiles0 };
import type {
  CapabilityDescriptor,
  CapabilityProviderManifest,
  DataSnapshotContext
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { getContractSchemaHash } from "../../../../packages/platform/contract-runtime/src/index.js";
import {
  createProviderRuntime,
  ProviderProtocolError,
  sha256,
  type ProviderOperation,
  type ProviderRuntime
} from "../../../../packages/platform/provider-sdk/src/index.js";
import type { Geometry, SituationCell, SituationMetrics } from "../../../../packages/world-model-core/src/types.js";
import {
  GOWM_SITUATION_OPERATION_IDS,
  GOWM_SITUATION_OPERATION_SCHEMAS,
  type GowmSituationOperationId
} from "./schemas.js";
import type { GowmSituationReadPort } from "./types.js";

export const GOWM_SITUATION_METRIC_PROFILE = {
  profileId: "gowm.h3-situation.metrics",
  profileVersion: "1.0",
  authority: "GOWM Foundation",
  resolutionPolicy: "GOWM_SITUATION_R7_R10",
  scoreMinimum: 0,
  scoreMaximum: 100
} as const;

export interface GowmSituationProviderOptions {
  port: GowmSituationReadPort;
  acceptedDataScope: string;
  now?: () => Date;
  receiptId?: () => string;
}

export interface GowmSituationProvider {
  runtime: ProviderRuntime;
  port: GowmSituationReadPort;
}

export function createGowmSituationProvider(options: GowmSituationProviderOptions): GowmSituationProvider {
  if (!options.acceptedDataScope.trim()) throw new Error("acceptedDataScope is required");
  const operations = GOWM_SITUATION_OPERATION_IDS.map((operationId) => createOperation(operationId, options));
  const manifest: CapabilityProviderManifest = {
    providerProtocolVersion: "1.0", manifestSchemaVersion: "1.1",
    provider: {
      providerId: "gowm.situation.h3",
      providerVersion: "0.2.0",
      owner: "gowm-platform",
      implementationDigest: sha256({
        provider: "gowm.situation.h3",
        version: "0.2.0",
        authority: "GOWM Foundation",
        deploymentScopeMode: "PINNED_SINGLE_SCOPE",
        metricProfile: GOWM_SITUATION_METRIC_PROFILE,
        operations: GOWM_SITUATION_OPERATION_IDS
      }),
      sourceRef: "urn:gowm:source:in-tree:h3-situation-projection"
    },
    endpoints: {
      manifest: "/v1/manifest",
      liveness: "/health/live",
      readiness: "/health/ready",
      execute: "/v1/operations/{operationId}:execute",
      job: "/v1/jobs/{jobId}"
    },
    capabilities: operations.map((operation) => operation.descriptor)
  };
  const policy = {
    version: "gowm-situation-read-policy/1.0",
    readOnly: true,
    authority: "GOWM Foundation",
    metricProfile: GOWM_SITUATION_METRIC_PROFILE,
    snapshotConsistency: "BEST_EFFORT",
    deploymentScopeMode: "PINNED_SINGLE_SCOPE",
    multiScopeSupport: false,
    genericH3Ownership: false,
    providerToProviderCalls: false
  } as const;
  return {
    port: options.port,
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

function createOperation(
  operationId: GowmSituationOperationId,
  options: GowmSituationProviderOptions
): ProviderOperation {
  const schemas = GOWM_SITUATION_OPERATION_SCHEMAS[operationId];
  const descriptor: CapabilityDescriptor = {
    operationId,
    operationVersion: "1.0", semanticProfile: declaredSemanticProfile(DECLARED_SEMANTICS, operationId, "1.0"),
    semanticRole: "PROJECTION_QUERY",
    dataBinding: "WORLD_SNAPSHOT_BOUND",
    resultSemantics: "WORLD_PROJECTION",
    executionBindings: ["SYNC_HTTP"],
    criticalPathPolicy: "REMOTE_ONLY",
    maturity: "PREVIEW",
    inputSchemaUri: schemas.inputSchemaUri,
    inputSchemaHash: schemas.inputSchemaHash,
    outputSchemaUri: schemas.outputSchemaUri,
    outputSchemaHash: schemas.outputSchemaHash,
    scopePolicy: "DATA_SCOPE_REQUIRED",
    execution: {
      mode: "SYNC",
      defaultTimeoutMs: 5_000,
      maximumTimeoutMs: 15_000,
      costClass: operationId === "gowm.situation.h3.get-area" ? "MEDIUM" : "LOW"
    },
    limits: {
      maximumInputBytes: 1_048_576,
      maximumOutputBytes: 16_777_216,
      maximumRows: operationId === "gowm.situation.h3.get-area" ? 100_000 : 1_000,
      maximumCells: operationId === "gowm.situation.h3.get-area" ? 100_000 : 1_000
    },
    snapshotPolicy: { dataSnapshot: "REQUIRED", computeSnapshot: "REQUIRED" },
    ports: {
      inputs: [{
        name: "request",
        schemaUri: schemas.inputSchemaUri,
        schemaHash: schemas.inputSchemaHash,
        valueKind: operationId === "gowm.situation.h3.get-cell" ? "H3_CELL_SET" : "ANY",
        unitSemantics: "DISCRETE"
      }],
      outputs: [{
        name: "result",
        schemaUri: schemas.outputSchemaUri,
        schemaHash: schemas.outputSchemaHash,
        valueKind: operationId === "gowm.situation.h3.get-cell" ? "ANY" : "ROW_SET",
        unitSemantics: "DISCRETE"
      }, ...situationOutputSubports(operationId)]
    }
  };
  return {
    descriptor,
    inputSchema: schemas.input,
    outputSchema: schemas.output,
    method: {
      engine: "GOWM Situation Projection",
      engineVersion: "1.0.0",
      methodId: operationId,
      methodVersion: "1.0"
    },
    async handle(input, context) {
      assertDeadline(context.deadline.remainingMs(), context.deadline.signal);
      const dataScopeClaim = context.security.dataScopeClaim;
      if (dataScopeClaim !== options.acceptedDataScope) {
        throw new ProviderProtocolError("SCOPE_DENIED", "GOWM Situation provider is pinned to a different deployment data scope", {
          retryable: false,
          details: { deploymentScopePinned: true }
        });
      }
      const record = asRecord(input);
      const value = await executeOperation(operationId, record, options.port, dataScopeClaim);
      assertDeadline(context.deadline.remainingMs(), context.deadline.signal);
      const worldVersion = maximumWorldVersion(value.cells, await options.port.worldVersion(dataScopeClaim));
      const capturedAt = (options.now ?? (() => new Date()))().toISOString();
      const output = { ...value.output, worldVersion, metricProfile: GOWM_SITUATION_METRIC_PROFILE };
      return {
        status: value.noData ? "NO_DATA" : "COMPLETED",
        value: output,
        dataSnapshot: snapshot(worldVersion, capturedAt, dataScopeClaim),
        consumption: { rows: value.cells.length, candidates: value.cells.length },
        warnings: [
          "gowm.situation.authority=GOWM_Foundation",
          "gowm.situation.metricProfile=1.0",
          "gowm.situation.scopeMode=PINNED_SINGLE_SCOPE",
          "gowm.situation.snapshot=BEST_EFFORT"
        ],
        changes: { repairApplied: false, typeChanged: false }
      };
    }
  };
}

function situationOutputSubports(operationId: GowmSituationOperationId): CapabilityDescriptor["ports"]["outputs"] {
  if (operationId !== "gowm.situation.h3.get-cell") return [];
  return [
    {
      name: "references",
      path: "/references",
      schemaUri: "urn:gowm:v0.2:value:array",
      schemaHash: getContractSchemaHash("urn:gowm:v0.2:value:array"),
      valueKind: "ROW_SET",
      unitSemantics: "DISCRETE"
    },
    {
      name: "candidateOnly",
      path: "/candidateOnly",
      schemaUri: "urn:gowm:v0.2:value:boolean",
      schemaHash: getContractSchemaHash("urn:gowm:v0.2:value:boolean"),
      valueKind: "SCALAR",
      unitSemantics: "DIMENSIONLESS"
    },
    {
      name: "exactVerificationRequired",
      path: "/exactVerificationRequired",
      schemaUri: "urn:gowm:v0.2:value:boolean",
      schemaHash: getContractSchemaHash("urn:gowm:v0.2:value:boolean"),
      valueKind: "SCALAR",
      unitSemantics: "DIMENSIONLESS"
    }
  ];
}

async function executeOperation(
  operationId: GowmSituationOperationId,
  input: Record<string, unknown>,
  port: GowmSituationReadPort,
  dataScopeKey: string
): Promise<{ output: Record<string, unknown>; cells: SituationCell[]; noData: boolean }> {
  switch (operationId) {
    case "gowm.situation.h3.get-cell": {
      const indexes = Array.isArray(input.cells)
        ? input.cells.map((value) => requiredString(value, "cells[]"))
        : [requiredString(input.h3Index, "h3Index")];
      const [cells, references] = await Promise.all([
        port.getCells(dataScopeKey, indexes),
        port.candidateReferences(dataScopeKey, indexes, 10_001)
      ]);
      if (references.length > 10_000) {
        throw new ProviderProtocolError("BUDGET_EXCEEDED", "Situation candidate reference budget exceeded", {
          retryable: false,
          details: { maximumReferences: 10_000 }
        });
      }
      return {
        output: { cells, references, candidateOnly: true, exactVerificationRequired: true },
        cells,
        noData: cells.length === 0 && references.length === 0
      };
    }
    case "gowm.situation.h3.get-area": {
      const cells = await port.areaCells(dataScopeKey, input.area as Geometry, requiredInteger(input.resolution, "resolution"));
      return {
        output: { cells, summary: { cellCount: cells.length, totals: sumMetrics(cells) } },
        cells,
        noData: cells.length === 0
      };
    }
    case "gowm.situation.h3.get-hotspots": {
      const resolution = requiredInteger(input.resolution, "resolution");
      const metric = requiredMetric(input.metric);
      const cells = await port.ranked(dataScopeKey, {
        resolution,
        metric,
        order: "DESC",
        limit: optionalInteger(input.limit, 10),
        ...(typeof input.parentCell === "string" ? { parentCell: input.parentCell } : {})
      });
      return { output: { cells, metric, resolution }, cells, noData: cells.length === 0 };
    }
    case "gowm.situation.h3.get-coverage-gaps": {
      const resolution = requiredInteger(input.resolution, "resolution");
      const cells = await port.ranked(dataScopeKey, {
        resolution,
        metric: "coverage",
        order: "ASC",
        limit: optionalInteger(input.limit, 10),
        ...(typeof input.parentCell === "string" ? { parentCell: input.parentCell } : {})
      });
      return { output: { cells, metric: "coverage", resolution }, cells, noData: cells.length === 0 };
    }
  }
}

function snapshot(worldVersion: number, capturedAt: string, dataScopeKey: string): DataSnapshotContext {
  const referenceKey = {
    namespace: "gowm",
    kind: "WORLD_PROJECTION",
    id: "h3-situation",
    version: String(worldVersion)
  };
  return {
    consistency: "BEST_EFFORT",
    capturedAt,
    scopeDigest: sha256({ dataScopeKey }),
    resources: [{
      referenceKey,
      authority: "GOWM Foundation",
      pinning: "BEST_EFFORT",
      digest: sha256({ referenceKey, metricProfile: GOWM_SITUATION_METRIC_PROFILE })
    }]
  };
}

function assertDeadline(remainingMs: number, signal: AbortSignal): void {
  if (remainingMs <= 0 || signal.aborted) {
    throw new ProviderProtocolError("DEADLINE_EXCEEDED", "GOWM Situation provider deadline exceeded");
  }
}

function sumMetrics(cells: SituationCell[]): SituationMetrics {
  const total: SituationMetrics = {
    agentCount: 0,
    vehicleCount: 0,
    sensorCount: 0,
    incidentCount: 0,
    observationCount: 0,
    riskScore: 0,
    coverageScore: 0,
    activityScore: 0,
    freshnessScore: 0
  };
  for (const cell of cells) {
    for (const key of Object.keys(total) as Array<keyof SituationMetrics>) total[key] += cell.metrics[key];
  }
  return total;
}

function maximumWorldVersion(cells: SituationCell[], current: number): number {
  return cells.reduce((maximum, cell) => Math.max(maximum, cell.worldVersion), current);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("situation input must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value as number;
}

function optionalInteger(value: unknown, fallback: number): number {
  return value === undefined ? fallback : requiredInteger(value, "limit");
}

function requiredMetric(value: unknown): "activity" | "risk" | "coverage" | "freshness" | "observations" {
  if (!["activity", "risk", "coverage", "freshness", "observations"].includes(String(value))) {
    throw new Error("metric is invalid");
  }
  return value as "activity" | "risk" | "coverage" | "freshness" | "observations";
}
