import type pg from "pg";
import type {
  GowmV071QuerySnapshotManifest as QuerySnapshotManifest,
  JobRecord,
  PlatformError,
  WorldQueryResult,
  WorldQueryResultNodeResult,
  WorldQuerySubmission
} from "../../../../packages/platform/contract-runtime/src/index.js";
import { ProviderProtocolError, sha256 } from "../../../../packages/platform/provider-sdk/src/index.js";
import type {
  QueryExecutionFence,
  QueryJobContext,
  QueryJobCreateResult,
  QueryPlanStore
} from "./query-plan-store.js";
import { principalContextHash } from "./principal-context.js";
import type { GatewayPrincipal } from "./types.js";

interface QueryRow {
  query_id: string;
  internal_job_id: string;
  public_job_id: string;
  request_id: string;
  principal_ref: string;
  principal_hash: string;
  idempotency_key: string;
  request_hash: `sha256:${string}`;
  submission: WorldQuerySubmission;
  query_snapshot_manifest: QuerySnapshotManifest;
  effective_snapshot_manifest: QuerySnapshotManifest;
  effective_snapshot_revision: number;
  effective_snapshot_updated_at: Date | string;
  principal_context: GatewayPrincipal;
  authentication_method: string;
  authenticated_at: Date | string;
  data_scope_claim: string | null;
  dataset_scope_claim: string | null;
  allow_experimental: boolean;
  result: WorldQueryResult | null;
  state: DatabaseJobState;
  deadline_at: Date | string | null;
  cancellation_requested_at: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  failure_code: string | null;
  lease_owner: string | null;
  attempt_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

type DatabaseJobState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED" | "TIMED_OUT";

const QUERY_SELECT = `
SELECT query_job.query_id,
       query_job.job_id::text AS internal_job_id,
       query_job.public_job_id,
       query_job.request_id,
       query_job.principal_ref,
       query_job.principal_hash,
       query_job.idempotency_key,
       query_job.request_hash,
       query_job.submission,
       query_job.query_snapshot_manifest,
       query_job.effective_snapshot_manifest,
       query_job.effective_snapshot_revision,
       query_job.effective_snapshot_updated_at,
       query_job.principal_context,
       query_job.authentication_method,
       query_job.authenticated_at,
       query_job.data_scope_claim,
       query_job.dataset_scope_claim,
       query_job.allow_experimental,
       query_job.result,
       gateway_job.state,
       gateway_job.deadline_at,
       gateway_job.cancellation_requested_at,
       gateway_job.started_at,
       gateway_job.completed_at,
       gateway_job.failure_code,
       gateway_job.lease_owner,
       gateway_job.attempt_count,
       gateway_job.created_at,
       gateway_job.updated_at
FROM gowm_capability.world_query_job query_job
JOIN gowm_capability.gateway_job gateway_job USING (job_id)`;

export class PostgresQueryPlanStore implements QueryPlanStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(context: QueryJobContext): Promise<QueryJobCreateResult> {
    const principalHash = principalContextHash(context.principal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<QueryRow>(
        `${QUERY_SELECT}
         WHERE query_job.principal_hash = $1 AND query_job.idempotency_key = $2
         FOR UPDATE OF query_job, gateway_job`,
        [principalHash, context.submission.idempotencyKey]
      );
      const row = existing.rows[0];
      if (row) {
        if (row.request_hash !== context.requestHash) {
          throw new ProviderProtocolError("IDEMPOTENCY_CONFLICT", "world query idempotency key was reused with a different request");
        }
        await client.query("COMMIT");
        return { context: fromRow(row), replayed: true };
      }

      const deadlineAt = new Date(
        Date.parse(context.job.createdAt) + context.submission.plan.budgets.maximumExecutionMs
      ).toISOString();
      const initialState = context.job.status === "RUNNING" ? "RUNNING" : "QUEUED";
      const synchronousLeaseOwner = `sync_${sha256(context.job.jobId).slice("sha256:".length, "sha256:".length + 32)}`;
      const insertedJob = await client.query<{ job_id: string }>(
        `INSERT INTO gowm_capability.gateway_job (
           job_kind, principal_hash, data_scope_key, request_hash, state, deadline_at,
           lease_owner, lease_until, started_at, attempt_count
         ) VALUES (
           'WORLD_QUERY', $1, $2, $3, $4, $5::timestamptz,
           CASE WHEN $4 = 'RUNNING' THEN $6 ELSE NULL END,
           CASE WHEN $4 = 'RUNNING' THEN $5::timestamptz + interval '30 seconds' ELSE NULL END,
           CASE WHEN $4 = 'RUNNING' THEN $7::timestamptz ELSE NULL END,
           CASE WHEN $4 = 'RUNNING' THEN 1 ELSE 0 END
         )
         RETURNING job_id::text`,
        [
          principalHash,
          context.principal.dataScopeClaim ?? null,
          context.requestHash,
          initialState,
          deadlineAt,
          synchronousLeaseOwner,
          context.job.startedAt ?? context.job.createdAt
        ]
      );
      const internalJobId = insertedJob.rows[0]?.job_id;
      if (!internalJobId) throw new Error("PostgreSQL did not return the world query job id");
      await client.query(
        `INSERT INTO gowm_capability.world_query_job (
           query_id, job_id, public_job_id, request_id, principal_ref, principal_hash,
           idempotency_key, request_hash, parameter_schema_hash, plan_hash, submission,
           authentication_method, authenticated_at, data_scope_claim, dataset_scope_claim,
           allow_experimental, query_snapshot_manifest, effective_snapshot_manifest,
           effective_snapshot_revision, effective_snapshot_updated_at, principal_context
         ) VALUES (
           $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
           $12, $13::timestamptz, $14, $15, $16, $17::jsonb, $18::jsonb,
           $19, clock_timestamp(), $20::jsonb
         )`,
        [
          context.submission.plan.queryId,
          internalJobId,
          context.job.jobId,
          context.job.requestId,
          context.principal.principalRef,
          principalHash,
          context.submission.idempotencyKey,
          context.requestHash,
          context.submission.parameterSchemaHash,
          sha256(context.submission.plan),
          JSON.stringify(context.submission),
          context.principal.authenticationMethod,
          context.principal.authenticatedAt,
          context.principal.dataScopeClaim ?? null,
          context.principal.datasetScopeClaim ?? null,
          context.principal.allowExperimental ?? false,
          JSON.stringify(context.requestedSnapshotManifest),
          JSON.stringify(context.effectiveSnapshotManifest),
          context.effectiveSnapshotRevision,
          JSON.stringify(context.principal)
        ]
      );
      await client.query(
        `INSERT INTO gowm_capability.world_query_node_execution (
           job_id, node_id, node_ordinal, operation_id, operation_version,
           state, attempt, node_record
         )
         SELECT $1::uuid, node.node_id, node.node_ordinal, node.operation_id,
                node.operation_version, 'QUEUED', 0, node.node_record
         FROM jsonb_to_recordset($2::jsonb) AS node(
           node_id text,
           node_ordinal smallint,
           operation_id text,
           operation_version text,
           node_record jsonb
         )`,
        [
          internalJobId,
          JSON.stringify(context.submission.plan.nodes.map((node, nodeOrdinal) => ({
            node_id: node.nodeId,
            node_ordinal: nodeOrdinal,
            operation_id: node.operation.operationId,
            operation_version: node.operation.operationVersion,
            node_record: {
              nodeId: node.nodeId,
              operation: node.operation,
              status: "QUEUED",
              attempt: 0
            }
          })))
        ]
      );
      await client.query(
        `INSERT INTO gowm_capability.gateway_job_state_transition (
           job_id, from_state, to_state, reason_code, actor_kind
         ) VALUES ($1::uuid, NULL, $2, $3, 'GATEWAY')`,
        [
          internalJobId,
          initialState,
          initialState === "RUNNING" ? "WORLD_QUERY_SYNC_STARTED" : "WORLD_QUERY_SUBMITTED"
        ]
      );
      await client.query("COMMIT");
      const created = await this.getByJobId(context.job.jobId);
      if (!created) throw new Error("created world query job could not be reloaded");
      return { context: created, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        const replay = await this.#getByIdempotency(principalHash, context.submission.idempotencyKey);
        if (replay) {
          if (replay.requestHash !== context.requestHash) {
            throw new ProviderProtocolError("IDEMPOTENCY_CONFLICT", "world query idempotency key was reused with a different request");
          }
          return { context: replay, replayed: true };
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateJob(job: JobRecord, fence?: QueryExecutionFence): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        job_id: string;
        state: DatabaseJobState;
        lease_owner: string | null;
        attempt_count: number;
        lease_active: boolean | null;
      }>(
        `SELECT query_job.job_id::text AS job_id, gateway_job.state,
                gateway_job.lease_owner, gateway_job.attempt_count,
                gateway_job.lease_until > clock_timestamp() AS lease_active
         FROM gowm_capability.world_query_job query_job
         JOIN gowm_capability.gateway_job gateway_job USING (job_id)
         WHERE query_job.public_job_id = $1
         FOR UPDATE OF query_job, gateway_job`,
        [job.jobId]
      );
      const row = current.rows[0];
      if (!row) throw new Error(`query job ${job.jobId} is not registered`);
      assertFence(row.lease_owner, row.attempt_count, row.lease_active, fence);
      if (terminalDatabaseState(row.state) && row.state !== toDatabaseState(job.status)) {
        throw new ProviderProtocolError("PROVIDER_NOT_READY", "world query terminal state cannot regress", {
          retryable: false
        });
      }
      const nextState = toDatabaseState(job.status);
      await client.query(
        `UPDATE gowm_capability.gateway_job
         SET state = $2,
             started_at = COALESCE($3::timestamptz, started_at),
             completed_at = $4::timestamptz,
             failure_code = $5,
             lease_owner = CASE WHEN $2 IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','TIMED_OUT') THEN NULL ELSE lease_owner END,
             lease_until = CASE WHEN $2 IN ('SUCCEEDED','PARTIAL','FAILED','CANCELLED','TIMED_OUT') THEN NULL ELSE lease_until END,
             updated_at = $6::timestamptz
         WHERE job_id = $1::uuid`,
        [
          row.job_id,
          nextState,
          job.startedAt ?? null,
          job.finishedAt ?? null,
          job.error?.error.code ?? null,
          job.updatedAt
        ]
      );
      await client.query(
        `UPDATE gowm_capability.world_query_job
         SET result = $2::jsonb, updated_at = $3::timestamptz
         WHERE job_id = $1::uuid`,
        [row.job_id, job.result === undefined ? null : JSON.stringify(job.result), job.updatedAt]
      );
      if (row.state !== nextState) {
        await client.query(
          `INSERT INTO gowm_capability.gateway_job_state_transition (
             job_id, from_state, to_state, reason_code, actor_kind
           ) VALUES ($1::uuid, $2, $3, 'WORLD_QUERY_RUNTIME', 'GATEWAY')`,
          [row.job_id, row.state, nextState]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getByQueryId(queryId: string): Promise<QueryJobContext | undefined> {
    const result = await this.pool.query<QueryRow>(`${QUERY_SELECT} WHERE query_job.query_id = $1`, [queryId]);
    return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
  }

  async getByJobId(jobId: string): Promise<QueryJobContext | undefined> {
    const result = await this.pool.query<QueryRow>(`${QUERY_SELECT} WHERE query_job.public_job_id = $1`, [jobId]);
    return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
  }

  async getByQueryIdForPrincipal(queryId: string, principalHash: string): Promise<QueryJobContext | undefined> {
    const result = await this.pool.query<QueryRow>(
      `${QUERY_SELECT} WHERE query_job.query_id = $1 AND query_job.principal_hash = $2`,
      [queryId, principalHash]
    );
    return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
  }

  async getByJobIdForPrincipal(jobId: string, principalHash: string): Promise<QueryJobContext | undefined> {
    const result = await this.pool.query<QueryRow>(
      `${QUERY_SELECT} WHERE query_job.public_job_id = $1 AND query_job.principal_hash = $2`,
      [jobId, principalHash]
    );
    return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
  }

  async putNode(jobId: string, node: WorldQueryResultNodeResult, fence?: QueryExecutionFence): Promise<void> {
    await this.commitNodeResult(jobId, node, undefined, fence);
  }

  async commitNodeResult(
    jobId: string,
    node: WorldQueryResultNodeResult,
    snapshotUpdate?: {
      expectedManifestHash: QuerySnapshotManifest["manifestHash"];
      nextEffectiveManifest: QuerySnapshotManifest;
    },
    fence?: QueryExecutionFence
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const context = await client.query<{
        internal_job_id: string;
        submission: WorldQuerySubmission;
        effective_manifest_hash: string;
        lease_owner: string | null;
        attempt_count: number;
        lease_active: boolean | null;
      }>(
        `SELECT query_job.job_id::text AS internal_job_id,
                query_job.submission,
                query_job.effective_snapshot_manifest ->> 'manifestHash' AS effective_manifest_hash,
                gateway_job.lease_owner,
                gateway_job.attempt_count,
                gateway_job.lease_until > clock_timestamp() AS lease_active
         FROM gowm_capability.world_query_job query_job
         JOIN gowm_capability.gateway_job gateway_job USING (job_id)
         WHERE query_job.public_job_id = $1
         FOR UPDATE OF query_job, gateway_job`,
        [jobId]
      );
      const query = context.rows[0];
      if (!query) throw new Error(`query job ${jobId} is not registered`);
      assertFence(query.lease_owner, query.attempt_count, query.lease_active, fence);
      if (
        snapshotUpdate !== undefined &&
        query.effective_manifest_hash !== snapshotUpdate.expectedManifestHash
      ) {
        throw new ProviderProtocolError("PROVIDER_NOT_READY", "effective snapshot compare-and-swap failed", {
          retryable: true,
          details: { stage: "EXECUTION_FENCE" }
        });
      }
      const ordinal = query.submission.plan.nodes.findIndex((candidate) => candidate.nodeId === node.nodeId);
      if (ordinal < 0) throw new Error(`query node ${node.nodeId} is not present in the persisted plan`);
      const prior = await client.query<{ state: WorldQueryResultNodeResult["status"] }>(
        `SELECT state
         FROM gowm_capability.world_query_node_execution
         WHERE job_id = $1::uuid AND node_id = $2
         FOR UPDATE`,
        [query.internal_job_id, node.nodeId]
      );
      await client.query(
        `INSERT INTO gowm_capability.world_query_node_execution (
           job_id, node_id, node_ordinal, operation_id, operation_version, provider_id,
           state, attempt, input_hash, output_hash, result_envelope, error,
           started_at, finished_at, node_record
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
           $13::timestamptz, $14::timestamptz, $15::jsonb
         )
         ON CONFLICT (job_id, node_id) DO UPDATE SET
           provider_id = EXCLUDED.provider_id,
           state = EXCLUDED.state,
           attempt = EXCLUDED.attempt,
           input_hash = EXCLUDED.input_hash,
           output_hash = EXCLUDED.output_hash,
           result_envelope = EXCLUDED.result_envelope,
           error = EXCLUDED.error,
           started_at = EXCLUDED.started_at,
           finished_at = EXCLUDED.finished_at,
           node_record = EXCLUDED.node_record,
           updated_at = clock_timestamp()`,
        [
          query.internal_job_id,
          node.nodeId,
          ordinal,
          node.operation.operationId,
          node.operation.operationVersion,
          node.providerId ?? null,
          node.status,
          node.attempt,
          node.inputHash ?? null,
          node.outputHash ?? null,
          node.result === undefined ? null : JSON.stringify(node.result),
          node.error === undefined ? null : JSON.stringify(node.error),
          node.startedAt ?? null,
          node.finishedAt ?? null,
          JSON.stringify(node)
        ]
      );
      if (prior.rows[0]?.state !== node.status) {
        await client.query(
          `INSERT INTO gowm_capability.world_query_node_transition (
             job_id, node_id, from_state, to_state, attempt, reason_code
           ) VALUES ($1::uuid, $2, $3, $4, $5, 'WORLD_QUERY_RUNTIME')`,
          [query.internal_job_id, node.nodeId, prior.rows[0]?.state ?? null, node.status, node.attempt]
        );
      }
      if (snapshotUpdate !== undefined) {
        const updated = await client.query(
          `UPDATE gowm_capability.world_query_job
           SET effective_snapshot_manifest = $2::jsonb,
               effective_snapshot_revision = effective_snapshot_revision + 1,
               effective_snapshot_updated_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE job_id = $1::uuid
             AND effective_snapshot_manifest ->> 'manifestHash' = $3`,
          [
            query.internal_job_id,
            JSON.stringify(snapshotUpdate.nextEffectiveManifest),
            snapshotUpdate.expectedManifestHash
          ]
        );
        if (updated.rowCount !== 1) {
          throw new ProviderProtocolError("PROVIDER_NOT_READY", "effective snapshot compare-and-swap failed", {
            retryable: true,
            details: { stage: "EXECUTION_FENCE" }
          });
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listNodes(jobId: string): Promise<WorldQueryResultNodeResult[]> {
    const result = await this.pool.query<{ node_record: WorldQueryResultNodeResult }>(
      `SELECT node.node_record
       FROM gowm_capability.world_query_node_execution node
       JOIN gowm_capability.world_query_job query_job USING (job_id)
       WHERE query_job.public_job_id = $1
       ORDER BY node.node_ordinal`,
      [jobId]
    );
    return result.rows.map((row) => structuredClone(row.node_record));
  }

  async requestCancellation(queryId: string, principalHash: string): Promise<QueryJobContext | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ job_id: string; state: DatabaseJobState }>(
        `SELECT query_job.job_id::text AS job_id, gateway_job.state
         FROM gowm_capability.world_query_job query_job
         JOIN gowm_capability.gateway_job gateway_job USING (job_id)
         WHERE query_job.query_id = $1 AND query_job.principal_hash = $2
         FOR UPDATE OF query_job, gateway_job`,
        [queryId, principalHash]
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const cancelImmediately = row.state === "QUEUED";
      await client.query(
        `UPDATE gowm_capability.gateway_job
         SET cancellation_requested_at = COALESCE(cancellation_requested_at, clock_timestamp()),
             state = CASE WHEN $2 THEN 'CANCELLED' ELSE state END,
             completed_at = CASE WHEN $2 THEN clock_timestamp() ELSE completed_at END,
             updated_at = clock_timestamp()
         WHERE job_id = $1::uuid`,
        [row.job_id, cancelImmediately]
      );
      if (cancelImmediately) {
        await client.query(
          `INSERT INTO gowm_capability.gateway_job_state_transition (
             job_id, from_state, to_state, reason_code, actor_kind
           ) VALUES ($1::uuid, 'QUEUED', 'CANCELLED', 'CANCELLATION_REQUESTED', 'GATEWAY')`,
          [row.job_id]
        );
      }
      await client.query("COMMIT");
      return await this.getByQueryId(queryId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cancellationRequested(jobId: string): Promise<boolean> {
    const result = await this.pool.query<{ requested: boolean }>(
      `SELECT gateway_job.cancellation_requested_at IS NOT NULL AS requested
       FROM gowm_capability.world_query_job query_job
       JOIN gowm_capability.gateway_job gateway_job USING (job_id)
       WHERE query_job.public_job_id = $1`,
      [jobId]
    );
    return result.rows[0]?.requested ?? false;
  }

  async claimNext(workerId: string, leaseSeconds = 60): Promise<QueryJobContext | undefined> {
    const claimed = await this.pool.query<{ public_job_id: string }>(
      `WITH claimed AS (
         SELECT * FROM gowm_capability.claim_world_query_job($1, $2)
       )
       SELECT query_job.public_job_id
       FROM claimed
       JOIN gowm_capability.world_query_job query_job ON query_job.job_id = claimed.job_id`,
      [workerId, leaseSeconds]
    );
    const publicJobId = claimed.rows[0]?.public_job_id;
    return publicJobId === undefined ? undefined : await this.getByJobId(publicJobId);
  }

  async #getByIdempotency(principalHash: string, idempotencyKey: string): Promise<QueryJobContext | undefined> {
    const result = await this.pool.query<QueryRow>(
      `${QUERY_SELECT} WHERE query_job.principal_hash = $1 AND query_job.idempotency_key = $2`,
      [principalHash, idempotencyKey]
    );
    return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
  }
}

function fromRow(row: QueryRow): QueryJobContext {
  const status = fromDatabaseState(row.state);
  const error = status === "FAILED"
    ? firstResultError(row.result) ?? genericJobError(row.request_id, row.failure_code ?? "WORLD_QUERY_FAILED")
    : undefined;
  const job: JobRecord = {
    jobId: row.public_job_id,
    requestId: row.request_id,
    kind: "WORLD_QUERY",
    status,
    queryId: row.query_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.started_at === null ? {} : { startedAt: iso(row.started_at) }),
    ...(row.completed_at === null ? {} : { finishedAt: iso(row.completed_at) }),
    ...(row.result === null ? {} : { result: structuredClone(row.result) }),
    ...(error === undefined ? {} : { error })
  };
  return {
    job,
    gatewayJobId: row.internal_job_id,
    submission: structuredClone(row.submission),
    requestedSnapshotManifest: structuredClone(row.query_snapshot_manifest),
    effectiveSnapshotManifest: structuredClone(row.effective_snapshot_manifest),
    effectiveSnapshotRevision: row.effective_snapshot_revision,
    ...(row.lease_owner === null
      ? {}
      : { executionFence: { leaseOwner: row.lease_owner, attempt: row.attempt_count } }),
    principal: structuredClone(row.principal_context),
    requestHash: row.request_hash,
    cancellationRequested: row.cancellation_requested_at !== null
  };
}

function toDatabaseState(status: JobRecord["status"]): DatabaseJobState {
  return status === "COMPLETED" ? "SUCCEEDED" : status;
}

function fromDatabaseState(status: DatabaseJobState): JobRecord["status"] {
  if (status === "SUCCEEDED") return "COMPLETED";
  if (status === "TIMED_OUT") return "FAILED";
  return status;
}

function firstResultError(result: WorldQueryResult | null): PlatformError | undefined {
  return result?.nodes.find((node) => node.error)?.error;
}

function genericJobError(requestId: string, code: string): PlatformError {
  return {
    schemaVersion: "1.0",
    requestId,
    error: {
      code,
      message: "World query failed",
      retryable: false,
      stage: "DAG_EXECUTION"
    }
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUniqueViolation(error: unknown): error is { code: "23505" } {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "23505";
}

function assertFence(
  leaseOwner: string | null,
  attempt: number,
  leaseActive: boolean | null,
  supplied: QueryExecutionFence | undefined
): void {
  if (leaseOwner === null && supplied === undefined) return;
  if (
    leaseOwner === null || supplied === undefined || leaseActive !== true ||
    supplied.leaseOwner !== leaseOwner || supplied.attempt !== attempt
  ) {
    throw new ProviderProtocolError("PROVIDER_NOT_READY", "world query execution lease was superseded", {
      retryable: false,
      details: { stage: "EXECUTION_FENCE" }
    });
  }
}

function terminalDatabaseState(state: DatabaseJobState): boolean {
  return ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "TIMED_OUT"].includes(state);
}
