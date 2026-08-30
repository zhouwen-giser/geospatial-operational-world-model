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
    private readonly bounds: SqlExecutionBounds = {}
  ) {}

  public async claim(
    workerId: string,
    batchSize: number,
    leaseSeconds: number
  ): Promise<HistoricalTrajectoryProjectionClaim[]> {
    const claimed = await this.pool.query<QueueRow>(`
      SELECT * FROM gowm_history.claim_historical_trajectory_projection(
        $1::text, $2::integer, make_interval(secs => $3::double precision)
      )
    `, [workerId, batchSize, leaseSeconds]);
    return claimed.rows.map((row) => mapClaim(row, workerId));
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
    // Never hold a write connection while the loader/slicer use their own
    // bounded read transactions. This also remains safe with a pool size of 1.
    const prepared = await materializer.prepareForCommit(request);
    return withProjectionTransaction(this.pool, async (connection) => {
      await connection.query("SELECT gowm_history_v1.set_data_scope($1::text)", [claim.dataScopeKey]);
      const result = await materializer.commitPreparedInTransaction(prepared, connection);
      await complete(connection, claim, result);
      return result;
    }, this.bounds);
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
