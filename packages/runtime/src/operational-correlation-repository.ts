import type pg from "pg";
import {
  assertCorrelationFinding,
  CorrelationResolveInputSchema,
  type CorrelationFinding
} from "../../operational-model/src/events.js";

export class OperationalCorrelationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async resolve(candidate: unknown): Promise<CorrelationFinding> {
    const input = CorrelationResolveInputSchema.parse(candidate);
    const hint = input.correlationHint;
    const resolved = await this.pool.query<{ finding_id: string }>(
      `SELECT resolve_operational_correlation(
         $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'correlation-resolver-v1'
       )::text AS finding_id`,
      [
        input.dataScopeKey,hint.externalAuthority,hint.externalKind,hint.externalValue,
        hint.relationHint ?? null,hint.matchBasis,hint.confidence ?? null,
        JSON.stringify(input.actorReferenceKeys),input.timeRange?.from ?? null,input.timeRange?.to ?? null
      ]
    );
    const findingId = resolved.rows[0]?.finding_id;
    if (!findingId) throw new Error("correlation resolver returned no finding");
    const finding = await this.get(input.dataScopeKey,findingId);
    if (!finding) throw new Error("correlation finding was not persisted");
    return finding;
  }

  async get(dataScopeKey: string,findingId: string): Promise<CorrelationFinding | undefined> {
    const result = await this.pool.query(
      "SELECT * FROM correlation_finding WHERE data_scope_key=$1 AND finding_id=$2::uuid",
      [dataScopeKey,findingId]
    );
    const row = result.rows[0] as Record<string,unknown> | undefined;
    return row ? mapCorrelationFinding(row) : undefined;
  }

  async replay(dataScopeKey: string,findingId: string): Promise<"MATCH" | "DIFFERENCE"> {
    if (!await this.get(dataScopeKey,findingId)) {
      throw new Error("correlation finding was unavailable in the authorized scope");
    }
    const created = await this.pool.query<{ replay_id: string }>(
      "SELECT replay_operational_correlation($1::uuid)::text AS replay_id",[findingId]
    );
    const result = await this.pool.query<{ outcome: "MATCH" | "DIFFERENCE" }>(
      `SELECT audit.outcome FROM correlation_resolution_replay audit
       JOIN correlation_finding finding ON finding.finding_id=audit.finding_id
       WHERE audit.replay_id=$3::uuid AND finding.finding_id=$2::uuid AND finding.data_scope_key=$1`,
      [dataScopeKey,findingId,created.rows[0]?.replay_id]
    );
    const outcome = result.rows[0]?.outcome;
    if (!outcome) throw new Error("correlation replay was unavailable in the authorized scope");
    return outcome;
  }
}

function mapCorrelationFinding(row: Record<string,unknown>): CorrelationFinding {
  const finding: CorrelationFinding = {
    findingId: String(row.finding_id),
    externalAuthority: String(row.external_authority),
    externalKind: String(row.external_kind),
    externalValue: String(row.external_value),
    ...(row.operational_task_reference_key ? { operationalTaskReferenceKey: {
      namespace: "gowm",kind: "OPERATIONAL_TASK",id: String(row.operational_task_reference_key),version: "1"
    } } : {}),
    operationalEventIds: json(row.operational_event_ids),
    relation: String(row.relation) as CorrelationFinding["relation"],
    matchBasis: String(row.match_basis) as CorrelationFinding["matchBasis"],
    ...(row.correlation_confidence===null || row.correlation_confidence===undefined
      ? {} : { correlationConfidence: Number(row.correlation_confidence) }),
    evidenceIds: json(row.evidence_ids),
    worldVersion: Number(row.world_version),
    methodVersion: String(row.method_version)
  };
  assertCorrelationFinding(finding);
  return finding;
}

function json<T>(value: unknown): T {
  return (typeof value==="string" ? JSON.parse(value) : value) as T;
}
