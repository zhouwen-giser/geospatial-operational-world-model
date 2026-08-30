import { describe, expect, it } from "vitest";
import {
  canonicalSha256
} from "../../packages/historical-trace-core/src/index.js";
import type {
  HistoricalSemanticRequest
} from "../../packages/historical-trace-model/src/index.js";
import {
  HistoricalProjectionCoordinator,
  PostgresHistoricalTrajectoryProjectionRepository,
  ProjectionFenceLostError,
  type HistoricalRequestedSnapshot,
  type HistoricalTrajectoryProjectionClaim,
  type HistoricalTrajectoryProjectionRepository,
  type PostgresHistoricalTrajectoryMaterializer,
  type SqlConnection,
  type SqlPool,
  type SqlQueryResult,
  type TaskIntervalProjectionRepository,
  type TrackletProjectionRepository
} from "../../packages/historical-trace-runtime/src/index.js";

const CAPTURED_AT = "2026-08-30T04:00:00.000Z";
const HASH = canonicalSha256({ queue: "history" });
const QUERY: HistoricalSemanticRequest = {
  subjectReferenceKey: { namespace: "gowm", kind: "WORLD_OBJECT", id: "subject-a", version: "2" },
  executionIntervalReferenceKey: {
    namespace: "gowm", kind: "TASK_EXECUTION_INTERVAL", id: "interval-a", version: "3"
  },
  phaseScope: "EXECUTION_ENVELOPE",
  sourceSelection: { mode: "ONLY_CANDIDATE" },
  sourceSelectionProfileReferenceKey: {
    namespace: "gowm.history", kind: "HISTORY_METHOD_PROFILE", id: "profile-a", version: "1.0"
  },
  analysisSpaceReferenceKey: { namespace: "gowm", kind: "ANALYSIS_SPACE", id: "space-a", version: "1" }
};

function snapshot(): HistoricalRequestedSnapshot {
  const canonical = {
    querySnapshotId: "snapshot-a",
    mode: "LATEST_AT_START" as const,
    consistency: "CONSISTENT_AT_START" as const,
    capturedAt: CAPTURED_AT,
    resources: [{
      resourceKind: "TASK_EXECUTION_INTERVAL",
      resourceId: "interval-a",
      version: "3",
      pinning: "PINNED" as const,
      contentHash: HASH
    }]
  };
  return { ...canonical, manifestHash: canonicalSha256(canonical) };
}

function queueRow(): Record<string, unknown> {
  return {
    queue_id: "00000000-0000-4000-8000-000000000001",
    data_scope_key: "scope-a",
    captured_at: CAPTURED_AT,
    query_payload: QUERY,
    requested_snapshot: snapshot(),
    state: "RUNNING",
    generation: 7,
    lease_until: "2026-08-30T04:01:00.000Z"
  };
}

describe("historical trajectory projection queue", () => {
  it("parses the frozen query/snapshot returned by a bounded claim", async () => {
    const pool: SqlPool = {
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<SqlQueryResult<Row>> => {
        expect(sql).toContain("claim_historical_trajectory_projection");
        expect(values).toEqual(["worker-a", 4, 30]);
        return { rows: [queueRow() as Row] };
      },
      connect: async () => { throw new Error("not called"); }
    };
    const claims = await new PostgresHistoricalTrajectoryProjectionRepository(pool)
      .claim("worker-a", 4, 30);

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      workerId: "worker-a", generation: 7, state: "RUNNING",
      capturedAt: CAPTURED_AT, query: QUERY,
      requestedSnapshot: { manifestHash: snapshot().manifestHash }
    });
  });

  it("rolls tentative materialization back when completion loses its generation fence", async () => {
    const calls: string[] = [];
    let preparedBeforeWriteTransaction = false;
    const connection: SqlConnection = {
      query: async <Row extends Record<string, unknown>>(sql: string): Promise<SqlQueryResult<Row>> => {
        calls.push(sql);
        if (sql.includes("complete_historical_trajectory_projection")) {
          return { rows: [{ completed: false } as unknown as Row] };
        }
        return { rows: [] };
      },
      release: () => { calls.push("RELEASE"); }
    };
    const pool: SqlPool = {
      query: async () => ({ rows: [] }),
      connect: async () => {
        expect(preparedBeforeWriteTransaction).toBe(true);
        return connection;
      }
    };
    const materializer = {
      prepareForCommit: async () => {
        preparedBeforeWriteTransaction = true;
        return { kind: "REVISION" } as never;
      },
      commitPreparedInTransaction: async (_prepared: unknown, tx: SqlConnection) => {
        await tx.query("INSERT TENTATIVE HISTORICAL REVISION");
        return {
          status: "MATERIALIZED" as const,
          trajectoryRevisionId: "00000000-0000-4000-8000-000000000010",
          analysisId: "00000000-0000-4000-8000-000000000011",
          contentHash: HASH,
          reused: false
        };
      }
    } as unknown as PostgresHistoricalTrajectoryMaterializer;
    const claim = {
      queueId: String(queueRow().queue_id), workerId: "worker-a", generation: 7,
      state: "RUNNING" as const, leaseUntil: String(queueRow().lease_until),
      dataScopeKey: "scope-a", capturedAt: CAPTURED_AT,
      query: QUERY, requestedSnapshot: snapshot()
    };

    await expect(new PostgresHistoricalTrajectoryProjectionRepository(pool)
      .materializeAndComplete(claim, materializer)).rejects.toBeInstanceOf(ProjectionFenceLostError);
    expect(calls).toContain("INSERT TENTATIVE HISTORICAL REVISION");
    expect(calls.some((sql) => sql.includes("complete_historical_trajectory_projection"))).toBe(true);
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("counts bounded materializations and stale fences without promoting failed claims", async () => {
    const first = {
      queueId: "00000000-0000-4000-8000-000000000001",
      workerId: "worker-a", generation: 1, state: "RUNNING" as const,
      leaseUntil: "2026-08-30T04:01:00.000Z", dataScopeKey: "scope-a",
      capturedAt: CAPTURED_AT, query: QUERY, requestedSnapshot: snapshot()
    } satisfies HistoricalTrajectoryProjectionClaim;
    const second = { ...first, queueId: "00000000-0000-4000-8000-000000000002" };
    let failed = 0;
    const trajectories: HistoricalTrajectoryProjectionRepository = {
      claim: async () => [first, second],
      materializeAndComplete: async (claim) => {
        if (claim.queueId === second.queueId) throw new ProjectionFenceLostError();
        return {
          status: "MATERIALIZED", trajectoryRevisionId: "00000000-0000-4000-8000-000000000010",
          analysisId: "00000000-0000-4000-8000-000000000011", contentHash: HASH, reused: false
        };
      },
      fail: async () => { failed += 1; return false; }
    };
    const coordinator = new HistoricalProjectionCoordinator({
      intervals: {} as TaskIntervalProjectionRepository,
      tracklets: {} as TrackletProjectionRepository,
      trajectories,
      materializer: {} as PostgresHistoricalTrajectoryMaterializer,
      now: () => new Date(CAPTURED_AT)
    });

    await expect(coordinator.materializeHistoricalTrajectories({
      workerId: "worker-a", batchSize: 2, leaseSeconds: 30, retryDelayMs: 100
    })).resolves.toEqual({
      historicalTrajectoryClaims: 2,
      historicalTrajectoriesMaterialized: 1,
      historicalTrajectoryOutcomesRecorded: 0,
      historicalProjectionFailures: 1,
      staleFenceFailures: 1
    });
    expect(failed).toBe(1);
  });
});
