export type Sha256Digest = `sha256:${string}`;

export const TASK_INTERVAL_EVENT_TYPES = [
  "EXECUTION_STARTED_OBSERVED",
  "EXECUTION_PROGRESS_OBSERVED",
  "EXECUTION_PAUSED_OBSERVED",
  "EXECUTION_RESUMED_OBSERVED",
  "EXECUTION_STOPPED_OBSERVED",
  "EXECUTION_FAILED_OBSERVED",
  "EXECUTION_CANCELLED_OBSERVED",
  "CONTROL_COMPLETED_REPORTED"
] as const;

export type TaskIntervalEventType = (typeof TASK_INTERVAL_EVENT_TYPES)[number];

export type IntervalFsmState = "NONE" | "RUNNING" | "PAUSED" | "TERMINAL" | "CONFLICTED";
export type TaskExecutionLifecycleState = "OPEN" | "CLOSED" | "CONFLICTED";
export type TaskExecutionDerivationKind = "OBSERVED" | "INFERRED" | "MIXED";
export type TaskExecutionStabilityState = "PROVISIONAL" | "SEALED" | "CONFLICTED";
export type TaskExecutionPhaseKind = "RUNNING" | "PAUSED" | "UNKNOWN";

export type TaskIntervalReasonCode =
  | "INTERVALS_AVAILABLE"
  | "TASK_NOT_FOUND"
  | "NO_EXECUTION_EVENTS"
  | "EXECUTION_BOUNDARY_MISSING"
  | "EVENT_SEQUENCE_CONFLICT"
  | "SAME_TIME_CONFLICT"
  | "DUPLICATE_START"
  | "DUPLICATE_RESUME"
  | "LEGACY_START_INTERPRETED_AS_RESUME"
  | "CONTROL_COMPLETION_USED_AS_TERMINAL"
  | "OPEN_EXECUTION"
  | "PROJECTION_PENDING";

export interface TaskIntervalEvent {
  eventId: string;
  eventType: string;
  eventTime: string;
  receivedTime: string;
  sourceAuthority: string;
  sourceEventKey: string;
  sourceRevisionNo: number;
  eventContentHash: Sha256Digest;
  confidence?: number;
}

export interface TaskIntervalMethodProfile {
  profileKey: string;
  profileVersion: number;
  profileHash: Sha256Digest;
  legacyResumeFromStarted: boolean;
  allowControlCompletionAsTerminal: boolean;
}

export const DEFAULT_TASK_INTERVAL_METHOD_PROFILE: TaskIntervalMethodProfile = {
  profileKey: "task-interval-observed-v1",
  profileVersion: 1,
  profileHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  legacyResumeFromStarted: false,
  allowControlCompletionAsTerminal: false
};

export interface HistoricalTimeRange {
  start: string;
  end: string;
  bounds: "[)";
}

export interface TaskExecutionPhase {
  phaseNo: number;
  phaseKind: TaskExecutionPhaseKind;
  start?: string;
  end?: string;
  startEventId?: string;
  endEventId?: string;
  confidence?: number;
  reasonCodes: TaskIntervalReasonCode[];
}

export interface TaskExecutionIntervalDraft {
  executionNo: number;
  lifecycleState: TaskExecutionLifecycleState;
  derivationKind: TaskExecutionDerivationKind;
  stabilityState: TaskExecutionStabilityState;
  start?: string;
  end?: string;
  startEventId?: string;
  terminalEventId?: string;
  phases: TaskExecutionPhase[];
  confidence?: number;
  reasonCodes: TaskIntervalReasonCode[];
  inputEvents: TaskIntervalEvent[];
}

export interface ReconstructedTaskExecutionInterval extends TaskExecutionIntervalDraft {
  inputEventSetHash: Sha256Digest;
  contentHash: Sha256Digest;
}

export interface TaskIntervalMachineResult {
  finalState: IntervalFsmState;
  executions: TaskExecutionIntervalDraft[];
  orphanEvents: TaskIntervalEvent[];
}

export interface TaskIntervalReconstructionResult {
  orderedEvents: TaskIntervalEvent[];
  executions: ReconstructedTaskExecutionInterval[];
  orphanEvents: TaskIntervalEvent[];
  inputEventSetHash: Sha256Digest;
}

export interface ExistingTaskIntervalRevision {
  intervalRevisionId: string;
  executionNo: number;
  revisionNo: number;
  contentHash: Sha256Digest;
}

export type TaskIntervalRevisionPlan =
  | {
      action: "REUSE";
      executionNo: number;
      revisionNo: number;
      existingRevisionId: string;
      interval: ReconstructedTaskExecutionInterval;
    }
  | {
      action: "APPEND";
      executionNo: number;
      revisionNo: number;
      supersedesRevisionId?: string;
      interval: ReconstructedTaskExecutionInterval;
    };
