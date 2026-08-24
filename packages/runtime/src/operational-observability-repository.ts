import type pg from "pg";
import {
  assertObservabilityAssessment,
  ObservabilityRequestSchema,
  type ObservabilityAssessment
} from "../../operational-model/src/events.js";

export interface StoredObservabilityAssessment {
  assessment: ObservabilityAssessment;
  evidenceSnapshot: Record<string,unknown>;
  resultHash: string;
}

export class OperationalObservabilityRepository {
  constructor(private readonly pool: pg.Pool) {}

  async assess(candidate: unknown): Promise<StoredObservabilityAssessment> {
    const input = ObservabilityRequestSchema.parse(candidate);
    const recorded = await this.pool.query<{ assessment_id: string }>(
      `SELECT record_operational_observability(
         $1,$2,$3::timestamptz,$4::timestamptz,$5::jsonb,$6,'operational-observability-v1'
       ) AS assessment_id`,
      [input.dataScopeKey,input.subjectReferenceKey.id,input.timeRange.from,input.timeRange.to,
       JSON.stringify(input.expectedSources),input.freshnessSlaSeconds]
    );
    const assessmentId = recorded.rows[0]?.assessment_id;
    if (!assessmentId) throw new Error("observability evaluator returned no assessment");
    const result = await this.pool.query(
      `SELECT output,evidence_snapshot,result_hash FROM operational_observability_assessment
       WHERE data_scope_key=$1 AND assessment_id=$2`,[input.dataScopeKey,assessmentId]
    );
    const row = result.rows[0] as Record<string,unknown> | undefined;
    if (!row) throw new Error("observability assessment was not persisted in the authorized scope");
    const assessment = json<ObservabilityAssessment>(row.output);
    assertObservabilityAssessment(assessment);
    return { assessment,evidenceSnapshot: json(row.evidence_snapshot),resultHash: String(row.result_hash) };
  }
}

function json<T>(value: unknown): T {
  return (typeof value==="string" ? JSON.parse(value) : value) as T;
}
