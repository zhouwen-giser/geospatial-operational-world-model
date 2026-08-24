export type GroundingCatalogMode = "reference" | "dataset" | "result";

export interface CatalogSqlResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface CatalogSqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<CatalogSqlResult<Row>>;
  release(): void;
}

export interface CatalogSqlPool {
  connect(): Promise<CatalogSqlClient>;
  end?(): Promise<void>;
}

export interface GroundingCatalogRepositoryOptions {
  pool: CatalogSqlPool;
  cursorSecret: string;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  maximumRows?: number;
  maximumCandidates?: number;
  now?: () => Date;
}

export interface GroundingCatalogExecutionResult {
  output?: unknown;
  dataSnapshot: import("../../../../packages/platform/contract-runtime/src/index.js").DataSnapshotContext;
  rows: number;
  candidates: number;
  warnings: string[];
}
