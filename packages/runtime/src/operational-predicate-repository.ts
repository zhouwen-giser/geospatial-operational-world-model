import type pg from "pg";
import {
  assertExternalPredicate,
  assertPredicateEvaluation,
  type ExternalPredicate,
  type PredicateEvaluation
} from "../../operational-model/src/events.js";

export interface StoredPredicateEvaluation {
  evaluation: PredicateEvaluation;
  predicate: ExternalPredicate;
  evidenceSnapshot: Record<string,unknown>;
  inputHash: string;
  resultHash: string;
}

export class OperationalPredicateRepository {
  constructor(private readonly pool: pg.Pool) {}

  async evaluate(dataScopeKey: string,candidate: unknown): Promise<StoredPredicateEvaluation> {
    assertExternalPredicate(candidate);
    if (!dataScopeKey) throw new Error("data scope is required");
    const recorded = await this.pool.query<{ evaluation_id: string }>(
      "SELECT record_external_predicate_evaluation($1,$2::jsonb,'predicate-evaluator-v1') AS evaluation_id",
      [dataScopeKey,JSON.stringify(candidate)]
    );
    const evaluationId = recorded.rows[0]?.evaluation_id;
    if (!evaluationId) throw new Error("predicate evaluator returned no evaluation");
    const stored = await this.get(dataScopeKey,evaluationId);
    if (!stored) throw new Error("predicate evaluation was not persisted in the authorized scope");
    return stored;
  }

  async get(dataScopeKey: string,evaluationId: string): Promise<StoredPredicateEvaluation | undefined> {
    const result = await this.pool.query(
      `SELECT predicate,status,evaluated_at_world_version,supporting_evidence_ids,
              contradicting_evidence_ids,assumptions,warnings,method_version,
              predicate_id,evaluation_id,evidence_snapshot,input_hash,result_hash
              ,observability_assessment
       FROM external_predicate_evaluation
       WHERE data_scope_key=$1 AND evaluation_id=$2`,
      [dataScopeKey,evaluationId]
    );
    const row = result.rows[0] as Record<string,unknown> | undefined;
    return row ? mapStoredEvaluation(row) : undefined;
  }
}

function mapStoredEvaluation(row: Record<string,unknown>): StoredPredicateEvaluation {
  const predicate = json<ExternalPredicate>(row.predicate);
  const evaluation: PredicateEvaluation = {
    evaluationId: String(row.evaluation_id),
    predicateId: String(row.predicate_id),
    status: String(row.status) as PredicateEvaluation["status"],
    evaluatedAtWorldVersion: Number(row.evaluated_at_world_version),
    supportingEvidenceIds: json(row.supporting_evidence_ids),
    contradictingEvidenceIds: json(row.contradicting_evidence_ids),
    assumptions: json(row.assumptions),
    warnings: json(row.warnings),
    methodVersion: String(row.method_version)
  };
  if (row.observability_assessment!==null && row.observability_assessment!==undefined) {
    evaluation.observabilityAssessment = json(row.observability_assessment);
  }
  assertExternalPredicate(predicate);
  assertPredicateEvaluation(evaluation);
  return {
    evaluation,predicate,
    evidenceSnapshot: json(row.evidence_snapshot),
    inputHash: String(row.input_hash),resultHash: String(row.result_hash)
  };
}

function json<T>(value: unknown): T {
  return (typeof value==="string" ? JSON.parse(value) : value) as T;
}
