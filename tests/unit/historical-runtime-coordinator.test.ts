import { describe, expect, it } from "vitest";
import {
  canonicalSha256,
  planTaskIntervalRevisions
} from "../../packages/historical-trace-core/src/index.js";
import type {
  ExistingTaskIntervalRevision,
  TaskIntervalEvent,
  TaskIntervalMethodProfile,
  TaskIntervalReconstructionResult
} from "../../packages/historical-trace-model/src/index.js";
import {
  HistoricalProjectionCoordinator,
  ProjectionFenceLostError,
  withProjectionTransaction,
  type SqlConnection,
  type SqlPool,
  type TaskIntervalCommitResult,
  type TaskIntervalProjectionClaim,
  type TaskIntervalProjectionInput,
  type TaskIntervalProjectionRepository,
  type TrackletFinalizationClaim,
  type TrackletFinalizationEvidence,
  type TrackletProjectionClaim,
  type TrackletProjectionRepository
} from "../../packages/historical-trace-runtime/src/index.js";

const PROFILE: TaskIntervalMethodProfile = {
  profileKey: "task-interval-observed-v1",
  profileVersion: 1,
  profileHash: canonicalSha256({ profile: "task-interval-observed-v1" }),
  legacyResumeFromStarted: false,
  allowControlCompletionAsTerminal: false
};

function event(id: string, type: string, phenomenon: string, received = phenomenon): TaskIntervalEvent {
  return {
    eventId: id,
    eventType: type,
    eventTime: phenomenon,
    receivedTime: received,
    sourceAuthority: "authority-a",
    sourceEventKey: id,
    sourceRevisionNo: 1,
    eventContentHash: canonicalSha256({ id, type, phenomenon, received })
  };
}

function claim(generation: number, hash: string): TaskIntervalProjectionClaim {
  return {
    queueId: `00000000-0000-4000-8000-00000000000${generation}`,
    dataScopeKey: "scope-a",
    operationalTaskId: "task-a",
    desiredEventSetHash: hash as `sha256:${string}`,
    generation,
    workerId: "history-worker",
    projectionAsOf: "2026-08-30T04:00:00.000Z",
    leaseUntil: "2026-08-30T04:01:00.000Z"
  };
}

class InMemoryIntervals implements TaskIntervalProjectionRepository {
  private readonly queued: TaskIntervalProjectionInput[] = [];
  public readonly revisions: ExistingTaskIntervalRevision[] = [];
  public readonly snapshots: Array<{ reconstruction: TaskIntervalReconstructionResult; prior: ExistingTaskIntervalRevision[] }> = [];
  public failed = 0;
  private revisionId = 0;

  public enqueue(events: TaskIntervalEvent[]): void {
    const desired = canonicalSha256(events.map((value) => value.eventContentHash));
    this.queued.push({ claim: claim(this.queued.length + this.snapshots.length + 1, desired), events, profile: PROFILE });
  }

  public async claim(): Promise<TaskIntervalProjectionClaim[]> {
    return this.queued.map((input) => input.claim);
  }

  public async load(value: TaskIntervalProjectionClaim): Promise<TaskIntervalProjectionInput> {
    const index = this.queued.findIndex((input) => input.claim.queueId === value.queueId);
    if (index < 0) throw new Error("claim unavailable");
    return this.queued.splice(index, 1)[0]!;
  }

  public async commit(
    _input: TaskIntervalProjectionInput,
    reconstruction: TaskIntervalReconstructionResult
  ): Promise<TaskIntervalCommitResult> {
    const prior = this.revisions.map((value) => ({ ...value }));
    this.snapshots.push({ reconstruction, prior });
    const plans = planTaskIntervalRevisions(reconstruction.executions, this.revisions);
    const appendedRevisionIds: string[] = [];
    const reusedRevisionIds: string[] = [];
    for (const plan of plans) {
      if (plan.action === "REUSE") {
        reusedRevisionIds.push(plan.existingRevisionId);
        continue;
      }
      const revision: ExistingTaskIntervalRevision = {
        intervalRevisionId: `revision-${++this.revisionId}`,
        executionNo: plan.executionNo,
        revisionNo: plan.revisionNo,
        contentHash: plan.interval.contentHash
      };
      const current = this.revisions.findIndex((value) => value.executionNo === plan.executionNo);
      if (current >= 0) this.revisions.splice(current, 1, revision);
      else this.revisions.push(revision);
      appendedRevisionIds.push(revision.intervalRevisionId);
    }
    return { appendedRevisionIds, reusedRevisionIds, supersededBeforeProjection: false };
  }

  public async fail(): Promise<boolean> {
    this.failed += 1;
    return true;
  }
}

class EmptyTracklets implements TrackletProjectionRepository {
  public async claimTracklets(): Promise<TrackletProjectionClaim[]> { return []; }
  public async rebuildAndComplete(): Promise<string> { throw new Error("not called"); }
  public async failTracklet(): Promise<boolean> { return true; }
  public async claimFinalizations(): Promise<TrackletFinalizationClaim[]> { return []; }
  public async loadFinalization(): Promise<TrackletFinalizationEvidence> { throw new Error("not called"); }
  public async finalizeAndComplete(): Promise<never> { throw new Error("not called"); }
  public async failFinalization(): Promise<boolean> { return true; }
}

