import { guardedProjectionPool, withProjectionExecution } from "./projection-execution.js";
import {
  canonicalSha256,
  historicalSemanticRequestHash
} from "../../historical-trace-core/src/index.js";
import type {
  HistoricalSemanticRequest,
  Sha256Digest
} from "../../historical-trace-model/src/index.js";
import {
  errorMessage,
  HistoricalProjectionInputError,
  isoTimestamp,
  ProjectionFenceLostError,
  requiredInteger,
  requiredString,
  type SqlConnection,
  type SqlExecutionBounds,
  type SqlPool,
  withProjectionTransaction
} from "./database.js";
import type {
  HistoricalSnapshotResource,
  HistoricalRequestedSnapshot,
  HistoricalTrajectoryMaterializationRequest,
  HistoricalTrajectoryMaterializationResult,
  PostgresHistoricalTrajectoryMaterializer
} from "./historical-trajectory-materializer.js";

export interface HistoricalTrajectoryProjectionClaim {
  queueId: string;
  workerId: string;
  generation: number;
  state: "RUNNING";
  leaseUntil: string;
  leaseSeconds?: number;
  dataScopeKey: string;
  capturedAt: string;
  query: HistoricalSemanticRequest;
  requestedSnapshot: HistoricalRequestedSnapshot;
}

export interface HistoricalTrajectoryProjectionRepository {
  claim(workerId: string, batchSize: number, leaseSeconds: number): Promise<HistoricalTrajectoryProjectionClaim[]>;
  materializeAndComplete(
    claim: HistoricalTrajectoryProjectionClaim,
    materializer: PostgresHistoricalTrajectoryMaterializer
  ): Promise<HistoricalTrajectoryMaterializationResult>;
  fail(claim: HistoricalTrajectoryProjectionClaim, error: unknown, retryAt: string): Promise<boolean>;
}

interface QueueRow extends Record<string, unknown> {
  queue_id: unknown;
  data_scope_key: unknown;
  captured_at: unknown;
  query_payload: unknown;
  requested_snapshot: unknown;
  generation: unknown;
  state: unknown;
  lease_until: unknown;
}

