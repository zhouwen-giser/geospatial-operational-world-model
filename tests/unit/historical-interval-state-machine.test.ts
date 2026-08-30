import { describe, expect, it } from "vitest";
import type {
  ExistingTaskIntervalRevision,
  TaskIntervalEvent,
  TaskIntervalMethodProfile
} from "../../packages/historical-trace-model/src/index.js";
import {
  canonicalSha256,
  orderTaskIntervalEvents,
  planTaskIntervalRevisions,
  reconstructTaskExecutionIntervals
} from "../../packages/historical-trace-core/src/index.js";

const PROFILE: TaskIntervalMethodProfile = {
  profileKey: "task-interval-observed-v1",
  profileVersion: 1,
  profileHash: canonicalSha256({ profile: "task-interval-observed-v1", version: 1 }),
  legacyResumeFromStarted: false,
  allowControlCompletionAsTerminal: false
};

function event(
  eventId: string,
  eventType: string,
  eventTime: string,
  overrides: Partial<TaskIntervalEvent> = {}
): TaskIntervalEvent {
  return {
    eventId,
    eventType,
    eventTime,
    receivedTime: new Date(Date.parse(eventTime) + 1_000).toISOString(),
    sourceAuthority: "authority-a",
    sourceEventKey: eventId,
    sourceRevisionNo: 1,
    eventContentHash: canonicalSha256({ eventId, eventType, eventTime }),
    confidence: 0.95,
    ...overrides
  };
}

