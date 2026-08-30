import type { TaskExecutionIntervalDraft } from "../../historical-trace-model/src/interval.js";
import { HISTORICAL_OUTCOME_REASON } from "../../historical-trace-model/src/outcome.js";
import type {
  GapPreservingSlicePlan,
  HistoricalCompletenessResult,
  HistoricalExcludedPeriod,
  HistoricalGap,
  HistoricalPhaseScope,
  HistoricalRequestDomain,
  HistoricalSegmentSlice,
  HistoricalSourceSegment,
  TimePeriod
} from "../../historical-trace-model/src/trajectory.js";

interface MillisPeriod {
  start: number;
  end: number;
}

function millis(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid timestamp: ${value}`);
  return parsed;
}

function asMillis(period: TimePeriod): MillisPeriod {
  const start = millis(period.start);
  const end = millis(period.end);
  if (end <= start) throw new TypeError(`Time period must be non-empty: ${period.start}/${period.end}`);
  return { start, end };
}

function fromMillis(period: MillisPeriod): TimePeriod {
  return {
    start: new Date(period.start).toISOString(),
    end: new Date(period.end).toISOString(),
    bounds: "[)"
  };
}

export function normalizeTimePeriods(periods: readonly TimePeriod[]): TimePeriod[] {
  const sorted = periods.map(asMillis).sort((left, right) => left.start - right.start || left.end - right.end);
  const normalized: MillisPeriod[] = [];
  for (const period of sorted) {
    const prior = normalized.at(-1);
    if (prior === undefined || period.start > prior.end) normalized.push({ ...period });
    else prior.end = Math.max(prior.end, period.end);
  }
  return normalized.map(fromMillis);
}

export function intersectTimePeriods(left: TimePeriod, right: TimePeriod): TimePeriod | undefined {
  const leftMillis = asMillis(left);
  const rightMillis = asMillis(right);
  const start = Math.max(leftMillis.start, rightMillis.start);
  const end = Math.min(leftMillis.end, rightMillis.end);
  return end <= start ? undefined : fromMillis({ start, end });
}

export function intersectPeriodSets(left: readonly TimePeriod[], right: readonly TimePeriod[]): TimePeriod[] {
  const intersections: TimePeriod[] = [];
  for (const leftPeriod of normalizeTimePeriods(left)) {
    for (const rightPeriod of normalizeTimePeriods(right)) {
      const intersection = intersectTimePeriods(leftPeriod, rightPeriod);
      if (intersection !== undefined) intersections.push(intersection);
    }
  }
  return normalizeTimePeriods(intersections);
}

export function timePeriodDurationMs(periods: readonly TimePeriod[]): number {
  return normalizeTimePeriods(periods)
    .map(asMillis)
    .reduce((total, period) => total + period.end - period.start, 0);
}

function makePeriod(start: string | undefined, end: string | undefined): TimePeriod | undefined {
  if (start === undefined || end === undefined || millis(end) <= millis(start)) return undefined;
  return fromMillis({ start: millis(start), end: millis(end) });
}

export function deriveHistoricalRequestDomain(
  interval: TaskExecutionIntervalDraft,
  phaseScope: HistoricalPhaseScope,
  effectiveCapturedAt: string
): HistoricalRequestDomain {
  const effectiveEnd = interval.end ?? new Date(millis(effectiveCapturedAt)).toISOString();
  const envelope = makePeriod(interval.start, effectiveEnd);
  if (envelope === undefined) {
    return {
      requestedPeriods: [],
      excludedPeriods: [],
      openExecution: interval.end === undefined,
      conflicted: true
    };
  }

  if (phaseScope === "EXECUTION_ENVELOPE") {
    return {
      requestedPeriods: [envelope],
      excludedPeriods: [],
      openExecution: interval.end === undefined,
      conflicted: interval.lifecycleState === "CONFLICTED"
    };
  }

  const running: TimePeriod[] = [];
  const excluded: HistoricalExcludedPeriod[] = [];
  for (const phase of interval.phases) {
    const phasePeriod = makePeriod(phase.start, phase.end ?? effectiveEnd);
    if (phasePeriod === undefined) continue;
    const clipped = intersectTimePeriods(phasePeriod, envelope);
    if (clipped === undefined) continue;
    if (phase.phaseKind === "RUNNING") running.push(clipped);
    else if (phase.phaseKind === "PAUSED") excluded.push({ reason: "EXCLUDED_PAUSED_PHASE", range: clipped });
  }

  return {
    requestedPeriods: normalizeTimePeriods(running),
    excludedPeriods: excluded.sort((left, right) => millis(left.range.start) - millis(right.range.start)),
    openExecution: interval.end === undefined,
    conflicted: interval.lifecycleState === "CONFLICTED"
  };
}

function copyGapWithRange(gap: HistoricalGap, range: TimePeriod): HistoricalGap {
  const result: HistoricalGap = { reason: gap.reason, range };
  if (gap.details !== undefined) result.details = gap.details;
  if (gap.leftMeasurementId !== undefined) result.leftMeasurementId = gap.leftMeasurementId;
  if (gap.rightMeasurementId !== undefined) result.rightMeasurementId = gap.rightMeasurementId;
  if (gap.sourceTrackletGapId !== undefined) result.sourceTrackletGapId = gap.sourceTrackletGapId;
  return result;
}

/**
 * Produces a slicing plan only. Every source Sequence and every requested
 * period remains an independent output Sequence; the helper never invents a
 * bridge or interpolation across a source gap or excluded pause.
 */
export function buildGapPreservingSlicePlan(
  sourceSegments: readonly HistoricalSourceSegment[],
  sourceGaps: readonly HistoricalGap[],
  requestedPeriods: readonly TimePeriod[]
): GapPreservingSlicePlan {
  const requested = normalizeTimePeriods(requestedPeriods);
  const unorderedSlices: Omit<HistoricalSegmentSlice, "sequenceNo">[] = [];
  for (const segment of sourceSegments) {
    if (!Number.isSafeInteger(segment.sourceSegmentNo) || segment.sourceSegmentNo < 1) {
      throw new TypeError("sourceSegmentNo must be a positive integer");
    }
    if (!Number.isSafeInteger(segment.sampleCount) || segment.sampleCount < 0) {
      throw new TypeError("sampleCount must be a non-negative integer");
    }
    for (const [index, requestedPeriod] of requested.entries()) {
      const period = intersectTimePeriods(segment.period, requestedPeriod);
      if (period === undefined) continue;
      unorderedSlices.push({
        sourceTrackletVersionId: segment.sourceTrackletVersionId,
        sourceSegmentNo: segment.sourceSegmentNo,
        sourceSampleCount: segment.sampleCount,
        period,
        requestedPeriodNo: index + 1
      });
    }
  }

  unorderedSlices.sort((left, right) =>
    millis(left.period.start) - millis(right.period.start)
    || millis(left.period.end) - millis(right.period.end)
    || (left.sourceTrackletVersionId < right.sourceTrackletVersionId ? -1 : left.sourceTrackletVersionId > right.sourceTrackletVersionId ? 1 : 0)
    || left.sourceSegmentNo - right.sourceSegmentNo
    || left.requestedPeriodNo - right.requestedPeriodNo
  );
  const segments = unorderedSlices.map((slice, index): HistoricalSegmentSlice => ({ ...slice, sequenceNo: index + 1 }));

  const gaps: HistoricalGap[] = [];
  for (const gap of sourceGaps) {
    for (const requestedPeriod of requested) {
      const range = intersectTimePeriods(gap.range, requestedPeriod);
      if (range !== undefined) gaps.push(copyGapWithRange(gap, range));
    }
  }
  gaps.sort((left, right) => millis(left.range.start) - millis(right.range.start) || millis(left.range.end) - millis(right.range.end));
  return { segments, gaps };
}

function definedAtStart(periods: readonly TimePeriod[], start: number): boolean {
  return periods.some((period) => {
    const value = asMillis(period);
    return value.start <= start && value.end > start;
  });
}

function definedThroughEnd(periods: readonly TimePeriod[], end: number): boolean {
  return periods.some((period) => {
    const value = asMillis(period);
    return value.start < end && value.end >= end;
  });
}

function gapAtStart(gaps: readonly HistoricalGap[], start: number): boolean {
  return gaps.some((gap) => {
    const value = asMillis(gap.range);
    return value.start <= start && value.end > start;
  });
}

function gapAtEnd(gaps: readonly HistoricalGap[], end: number): boolean {
  return gaps.some((gap) => {
    const value = asMillis(gap.range);
    return value.start < end && value.end >= end;
  });
}

export interface HistoricalCompletenessInput {
  requestedPeriods: readonly TimePeriod[];
  definedPeriods: readonly TimePeriod[];
  gaps: readonly HistoricalGap[];
  sampleCount: number;
  sequenceCount: number;
  openExecution?: boolean;
  asOfComplete?: boolean;
  sourceConflict?: boolean;
  intervalConflict?: boolean;
}

export function calculateHistoricalCompleteness(input: HistoricalCompletenessInput): HistoricalCompletenessResult {
  if (!Number.isSafeInteger(input.sampleCount) || input.sampleCount < 0) throw new TypeError("sampleCount must be a non-negative integer");
  if (!Number.isSafeInteger(input.sequenceCount) || input.sequenceCount < 0) throw new TypeError("sequenceCount must be a non-negative integer");

  const requestedPeriods = normalizeTimePeriods(input.requestedPeriods);
  const definedPeriods = intersectPeriodSets(input.definedPeriods, requestedPeriods);
  const relevantGaps = input.gaps.filter((gap) => requestedPeriods.some((period) => intersectTimePeriods(gap.range, period) !== undefined));
  const requestedDuration = timePeriodDurationMs(requestedPeriods);
  const definedDuration = timePeriodDurationMs(definedPeriods);
  const temporalCoverageRatio = requestedDuration === 0 ? 0 : Math.min(1, definedDuration / requestedDuration);
  const firstRequest = requestedPeriods[0];
  const lastRequest = requestedPeriods.at(-1);
  const prefixComplete = firstRequest !== undefined
    && definedAtStart(definedPeriods, millis(firstRequest.start))
    && !gapAtStart(relevantGaps, millis(firstRequest.start));
  let suffixComplete = lastRequest !== undefined
    && definedThroughEnd(definedPeriods, millis(lastRequest.end))
    && !gapAtEnd(relevantGaps, millis(lastRequest.end));
  if (input.openExecution === true && input.asOfComplete !== true) suffixComplete = false;

  const completeness = {
    temporalCoverageRatio,
    prefixComplete,
    suffixComplete,
    sampleCount: input.sampleCount,
    sequenceCount: input.sequenceCount,
    gapCount: relevantGaps.length
  };

  if (input.sourceConflict === true || input.intervalConflict === true) {
    return {
      status: "INDETERMINATE",
      reasonCode: input.sourceConflict === true ? HISTORICAL_OUTCOME_REASON.SOURCE_CONFLICT : HISTORICAL_OUTCOME_REASON.INTERVAL_CONFLICT,
      warnings: [],
      completeness,
      requestedPeriods,
      definedPeriods
    };
  }
  if (requestedDuration <= 0) {
    return {
      status: "INDETERMINATE",
      reasonCode: HISTORICAL_OUTCOME_REASON.INVALID_REQUEST_DURATION,
      warnings: [],
      completeness,
      requestedPeriods,
      definedPeriods
    };
  }
  if (input.sampleCount === 0) {
    return {
      status: "NO_DATA",
      reasonCode: HISTORICAL_OUTCOME_REASON.NO_TRAJECTORY_POINTS,
      warnings: [],
      completeness,
      requestedPeriods,
      definedPeriods
    };
  }
  if (temporalCoverageRatio < 1 || relevantGaps.length > 0) {
    return {
      status: "PARTIAL",
      reasonCode: relevantGaps.length > 0 ? HISTORICAL_OUTCOME_REASON.UNKNOWN_GAPS : HISTORICAL_OUTCOME_REASON.PARTIAL_COVERAGE,
      warnings: [],
      completeness,
      requestedPeriods,
      definedPeriods
    };
  }
  return {
    status: "COMPLETED",
    reasonCode: HISTORICAL_OUTCOME_REASON.COMPLETE,
    warnings: [],
    completeness,
    requestedPeriods,
    definedPeriods
  };
}
