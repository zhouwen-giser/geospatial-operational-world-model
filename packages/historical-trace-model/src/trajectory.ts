import type { HistoricalOutcomeStatus } from "./outcome.js";
import type { LogicalReferenceKey, VersionedReferenceKey } from "./references.js";

export type HistoricalPhaseScope = "EXECUTION_ENVELOPE" | "ACTIVE_PHASES_ONLY";
export type HistoricalGapReason = "UNKNOWN_INPUT_GAP" | "SOURCE_COVERAGE_GAP" | "TRACKLET_BOUNDARY_GAP";
export type HistoricalExclusionReason = "EXCLUDED_PAUSED_PHASE";

export interface TimePeriod {
  start: string;
  end: string;
  bounds: "[)";
}

export interface HistoricalGap {
  reason: HistoricalGapReason;
  range: TimePeriod;
  details?: string;
  leftMeasurementId?: string;
  rightMeasurementId?: string;
  sourceTrackletGapId?: string;
}

export interface HistoricalExcludedPeriod {
  reason: HistoricalExclusionReason;
  range: TimePeriod;
}

export interface HistoricalSourceSegment {
  sourceTrackletVersionId: string;
  sourceSegmentNo: number;
  period: TimePeriod;
  sampleCount: number;
}

export interface HistoricalSegmentSlice {
  sourceTrackletVersionId: string;
  sourceSegmentNo: number;
  sourceSampleCount: number;
  period: TimePeriod;
  sequenceNo: number;
  requestedPeriodNo: number;
}

export interface GapPreservingSlicePlan {
  segments: HistoricalSegmentSlice[];
  gaps: HistoricalGap[];
}

export interface HistoricalCompleteness {
  temporalCoverageRatio: number;
  prefixComplete: boolean;
  suffixComplete: boolean;
  sampleCount: number;
  sequenceCount: number;
  gapCount: number;
}

export interface HistoricalCompletenessResult {
  status: HistoricalOutcomeStatus;
  reasonCode: string;
  warnings: string[];
  completeness: HistoricalCompleteness;
  requestedPeriods: TimePeriod[];
  definedPeriods: TimePeriod[];
}

export interface HistoricalRequestDomain {
  requestedPeriods: TimePeriod[];
  excludedPeriods: HistoricalExcludedPeriod[];
  openExecution: boolean;
  conflicted: boolean;
}

export type HistoricalSourceSelection =
  | {
      mode: "EXPLICIT_SOURCE";
      sourceKey: string;
      trackerSessionKey?: string;
    }
  | {
      mode: "ONLY_CANDIDATE";
    };

export type TaskExecutionIntervalReferenceKey = VersionedReferenceKey<"TASK_EXECUTION_INTERVAL">;
export type TaskExecutionIntervalLogicalReferenceKey = LogicalReferenceKey<"TASK_EXECUTION_INTERVAL">;
export type HistoryMethodProfileReferenceKey = VersionedReferenceKey<"HISTORY_METHOD_PROFILE">;

/**
 * Fields accepted by the historical trajectory query that participate in, or
 * are intentionally excluded from, its canonical semantic request identity.
 */
export interface HistoricalSemanticRequest {
  subjectReferenceKey: VersionedReferenceKey;
  executionIntervalReferenceKey: TaskExecutionIntervalReferenceKey;
  phaseScope: HistoricalPhaseScope;
  sourceSelection: HistoricalSourceSelection;
  sourceSelectionProfileReferenceKey: HistoryMethodProfileReferenceKey;
  analysisSpaceReferenceKey?: VersionedReferenceKey;
  /** Presentation-only and intentionally absent from HistoricalSemanticRequestIdentity. */
  maximumInlinePoints?: number;
}

/** Frozen shape hashed by historicalSemanticRequestHash. */
export interface HistoricalSemanticRequestIdentity {
  subjectReferenceKey: LogicalReferenceKey;
  executionIntervalReferenceKey: TaskExecutionIntervalLogicalReferenceKey;
  phaseScope: HistoricalPhaseScope;
  sourceSelection: HistoricalSourceSelection;
  sourceSelectionProfileReferenceKey: HistoryMethodProfileReferenceKey;
  analysisSpaceReferenceKey?: LogicalReferenceKey;
}

export interface HistoricalTrackletCandidate {
  sourceKey: string;
  trackerSessionKey: string;
  trackletId: string;
  trackletVersionId: string;
  versionNo: number;
  createdAt: string;
  subjectReferenceIdentity: string;
  analysisSpaceIdentity: string;
  periods: TimePeriod[];
  bindingState?: "VALID" | "CONFLICTED";
}

export interface HistoricalSourceSelectionRequest {
  selection: HistoricalSourceSelection;
  capturedAt: string;
  subjectReferenceIdentity: string;
  analysisSpaceIdentity?: string;
  requestedPeriods: TimePeriod[];
}

export type HistoricalSourceSelectionResult =
  | {
      status: "SELECTED";
      sourceKey: string;
      trackerSessionKey: string;
      analysisSpaceIdentity: string;
      candidates: HistoricalTrackletCandidate[];
    }
  | {
      status: "NO_DATA" | "INDETERMINATE";
      reasonCode: string;
      candidates: HistoricalTrackletCandidate[];
    };
