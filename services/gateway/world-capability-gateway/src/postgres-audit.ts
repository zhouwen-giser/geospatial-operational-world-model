import type pg from "pg";
import { sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type { AuditEvent, AuditSink } from "./types.js";

/** Payload-free durable audit sink backed by migration 011. */
export class PostgresAuditSink implements AuditSink {
  constructor(private readonly pool: pg.Pool) {}

  async append(event: Readonly<AuditEvent>): Promise<void> {
    await this.pool.query(
      `INSERT INTO gowm_capability.gateway_audit_event (
         event_type, outcome, principal_hash, operation_id, operation_version,
         provider_id, request_hash, response_hash, trace_id, reason_code, metrics, occurred_at
       ) VALUES ('DIRECT_EXECUTION',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [
        auditOutcome(event.outcome),
        sha256(event.principalRef),
        event.operationId,
        event.operationVersion,
        event.providerId ?? null,
        event.inputHash,
        event.outputHash ?? null,
        event.requestId,
        event.errorCode ?? null,
        JSON.stringify({ elapsedMs: event.elapsedMs ?? null, replayed: event.outcome === "REPLAYED" }),
        event.occurredAt
      ]
    );
  }
}

function auditOutcome(outcome: AuditEvent["outcome"]): string {
  if (outcome === "COMPLETED" || outcome === "REPLAYED") return "SUCCEEDED";
  if (outcome === "REJECTED") return "DENIED";
  if (outcome === "ACCEPTED") return "ALLOWED";
  return "FAILED";
}
