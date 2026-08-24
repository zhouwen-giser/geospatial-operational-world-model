import type pg from "pg";
import type {
  CapabilityResultEnvelope,
  ExecutionReceipt,
  JobRecord
} from "../../../../packages/platform/contract-runtime/src/index.js";
import type { GatewayRecordStore } from "./records.js";

interface ReceiptRow {
  receipt_id: string;
  operation_id: string;
  operation_version: string;
  provider_id: string;
  provider_version: string;
  input_hash: `sha256:${string}`;
  output_hash: `sha256:${string}`;
  engine_name: string;
  engine_version: string;
  method_id: string;
  method_version: string;
  compute_snapshot_hash: `sha256:${string}`;
  duration_ms: number;
  warnings: string[];
  changes: ExecutionReceipt["changes"];
  generated_at: Date | string;
}

/** Receipt lookup over migration 011. Direct results are inserted atomically by the idempotency store. */
export class PostgresGatewayRecordStore implements GatewayRecordStore {
  constructor(private readonly pool: pg.Pool) {}

  async putResult(result: CapabilityResultEnvelope): Promise<void> {
    const receiptIds = result.receipts.map(({ receiptId }) => receiptId);
    const persisted = await this.pool.query<{ receipt_id: string }>(
      `SELECT receipt_id FROM gowm_capability.execution_receipt WHERE receipt_id = ANY($1::text[])`,
      [receiptIds]
    );
    if (persisted.rows.length !== new Set(receiptIds).size) {
      throw new Error("Gateway result receipt was not durably persisted before publication");
    }
  }

  async getReceipt(receiptId: string): Promise<ExecutionReceipt | undefined> {
    const result = await this.pool.query<ReceiptRow>(
      `SELECT receipt_id, operation_id, operation_version, provider_id, provider_version,
              input_hash, output_hash, engine_name, engine_version, method_id, method_version,
              compute_snapshot_hash, duration_ms, warnings, changes, generated_at
       FROM gowm_capability.execution_receipt
       WHERE receipt_id=$1`,
      [receiptId]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      receiptId: row.receipt_id,
      operationId: row.operation_id,
      operationVersion: row.operation_version,
      providerId: row.provider_id,
      providerVersion: row.provider_version,
      inputHash: row.input_hash,
      outputHash: row.output_hash,
      computeSnapshotHash: row.compute_snapshot_hash,
      durationMs: row.duration_ms,
      generatedAt: iso(row.generated_at),
      method: {
        engine: row.engine_name,
        engineVersion: row.engine_version,
        methodId: row.method_id,
        methodVersion: row.method_version
      },
      warnings: [...row.warnings],
      changes: structuredClone(row.changes)
    };
  }

  async getJob(_jobId: string): Promise<JobRecord | undefined> {
    // Direct execution is synchronous in v0.2 and creates no public job.
    // World-query jobs are resolved by PostgresQueryPlanStore in the app.
    return undefined;
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
