import type { DataSnapshotContext } from "../../platform/contract-runtime/src/index.js";

export type Row = Record<string, unknown>;

export interface NetworkSqlResult<T extends Row = Row> {
  rows: T[];
  rowCount: number | null;
}

export interface NetworkSqlClient {
  query<T extends Row = Row>(text: string, values?: readonly unknown[]): Promise<NetworkSqlResult<T>>;
  release(): void;
}

export interface NetworkSqlPool {
  connect(): Promise<NetworkSqlClient>;
  end?(): Promise<void>;
}

export interface NetworkProviderOptions {
  pool: NetworkSqlPool;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  maximumSegments?: number;
  maximumMatrixPoints?: number;
  ambiguityScoreTolerance?: number;
  now?: () => Date;
  receiptId?: () => string;
}

export interface DirectedState {
  arcKey: string;
  fractionPpm: number;
  direction: "FORWARD" | "REVERSE";
  headingMicrodegrees?: number;
  sourceFeatureReferenceKey?: Row;
}

export interface RoutingSnapshot {
  networkDatasetVersion: string;
  graphVersion: string;
  travelProfileVersion: string;
  costProfileVersion: string;
  conditionSnapshotId?: string;
  sourceWorldVersion?: number;
  graphContentHash: `sha256:${string}`;
  costContentHash: `sha256:${string}`;
  conditionContentHash?: `sha256:${string}`;
  capturedAt?: string;
}

export interface NetworkArc {
  id: string;
  key: string;
  source: string;
  target: string;
  direction: "FORWARD" | "REVERSE";
  headingMicrodegrees: number;
  sourceFeatureReferenceKey?: Row;
  distanceMm: number;
  durationMs: number;
  riskMicroUnits: number;
  energyMwh: number;
  combinedCostUnits: number;
  conditionPenaltyUnits: number;
}

export interface TurnRule {
  sequence: string[];
  ruleType: "FORBIDDEN" | "ALLOWED_ONLY" | "PENALTY";
  penaltyUnits: number;
}

export interface LoadedNetwork {
  routingSnapshot: RoutingSnapshot;
  graph: Row;
  dataSnapshot: DataSnapshotContext;
  arcs: NetworkArc[];
  turnRules: TurnRule[];
}

export interface NetworkExecutionResult {
  output: unknown;
  dataSnapshot: DataSnapshotContext;
  rows: number;
  candidates: number;
  warnings: string[];
  status?: "COMPLETED" | "NO_DATA" | "INDETERMINATE";
}