function object(value: unknown, field: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HistoricalProjectionInputError(`${field} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function digest(value: unknown, field: string): Sha256Digest {
  const candidate = requiredString(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(candidate)) {
    throw new HistoricalProjectionInputError(`${field} is not SHA-256`);
  }
  return candidate as Sha256Digest;
}

function queryPayload(value: unknown): HistoricalSemanticRequest {
  const candidate = object(value, "query_payload") as unknown as HistoricalSemanticRequest;
  // The canonical helper traverses every identity-bearing field and therefore
  // rejects a malformed queue payload before the worker touches domain data.
  historicalSemanticRequestHash(candidate);
  return structuredClone(candidate);
}

function requestedSnapshot(value: unknown, capturedAt: string): HistoricalRequestedSnapshot {
  const candidate = object(value, "requested_snapshot");
  const resourcesValue = candidate.resources;
  if (!Array.isArray(resourcesValue) || resourcesValue.length > 512) {
    throw new HistoricalProjectionInputError("requested_snapshot resources are invalid");
  }
  const resources = resourcesValue.map((item, index) => {
    const resource = object(item, `requested_snapshot resource ${index}`);
    const pinningValue = requiredString(resource.pinning, "snapshot resource pinning");
    if (pinningValue !== "PINNED" && pinningValue !== "AT_LEAST" && pinningValue !== "BEST_EFFORT") {
      throw new HistoricalProjectionInputError("snapshot resource pinning is invalid");
    }
    const pinning = pinningValue as HistoricalSnapshotResource["pinning"];
    const contentHash = resource.contentHash === undefined
      ? undefined
      : digest(resource.contentHash, "snapshot resource contentHash");
    const worldVersion = resource.worldVersion === undefined
      ? undefined
      : requiredInteger(resource.worldVersion, "snapshot resource worldVersion");
    if (worldVersion !== undefined && worldVersion < 0) {
      throw new HistoricalProjectionInputError("snapshot resource worldVersion is negative");
    }
    return {
      resourceKind: requiredString(resource.resourceKind, "snapshot resource kind"),
      resourceId: requiredString(resource.resourceId, "snapshot resource id"),
      version: requiredString(resource.version, "snapshot resource version"),
      pinning,
      ...(contentHash === undefined ? {} : { contentHash }),
      ...(worldVersion === undefined ? {} : { worldVersion })
    };
  });
  const snapshotCapturedAt = isoTimestamp(candidate.capturedAt, "requested_snapshot capturedAt");
  if (snapshotCapturedAt !== capturedAt) {
    throw new HistoricalProjectionInputError("requested_snapshot capturedAt differs from the queue capture");
  }
  const snapshot: HistoricalRequestedSnapshot = {
    querySnapshotId: requiredString(candidate.querySnapshotId, "querySnapshotId"),
    mode: requiredString(candidate.mode, "snapshot mode") as HistoricalRequestedSnapshot["mode"],
    consistency: requiredString(candidate.consistency, "snapshot consistency") as HistoricalRequestedSnapshot["consistency"],
    capturedAt: snapshotCapturedAt,
    resources,
    manifestHash: digest(candidate.manifestHash, "snapshot manifestHash"),
    ...(candidate.minimumWorldVersion === undefined
      ? {}
      : { minimumWorldVersion: requiredInteger(candidate.minimumWorldVersion, "minimumWorldVersion") })
  };
  if (!["LATEST_AT_START", "PINNED", "AT_LEAST_WORLD_VERSION", "BEST_EFFORT"].includes(snapshot.mode)
      || !["PINNED", "CONSISTENT_AT_START", "BEST_EFFORT"].includes(snapshot.consistency)) {
    throw new HistoricalProjectionInputError("requested_snapshot policy is invalid");
  }
  const { manifestHash, ...canonical } = snapshot;
  if (canonicalSha256(canonical) !== manifestHash) {
    throw new HistoricalProjectionInputError("requested_snapshot manifestHash is invalid");
  }
  return snapshot;
}

function mapClaim(row: QueueRow, workerId: string): HistoricalTrajectoryProjectionClaim {
  const capturedAt = isoTimestamp(row.captured_at, "captured_at");
  if (row.state !== "RUNNING") throw new HistoricalProjectionInputError("claimed trajectory queue row is not RUNNING");
  return {
    queueId: requiredString(row.queue_id, "queue_id"),
    workerId,
    generation: requiredInteger(row.generation, "generation"),
    state: "RUNNING",
    leaseUntil: isoTimestamp(row.lease_until, "lease_until"),
    dataScopeKey: requiredString(row.data_scope_key, "data_scope_key"),
    capturedAt,
    query: queryPayload(row.query_payload),
    requestedSnapshot: requestedSnapshot(row.requested_snapshot, capturedAt)
  };
}

async function complete(
  connection: SqlConnection,
  claim: HistoricalTrajectoryProjectionClaim,
  result: HistoricalTrajectoryMaterializationResult
): Promise<void> {
  const trajectoryRevisionId = result.status === "MATERIALIZED" ? result.trajectoryRevisionId : null;
  const outcomeId = result.status === "OUTCOME" ? result.outcome.outcomeId : null;
  const completed = await connection.query<{ completed: unknown }>(`
    SELECT gowm_history.complete_historical_trajectory_projection(
      $1::uuid, $2::text, $3::bigint, $4::uuid, $5::uuid
    ) AS completed
  `, [claim.queueId, claim.workerId, claim.generation, trajectoryRevisionId, outcomeId]);
  if (completed.rows[0]?.completed !== true) throw new ProjectionFenceLostError();
}

export class PostgresHistoricalTrajectoryProjectionRepository
implements HistoricalTrajectoryProjectionRepository {
  public constructor(
    private readonly pool: SqlPool,
    private readonly bounds: SqlExecutionBounds = {},
    private readonly execution: { leasePool?: SqlPool; signal?: AbortSignal } = {}
  ) {}

  public async claim(
    workerId: string,
    batchSize: number,
    leaseSeconds: number
  ): Promise<HistoricalTrajectoryProjectionClaim[]> {
    this.execution.signal?.throwIfAborted();
    const claimed = await this.pool.query<QueueRow>(`
      SELECT * FROM gowm_history.claim_historical_trajectory_projection(
        $1::text, $2::integer, make_interval(secs => $3::double precision)
      )
    `, [workerId, batchSize, leaseSeconds]);
    return claimed.rows.map((row) => ({ ...mapClaim(row, workerId), leaseSeconds }));
  }

  public async materializeAndComplete(
    claim: HistoricalTrajectoryProjectionClaim,
    materializer: PostgresHistoricalTrajectoryMaterializer
  ): Promise<HistoricalTrajectoryMaterializationResult> {
    const request: HistoricalTrajectoryMaterializationRequest = {
      dataScopeKey: claim.dataScopeKey,
      capturedAt: claim.capturedAt,
      query: claim.query,
      requestedSnapshot: claim.requestedSnapshot
    };
    const controller = new AbortController();
    const signal = this.execution.signal;
    const leaseMs = (claim.leaseSeconds ?? 30) * 1000;
    const leasePool = this.execution.leasePool ?? this.pool;
    let deadline = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | undefined;
    const lost = () => controller.abort(new ProjectionFenceLostError());
    const cancelled = () => controller.abort(signal?.reason ?? new Error("Projection cancelled"));
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
    const check = () => {
      controller.signal.throwIfAborted();
      if (performance.now() >= deadline) throw new ProjectionFenceLostError();
    };
    const renew = async () => {
      controller.signal.throwIfAborted();
      const started = performance.now();
      const result = await leasePool.query<{renewed: unknown}>(`
        SELECT gowm_history.renew_historical_trajectory_projection(
          $1::uuid,$2::text,$3::bigint,make_interval(secs=>$4::double precision)
        ) AS renewed`, [claim.queueId,claim.workerId,claim.generation,leaseMs/1000]);
      if (stopped) return;
      if (result.rows[0]?.renewed !== true) throw new ProjectionFenceLostError();
      deadline = started + leaseMs;
      check();
      clearTimeout(watchdog);
      watchdog = setTimeout(lost, Math.max(1, deadline-performance.now()));
    };
    const schedule = () => {
      timer = setTimeout(() => {
        inFlight = renew().catch(() => { if (!stopped) lost(); }).finally(() => {
          if (!stopped && !controller.signal.aborted) schedule();
        });
      }, Math.max(10, Math.floor(leaseMs/3)));
    };
    try {
      // Verify ownership before loading anything; an expired batch claim cannot
      // be revived. Production uses an independent small pool for renewal.
      await renew();
      schedule();
      return await withProjectionExecution(check, async () => {
        const prepared = await materializer.prepareForCommit(request);
        check();
        return withProjectionTransaction(guardedProjectionPool(this.pool), async (connection) => {
          await connection.query("SELECT gowm_history_v1.set_data_scope($1::text)", [claim.dataScopeKey]);
          const result = await materializer.commitPreparedInTransaction(prepared, connection);
          check();
          await complete(connection, claim, result);
          return result;
        }, this.bounds);
      });
    } finally {
      stopped = true;
      clearTimeout(timer); clearTimeout(watchdog);
      signal?.removeEventListener("abort", cancelled);
      await inFlight;
    }
  }

  public async fail(
    claim: HistoricalTrajectoryProjectionClaim,
    error: unknown,
    retryAt: string
  ): Promise<boolean> {
    const result = await this.pool.query<{ failed: unknown }>(`
      SELECT gowm_history.fail_historical_trajectory_projection(
        $1::uuid, $2::text, $3::bigint, $4::text, $5::timestamptz
      ) AS failed
    `, [claim.queueId, claim.workerId, claim.generation, errorMessage(error), isoTimestamp(retryAt, "retryAt")]);
    return result.rows[0]?.failed === true;
  }
}