describe("historical task interval reconstruction", () => {
  it("uses the mandatory six-field deterministic event order", () => {
    const time = "2026-08-30T01:00:00.000Z";
    const received = "2026-08-30T01:00:01.000Z";
    const input = [
      event("event-z", "EXECUTION_PROGRESS_OBSERVED", time, { receivedTime: received, sourceAuthority: "b", sourceEventKey: "a" }),
      event("event-b", "EXECUTION_PROGRESS_OBSERVED", time, { receivedTime: received, sourceAuthority: "a", sourceEventKey: "a", sourceRevisionNo: 2 }),
      event("event-a", "EXECUTION_PROGRESS_OBSERVED", time, { receivedTime: received, sourceAuthority: "a", sourceEventKey: "a", sourceRevisionNo: 2 }),
      event("event-c", "EXECUTION_PROGRESS_OBSERVED", time, { receivedTime: received, sourceAuthority: "a", sourceEventKey: "b" }),
      event("event-early", "EXECUTION_PROGRESS_OBSERVED", time, { receivedTime: "2026-08-30T01:00:00.500Z", sourceAuthority: "z" })
    ];

    expect(orderTaskIntervalEvents(input).map((item) => item.eventId)).toEqual([
      "event-early", "event-a", "event-b", "event-c", "event-z"
    ]);
    expect(input[0]!.eventId).toBe("event-z");
  });

  it("reconstructs RUNNING, PAUSED, RUNNING phases and a closed interval", () => {
    const result = reconstructTaskExecutionIntervals([
      event("start", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:00:00Z"),
      event("pause", "EXECUTION_PAUSED_OBSERVED", "2026-08-30T01:10:00Z"),
      event("resume", "EXECUTION_RESUMED_OBSERVED", "2026-08-30T01:20:00Z"),
      event("stop", "EXECUTION_STOPPED_OBSERVED", "2026-08-30T01:30:00Z")
    ], PROFILE);

    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]).toMatchObject({
      executionNo: 1,
      lifecycleState: "CLOSED",
      derivationKind: "OBSERVED",
      start: "2026-08-30T01:00:00.000Z",
      end: "2026-08-30T01:30:00.000Z"
    });
    expect(result.executions[0]!.phases.map((phase) => phase.phaseKind)).toEqual(["RUNNING", "PAUSED", "RUNNING"]);
    expect(result.executions[0]!.phases.map((phase) => [phase.start, phase.end])).toEqual([
      ["2026-08-30T01:00:00.000Z", "2026-08-30T01:10:00.000Z"],
      ["2026-08-30T01:10:00.000Z", "2026-08-30T01:20:00.000Z"],
      ["2026-08-30T01:20:00.000Z", "2026-08-30T01:30:00.000Z"]
    ]);
  });

  it("increments execution numbers only after a terminal execution", () => {
    const result = reconstructTaskExecutionIntervals([
      event("start-1", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:00:00Z"),
      event("duplicate", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:01:00Z"),
      event("stop-1", "EXECUTION_STOPPED_OBSERVED", "2026-08-30T01:02:00Z"),
      event("start-2", "EXECUTION_STARTED_OBSERVED", "2026-08-30T02:00:00Z")
    ], PROFILE);

    expect(result.executions.map((interval) => interval.executionNo)).toEqual([1, 2]);
    expect(result.executions[0]!.reasonCodes).toContain("DUPLICATE_START");
    expect(result.executions[1]).toMatchObject({ lifecycleState: "OPEN", reasonCodes: ["OPEN_EXECUTION"] });
    expect(result.executions[1]!.end).toBeUndefined();
  });

  it("keeps an open interval upper bound absent", () => {
    const result = reconstructTaskExecutionIntervals([
      event("start", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:00:00Z"),
      event("progress", "EXECUTION_PROGRESS_OBSERVED", "2026-08-30T01:10:00Z")
    ], PROFILE);

    expect(result.executions[0]).toMatchObject({ lifecycleState: "OPEN", start: "2026-08-30T01:00:00.000Z" });
    expect(result.executions[0]!.end).toBeUndefined();
    expect(result.executions[0]!.phases[0]!.end).toBeUndefined();
  });

  it("represents a terminal event without a start as conflicted", () => {
    const result = reconstructTaskExecutionIntervals([
      event("stop", "EXECUTION_STOPPED_OBSERVED", "2026-08-30T01:30:00Z")
    ], PROFILE);

    expect(result.executions[0]).toMatchObject({
      lifecycleState: "CONFLICTED",
      stabilityState: "CONFLICTED",
      end: "2026-08-30T01:30:00.000Z"
    });
    expect(result.executions[0]!.start).toBeUndefined();
    expect(result.executions[0]!.reasonCodes).toEqual(expect.arrayContaining([
      "EXECUTION_BOUNDARY_MISSING", "EVENT_SEQUENCE_CONFLICT"
    ]));
  });

  it("marks simultaneous mutually exclusive boundaries as SAME_TIME_CONFLICT", () => {
    const result = reconstructTaskExecutionIntervals([
      event("start", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:00:00Z"),
      event("a-pause", "EXECUTION_PAUSED_OBSERVED", "2026-08-30T01:10:00Z"),
      event("b-resume", "EXECUTION_RESUMED_OBSERVED", "2026-08-30T01:10:00Z"),
      event("stop", "EXECUTION_STOPPED_OBSERVED", "2026-08-30T01:20:00Z")
    ], PROFILE);

    expect(result.executions[0]!.lifecycleState).toBe("CONFLICTED");
    expect(result.executions[0]!.reasonCodes).toContain("SAME_TIME_CONFLICT");
  });

  it("materializes one conflicted execution when simultaneous start/terminal tie-break order is reversed", () => {
    const time = "2026-08-30T01:00:00Z";
    const result = reconstructTaskExecutionIntervals([
      event("terminal-first", "EXECUTION_STOPPED_OBSERVED", time, { sourceAuthority: "a" }),
      event("start-second", "EXECUTION_STARTED_OBSERVED", time, { sourceAuthority: "z" })
    ], PROFILE);

    expect(result.orderedEvents.map((item) => item.eventId)).toEqual(["terminal-first", "start-second"]);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]).toMatchObject({
      executionNo: 1,
      lifecycleState: "CONFLICTED",
      reasonCodes: expect.arrayContaining(["SAME_TIME_CONFLICT", "EVENT_SEQUENCE_CONFLICT"])
    });
  });

  it("never treats progress as resume and profile-gates legacy STARTED resume", () => {
    const inputs = [
      event("start", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:00:00Z"),
      event("pause", "EXECUTION_PAUSED_OBSERVED", "2026-08-30T01:10:00Z"),
      event("progress", "EXECUTION_PROGRESS_OBSERVED", "2026-08-30T01:15:00Z"),
      event("legacy-start", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:20:00Z"),
      event("stop", "EXECUTION_STOPPED_OBSERVED", "2026-08-30T01:30:00Z")
    ];
    const strict = reconstructTaskExecutionIntervals(inputs, PROFILE).executions[0]!;
    const compatible = reconstructTaskExecutionIntervals(inputs, { ...PROFILE, legacyResumeFromStarted: true }).executions[0]!;

    expect(strict.lifecycleState).toBe("CONFLICTED");
    expect(strict.phases.map((phase) => phase.phaseKind)).toEqual(["RUNNING", "PAUSED"]);
    expect(compatible.lifecycleState).toBe("CLOSED");
    expect(compatible.phases.map((phase) => phase.phaseKind)).toEqual(["RUNNING", "PAUSED", "RUNNING"]);
    expect(compatible.reasonCodes).toContain("LEGACY_START_INTERPRETED_AS_RESUME");
  });

  it("uses control completion only when the pinned profile allows it", () => {
    const inputs = [
      event("start", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:00:00Z"),
      event("control-complete", "CONTROL_COMPLETED_REPORTED", "2026-08-30T01:30:00Z")
    ];
    const observedOnly = reconstructTaskExecutionIntervals(inputs, PROFILE).executions[0]!;
    const mixed = reconstructTaskExecutionIntervals(inputs, { ...PROFILE, allowControlCompletionAsTerminal: true }).executions[0]!;

    expect(observedOnly.lifecycleState).toBe("OPEN");
    expect(mixed).toMatchObject({ lifecycleState: "CLOSED", derivationKind: "MIXED" });
    expect(mixed.reasonCodes).toContain("CONTROL_COMPLETION_USED_AS_TERMINAL");
  });

  it("plans a new immutable revision when late input changes the canonical content", () => {
    const initial = reconstructTaskExecutionIntervals([
      event("start", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:00:00Z"),
      event("stop", "EXECUTION_STOPPED_OBSERVED", "2026-08-30T01:30:00Z")
    ], PROFILE).executions[0]!;
    const existing: ExistingTaskIntervalRevision = {
      intervalRevisionId: "interval-revision-1",
      executionNo: 1,
      revisionNo: 1,
      contentHash: initial.contentHash
    };
    const replay = planTaskIntervalRevisions([initial], [existing]);

    const revised = reconstructTaskExecutionIntervals([
      event("start", "EXECUTION_STARTED_OBSERVED", "2026-08-30T01:00:00Z"),
      event("late-pause", "EXECUTION_PAUSED_OBSERVED", "2026-08-30T01:10:00Z", { receivedTime: "2026-08-30T03:00:00Z" }),
      event("late-resume", "EXECUTION_RESUMED_OBSERVED", "2026-08-30T01:20:00Z", { receivedTime: "2026-08-30T03:00:01Z" }),
      event("stop", "EXECUTION_STOPPED_OBSERVED", "2026-08-30T01:30:00Z")
    ], PROFILE).executions[0]!;
    const append = planTaskIntervalRevisions([revised], [existing]);

    expect(replay[0]).toMatchObject({ action: "REUSE", revisionNo: 1 });
    expect(append[0]).toMatchObject({ action: "APPEND", revisionNo: 2, supersedesRevisionId: "interval-revision-1" });
    expect(revised.contentHash).not.toBe(initial.contentHash);
    expect(existing).toEqual({
      intervalRevisionId: "interval-revision-1",
      executionNo: 1,
      revisionNo: 1,
      contentHash: initial.contentHash
    });
  });
});
