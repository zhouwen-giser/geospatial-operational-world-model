import type { Pool } from "pg";

export interface CoverageSubmission {
  dataScopeKey: string;
  datasetScopeKey: string;
  externalRequestId: string;
  idempotencyKey: string;
  gatewayJobId: string;
  requestHash: `sha256:${string}`;
  routingSnapshotHash: `sha256:${string}`;
  routingSnapshot: Record<string, unknown>;
  request: Record<string, unknown>;
}

export interface CoverageClaim {
  coverageRequestId: string;
  coverageRunId: string;
  generation: number;
  leaseUntil: string;
}

export interface CoverageAsyncRepository {
  claimNext(attempt: number, leaseOwner: string, leaseSeconds: number, maximumScopeConcurrency: number): Promise<CoverageClaim | null>;
  heartbeat(claim: Pick<CoverageClaim, "coverageRequestId" | "generation">, leaseOwner: string, leaseSeconds: number, stage: string, progressPpm: number, resourceMetrics: Record<string, unknown>): Promise<boolean>;
  persistProblem(claim: Pick<CoverageClaim, "coverageRequestId" | "generation">, leaseOwner: string, problemHash: `sha256:${string}`, canonicalProblem: Record<string, unknown>): Promise<string>;
  publishResult(claim: Pick<CoverageClaim, "coverageRequestId" | "generation">, leaseOwner: string, input: {
    referenceKey: string;
    status: "SUCCEEDED" | "PARTIAL" | "NO_FEASIBLE_PLAN";
    resultHash: `sha256:${string}`;
    validUntil: string;
    result: Record<string, unknown>;
  }): Promise<boolean>;
}

export class PostgresCoverageAsyncRepository implements CoverageAsyncRepository {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async submit(input: CoverageSubmission): Promise<{ coverageRequestId: string; status: string; replayed: boolean }> {
    const result = await this.pool.query<{ coverage_request_id: string; status: string; replayed: boolean }>(
      "SELECT * FROM coverage_planner.submit_coverage_request($1,$2,$3,$4,$5::uuid,$6,$7,$8::jsonb,$9::jsonb)",
      [input.dataScopeKey, input.datasetScopeKey, input.externalRequestId, input.idempotencyKey, input.gatewayJobId,
        input.requestHash, input.routingSnapshotHash, JSON.stringify(input.routingSnapshot), JSON.stringify(input.request)]
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("coverage submission returned no row");
    return { coverageRequestId: row.coverage_request_id, status: row.status, replayed: row.replayed };
  }

  async claimNext(attempt: number, leaseOwner: string, leaseSeconds: number, maximumScopeConcurrency: number): Promise<CoverageClaim | null> {
    const result = await this.pool.query<{ coverage_request_id: string; coverage_run_id: string; generation: string; lease_until: Date }>(
      "SELECT * FROM coverage_planner.claim_next_coverage_request($1,$2,$3,$4)",
      [attempt, leaseOwner, leaseSeconds, maximumScopeConcurrency]
    );
    const row = result.rows[0];
    return row === undefined ? null : { coverageRequestId: row.coverage_request_id, coverageRunId: row.coverage_run_id, generation: Number(row.generation), leaseUntil: row.lease_until.toISOString() };
  }

  async heartbeat(claim: Pick<CoverageClaim, "coverageRequestId" | "generation">, leaseOwner: string, leaseSeconds: number, stage: string, progressPpm: number, resourceMetrics: Record<string, unknown>): Promise<boolean> {
    const result = await this.pool.query<{ accepted: boolean }>(
      "SELECT coverage_planner.heartbeat_coverage_run($1::uuid,$2::bigint,$3,$4,$5,$6,$7::jsonb) AS accepted",
      [claim.coverageRequestId, claim.generation, leaseOwner, leaseSeconds, stage, progressPpm, JSON.stringify(resourceMetrics)]
    );
    return result.rows[0]?.accepted === true;
  }

  async persistProblem(claim: Pick<CoverageClaim, "coverageRequestId" | "generation">, leaseOwner: string, problemHash: `sha256:${string}`, canonicalProblem: Record<string, unknown>): Promise<string> {
    const result = await this.pool.query<{ problem_id: string }>(
      "SELECT coverage_planner.persist_coverage_problem($1::uuid,$2::bigint,$3,$4,$5::jsonb) AS problem_id",
      [claim.coverageRequestId, claim.generation, leaseOwner, problemHash, JSON.stringify(canonicalProblem)]
    );
    const id = result.rows[0]?.problem_id;
    if (id === undefined) throw new Error("coverage problem persistence returned no identity");
    return id;
  }

  async publishResult(claim: Pick<CoverageClaim, "coverageRequestId" | "generation">, leaseOwner: string, input: {
    referenceKey: string;
    status: "SUCCEEDED" | "PARTIAL" | "NO_FEASIBLE_PLAN";
    resultHash: `sha256:${string}`;
    validUntil: string;
    result: Record<string, unknown>;
  }): Promise<boolean> {
    const result = await this.pool.query<{ published: boolean }>(
      "SELECT coverage_planner.publish_coverage_result($1::uuid,$2::bigint,$3,$4,$5,$6,$7::timestamptz,$8::jsonb) AS published",
      [claim.coverageRequestId, claim.generation, leaseOwner, input.referenceKey, input.status, input.resultHash, input.validUntil, JSON.stringify(input.result)]
    );
    return result.rows[0]?.published === true;
  }

  async cancel(coverageRequestId: string, reason: string): Promise<boolean> {
    const result = await this.pool.query<{ cancelled: boolean }>(
      "SELECT coverage_planner.cancel_coverage_request($1::uuid,$2) AS cancelled", [coverageRequestId, reason]
    );
    return result.rows[0]?.cancelled === true;
  }

  async reapExpired(limit: number): Promise<number> {
    const result = await this.pool.query<{ count: number }>("SELECT coverage_planner.reap_expired_coverage_runs($1) AS count", [limit]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async getResult(coverageRequestId: string, dataScopeKey: string, datasetScopeKey: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{ result: Record<string, unknown> | null }>(
      "SELECT coverage_planner.get_coverage_result($1::uuid,$2,$3) AS result", [coverageRequestId, dataScopeKey, datasetScopeKey]
    );
    return result.rows[0]?.result ?? null;
  }
}
