import type {
  ExistingTaskIntervalRevision,
  ReconstructedTaskExecutionInterval,
  TaskIntervalEvent,
  TaskIntervalMethodProfile,
  TaskIntervalReconstructionResult,
  TaskIntervalRevisionPlan
} from "../../historical-trace-model/src/interval.js";
import { canonicalInputSetHash, canonicalSha256 } from "./canonical-hash.js";
import { runTaskIntervalStateMachine } from "./interval-state-machine.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function timestampMillis(value: string, field: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError(`Invalid ${field}: ${value}`);
  return millis;
}

function validateEvent(event: TaskIntervalEvent): void {
  timestampMillis(event.eventTime, "eventTime");
  timestampMillis(event.receivedTime, "receivedTime");
  if (!Number.isSafeInteger(event.sourceRevisionNo) || event.sourceRevisionNo < 1) {
    throw new TypeError(`Invalid sourceRevisionNo for ${event.eventId}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(event.eventContentHash)) {
    throw new TypeError(`Invalid eventContentHash for ${event.eventId}`);
  }
  if (event.confidence !== undefined && (!Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1)) {
    throw new TypeError(`Invalid confidence for ${event.eventId}`);
  }
}

export function compareTaskIntervalEvents(left: TaskIntervalEvent, right: TaskIntervalEvent): number {
  return timestampMillis(left.eventTime, "eventTime") - timestampMillis(right.eventTime, "eventTime")
    || timestampMillis(left.receivedTime, "receivedTime") - timestampMillis(right.receivedTime, "receivedTime")
    || compareText(left.sourceAuthority, right.sourceAuthority)
    || compareText(left.sourceEventKey, right.sourceEventKey)
    || left.sourceRevisionNo - right.sourceRevisionNo
    || compareText(left.eventId, right.eventId);
}

export function orderTaskIntervalEvents(events: readonly TaskIntervalEvent[]): TaskIntervalEvent[] {
  for (const event of events) validateEvent(event);
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.eventId)) throw new TypeError(`Duplicate eventId: ${event.eventId}`);
    eventIds.add(event.eventId);
  }
  return [...events].sort(compareTaskIntervalEvents);
}

function eventInput(event: TaskIntervalEvent): { eventId: string; eventContentHash: string } {
  return { eventId: event.eventId, eventContentHash: event.eventContentHash };
}

export function reconstructTaskExecutionIntervals(
  events: readonly TaskIntervalEvent[],
  profile: TaskIntervalMethodProfile
): TaskIntervalReconstructionResult {
  const orderedEvents = orderTaskIntervalEvents(events);
  const machine = runTaskIntervalStateMachine(orderedEvents, profile);
  const executions = machine.executions.map((draft): ReconstructedTaskExecutionInterval => {
    const inputEventSetHash = canonicalInputSetHash(draft.inputEvents.map(eventInput));
    const contentHash = canonicalSha256({
      executionNo: draft.executionNo,
      lifecycleState: draft.lifecycleState,
      derivationKind: draft.derivationKind,
      stabilityState: draft.stabilityState,
      ...(draft.start === undefined ? {} : { start: draft.start }),
      ...(draft.end === undefined ? {} : { end: draft.end }),
      ...(draft.startEventId === undefined ? {} : { startEventId: draft.startEventId }),
      ...(draft.terminalEventId === undefined ? {} : { terminalEventId: draft.terminalEventId }),
      phases: draft.phases,
      ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
      reasonCodes: draft.reasonCodes,
      inputEventSetHash,
      profile: {
        key: profile.profileKey,
        version: profile.profileVersion,
        hash: profile.profileHash
      }
    });
    return { ...draft, inputEventSetHash, contentHash };
  });
  return {
    orderedEvents,
    executions,
    orphanEvents: machine.orphanEvents,
    inputEventSetHash: canonicalInputSetHash(orderedEvents.map(eventInput))
  };
}

/**
 * Creates an append/reuse plan without mutating either the prior immutable
 * revisions or the newly reconstructed values.
 */
export function planTaskIntervalRevisions(
  reconstructed: readonly ReconstructedTaskExecutionInterval[],
  existing: readonly ExistingTaskIntervalRevision[]
): TaskIntervalRevisionPlan[] {
  const existingByExecution = new Map<number, ExistingTaskIntervalRevision>();
  for (const revision of existing) {
    const prior = existingByExecution.get(revision.executionNo);
    if (prior === undefined || revision.revisionNo > prior.revisionNo) existingByExecution.set(revision.executionNo, revision);
  }

  return reconstructed.map((interval): TaskIntervalRevisionPlan => {
    const prior = existingByExecution.get(interval.executionNo);
    if (prior !== undefined && prior.contentHash === interval.contentHash) {
      return {
        action: "REUSE",
        executionNo: interval.executionNo,
        revisionNo: prior.revisionNo,
        existingRevisionId: prior.intervalRevisionId,
        interval
      };
    }
    const append: TaskIntervalRevisionPlan = {
      action: "APPEND",
      executionNo: interval.executionNo,
      revisionNo: (prior?.revisionNo ?? 0) + 1,
      interval
    };
    if (prior !== undefined) append.supersedesRevisionId = prior.intervalRevisionId;
    return append;
  });
}
