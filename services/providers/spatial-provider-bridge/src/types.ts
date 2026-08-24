import type {
  DataSnapshotContext,
  EvidenceReference,
  PlatformCommonDefinitionsReferenceKey,
  SpatialProviderOperationContractsV1Metric,
  SpatialProviderOperationContractsV1ObjectPageOutput,
  SpatialProviderOperationContractsV1ObjectResult
} from "../../../../packages/platform/contract-runtime/src/index.js";
import type { ResourceConsumption } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { SpatialOperationId } from "./schemas.js";

export type ReferenceKey = PlatformCommonDefinitionsReferenceKey;
export type SpatialObjectResult = SpatialProviderOperationContractsV1ObjectResult;
export type SpatialObjectPage = SpatialProviderOperationContractsV1ObjectPageOutput;
export type SpatialMetric = SpatialProviderOperationContractsV1Metric;

export interface SpatialQueryResult {
  output: unknown;
  dataSnapshot: DataSnapshotContext;
  evidenceReferences: EvidenceReference[];
  consumption: ResourceConsumption;
  warnings: string[];
}

export interface SpatialSqlResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface SpatialSqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<SpatialSqlResult<Row>>;
  release(): void;
}

export interface SpatialSqlPool {
  connect(): Promise<SpatialSqlClient>;
  end?(): Promise<void>;
}

export interface SpatialRepositoryOptions {
  pool: SpatialSqlPool;
  cursorSecret: string;
  postgisVersion?: string;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  maximumRows?: number;
  maximumCandidates?: number;
  maximumEvidenceReferences?: number;
}

export interface SpatialRepositoryExecutionContext {
  operationId: SpatialOperationId;
  dataScopeKey: string;
  deadlineRemainingMs: number;
}

export interface DatasetSnapshotRow extends Record<string, unknown> {
  dataset_reference_key: unknown;
  current_world_version: unknown;
  snapshot_consistency: unknown;
  captured_at: unknown;
}
