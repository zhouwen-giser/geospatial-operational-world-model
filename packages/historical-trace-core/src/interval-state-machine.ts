import type {
  IntervalFsmState,
  TaskExecutionIntervalDraft,
  TaskExecutionPhase,
  TaskIntervalEvent,
  TaskIntervalMachineResult,
  TaskIntervalMethodProfile,
  TaskIntervalReasonCode
} from "../../historical-trace-model/src/interval.js";

type NominalState = Exclude<IntervalFsmState, "CONFLICTED">;

interface MutablePhase {
  phaseKind: TaskExecutionPhase["phaseKind"];
  start?: string;
  end?: string;
  startEventId?: string;
  endEventId?: string;
  confidences: number[];
  reasonCodes: Set<TaskIntervalReasonCode>;
}

interface MutableExecution {
  executionNo: number;
  start?: string;
  end?: string;
  startEventId?: string;
  terminalEventId?: string;
  phases: MutablePhase[];
  reasonCodes: Set<TaskIntervalReasonCode>;
  inputEvents: TaskIntervalEvent[];
  confidences: number[];
  conflicted: boolean;
  usedControlCompletion: boolean;
}

const TERMINAL_EVENTS = new Set([
  "EXECUTION_STOPPED_OBSERVED",
  "EXECUTION_FAILED_OBSERVED",
  "EXECUTION_CANCELLED_OBSERVED"
]);

const BOUNDARY_EVENTS = new Set([
  "EXECUTION_STARTED_OBSERVED",
  "EXECUTION_PAUSED_OBSERVED",
  "EXECUTION_RESUMED_OBSERVED",
  ...TERMINAL_EVENTS
]);

function timestamp(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new TypeError(`Invalid event timestamp: ${value}`);
  return new Date(millis).toISOString();
}

function confidence(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.min(...values);
}

function startPhase(kind: MutablePhase["phaseKind"], event: TaskIntervalEvent, start?: string): MutablePhase {
  const phase: MutablePhase = {
    phaseKind: kind,
    confidences: [],
    reasonCodes: new Set<TaskIntervalReasonCode>()
  };
  if (start !== undefined) phase.start = start;
  phase.startEventId = event.eventId;
  if (event.confidence !== undefined) phase.confidences.push(event.confidence);
  return phase;
}

function closePhase(execution: MutableExecution, event: TaskIntervalEvent): void {
  const phase = execution.phases.at(-1);
  if (phase === undefined || phase.end !== undefined) return;
  phase.end = timestamp(event.eventTime);
  phase.endEventId = event.eventId;
  if (event.confidence !== undefined) phase.confidences.push(event.confidence);
}

function attach(execution: MutableExecution, event: TaskIntervalEvent): void {
  execution.inputEvents.push(event);
  if (event.confidence !== undefined) execution.confidences.push(event.confidence);
}

function addReason(execution: MutableExecution, reason: TaskIntervalReasonCode): void {
  execution.reasonCodes.add(reason);
}

function markConflict(execution: MutableExecution, reason: TaskIntervalReasonCode): void {
  execution.conflicted = true;
  execution.reasonCodes.add(reason);
}

function finish(execution: MutableExecution): TaskExecutionIntervalDraft {
  if (execution.end === undefined && !execution.conflicted) addReason(execution, "OPEN_EXECUTION");
  if (execution.start === undefined) {
    markConflict(execution, "EXECUTION_BOUNDARY_MISSING");
    addReason(execution, "EVENT_SEQUENCE_CONFLICT");
  }

  const phases = execution.phases.map((phase, index): TaskExecutionPhase => {
    const output: TaskExecutionPhase = {
      phaseNo: index + 1,
      phaseKind: phase.phaseKind,
      reasonCodes: [...phase.reasonCodes].sort()
    };
    if (phase.start !== undefined) output.start = phase.start;
    if (phase.end !== undefined) output.end = phase.end;
    if (phase.startEventId !== undefined) output.startEventId = phase.startEventId;
    if (phase.endEventId !== undefined) output.endEventId = phase.endEventId;
    const phaseConfidence = confidence(phase.confidences);
    if (phaseConfidence !== undefined) output.confidence = phaseConfidence;
    return output;
  });

  const output: TaskExecutionIntervalDraft = {
    executionNo: execution.executionNo,
    lifecycleState: execution.conflicted ? "CONFLICTED" : execution.end === undefined ? "OPEN" : "CLOSED",
    derivationKind: execution.usedControlCompletion ? "MIXED" : "OBSERVED",
    stabilityState: execution.conflicted ? "CONFLICTED" : "PROVISIONAL",
    phases,
    reasonCodes: [...execution.reasonCodes].sort(),
    inputEvents: [...execution.inputEvents]
  };
  if (execution.start !== undefined) output.start = execution.start;
  if (execution.end !== undefined) output.end = execution.end;
  if (execution.startEventId !== undefined) output.startEventId = execution.startEventId;
  if (execution.terminalEventId !== undefined) output.terminalEventId = execution.terminalEventId;
  const executionConfidence = confidence(execution.confidences);
  if (executionConfidence !== undefined) output.confidence = executionConfidence;
  return output;
}

