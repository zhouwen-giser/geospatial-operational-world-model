import type pg from "pg";
import type { CapabilityResultEnvelope } from "../../../../packages/platform/contract-runtime/src/index.js";
import { newOpaqueId, ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type {
  GatewayIdempotencyScope,
  GatewayIdempotencyStore,
  IdempotentResult
} from "./idempotency.js";

interface ClaimRow {
  disposition: "CLAIMED_NEW" | "CLAIMED_RECOVERED" | "REPLAY" | "IN_PROGRESS" | "FAILED";
  out_idempotency_record_id: string;
  out_job_id: string | null;
  out_receipt_id: string | null;
  out_result_envelope: CapabilityResultEnvelope | null;
}

export interface PostgresIdempotencyOptions {
  leaseOwner: string;
  leaseDuration?: string;
  retention?: string;
}

/** Durable direct-execution replay store backed by migration 011. */
export class PostgresGatewayIdempotencyStore implements GatewayIdempotencyStore<CapabilityResultEnvelope> {
  readonly #leaseDuration: string;
  readonly #retention: string;

  constructor(readonly pool: pg.Pool, readonly options: PostgresIdempotencyOptions) {
    if (!options.leaseOwner.trim()) throw new TypeError("leaseOwner is required");
    this.#leaseDuration = options.leaseDuration ?? "30 seconds";
    this.#retention = options.retention ?? "24 hours";
  }

  async execute(
    scope: GatewayIdempotencyScope,
    idempotencyKey: string,
    request: unknown,
    action: () => Promise<CapabilityResultEnvelope>
  ): Promise<IdempotentResult<CapabilityResultEnvelope>> {
    const requestHash = sha256(request);
    const leaseOwner = sha256({
      namespace: this.options.leaseOwner,
      claim: newOpaqueId("idem_claim")
    });
    const claim = await this.#claim(scope, idempotencyKey, requestHash, leaseOwner);
    if (claim.disposition === "REPLAY") {
      if (!claim.out_result_envelope) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "completed idempotency record has no result envelope");
      return { value: claim.out_result_envelope, replayed: true };
    }
    if (claim.disposition === "IN_PROGRESS") {
      throw new ProviderProtocolError("PROVIDER_NOT_READY", "matching idempotent request is already in progress", { retryable: true });
    }
    if (claim.disposition === "FAILED") {
      throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "matching idempotent request previously failed");
    }

    try {
      const value = await action();
      await this.#complete(claim.out_idempotency_record_id, value, leaseOwner);
      return { value, replayed: false };
    } catch (error) {
      await this.#fail(claim.out_idempotency_record_id, leaseOwner).catch(() => undefined);
      throw error;
    }
  }

  async #claim(scope: GatewayIdempotencyScope, idempotencyKey: string, requestHash: string, leaseOwner: string): Promise<ClaimRow> {
    try {
      const result = await this.pool.query<ClaimRow>(
        `SELECT * FROM gowm_capability.claim_idempotency(
           $1, $2, $3, $4, $5, $6, $7::interval, $8::interval
         )`,
        [
          scope.principalHash,
          scope.operationId,
          scope.operationVersion,
          idempotencyKey,
          requestHash,
          leaseOwner,
          this.#leaseDuration,
          this.#retention
        ]
      );
      const row = result.rows[0];
      if (!row) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "idempotency claim returned no disposition");
      return row;
    } catch (error) {
      if ((error as { code?: string }).code === "22000") {
        throw new ProviderProtocolError("IDEMPOTENCY_CONFLICT", "idempotency key was reused with a different request", { cause: error });
      }
      throw error;
    }
  }

  async #complete(recordId: string, envelope: CapabilityResultEnvelope, leaseOwner: string): Promise<void> {
    const receipt = envelope.receipts[0];
    if (!receipt) throw new ProviderProtocolError("INTERNAL_PROVIDER_ERROR", "durable completion requires an execution receipt");
    const snapshot = envelope.computeSnapshot;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO gowm_capability.execution_receipt (
           receipt_id, operation_id, operation_version, provider_id, provider_version,
           input_hash, output_hash, engine_name, engine_version, method_id, method_version,
           policy_version, input_schema_hash, output_schema_hash, compute_snapshot_hash,
           duration_ms, outcome, compute_snapshot, data_snapshot, warnings, changes, details, generated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
           $18::jsonb,$19::jsonb,$20::text[],$21::jsonb,$22::jsonb,$23
         ) ON CONFLICT (receipt_id) DO NOTHING`,
        [
          receipt.receiptId,
          receipt.operationId,
          receipt.operationVersion,
          receipt.providerId,
          receipt.providerVersion,
          receipt.inputHash,
          receipt.outputHash,
          receipt.method.engine,
          receipt.method.engineVersion,
          receipt.method.methodId,
          receipt.method.methodVersion,
          snapshot.policy.version,
          snapshot.schemas.inputSchemaHash,
          snapshot.schemas.outputSchemaHash,
          receipt.computeSnapshotHash,
          Math.round(receipt.durationMs),
          outcome(envelope.status),
          JSON.stringify(snapshot),
          envelope.dataSnapshot === undefined ? null : JSON.stringify(envelope.dataSnapshot),
          receipt.warnings,
          JSON.stringify(receipt.changes),
          JSON.stringify({ resultRequestId: envelope.requestId }),
          receipt.generatedAt
        ]
      );
      for (const [ordinal, evidence] of envelope.evidenceReferences.entries()) {
        await client.query(
          `INSERT INTO gowm_capability.receipt_evidence_reference (
             receipt_id, evidence_ordinal, evidence_id, authority, evidence_type,
             reference_key, schema_uri, schema_hash, payload_ref, observed_at, world_version
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
           ON CONFLICT (receipt_id, evidence_ordinal) DO NOTHING`,
          [
            receipt.receiptId,
            ordinal,
            evidence.evidenceId,
            evidence.authority,
            evidence.evidenceType,
            JSON.stringify(evidence.referenceKey),
            evidence.schemaUri,
            evidence.schemaHash,
            evidence.payloadRef ?? null,
            evidence.observedAt ?? null,
            evidence.worldVersion ?? null
          ]
        );
      }
      const completion = await client.query(
        `UPDATE gowm_capability.idempotency_record
         SET receipt_id=$2, result_envelope=$3::jsonb, status='COMPLETED',
             lease_owner=NULL, lease_until=NULL, updated_at=clock_timestamp()
         WHERE idempotency_record_id=$1 AND status='IN_PROGRESS' AND lease_owner=$4`,
        [recordId, receipt.receiptId, JSON.stringify(envelope), leaseOwner]
      );
      if (completion.rowCount !== 1) throw new ProviderProtocolError("PROVIDER_NOT_READY", "idempotency lease was lost before completion", { retryable: true });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #fail(recordId: string, leaseOwner: string): Promise<void> {
    await this.pool.query(
      `UPDATE gowm_capability.idempotency_record
       SET status='FAILED', lease_owner=NULL, lease_until=NULL, updated_at=clock_timestamp()
       WHERE idempotency_record_id=$1 AND status='IN_PROGRESS' AND lease_owner=$2`,
      [recordId, leaseOwner]
    );
  }
}

function outcome(status: CapabilityResultEnvelope["status"]): string {
  switch (status) {
    case "COMPLETED": return "SUCCEEDED";
    case "PARTIAL": return "PARTIAL";
    case "NO_DATA": return "NO_DATA";
    case "INDETERMINATE": return "INDETERMINATE";
    case "FAILED": return "FAILED";
  }
}
