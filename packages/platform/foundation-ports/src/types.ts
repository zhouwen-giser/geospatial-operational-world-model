import type { Geometry } from "../../../world-model-core/src/types.js";
import type {
  ComputeSnapshotContext,
  CrsNormalizeGeometryInputV1,
  CrsNormalizeGeometryOutputV1,
  ExecutionReceipt,
  GeometryValidateOutputV1,
  GowmFoundationH3ProjectPointInputV1,
  GowmFoundationH3ProjectPointOutputV1,
  H3IndexPointsInputV1,
  H3IndexPointsOutputV1
} from "../../contract-runtime/src/index.js";

export interface Clock {
  now(): Date;
}

export interface IdFactory {
  nextId(): string;
}

export type FoundationComputeSnapshot = ComputeSnapshotContext;
export type FoundationProcessingReceipt = ExecutionReceipt;

export interface OperationSchemaAttestation {
  inputSchemaHash: `sha256:${string}`;
  outputSchemaHash: `sha256:${string}`;
}

export interface FoundationExecution<T> {
  result: T;
  computeSnapshot: FoundationComputeSnapshot;
  receipt: FoundationProcessingReceipt;
  supportingReceipts: Array<{
    computeSnapshot: FoundationComputeSnapshot;
    receipt: FoundationProcessingReceipt;
  }>;
  executionContext: {
    executionBinding: "EMBEDDED_LOCAL";
    criticalPathPolicy: "LOCAL_ONLY";
    remoteDependency: false;
    evidenceSemantics: "COMPUTE_ONLY_NOT_WORLD_EVIDENCE";
  };
}

export type GeometryValidationResult = GeometryValidateOutputV1;

export interface GeometryValidationPort {
  validate(geometry: Geometry): Promise<FoundationExecution<GeometryValidationResult>>;
  assertValid(geometry: Geometry): Promise<FoundationExecution<GeometryValidationResult>>;
}

/** Pre-contract request: the local implementation gives non-4326 callers a typed policy denial. */
export type CrsNormalizationInput = Omit<CrsNormalizeGeometryInputV1, "sourceCrs" | "geometry"> & {
  sourceCrs: string;
  geometry: Geometry;
};

export type CrsNormalizationResult = Omit<CrsNormalizeGeometryOutputV1, "geometry"> & {
  geometry: Geometry;
};

export interface CrsNormalizationPort {
  normalizeGeometry(input: CrsNormalizationInput): Promise<FoundationExecution<CrsNormalizationResult>>;
}

export type H3GeoPoint = H3IndexPointsInputV1["points"][number];
export type H3ResolutionInput = H3IndexPointsInputV1["resolution"];
export type H3IndexPointsInput = H3IndexPointsInputV1;
export type H3Cell = H3IndexPointsOutputV1[number];

export interface H3ProjectionInput {
  point: GowmFoundationH3ProjectPointInputV1["point"];
  resolutions?: GowmFoundationH3ProjectPointInputV1["resolutions"];
}

export type H3ProjectionResult = GowmFoundationH3ProjectPointOutputV1;

export interface H3LocalAdapter {
  indexPoints(input: H3IndexPointsInput): Promise<FoundationExecution<H3Cell[]>>;
  projectPoint(input: H3ProjectionInput): Promise<FoundationExecution<H3ProjectionResult>>;
}

export interface SqlQueryResult<Row> {
  rows: Row[];
}

export interface LocalSqlExecutor {
  query<Row>(text: string, values: readonly unknown[]): Promise<SqlQueryResult<Row>>;
}