function isTerminal(event: TaskIntervalEvent, profile: TaskIntervalMethodProfile): boolean {
  return TERMINAL_EVENTS.has(event.eventType)
    || (event.eventType === "CONTROL_COMPLETED_REPORTED" && profile.allowControlCompletionAsTerminal);
}

function boundaryKind(event: TaskIntervalEvent, profile: TaskIntervalMethodProfile): string | undefined {
  if (BOUNDARY_EVENTS.has(event.eventType)) return event.eventType;
  return event.eventType === "CONTROL_COMPLETED_REPORTED" && profile.allowControlCompletionAsTerminal
    ? event.eventType
    : undefined;
}

function hasSameTimeConflict(events: readonly TaskIntervalEvent[], profile: TaskIntervalMethodProfile): boolean {
  const kinds = new Set(events.map((event) => boundaryKind(event, profile)).filter((kind) => kind !== undefined));
  return kinds.size > 1;
}

function groupByEventTime(events: readonly TaskIntervalEvent[]): TaskIntervalEvent[][] {
  const groups: TaskIntervalEvent[][] = [];
  for (const event of events) {
    const prior = groups.at(-1);
    if (prior !== undefined && Date.parse(prior[0]!.eventTime) === Date.parse(event.eventTime)) prior.push(event);
    else groups.push([event]);
  }
  return groups;
}

function newExecution(executionNo: number, event: TaskIntervalEvent, missingStart: boolean): MutableExecution {
  const eventTime = timestamp(event.eventTime);
  const execution: MutableExecution = {
    executionNo,
    phases: [],
    reasonCodes: new Set<TaskIntervalReasonCode>(),
    inputEvents: [],
    confidences: [],
    conflicted: missingStart,
    usedControlCompletion: false
  };
  if (!missingStart) {
    execution.start = eventTime;
    execution.startEventId = event.eventId;
  } else {
    execution.reasonCodes.add("EXECUTION_BOUNDARY_MISSING");
    execution.reasonCodes.add("EVENT_SEQUENCE_CONFLICT");
  }
  attach(execution, event);
  return execution;
}

/**
 * Runs the interval FSM over events that have already been put in the mandated
 * deterministic order. It performs no persistence and never uses wall-clock time.
 */