describe("historical projection runtime coordinator", () => {
  it("rebuilds by phenomenon/received order and appends a new immutable revision for late input", async () => {
    const intervals = new InMemoryIntervals();
    const coordinator = new HistoricalProjectionCoordinator({ intervals, tracklets: new EmptyTracklets() });
    intervals.enqueue([
      event("stop", "EXECUTION_STOPPED_OBSERVED", "2026-08-30T01:30:00Z", "2026-08-30T01:30:01Z"),
      event("start", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:00:00Z", "2026-08-30T01:00:01Z")
    ]);
    expect(await coordinator.tick({ workerId: "worker", batchSize: 10, leaseSeconds: 30 })).toMatchObject({
      taskIntervalsProjected: 1, historicalProjectionFailures: 0
    });
    const first = { ...intervals.revisions[0]! };
    expect(intervals.snapshots[0]!.reconstruction.orderedEvents.map((value) => value.eventId)).toEqual(["start", "stop"]);

    intervals.enqueue([
      event("stop", "EXECUTION_STOPPED_OBSERVED", "2026-08-30T01:30:00Z", "2026-08-30T01:30:01Z"),
      event("late-resume", "EXECUTION_RESUMED_OBSERVED", "2026-08-30T01:20:00Z", "2026-08-30T03:00:01Z"),
      event("start", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:00:00Z", "2026-08-30T01:00:01Z"),
      event("late-pause", "EXECUTION_PAUSED_OBSERVED", "2026-08-30T01:10:00Z", "2026-08-30T03:00:00Z")
    ]);
    await coordinator.tick({ workerId: "worker", batchSize: 10, leaseSeconds: 30 });

    expect(intervals.revisions[0]).toMatchObject({ executionNo: 1, revisionNo: 2 });
    expect(intervals.revisions[0]!.contentHash).not.toBe(first.contentHash);
    expect(first).toMatchObject({ revisionNo: 1 });
    expect(intervals.snapshots[1]!.prior).toEqual([first]);
  });

  it("preserves SAME_TIME_CONFLICT and fails a stale generation closed", async () => {
    const intervals = new InMemoryIntervals();
    intervals.enqueue([
      event("start", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:00:00Z"),
      event("pause", "EXECUTION_PAUSED_OBSERVED", "2026-08-30T01:10:00Z"),
      event("resume", "EXECUTION_RESUMED_OBSERVED", "2026-08-30T01:10:00Z"),
      event("stop", "EXECUTION_STOPPED_OBSERVED", "2026-08-30T01:20:00Z")
    ]);
    const staleTracklet: TrackletProjectionClaim = {
      queueId: "00000000-0000-4000-8000-000000000099",
      workerId: "worker", generation: 7,
      leaseUntil: "2026-08-30T04:01:00Z",
      dataScopeKey: "scope-a", sourceKey: "source-a", sourceLocalTargetId: "target-a",
      trackerSessionKey: "session-a", analysisSpaceKey: "space-a", profileKey: "source-local-default",
      desiredInputSetHash: canonicalSha256({ desired: 1 })
    };
    let failedTracklet = 0;
    const tracklets: TrackletProjectionRepository = {
      claimTracklets: async () => [staleTracklet],
      rebuildAndComplete: async () => { throw new ProjectionFenceLostError(); },
      failTracklet: async () => { failedTracklet += 1; return false; },
      claimFinalizations: async () => [],
      loadFinalization: async () => { throw new Error("not called"); },
      finalizeAndComplete: async () => { throw new Error("not called"); },
      failFinalization: async () => false
    };
    const result = await new HistoricalProjectionCoordinator({ intervals, tracklets }).tick({
      workerId: "worker", batchSize: 10, leaseSeconds: 30
    });

    expect(intervals.snapshots[0]!.reconstruction.executions[0]).toMatchObject({
      lifecycleState: "CONFLICTED",
      reasonCodes: expect.arrayContaining(["SAME_TIME_CONFLICT"])
    });
    expect(result).toMatchObject({ historicalProjectionFailures: 1, staleFenceFailures: 1, trackletsRebuilt: 0 });
    expect(failedTracklet).toBe(1);
  });

  it("rolls a stale CAS transaction back after tentative revision/head work", async () => {
    const calls: string[] = [];
    const connection: SqlConnection = {
      query: async (sql) => { calls.push(sql); return { rows: [] }; },
      release: () => { calls.push("RELEASE"); }
    };
    const pool: SqlPool = { query: connection.query, connect: async () => connection };

    await expect(withProjectionTransaction(pool, async (tx) => {
      await tx.query("INSERT REVISION AND UPDATE HEAD");
      throw new ProjectionFenceLostError();
    })).rejects.toBeInstanceOf(ProjectionFenceLostError);

    expect(calls).toEqual([
      "BEGIN",
      "SELECT set_config('statement_timeout',$1::text,true), set_config('lock_timeout',$2::text,true)",
      "INSERT REVISION AND UPDATE HEAD",
      "ROLLBACK",
      "RELEASE"
    ]);
  });
});