export function runTaskIntervalStateMachine(
  orderedEvents: readonly TaskIntervalEvent[],
  profile: TaskIntervalMethodProfile
): TaskIntervalMachineResult {
  const executions: MutableExecution[] = [];
  const orphanEvents: TaskIntervalEvent[] = [];
  let current: MutableExecution | undefined;
  let state: NominalState = "NONE";
  let executionNo = 0;

  const finalizeCurrent = (): void => {
    if (current === undefined) return;
    executions.push(current);
    current = undefined;
  };

  for (const group of groupByEventTime(orderedEvents)) {
    const groupConflict = hasSameTimeConflict(group, profile);
    const groupEventIds = new Set(group.map((event) => event.eventId));

    // When no execution is active, a contradictory boundary group represents
    // one physically indeterminate execution, not a tie-break-dependent number
    // of executions. Preserve the mandated event order as evidence while
    // materializing a single conflicted interval.
    const simultaneousStart = group.find((event) => event.eventType === "EXECUTION_STARTED_OBSERVED");
    if (groupConflict && (state === "NONE" || (state === "TERMINAL" && simultaneousStart !== undefined))) {
      const anchor = simultaneousStart ?? group.find((event) => boundaryKind(event, profile) !== undefined)!;
      const simultaneousTerminal = group.find((event) => isTerminal(event, profile));
      executionNo += 1;
      current = newExecution(executionNo, anchor, simultaneousStart === undefined);
      for (const event of group) {
        if (event.eventId !== anchor.eventId) attach(current, event);
      }
      const unknownPhase = startPhase(
        "UNKNOWN",
        anchor,
        simultaneousStart === undefined ? undefined : timestamp(simultaneousStart.eventTime)
      );
      current.phases.push(unknownPhase);
      markConflict(current, "SAME_TIME_CONFLICT");
      addReason(current, "EVENT_SEQUENCE_CONFLICT");
      if (simultaneousTerminal !== undefined) {
        closePhase(current, simultaneousTerminal);
        current.end = timestamp(simultaneousTerminal.eventTime);
        current.terminalEventId = simultaneousTerminal.eventId;
        if (simultaneousTerminal.eventType === "CONTROL_COMPLETED_REPORTED") {
          current.usedControlCompletion = true;
          addReason(current, "CONTROL_COMPLETION_USED_AS_TERMINAL");
        }
        finalizeCurrent();
        state = "TERMINAL";
      } else {
        state = group.some((event) => event.eventType === "EXECUTION_PAUSED_OBSERVED")
          && !group.some((event) => event.eventType === "EXECUTION_RESUMED_OBSERVED" || event.eventType === "EXECUTION_STARTED_OBSERVED")
          ? "PAUSED"
          : "RUNNING";
      }
      continue;
    }

    for (const event of group) {
      const eventTime = timestamp(event.eventTime);
      const terminal = isTerminal(event, profile);

      if (state === "NONE") {
        if (event.eventType === "EXECUTION_STARTED_OBSERVED") {
          executionNo += 1;
          current = newExecution(executionNo, event, false);
          current.phases.push(startPhase("RUNNING", event, eventTime));
          state = "RUNNING";
        } else if (event.eventType === "EXECUTION_RESUMED_OBSERVED" || event.eventType === "EXECUTION_PAUSED_OBSERVED" || terminal) {
          executionNo += 1;
          current = newExecution(executionNo, event, true);
          if (terminal) {
            current.end = eventTime;
            current.terminalEventId = event.eventId;
            current.phases.push(startPhase("UNKNOWN", event));
            closePhase(current, event);
            if (event.eventType === "CONTROL_COMPLETED_REPORTED") {
              current.usedControlCompletion = true;
              addReason(current, "CONTROL_COMPLETION_USED_AS_TERMINAL");
            }
            finalizeCurrent();
            state = "TERMINAL";
          } else {
            current.phases.push(startPhase(event.eventType === "EXECUTION_PAUSED_OBSERVED" ? "PAUSED" : "RUNNING", event));
            state = event.eventType === "EXECUTION_PAUSED_OBSERVED" ? "PAUSED" : "RUNNING";
          }
        } else {
          orphanEvents.push(event);
        }
        continue;
      }

      if (state === "TERMINAL") {
        if (event.eventType === "EXECUTION_STARTED_OBSERVED") {
          executionNo += 1;
          current = newExecution(executionNo, event, false);
          current.phases.push(startPhase("RUNNING", event, eventTime));
          state = "RUNNING";
        } else {
          orphanEvents.push(event);
        }
        continue;
      }

      if (current === undefined) throw new Error("Task interval FSM lost the current execution");
      attach(current, event);

      if (state === "RUNNING") {
        if (event.eventType === "EXECUTION_PROGRESS_OBSERVED") continue;
        if (event.eventType === "EXECUTION_PAUSED_OBSERVED") {
          closePhase(current, event);
          current.phases.push(startPhase("PAUSED", event, eventTime));
          state = "PAUSED";
          continue;
        }
        if (event.eventType === "EXECUTION_STARTED_OBSERVED") {
          addReason(current, "DUPLICATE_START");
          continue;
        }
        if (event.eventType === "EXECUTION_RESUMED_OBSERVED") {
          addReason(current, "DUPLICATE_RESUME");
          continue;
        }
        if (terminal) {
          closePhase(current, event);
          current.end = eventTime;
          current.terminalEventId = event.eventId;
          if (event.eventType === "CONTROL_COMPLETED_REPORTED") {
            current.usedControlCompletion = true;
            addReason(current, "CONTROL_COMPLETION_USED_AS_TERMINAL");
          }
          finalizeCurrent();
          state = "TERMINAL";
        }
        continue;
      }

      if (event.eventType === "EXECUTION_PROGRESS_OBSERVED") continue;
      if (event.eventType === "EXECUTION_RESUMED_OBSERVED") {
        closePhase(current, event);
        current.phases.push(startPhase("RUNNING", event, eventTime));
        state = "RUNNING";
        continue;
      }
      if (event.eventType === "EXECUTION_STARTED_OBSERVED") {
        if (profile.legacyResumeFromStarted) {
          closePhase(current, event);
          current.phases.push(startPhase("RUNNING", event, eventTime));
          addReason(current, "LEGACY_START_INTERPRETED_AS_RESUME");
          state = "RUNNING";
        } else {
          markConflict(current, "EVENT_SEQUENCE_CONFLICT");
        }
        continue;
      }
      if (event.eventType === "EXECUTION_PAUSED_OBSERVED") {
        markConflict(current, "EVENT_SEQUENCE_CONFLICT");
        continue;
      }
      if (terminal) {
        closePhase(current, event);
        current.end = eventTime;
        current.terminalEventId = event.eventId;
        if (event.eventType === "CONTROL_COMPLETED_REPORTED") {
          current.usedControlCompletion = true;
          addReason(current, "CONTROL_COMPLETION_USED_AS_TERMINAL");
        }
        finalizeCurrent();
        state = "TERMINAL";
      }
    }

    if (groupConflict) {
      for (const execution of [current, ...executions].filter((value): value is MutableExecution => value !== undefined)) {
        if (execution.inputEvents.some((event) => groupEventIds.has(event.eventId))) markConflict(execution, "SAME_TIME_CONFLICT");
      }
    }
  }

  finalizeCurrent();
  const materialized = executions.map(finish);
  const last = materialized.at(-1);
  const finalState: IntervalFsmState = last?.lifecycleState === "CONFLICTED"
    ? "CONFLICTED"
    : state;
  return { finalState, executions: materialized, orphanEvents };
}
